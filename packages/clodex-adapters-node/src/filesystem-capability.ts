import {
  capabilityScopeEquals,
  snapshotCapabilityScope,
  type CapabilityScope,
  type FilesystemCreateCapabilityPort,
  type FilesystemCreateExecuteInput,
  type FilesystemCreateInspectInput,
  type FilesystemMkdirCapabilityPort,
  type FilesystemMkdirExecuteInput,
  type FilesystemMkdirInspectInput,
  type FilesystemReplaceCapabilityPort,
  type FilesystemReplaceExecuteInput,
  type FilesystemReplaceInspectInput,
} from '@clodex/adapters';

import {
  NodeAdapterSecurityError,
  assertPinnedDirectoryLease,
  decodeBoundedUtf8,
  openPinnedDirectory,
  requireBoundedInteger,
  requireDigest,
  runPinnedExecutable,
  sha256Bytes,
  sha256Text,
  type PinnedDirectoryDescriptor,
  type PinnedDirectoryLease,
  type PinnedExecutableDescriptor,
} from './node-security.js';

export const OPENAT2_HELPER_PROTOCOL_VERSION = '1' as const;
export const OPENAT2_HELPER_STDIO_ROOT_FD = 4 as const;

export interface LinuxOpenat2FilesystemCapabilityOptions {
  readonly capabilityScope: CapabilityScope;
  readonly root: PinnedDirectoryDescriptor;
  readonly helper: PinnedExecutableDescriptor;
  readonly timeoutMs?: number;
  readonly maxContentBytes?: number;
}

export interface WorkspaceTreeCommitment {
  readonly rootObjectId: string;
  readonly stateCommitmentHash: string;
}

export interface WorkspaceTreeCommitmentPort {
  inspectTreeCommitment(): Promise<WorkspaceTreeCommitment>;
}

export interface HeldWorkspaceTreeCommitmentPort {
  inspectHeldTreeCommitment(
    workspace: PinnedDirectoryLease,
  ): Promise<WorkspaceTreeCommitment>;
}

type HelperOperation =
  | 'inspect-create'
  | 'execute-create'
  | 'inspect-replace'
  | 'execute-replace'
  | 'inspect-mkdir'
  | 'execute-mkdir'
  | 'tree-commitment';

interface HelperInvocation {
  readonly operation: HelperOperation;
  readonly path: string;
  readonly expectedStateCommitmentHash?: string;
  readonly beforeSha256?: string;
  readonly contentSha256?: string;
  readonly content?: Uint8Array;
  readonly stage: 'prepare' | 'execute';
}

/**
 * Linux production capability for the fixed filesystem operations exposed by
 * @clodex/adapters. It deliberately has no general read/write/path API.
 *
 * The provisioned workspace descriptor is opened O_NOFOLLOW, device/inode
 * checked, held for the whole helper call, and transferred as fd 4. The pinned
 * helper is hashed and executed from the same fd 3. All descendant resolution
 * and mutation is performed by the native openat2 helper.
 */
export class LinuxOpenat2FilesystemCapability
  implements
    FilesystemCreateCapabilityPort,
    FilesystemReplaceCapabilityPort,
    FilesystemMkdirCapabilityPort,
    WorkspaceTreeCommitmentPort,
    HeldWorkspaceTreeCommitmentPort
{
  public readonly capabilityScope: CapabilityScope;

  readonly #root: PinnedDirectoryDescriptor;
  readonly #helper: PinnedExecutableDescriptor;
  readonly #timeoutMs: number;
  readonly #maxContentBytes: number;

  public constructor(options: LinuxOpenat2FilesystemCapabilityOptions) {
    this.capabilityScope = snapshotCapabilityScope(
      readOwnData<CapabilityScope>(options, 'capabilityScope'),
    );
    this.#root = snapshotRoot(
      readOwnData<PinnedDirectoryDescriptor>(options, 'root'),
    );
    this.#helper = snapshotHelper(
      readOwnData<PinnedExecutableDescriptor>(options, 'helper'),
    );
    this.#timeoutMs = requireBoundedInteger(
      readOptionalOwnData(options, 'timeoutMs') ?? 30_000,
      100,
      5 * 60_000,
      'Filesystem helper timeout',
    );
    this.#maxContentBytes = requireBoundedInteger(
      readOptionalOwnData(options, 'maxContentBytes') ?? 64 * 1024 * 1024,
      0,
      256 * 1024 * 1024,
      'Filesystem maximum content bytes',
    );
    Object.freeze(this);
  }

  public async inspectCreate(
    input: FilesystemCreateInspectInput,
  ): Promise<unknown> {
    this.#assertScope(input.capabilityScope, 'prepare');
    const path = requireRelativeSelectorPath(input.selector, 'file');
    requireContentDescriptor(
      input.contentSha256,
      input.contentBytes,
      this.#maxContentBytes,
    );
    const [stateCommitmentHash] = await this.#invoke({
      operation: 'inspect-create',
      path,
      stage: 'prepare',
    });
    return Object.freeze({
      operation: 'filesystem.create',
      resolvedObjectId: this.#resolvedObjectId('file', path),
      stateCommitmentHash,
      targetState: 'absent',
    });
  }

  public async executeCreate(
    input: FilesystemCreateExecuteInput,
  ): Promise<unknown> {
    this.#assertScope(input.capabilityScope, 'execute');
    const path = requireRelativeSelectorPath(input.selector, 'file');
    const content = snapshotExactContent(
      input.content,
      input.contentSha256,
      input.contentBytes,
      this.#maxContentBytes,
    );
    const resolvedObjectId = this.#resolvedObjectId('file', path);
    assertExactIdentifier(
      input.resolvedObjectId,
      resolvedObjectId,
      'Resolved filesystem object',
    );
    const expectedStateCommitmentHash = requireDigest(
      input.expectedStateCommitmentHash,
      'Expected filesystem state commitment',
    );
    const [preStateHash, postStateHash] = await this.#invoke({
      operation: 'execute-create',
      path,
      expectedStateCommitmentHash,
      contentSha256: input.contentSha256,
      content,
      stage: 'execute',
    });
    return Object.freeze({
      operation: 'filesystem.create',
      ticketId: requireIdentifier(input.ticketId, 'Ticket ID'),
      resolvedObjectId,
      preStateHash,
      postStateHash,
      contentSha256: input.contentSha256,
      contentBytes: input.contentBytes,
    });
  }

  public async inspectReplace(
    input: FilesystemReplaceInspectInput,
  ): Promise<unknown> {
    this.#assertScope(input.capabilityScope, 'prepare');
    const path = requireRelativeSelectorPath(input.selector, 'file');
    requireContentDescriptor(
      input.contentSha256,
      input.contentBytes,
      this.#maxContentBytes,
    );
    const beforeSha256 = requireDigest(
      input.beforeSha256,
      'Expected current content digest',
    );
    const [stateCommitmentHash, currentContentSha256] = await this.#invoke({
      operation: 'inspect-replace',
      path,
      beforeSha256,
      stage: 'prepare',
    });
    return Object.freeze({
      operation: 'filesystem.replace',
      resolvedObjectId: this.#resolvedObjectId('file', path),
      stateCommitmentHash,
      targetState: 'file',
      currentContentSha256,
    });
  }

  public async executeReplace(
    input: FilesystemReplaceExecuteInput,
  ): Promise<unknown> {
    this.#assertScope(input.capabilityScope, 'execute');
    const path = requireRelativeSelectorPath(input.selector, 'file');
    const beforeSha256 = requireDigest(
      input.beforeSha256,
      'Expected current content digest',
    );
    const content = snapshotExactContent(
      input.content,
      input.contentSha256,
      input.contentBytes,
      this.#maxContentBytes,
    );
    const resolvedObjectId = this.#resolvedObjectId('file', path);
    assertExactIdentifier(
      input.resolvedObjectId,
      resolvedObjectId,
      'Resolved filesystem object',
    );
    const expectedStateCommitmentHash = requireDigest(
      input.expectedStateCommitmentHash,
      'Expected filesystem state commitment',
    );
    const [preStateHash, postStateHash, capturedBeforeSha256] =
      await this.#invoke({
        operation: 'execute-replace',
        path,
        expectedStateCommitmentHash,
        beforeSha256,
        contentSha256: input.contentSha256,
        content,
        stage: 'execute',
      });
    if (capturedBeforeSha256 !== beforeSha256) {
      throw new NodeAdapterSecurityError(
        'helper-output-invalid',
        'execute',
        'Native helper did not bind the captured before-content digest',
        true,
      );
    }
    return Object.freeze({
      operation: 'filesystem.replace',
      ticketId: requireIdentifier(input.ticketId, 'Ticket ID'),
      resolvedObjectId,
      preStateHash,
      postStateHash,
      beforeSha256,
      contentSha256: input.contentSha256,
      contentBytes: input.contentBytes,
    });
  }

  public async inspectMkdir(
    input: FilesystemMkdirInspectInput,
  ): Promise<unknown> {
    this.#assertScope(input.capabilityScope, 'prepare');
    const path = requireRelativeSelectorPath(input.selector, 'tree');
    const [stateCommitmentHash] = await this.#invoke({
      operation: 'inspect-mkdir',
      path,
      stage: 'prepare',
    });
    return Object.freeze({
      operation: 'filesystem.mkdir',
      resolvedObjectId: this.#resolvedObjectId('tree', path),
      stateCommitmentHash,
      targetState: 'absent',
    });
  }

  public async executeMkdir(
    input: FilesystemMkdirExecuteInput,
  ): Promise<unknown> {
    this.#assertScope(input.capabilityScope, 'execute');
    const path = requireRelativeSelectorPath(input.selector, 'tree');
    const resolvedObjectId = this.#resolvedObjectId('tree', path);
    assertExactIdentifier(
      input.resolvedObjectId,
      resolvedObjectId,
      'Resolved filesystem object',
    );
    const expectedStateCommitmentHash = requireDigest(
      input.expectedStateCommitmentHash,
      'Expected filesystem state commitment',
    );
    const [preStateHash, postStateHash] = await this.#invoke({
      operation: 'execute-mkdir',
      path,
      expectedStateCommitmentHash,
      stage: 'execute',
    });
    return Object.freeze({
      operation: 'filesystem.mkdir',
      ticketId: requireIdentifier(input.ticketId, 'Ticket ID'),
      resolvedObjectId,
      preStateHash,
      postStateHash,
    });
  }

  public async inspectTreeCommitment(): Promise<WorkspaceTreeCommitment> {
    const [stateCommitmentHash] = await this.#invoke({
      operation: 'tree-commitment',
      path: '',
      stage: 'prepare',
    });
    return Object.freeze({
      rootObjectId: this.capabilityScope.rootObjectId,
      stateCommitmentHash,
    });
  }

  public async inspectHeldTreeCommitment(
    workspace: PinnedDirectoryLease,
  ): Promise<WorkspaceTreeCommitment> {
    if (
      workspace.device !== this.#root.device ||
      workspace.inode !== this.#root.inode
    ) {
      throw new NodeAdapterSecurityError(
        'root-identity-mismatch',
        'prepare',
        'Held workspace does not match the filesystem capability root',
      );
    }
    const [stateCommitmentHash] = await this.#invoke(
      {
        operation: 'tree-commitment',
        path: '',
        stage: 'prepare',
      },
      workspace,
    );
    return Object.freeze({
      rootObjectId: this.capabilityScope.rootObjectId,
      stateCommitmentHash,
    });
  }

  async #invoke(
    input: HelperInvocation,
    providedRootLease?: PinnedDirectoryLease,
  ): Promise<readonly [string, ...string[]]> {
    const rootLease =
      providedRootLease ?? (await openPinnedDirectory(this.#root));
    try {
      const content = input.content;
      const result = await runPinnedExecutable({
        executable: this.#helper,
        args: Object.freeze([
          `--protocol-v${OPENAT2_HELPER_PROTOCOL_VERSION}`,
          input.operation,
          rootLease.device,
          rootLease.inode,
          input.path,
          input.expectedStateCommitmentHash ?? '-',
          input.beforeSha256 ?? '-',
          input.contentSha256 ?? '-',
          String(content?.byteLength ?? 0),
        ]),
        ...(content === undefined ? {} : { stdin: content }),
        environment: Object.freeze({ LANG: 'C', LC_ALL: 'C' }),
        extraFileDescriptors: Object.freeze([rootLease.handle.fd]),
        timeoutMs: this.#timeoutMs,
        maxStdoutBytes: 1024,
        maxStderrBytes: 4096,
        stage: input.stage,
        effectMayHaveOccurredOnFailure: input.stage === 'execute',
      });
      await assertPinnedDirectoryLease(rootLease, input.stage);
      const effectMayHaveOccurred = input.stage === 'execute';
      const stderr = decodeBoundedUtf8(
        result.stderr,
        'Native helper stderr',
        input.stage,
        effectMayHaveOccurred,
      );
      if (result.exitCode !== 0 || result.signal !== null) {
        const failedEffectMayHaveOccurred =
          input.stage === 'execute' || stderr.startsWith('ERR\tUNCERTAIN\t');
        throw new NodeAdapterSecurityError(
          failedEffectMayHaveOccurred ? 'effect-uncertain' : 'helper-failure',
          input.stage,
          `Native openat2 helper failed closed${stderr === '' ? '' : `: ${stderr.trim()}`}`,
          failedEffectMayHaveOccurred,
        );
      }
      if (stderr !== '') {
        throw new NodeAdapterSecurityError(
          'helper-output-invalid',
          input.stage,
          'Native helper emitted unexpected stderr on success',
          input.stage === 'execute',
        );
      }
      return parseHelperSuccess(result.stdout, input.operation, input.stage);
    } finally {
      if (providedRootLease === undefined) {
        await rootLease.handle.close().catch(() => undefined);
      }
    }
  }

  #assertScope(value: CapabilityScope, stage: 'prepare' | 'execute'): void {
    const scope = snapshotCapabilityScope(value);
    if (!capabilityScopeEquals(scope, this.capabilityScope)) {
      throw new NodeAdapterSecurityError(
        'capability-scope-mismatch',
        stage,
        'Filesystem capability rejected a workspace/task/root scope mismatch',
        false,
      );
    }
  }

  #resolvedObjectId(kind: 'file' | 'tree', path: string): string {
    const digest = sha256Text(
      [
        'clodex.filesystem-object.v1',
        this.capabilityScope.workspaceId,
        this.capabilityScope.taskId,
        this.capabilityScope.rootObjectId,
        kind,
        path,
      ].join('\0'),
    );
    return `fs.${digest}`;
  }
}

function parseHelperSuccess(
  bytes: Uint8Array,
  operation: HelperOperation,
  stage: 'prepare' | 'execute',
): readonly [string, ...string[]] {
  const effectMayHaveOccurred = stage === 'execute';
  const output = decodeBoundedUtf8(
    bytes,
    'Native helper stdout',
    stage,
    effectMayHaveOccurred,
  );
  if (!output.endsWith('\n') || output.slice(0, -1).includes('\n')) {
    throw new NodeAdapterSecurityError(
      'helper-output-invalid',
      stage,
      'Native helper must emit exactly one newline-terminated record',
      stage === 'execute',
    );
  }
  const fields = output.slice(0, -1).split('\t');
  const expectedFieldCount =
    operation === 'inspect-replace'
      ? 3
      : operation === 'execute-replace'
        ? 4
        : operation.startsWith('execute-')
          ? 3
          : 2;
  if (fields[0] !== 'OK' || fields.length !== expectedFieldCount) {
    throw new NodeAdapterSecurityError(
      'helper-output-invalid',
      stage,
      'Native helper returned an invalid fixed protocol record',
      stage === 'execute',
    );
  }
  const [firstDigest, ...remainingDigests] = fields
    .slice(1)
    .map((field) =>
      requireDigest(field, 'Helper digest', stage, effectMayHaveOccurred),
    );
  if (firstDigest === undefined) {
    throw new NodeAdapterSecurityError(
      'helper-output-invalid',
      stage,
      'Native helper omitted its required state commitment',
      effectMayHaveOccurred,
    );
  }
  const digests: [string, ...string[]] = [firstDigest, ...remainingDigests];
  return Object.freeze(digests);
}

function requireRelativeSelectorPath(
  selector: { readonly kind: 'file' | 'tree'; readonly path: string },
  expectedKind: 'file' | 'tree',
): string {
  if (
    selector === null ||
    typeof selector !== 'object' ||
    selector.kind !== expectedKind ||
    typeof selector.path !== 'string'
  ) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'prepare',
      `Filesystem selector must be a ${expectedKind} selector`,
    );
  }
  const path = selector.path;
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    Buffer.byteLength(path, 'utf8') > 16 * 1024 ||
    containsAsciiControlCodeUnit(path) ||
    path
      .split('/')
      .some(
        (component) =>
          component === '' || component === '.' || component === '..',
      )
  ) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'prepare',
      'Filesystem selector path is not a safe non-root relative path',
    );
  }
  return path;
}

function containsAsciiControlCodeUnit(value: string): boolean {
  for (const character of value) {
    const codeUnit = character.charCodeAt(0);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function requireContentDescriptor(
  digestValue: unknown,
  bytesValue: unknown,
  maximumBytes: number,
): void {
  requireDigest(digestValue, 'Filesystem content digest');
  requireBoundedInteger(
    bytesValue,
    0,
    maximumBytes,
    'Filesystem content byte count',
  );
}

function snapshotExactContent(
  value: unknown,
  expectedDigestValue: unknown,
  expectedBytesValue: unknown,
  maximumBytes: number,
): Uint8Array {
  const expectedDigest = requireDigest(
    expectedDigestValue,
    'Filesystem content digest',
  );
  const expectedBytes = requireBoundedInteger(
    expectedBytesValue,
    0,
    maximumBytes,
    'Filesystem content byte count',
  );
  if (!(value instanceof Uint8Array)) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'execute',
      'Filesystem content must be detached Uint8Array bytes',
    );
  }
  const snapshot = Uint8Array.from(value);
  if (
    snapshot.byteLength !== expectedBytes ||
    sha256Bytes(snapshot) !== expectedDigest
  ) {
    throw new NodeAdapterSecurityError(
      'state-commitment-mismatch',
      'execute',
      'Filesystem content bytes do not match the authorized digest and length',
    );
  }
  return snapshot;
}

function assertExactIdentifier(
  actualValue: unknown,
  expected: string,
  label: string,
): void {
  if (actualValue !== expected) {
    throw new NodeAdapterSecurityError(
      'state-commitment-mismatch',
      'execute',
      `${label} differs from the descriptor-relative object selected at prepare`,
    );
  }
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value)
  ) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'execute',
      `${label} is invalid`,
    );
  }
  return value;
}

function snapshotRoot(
  value: PinnedDirectoryDescriptor,
): PinnedDirectoryDescriptor {
  return Object.freeze({ ...value });
}

function snapshotHelper(
  value: PinnedExecutableDescriptor,
): PinnedExecutableDescriptor {
  return Object.freeze({ ...value });
}

function readOwnData<T>(owner: object, name: string): T {
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      `Filesystem option ${name} must be own enumerable data`,
    );
  }
  return descriptor.value as T;
}

function readOptionalOwnData(owner: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor) || !descriptor.enumerable) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      `Filesystem option ${name} must be own enumerable data`,
    );
  }
  return descriptor.value;
}

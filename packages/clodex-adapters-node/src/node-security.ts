import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

export const LINUX_CONFINED_ADAPTER_PROFILE = Object.freeze({
  kind: 'clodex.linux-confined-adapter-profile',
  version: 1,
  platform: 'linux',
  filesystemResolution:
    'descriptor-relative-openat2-beneath-no-symlinks-no-magiclinks-no-xdev',
  filesystemMutation:
    'fixed-create-and-rename-exchange-replace-with-file-and-directory-fsync',
  filesystemMkdirExecution:
    'disabled-without-pinned-private-same-filesystem-staging',
  filesystemNamespaceFreeze: false,
  filesystemReplaceAtomicInodeCas: false,
  filesystemReplaceRaceDisposition:
    'post-validate-and-close-uncertain; not a kernel compare-and-swap primitive',
  executableIdentity: 'open-hash-fstat-execute-same-fd-via-procfs',
  executableDependencyClosurePinned: false,
  workspaceIdentity: 'open-directory-fstat-and-hold-descriptor',
  containerImageSelection: 'digest-only-pull-never',
  containerNetwork: 'none',
  containerWorkspace: 'read-only-bind-of-held-directory-descriptor',
  containerRoot: 'read-only',
  containerPrivileges: 'all-capabilities-dropped-no-new-privileges',
  gitObservationAtomicWorkspaceSnapshot: false,
  testRunAtomicWorkspaceSnapshot: false,
  workspaceRaceDisposition:
    'pre/post tree commitment with uncertain closure; not a frozen snapshot',
  arbitraryHostFilesystemApi: false,
  arbitraryCommandApi: false,
  dockerDaemonEndpointIndependentlyPinned: false,
  appArmorEnforcementModeIndependentlyAttested: false,
  featureGateDefault: false,
  independentlyProtectedTrustHead: false,
} as const);

export type NodeAdapterStage =
  | 'configuration'
  | 'prepare'
  | 'execute'
  | 'compensation';

export type NodeAdapterErrorCode =
  | 'argument-invalid'
  | 'capability-scope-mismatch'
  | 'container-failure'
  | 'container-output-invalid'
  | 'effect-uncertain'
  | 'executable-invalid'
  | 'executable-integrity-mismatch'
  | 'helper-failure'
  | 'helper-output-invalid'
  | 'output-limit-exceeded'
  | 'platform-unsupported'
  | 'process-failure'
  | 'process-timeout'
  | 'root-identity-mismatch'
  | 'state-commitment-mismatch';

export class NodeAdapterSecurityError extends Error {
  public constructor(
    public readonly code: NodeAdapterErrorCode,
    public readonly stage: NodeAdapterStage,
    message: string,
    public readonly effectMayHaveOccurred = false,
    public readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = 'NodeAdapterSecurityError';
  }
}

export interface PinnedExecutableDescriptor {
  readonly path: string;
  readonly sha256: string;
  readonly device?: string;
  readonly inode?: string;
}

export interface PinnedDataFileDescriptor {
  readonly path: string;
  readonly sha256: string;
  readonly device?: string;
  readonly inode?: string;
}

export interface PinnedDirectoryDescriptor {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
}

export interface PinnedDirectoryLease {
  readonly handle: FileHandle;
  readonly path: string;
  readonly device: string;
  readonly inode: string;
}

export interface PinnedProcessInput {
  readonly executable: PinnedExecutableDescriptor;
  readonly args: readonly string[];
  readonly stdin?: Uint8Array;
  readonly environment?: Readonly<Record<string, string>>;
  readonly extraFileDescriptors?: readonly number[];
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly stage: NodeAdapterStage;
  readonly effectMayHaveOccurredOnFailure: boolean;
}

export interface PinnedProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DECIMAL_IDENTITY_PATTERN = /^(0|[1-9][0-9]{0,39})$/;
const MAX_ARGUMENT_BYTES = 32 * 1024;

export function requireLinux(): void {
  if (process.platform !== 'linux') {
    throw new NodeAdapterSecurityError(
      'platform-unsupported',
      'configuration',
      'OS-confined Clodex Node adapters require Linux openat2 and procfs',
    );
  }
}

export function requireDigest(
  value: unknown,
  label: string,
  stage: NodeAdapterStage = 'configuration',
  effectMayHaveOccurred = false,
): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      stage,
      `${label} must be a lowercase SHA-256 digest`,
      effectMayHaveOccurred,
    );
  }
  return value;
}

export function requireDecimalIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DECIMAL_IDENTITY_PATTERN.test(value)) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      `${label} must be a canonical unsigned decimal identity`,
    );
  }
  return value;
}

export function requireBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value as number;
}

export function requireSafeAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !isAbsolute(value) ||
    value.includes('\0') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      `${label} must be an absolute path without control bytes`,
    );
  }
  return resolve(value);
}

export function requireContainerMountSource(
  value: unknown,
  label: string,
): string {
  const path = requireSafeAbsolutePath(value, label);
  if (path.includes(',')) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      `${label} cannot contain a comma in Docker --mount syntax`,
    );
  }
  return path;
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function openPinnedDirectory(
  descriptorValue: PinnedDirectoryDescriptor,
): Promise<PinnedDirectoryLease> {
  requireLinux();
  const descriptor = snapshotDirectoryDescriptor(descriptorValue);
  let handle: FileHandle;
  try {
    handle = await open(
      descriptor.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new NodeAdapterSecurityError(
      'root-identity-mismatch',
      'prepare',
      'Pinned workspace root could not be opened without following links',
      false,
      error,
    );
  }
  try {
    const metadata = await handle.stat({ bigint: true });
    if (
      !metadata.isDirectory() ||
      metadata.dev.toString(10) !== descriptor.device ||
      metadata.ino.toString(10) !== descriptor.inode
    ) {
      throw new NodeAdapterSecurityError(
        'root-identity-mismatch',
        'prepare',
        'Workspace root device/inode does not match the provisioned object capability',
      );
    }
    return Object.freeze({
      handle,
      path: descriptor.path,
      device: descriptor.device,
      inode: descriptor.inode,
    });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function assertPinnedDirectoryLease(
  lease: PinnedDirectoryLease,
  stage: NodeAdapterStage,
): Promise<void> {
  try {
    const metadata = await lease.handle.stat({ bigint: true });
    if (
      !metadata.isDirectory() ||
      metadata.dev.toString(10) !== lease.device ||
      metadata.ino.toString(10) !== lease.inode
    ) {
      throw new NodeAdapterSecurityError(
        'root-identity-mismatch',
        stage,
        'Held workspace descriptor no longer names the provisioned root object',
        stage === 'execute',
      );
    }
  } catch (error) {
    if (error instanceof NodeAdapterSecurityError) throw error;
    throw new NodeAdapterSecurityError(
      'root-identity-mismatch',
      stage,
      'Held workspace descriptor could not be revalidated',
      stage === 'execute',
      error,
    );
  }
}

export async function openPinnedDataFile(
  descriptorValue: PinnedDataFileDescriptor,
  stage: NodeAdapterStage,
): Promise<FileHandle> {
  return await openVerifiedRegularFile(descriptorValue, stage, false);
}

export async function runPinnedExecutable(
  input: PinnedProcessInput,
): Promise<PinnedProcessResult> {
  requireLinux();
  const executable = snapshotPinnedFile(input.executable, 'executable');
  const timeoutMs = requireBoundedInteger(
    input.timeoutMs,
    1,
    24 * 60 * 60 * 1_000,
    'Process timeout',
  );
  const maxStdoutBytes = requireBoundedInteger(
    input.maxStdoutBytes,
    1,
    256 * 1024 * 1024,
    'Maximum stdout bytes',
  );
  const maxStderrBytes = requireBoundedInteger(
    input.maxStderrBytes,
    1,
    16 * 1024 * 1024,
    'Maximum stderr bytes',
  );
  const args = snapshotArguments(input.args);
  const environment = snapshotEnvironment(input.environment ?? {});
  const extraFileDescriptors = snapshotExtraFileDescriptors(
    input.extraFileDescriptors ?? [],
  );
  const executableHandle = await openVerifiedRegularFile(
    executable,
    input.stage,
    true,
  );

  try {
    const stdio: Array<'pipe' | number> = [
      'pipe',
      'pipe',
      'pipe',
      executableHandle.fd,
      ...extraFileDescriptors,
    ];
    const child = spawn('/proc/self/fd/3', args, {
      cwd: '/',
      detached: true,
      env: environment,
      shell: false,
      stdio,
      windowsHide: true,
    });
    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdin === null || stdout === null || stderr === null) {
      terminateProcessTree(child.pid);
      throw new NodeAdapterSecurityError(
        'process-failure',
        input.stage,
        'Pinned process did not expose the fixed pipe topology',
        input.effectMayHaveOccurredOnFailure,
      );
    }

    return await new Promise<PinnedProcessResult>((resolveResult, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failure: NodeAdapterSecurityError | null = null;
      let closed = false;

      const fail = (error: NodeAdapterSecurityError): void => {
        if (closed || failure !== null) return;
        failure = error;
        terminateProcessTree(child.pid);
      };

      const timer = setTimeout(() => {
        fail(
          new NodeAdapterSecurityError(
            'process-timeout',
            input.stage,
            'Pinned process exceeded its fixed execution deadline',
            input.effectMayHaveOccurredOnFailure,
          ),
        );
      }, timeoutMs);
      timer.unref();

      stdout.on('data', (chunkValue: Buffer | Uint8Array) => {
        const chunk = Buffer.from(chunkValue);
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > maxStdoutBytes) {
          fail(
            new NodeAdapterSecurityError(
              'output-limit-exceeded',
              input.stage,
              'Pinned process stdout exceeded its fixed byte limit',
              input.effectMayHaveOccurredOnFailure,
            ),
          );
          return;
        }
        stdoutChunks.push(chunk);
      });
      stderr.on('data', (chunkValue: Buffer | Uint8Array) => {
        const chunk = Buffer.from(chunkValue);
        stderrBytes += chunk.byteLength;
        if (stderrBytes > maxStderrBytes) {
          fail(
            new NodeAdapterSecurityError(
              'output-limit-exceeded',
              input.stage,
              'Pinned process stderr exceeded its fixed byte limit',
              input.effectMayHaveOccurredOnFailure,
            ),
          );
          return;
        }
        stderrChunks.push(chunk);
      });
      stdout.once('error', (error) => {
        fail(
          new NodeAdapterSecurityError(
            'process-failure',
            input.stage,
            'Pinned process stdout could not be captured completely',
            input.effectMayHaveOccurredOnFailure,
            error,
          ),
        );
      });
      stderr.once('error', (error) => {
        fail(
          new NodeAdapterSecurityError(
            'process-failure',
            input.stage,
            'Pinned process stderr could not be captured completely',
            input.effectMayHaveOccurredOnFailure,
            error,
          ),
        );
      });
      child.once('error', (error) => {
        fail(
          new NodeAdapterSecurityError(
            'process-failure',
            input.stage,
            'Pinned executable could not be dispatched',
            input.effectMayHaveOccurredOnFailure,
            error,
          ),
        );
      });
      child.once('close', (exitCode, signal) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        if (failure !== null) {
          reject(failure);
          return;
        }
        resolveResult(
          Object.freeze({
            exitCode,
            signal,
            stdout: Uint8Array.from(Buffer.concat(stdoutChunks)),
            stderr: Uint8Array.from(Buffer.concat(stderrChunks)),
          }),
        );
      });

      stdin.once('error', (error) => {
        fail(
          new NodeAdapterSecurityError(
            'process-failure',
            input.stage,
            'Pinned process rejected its exact input bytes',
            input.effectMayHaveOccurredOnFailure,
            error,
          ),
        );
      });
      stdin.end(
        input.stdin === undefined ? undefined : Buffer.from(input.stdin),
      );
    });
  } finally {
    await executableHandle.close().catch(() => undefined);
  }
}

export function decodeBoundedUtf8(
  value: Uint8Array,
  label: string,
  stage: NodeAdapterStage = 'execute',
  effectMayHaveOccurred = stage === 'execute',
): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch (error) {
    throw new NodeAdapterSecurityError(
      'helper-output-invalid',
      stage,
      `${label} is not canonical UTF-8`,
      effectMayHaveOccurred,
      error,
    );
  }
}

function snapshotDirectoryDescriptor(
  value: PinnedDirectoryDescriptor,
): PinnedDirectoryDescriptor {
  return Object.freeze({
    path: requireSafeAbsolutePath(readOwnData(value, 'path'), 'Root path'),
    device: requireDecimalIdentity(readOwnData(value, 'device'), 'Root device'),
    inode: requireDecimalIdentity(readOwnData(value, 'inode'), 'Root inode'),
  });
}

function snapshotPinnedFile(
  value: PinnedExecutableDescriptor | PinnedDataFileDescriptor,
  label: string,
): PinnedExecutableDescriptor {
  const deviceValue = readOptionalOwnData(value, 'device');
  const inodeValue = readOptionalOwnData(value, 'inode');
  if ((deviceValue === undefined) !== (inodeValue === undefined)) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      `${label} device and inode must be supplied together`,
    );
  }
  return Object.freeze({
    path: requireSafeAbsolutePath(readOwnData(value, 'path'), `${label} path`),
    sha256: requireDigest(readOwnData(value, 'sha256'), `${label} digest`),
    ...(deviceValue === undefined
      ? {}
      : {
          device: requireDecimalIdentity(deviceValue, `${label} device`),
          inode: requireDecimalIdentity(inodeValue, `${label} inode`),
        }),
  });
}

async function openVerifiedRegularFile(
  descriptorValue: PinnedExecutableDescriptor | PinnedDataFileDescriptor,
  stage: NodeAdapterStage,
  executable: boolean,
): Promise<FileHandle> {
  const descriptor = snapshotPinnedFile(
    descriptorValue,
    executable ? 'executable' : 'data file',
  );
  let handle: FileHandle;
  try {
    handle = await open(
      descriptor.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new NodeAdapterSecurityError(
      'executable-invalid',
      stage,
      'Pinned regular file could not be opened without following links',
      false,
      error,
    );
  }
  try {
    const before = await handle.stat({ bigint: true });
    const permissionBits = Number(before.mode & 0o777n);
    const currentUid =
      typeof process.getuid === 'function' ? BigInt(process.getuid()) : null;
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      Number(before.mode & 0o6000n) !== 0 ||
      (permissionBits & 0o022) !== 0 ||
      (currentUid !== null &&
        before.uid === currentUid &&
        (permissionBits & 0o200) !== 0) ||
      (executable && (permissionBits & 0o111) === 0)
    ) {
      throw new NodeAdapterSecurityError(
        'executable-invalid',
        stage,
        'Pinned file must be a single-link regular file without set-id bits and not writable by the executing principal or by group/other',
      );
    }
    if (
      descriptor.device !== undefined &&
      (before.dev.toString(10) !== descriptor.device ||
        before.ino.toString(10) !== descriptor.inode)
    ) {
      throw new NodeAdapterSecurityError(
        'executable-integrity-mismatch',
        stage,
        'Pinned file device/inode differs from the trusted descriptor',
      );
    }
    const digest = await hashFileHandle(handle);
    const after = await handle.stat({ bigint: true });
    if (!sameStableFile(before, after) || digest !== descriptor.sha256) {
      throw new NodeAdapterSecurityError(
        'executable-integrity-mismatch',
        stage,
        'Pinned file bytes or identity changed during verification',
      );
    }
    if (executable) {
      const signature = Buffer.alloc(4);
      const readResult = await handle.read(signature, 0, 4, 0);
      if (
        readResult.bytesRead !== 4 ||
        signature[0] !== 0x7f ||
        signature[1] !== 0x45 ||
        signature[2] !== 0x4c ||
        signature[3] !== 0x46
      ) {
        throw new NodeAdapterSecurityError(
          'executable-invalid',
          stage,
          'Pinned executable must be an ELF binary, not a script interpreter trampoline',
        );
      }
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function hashFileHandle(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  for (;;) {
    const result = await handle.read(buffer, 0, buffer.byteLength, offset);
    if (result.bytesRead === 0) break;
    hash.update(buffer.subarray(0, result.bytesRead));
    offset += result.bytesRead;
  }
  return hash.digest('hex');
}

function sameStableFile(
  left: Awaited<ReturnType<FileHandle['stat']>>,
  right: Awaited<ReturnType<FileHandle['stat']>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function snapshotArguments(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 256) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      'Pinned process arguments must be a bounded dense array',
    );
  }
  const result: string[] = [];
  for (let index = 0; index < values.length; ++index) {
    if (!(index in values)) {
      throw new NodeAdapterSecurityError(
        'argument-invalid',
        'configuration',
        'Pinned process arguments cannot be sparse',
      );
    }
    const value = values[index];
    if (
      typeof value !== 'string' ||
      value.includes('\0') ||
      Buffer.byteLength(value, 'utf8') > MAX_ARGUMENT_BYTES
    ) {
      throw new NodeAdapterSecurityError(
        'argument-invalid',
        'configuration',
        `Pinned process argument ${index} is invalid`,
      );
    }
    result.push(value);
  }
  return Object.freeze(result);
}

function snapshotEnvironment(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null);
  for (const name of Object.keys(value).sort()) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
      throw new NodeAdapterSecurityError(
        'argument-invalid',
        'configuration',
        `Pinned process environment name ${name} is invalid`,
      );
    }
    const environmentValue = value[name];
    if (
      typeof environmentValue !== 'string' ||
      environmentValue.includes('\0') ||
      Buffer.byteLength(environmentValue, 'utf8') > MAX_ARGUMENT_BYTES
    ) {
      throw new NodeAdapterSecurityError(
        'argument-invalid',
        'configuration',
        `Pinned process environment value ${name} is invalid`,
      );
    }
    result[name] = environmentValue;
  }
  return Object.freeze(result);
}

function snapshotExtraFileDescriptors(values: readonly number[]): number[] {
  if (!Array.isArray(values) || values.length > 16) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      'Extra descriptor list is invalid',
    );
  }
  const result: number[] = [];
  for (let index = 0; index < values.length; ++index) {
    if (!(index in values)) {
      throw new NodeAdapterSecurityError(
        'argument-invalid',
        'configuration',
        'Extra descriptor list cannot be sparse',
      );
    }
    const value = values[index];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new NodeAdapterSecurityError(
        'argument-invalid',
        'configuration',
        'Extra descriptor must be a non-negative integer',
      );
    }
    result.push(value);
  }
  return result;
}

function terminateProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process already exited. The close event remains the completion fence.
    }
  }
}

function readOwnData(owner: object, name: string): unknown {
  if (owner === null || typeof owner !== 'object') {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      'Security descriptor must be a data-only object',
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      `Security descriptor field ${name} must be own enumerable data`,
    );
  }
  return descriptor.value;
}

function readOptionalOwnData(owner: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor) || !descriptor.enumerable) {
    throw new NodeAdapterSecurityError(
      'argument-invalid',
      'configuration',
      `Security descriptor field ${name} must be own enumerable data`,
    );
  }
  return descriptor.value;
}

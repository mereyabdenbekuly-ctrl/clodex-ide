import type {
  HashPort,
  SafeCodingAction,
  SafeCodingExecutionTicket,
} from '@clodex/contracts';
import type {
  PreparedSafeCodingAction,
  TrustedSafeCodingAdapterBinding,
} from '@clodex/guardian';
import type {
  PreparedRuntimeEffect,
  SafeCodingRuntimeAdapterPrepareInput,
  SafeCodingRuntimeAdapterResult,
} from '@clodex/runtime';

import {
  ReferenceAdapterError,
  assertEqual,
  assertPreparedMatchesTicket,
  createAdapterResult,
  createOneShotPreparedEffect,
  preparedActionFrom,
  requireActionKind,
  requireClosedRecord,
  requireDigest,
  requireIdentifier,
  requireLiteral,
  requireNonNegativeInteger,
  requireExactTicket,
  readOwnDataField,
  snapshotBinding,
  snapshotCapabilityScope,
  snapshotHashPort,
  snapshotMethod,
  type ActionOfKind,
  type CapabilityScope,
  type CapabilityConfinedSafeCodingAdapter,
  type CapabilityScopedPortInput,
} from './common.js';

export interface FilesystemContentDescriptor {
  readonly contentSha256: string;
  readonly contentBytes: number;
}

export interface FilesystemContentResolveInput
  extends FilesystemContentDescriptor,
    CapabilityScopedPortInput {}

/** Digest-addressed content capability; it exposes no generic path or file API. */
export interface FilesystemContentResolverPort {
  resolveExact(
    descriptor: FilesystemContentResolveInput,
  ): unknown | Promise<unknown>;
}

export interface FilesystemCreateInspectInput
  extends FilesystemContentDescriptor,
    CapabilityScopedPortInput {
  readonly requestId: string;
  readonly selector: {
    readonly kind: 'file';
    readonly path: string;
  };
}

export interface FilesystemCreateExecuteInput
  extends FilesystemCreateInspectInput {
  readonly ticketId: string;
  readonly resolvedObjectId: string;
  readonly expectedStateCommitmentHash: string;
  /** Detached exact bytes. The port MUST perform an atomic expected-state CAS. */
  readonly content: Uint8Array;
}

export interface FilesystemCreateCapabilityPort {
  inspectCreate(
    input: FilesystemCreateInspectInput,
  ): unknown | Promise<unknown>;
  executeCreate(
    input: FilesystemCreateExecuteInput,
  ): unknown | Promise<unknown>;
}

export interface FilesystemReplaceInspectInput
  extends FilesystemContentDescriptor,
    CapabilityScopedPortInput {
  readonly requestId: string;
  readonly selector: {
    readonly kind: 'file';
    readonly path: string;
  };
  readonly beforeSha256: string;
}

export interface FilesystemReplaceExecuteInput
  extends FilesystemReplaceInspectInput {
  readonly ticketId: string;
  readonly resolvedObjectId: string;
  readonly expectedStateCommitmentHash: string;
  /** Detached exact bytes. The port MUST perform an atomic expected-state CAS. */
  readonly content: Uint8Array;
}

export interface FilesystemReplaceCapabilityPort {
  inspectReplace(
    input: FilesystemReplaceInspectInput,
  ): unknown | Promise<unknown>;
  executeReplace(
    input: FilesystemReplaceExecuteInput,
  ): unknown | Promise<unknown>;
}

export interface FilesystemMkdirInspectInput extends CapabilityScopedPortInput {
  readonly requestId: string;
  readonly selector: {
    readonly kind: 'tree';
    readonly path: string;
  };
}

export interface FilesystemMkdirExecuteInput
  extends FilesystemMkdirInspectInput {
  readonly ticketId: string;
  readonly resolvedObjectId: string;
  /** The port MUST create only if this exact expected state still holds. */
  readonly expectedStateCommitmentHash: string;
}

export interface FilesystemMkdirCapabilityPort {
  inspectMkdir(input: FilesystemMkdirInspectInput): unknown | Promise<unknown>;
  executeMkdir(input: FilesystemMkdirExecuteInput): unknown | Promise<unknown>;
}

export interface ReferenceFilesystemCreateAdapterOptions {
  readonly capabilityScope: CapabilityScope;
  readonly binding: TrustedSafeCodingAdapterBinding & {
    readonly action: 'filesystem.create';
  };
  readonly hash: HashPort;
  readonly contents: FilesystemContentResolverPort;
  readonly capability: FilesystemCreateCapabilityPort;
}

export interface ReferenceFilesystemReplaceAdapterOptions {
  readonly capabilityScope: CapabilityScope;
  readonly binding: TrustedSafeCodingAdapterBinding & {
    readonly action: 'filesystem.replace';
  };
  readonly hash: HashPort;
  readonly contents: FilesystemContentResolverPort;
  readonly capability: FilesystemReplaceCapabilityPort;
}

export interface ReferenceFilesystemMkdirAdapterOptions {
  readonly capabilityScope: CapabilityScope;
  readonly binding: TrustedSafeCodingAdapterBinding & {
    readonly action: 'filesystem.mkdir';
  };
  readonly hash: HashPort;
  readonly capability: FilesystemMkdirCapabilityPort;
}

interface PreparedInspection {
  readonly resolvedObjectId: string;
  readonly stateCommitmentHash: string;
}

export class ReferenceFilesystemCreateAdapter
  implements CapabilityConfinedSafeCodingAdapter
{
  public readonly capabilityScope: CapabilityScope;
  public readonly binding: TrustedSafeCodingAdapterBinding & {
    readonly action: 'filesystem.create';
  };

  readonly #hash: HashPort;
  readonly #resolveContent: FilesystemContentResolverPort['resolveExact'];
  readonly #inspect: FilesystemCreateCapabilityPort['inspectCreate'];
  readonly #execute: FilesystemCreateCapabilityPort['executeCreate'];

  public constructor(options: ReferenceFilesystemCreateAdapterOptions) {
    const binding = readOwnDataField<
      ReferenceFilesystemCreateAdapterOptions['binding']
    >(options, 'binding', 'Filesystem adapter binding');
    const hash = readOwnDataField<HashPort>(
      options,
      'hash',
      'Filesystem hash port',
    );
    const contents = readOwnDataField<FilesystemContentResolverPort>(
      options,
      'contents',
      'Filesystem content resolver',
    );
    const capability = readOwnDataField<FilesystemCreateCapabilityPort>(
      options,
      'capability',
      'Filesystem create capability',
    );
    this.capabilityScope = snapshotCapabilityScope(
      readOwnDataField(options, 'capabilityScope', 'Filesystem adapter scope'),
    );
    this.binding = snapshotBinding(
      binding,
      'filesystem.create',
      'local.reversible',
    );
    this.#hash = snapshotHashPort(hash);
    this.#resolveContent = snapshotMethod(
      contents,
      'resolveExact',
      'Filesystem content resolver',
    );
    this.#inspect = snapshotMethod(
      capability,
      'inspectCreate',
      'filesystem.create inspect',
    );
    this.#execute = snapshotMethod(
      capability,
      'executeCreate',
      'filesystem.create execute',
    );
    Object.freeze(this);
  }

  public async prepareAuthorization(
    actionValue: SafeCodingAction,
  ): Promise<PreparedSafeCodingAction> {
    const action = requireActionKind(actionValue, 'filesystem.create');
    const content = await resolveExactContent(
      action,
      this.capabilityScope,
      this.#resolveContent,
      this.#hash,
    );
    // Authorization PREPARE proves the reviewed digest is currently resolvable;
    // exact bytes are deliberately discarded and re-resolved at runtime PREPARE.
    void content;
    const inspection = await this.inspect(action);
    return preparedActionFrom(
      inspection.resolvedObjectId,
      inspection.stateCommitmentHash,
    );
  }

  public async prepare(
    input: SafeCodingRuntimeAdapterPrepareInput,
  ): Promise<PreparedRuntimeEffect> {
    const action = requireActionKind(input.action, 'filesystem.create');
    const ticket = await requireExactTicket(
      input.ticket,
      action,
      this.binding,
      this.capabilityScope,
      this.#hash,
    );
    const content = await resolveExactContent(
      action,
      this.capabilityScope,
      this.#resolveContent,
      this.#hash,
    );
    const inspection = await this.inspect(action);
    assertPreparedMatchesTicket(inspection, ticket);

    return createOneShotPreparedEffect(
      async (): Promise<SafeCodingRuntimeAdapterResult> => {
        const value = await this.#execute(
          Object.freeze({
            ...createInput(action, this.capabilityScope),
            ticketId: ticket.ticketId,
            resolvedObjectId: inspection.resolvedObjectId,
            expectedStateCommitmentHash: inspection.stateCommitmentHash,
            content: Uint8Array.prototype.slice.call(content) as Uint8Array,
          }),
        );
        return validateCreateExecution(value, action, ticket, inspection);
      },
    );
  }

  private async inspect(
    action: ActionOfKind<'filesystem.create'>,
  ): Promise<PreparedInspection> {
    const value = await this.#inspect(
      Object.freeze(createInput(action, this.capabilityScope)),
    );
    const record = requireClosedRecord(
      value,
      ['operation', 'resolvedObjectId', 'stateCommitmentHash', 'targetState'],
      'filesystem.create inspection',
      'prepare',
    );
    requireLiteral(
      record.operation,
      'filesystem.create',
      'Inspection operation',
      'prepare',
    );
    requireLiteral(
      record.targetState,
      'absent',
      'Create target state',
      'prepare',
    );
    return preparedActionFrom(
      requireIdentifier(
        record.resolvedObjectId,
        'Resolved object ID',
        'prepare',
      ),
      requireDigest(
        record.stateCommitmentHash,
        'State commitment hash',
        'prepare',
      ),
    );
  }
}

export class ReferenceFilesystemReplaceAdapter
  implements CapabilityConfinedSafeCodingAdapter
{
  public readonly capabilityScope: CapabilityScope;
  public readonly binding: TrustedSafeCodingAdapterBinding & {
    readonly action: 'filesystem.replace';
  };

  readonly #hash: HashPort;
  readonly #resolveContent: FilesystemContentResolverPort['resolveExact'];
  readonly #inspect: FilesystemReplaceCapabilityPort['inspectReplace'];
  readonly #execute: FilesystemReplaceCapabilityPort['executeReplace'];

  public constructor(options: ReferenceFilesystemReplaceAdapterOptions) {
    const binding = readOwnDataField<
      ReferenceFilesystemReplaceAdapterOptions['binding']
    >(options, 'binding', 'Filesystem adapter binding');
    const hash = readOwnDataField<HashPort>(
      options,
      'hash',
      'Filesystem hash port',
    );
    const contents = readOwnDataField<FilesystemContentResolverPort>(
      options,
      'contents',
      'Filesystem content resolver',
    );
    const capability = readOwnDataField<FilesystemReplaceCapabilityPort>(
      options,
      'capability',
      'Filesystem replace capability',
    );
    this.capabilityScope = snapshotCapabilityScope(
      readOwnDataField(options, 'capabilityScope', 'Filesystem adapter scope'),
    );
    this.binding = snapshotBinding(
      binding,
      'filesystem.replace',
      'local.reversible',
    );
    this.#hash = snapshotHashPort(hash);
    this.#resolveContent = snapshotMethod(
      contents,
      'resolveExact',
      'Filesystem content resolver',
    );
    this.#inspect = snapshotMethod(
      capability,
      'inspectReplace',
      'filesystem.replace inspect',
    );
    this.#execute = snapshotMethod(
      capability,
      'executeReplace',
      'filesystem.replace execute',
    );
    Object.freeze(this);
  }

  public async prepareAuthorization(
    actionValue: SafeCodingAction,
  ): Promise<PreparedSafeCodingAction> {
    const action = requireActionKind(actionValue, 'filesystem.replace');
    const content = await resolveExactContent(
      action,
      this.capabilityScope,
      this.#resolveContent,
      this.#hash,
    );
    void content;
    const inspection = await this.inspect(action);
    return preparedActionFrom(
      inspection.resolvedObjectId,
      inspection.stateCommitmentHash,
    );
  }

  public async prepare(
    input: SafeCodingRuntimeAdapterPrepareInput,
  ): Promise<PreparedRuntimeEffect> {
    const action = requireActionKind(input.action, 'filesystem.replace');
    const ticket = await requireExactTicket(
      input.ticket,
      action,
      this.binding,
      this.capabilityScope,
      this.#hash,
    );
    const content = await resolveExactContent(
      action,
      this.capabilityScope,
      this.#resolveContent,
      this.#hash,
    );
    const inspection = await this.inspect(action);
    assertPreparedMatchesTicket(inspection, ticket);

    return createOneShotPreparedEffect(
      async (): Promise<SafeCodingRuntimeAdapterResult> => {
        const value = await this.#execute(
          Object.freeze({
            ...replaceInput(action, this.capabilityScope),
            ticketId: ticket.ticketId,
            resolvedObjectId: inspection.resolvedObjectId,
            expectedStateCommitmentHash: inspection.stateCommitmentHash,
            content: Uint8Array.prototype.slice.call(content) as Uint8Array,
          }),
        );
        return validateReplaceExecution(value, action, ticket, inspection);
      },
    );
  }

  private async inspect(
    action: ActionOfKind<'filesystem.replace'>,
  ): Promise<PreparedInspection> {
    const value = await this.#inspect(
      Object.freeze(replaceInput(action, this.capabilityScope)),
    );
    const record = requireClosedRecord(
      value,
      [
        'currentContentSha256',
        'operation',
        'resolvedObjectId',
        'stateCommitmentHash',
        'targetState',
      ],
      'filesystem.replace inspection',
      'prepare',
    );
    requireLiteral(
      record.operation,
      'filesystem.replace',
      'Inspection operation',
      'prepare',
    );
    requireLiteral(
      record.targetState,
      'file',
      'Replace target state',
      'prepare',
    );
    assertEqual(
      requireDigest(
        record.currentContentSha256,
        'Current content digest',
        'prepare',
      ),
      action.beforeSha256,
      'Current content digest',
      'prepare',
    );
    return preparedActionFrom(
      requireIdentifier(
        record.resolvedObjectId,
        'Resolved object ID',
        'prepare',
      ),
      requireDigest(
        record.stateCommitmentHash,
        'State commitment hash',
        'prepare',
      ),
    );
  }
}

export class ReferenceFilesystemMkdirAdapter
  implements CapabilityConfinedSafeCodingAdapter
{
  public readonly capabilityScope: CapabilityScope;
  public readonly binding: TrustedSafeCodingAdapterBinding & {
    readonly action: 'filesystem.mkdir';
  };

  readonly #hash: HashPort;
  readonly #inspect: FilesystemMkdirCapabilityPort['inspectMkdir'];
  readonly #execute: FilesystemMkdirCapabilityPort['executeMkdir'];

  public constructor(options: ReferenceFilesystemMkdirAdapterOptions) {
    const binding = readOwnDataField<
      ReferenceFilesystemMkdirAdapterOptions['binding']
    >(options, 'binding', 'Filesystem adapter binding');
    const hash = readOwnDataField<HashPort>(
      options,
      'hash',
      'Filesystem hash port',
    );
    const capability = readOwnDataField<FilesystemMkdirCapabilityPort>(
      options,
      'capability',
      'Filesystem mkdir capability',
    );
    this.capabilityScope = snapshotCapabilityScope(
      readOwnDataField(options, 'capabilityScope', 'Filesystem adapter scope'),
    );
    this.binding = snapshotBinding(
      binding,
      'filesystem.mkdir',
      'local.reversible',
    );
    this.#hash = snapshotHashPort(hash);
    this.#inspect = snapshotMethod(
      capability,
      'inspectMkdir',
      'filesystem.mkdir inspect',
    );
    this.#execute = snapshotMethod(
      capability,
      'executeMkdir',
      'filesystem.mkdir execute',
    );
    Object.freeze(this);
  }

  public async prepareAuthorization(
    actionValue: SafeCodingAction,
  ): Promise<PreparedSafeCodingAction> {
    const action = requireActionKind(actionValue, 'filesystem.mkdir');
    const inspection = await this.inspect(action);
    return preparedActionFrom(
      inspection.resolvedObjectId,
      inspection.stateCommitmentHash,
    );
  }

  public async prepare(
    input: SafeCodingRuntimeAdapterPrepareInput,
  ): Promise<PreparedRuntimeEffect> {
    const action = requireActionKind(input.action, 'filesystem.mkdir');
    const ticket = await requireExactTicket(
      input.ticket,
      action,
      this.binding,
      this.capabilityScope,
      this.#hash,
    );
    const inspection = await this.inspect(action);
    assertPreparedMatchesTicket(inspection, ticket);

    return createOneShotPreparedEffect(
      async (): Promise<SafeCodingRuntimeAdapterResult> => {
        const value = await this.#execute(
          Object.freeze({
            ...mkdirInput(action, this.capabilityScope),
            ticketId: ticket.ticketId,
            resolvedObjectId: inspection.resolvedObjectId,
            expectedStateCommitmentHash: inspection.stateCommitmentHash,
          }),
        );
        return validateMkdirExecution(value, ticket, inspection);
      },
    );
  }

  private async inspect(
    action: ActionOfKind<'filesystem.mkdir'>,
  ): Promise<PreparedInspection> {
    const value = await this.#inspect(
      Object.freeze(mkdirInput(action, this.capabilityScope)),
    );
    const record = requireClosedRecord(
      value,
      ['operation', 'resolvedObjectId', 'stateCommitmentHash', 'targetState'],
      'filesystem.mkdir inspection',
      'prepare',
    );
    requireLiteral(
      record.operation,
      'filesystem.mkdir',
      'Inspection operation',
      'prepare',
    );
    requireLiteral(
      record.targetState,
      'absent',
      'Mkdir target state',
      'prepare',
    );
    return preparedActionFrom(
      requireIdentifier(
        record.resolvedObjectId,
        'Resolved object ID',
        'prepare',
      ),
      requireDigest(
        record.stateCommitmentHash,
        'State commitment hash',
        'prepare',
      ),
    );
  }
}

function createInput(
  action: ActionOfKind<'filesystem.create'>,
  capabilityScope: CapabilityScope,
): FilesystemCreateInspectInput {
  return {
    capabilityScope,
    requestId: action.requestId,
    selector: Object.freeze({ ...action.selector }),
    contentSha256: action.contentSha256,
    contentBytes: action.contentBytes,
  };
}

function replaceInput(
  action: ActionOfKind<'filesystem.replace'>,
  capabilityScope: CapabilityScope,
): FilesystemReplaceInspectInput {
  return {
    capabilityScope,
    requestId: action.requestId,
    selector: Object.freeze({ ...action.selector }),
    beforeSha256: action.beforeSha256,
    contentSha256: action.contentSha256,
    contentBytes: action.contentBytes,
  };
}

function mkdirInput(
  action: ActionOfKind<'filesystem.mkdir'>,
  capabilityScope: CapabilityScope,
): FilesystemMkdirInspectInput {
  return {
    capabilityScope,
    requestId: action.requestId,
    selector: Object.freeze({ ...action.selector }),
  };
}

async function resolveExactContent(
  action:
    | ActionOfKind<'filesystem.create'>
    | ActionOfKind<'filesystem.replace'>,
  capabilityScope: CapabilityScope,
  resolve: FilesystemContentResolverPort['resolveExact'],
  hash: HashPort,
): Promise<Uint8Array> {
  let value: unknown;
  try {
    value = await resolve(
      Object.freeze({
        capabilityScope,
        contentSha256: action.contentSha256,
        contentBytes: action.contentBytes,
      }),
    );
  } catch (error) {
    throw new ReferenceAdapterError(
      'content-unavailable',
      'prepare',
      'Digest-addressed content could not be resolved',
      error,
    );
  }
  if (!(value instanceof Uint8Array)) {
    throw new ReferenceAdapterError(
      'content-integrity-mismatch',
      'prepare',
      'Content resolver must return Uint8Array bytes',
    );
  }
  const snapshot = Uint8Array.prototype.slice.call(value) as Uint8Array;
  if (snapshot.byteLength !== action.contentBytes) {
    throw new ReferenceAdapterError(
      'content-integrity-mismatch',
      'prepare',
      'Resolved content byte length does not match the action',
    );
  }
  let digest: string;
  try {
    digest = await hash.sha256(
      Uint8Array.prototype.slice.call(snapshot) as Uint8Array,
    );
  } catch (error) {
    throw new ReferenceAdapterError(
      'content-integrity-mismatch',
      'prepare',
      'Resolved content digest could not be verified',
      error,
    );
  }
  if (digest !== action.contentSha256) {
    throw new ReferenceAdapterError(
      'content-integrity-mismatch',
      'prepare',
      'Resolved content digest does not match the action',
    );
  }
  return snapshot;
}

function validateCreateExecution(
  value: unknown,
  action: ActionOfKind<'filesystem.create'>,
  ticket: SafeCodingExecutionTicket,
  inspection: PreparedInspection,
): SafeCodingRuntimeAdapterResult {
  const record = requireClosedRecord(
    value,
    [
      'contentBytes',
      'contentSha256',
      'operation',
      'postStateHash',
      'preStateHash',
      'resolvedObjectId',
      'ticketId',
    ],
    'filesystem.create execution result',
    'execute',
  );
  requireLiteral(record.operation, 'filesystem.create', 'Operation', 'execute');
  assertExecutionIdentity(record, ticket, inspection);
  assertEqual(
    requireDigest(record.contentSha256, 'Content digest', 'execute'),
    action.contentSha256,
    'Content digest',
    'execute',
  );
  assertEqual(
    requireNonNegativeInteger(record.contentBytes, 'Content bytes', 'execute'),
    action.contentBytes,
    'Content bytes',
    'execute',
  );
  const postStateHash = requireDigest(
    record.postStateHash,
    'Post-state hash',
    'execute',
  );
  return createAdapterResult(
    Object.freeze({
      operation: 'filesystem.create',
      ticketId: ticket.ticketId,
      resolvedObjectId: inspection.resolvedObjectId,
      contentSha256: action.contentSha256,
      contentBytes: action.contentBytes,
    }),
    inspection.stateCommitmentHash,
    postStateHash,
  );
}

function validateReplaceExecution(
  value: unknown,
  action: ActionOfKind<'filesystem.replace'>,
  ticket: SafeCodingExecutionTicket,
  inspection: PreparedInspection,
): SafeCodingRuntimeAdapterResult {
  const record = requireClosedRecord(
    value,
    [
      'beforeSha256',
      'contentBytes',
      'contentSha256',
      'operation',
      'postStateHash',
      'preStateHash',
      'resolvedObjectId',
      'ticketId',
    ],
    'filesystem.replace execution result',
    'execute',
  );
  requireLiteral(
    record.operation,
    'filesystem.replace',
    'Operation',
    'execute',
  );
  assertExecutionIdentity(record, ticket, inspection);
  assertEqual(
    requireDigest(record.beforeSha256, 'Before content digest', 'execute'),
    action.beforeSha256,
    'Before content digest',
    'execute',
  );
  assertEqual(
    requireDigest(record.contentSha256, 'Content digest', 'execute'),
    action.contentSha256,
    'Content digest',
    'execute',
  );
  assertEqual(
    requireNonNegativeInteger(record.contentBytes, 'Content bytes', 'execute'),
    action.contentBytes,
    'Content bytes',
    'execute',
  );
  const postStateHash = requireDigest(
    record.postStateHash,
    'Post-state hash',
    'execute',
  );
  return createAdapterResult(
    Object.freeze({
      operation: 'filesystem.replace',
      ticketId: ticket.ticketId,
      resolvedObjectId: inspection.resolvedObjectId,
      beforeSha256: action.beforeSha256,
      contentSha256: action.contentSha256,
      contentBytes: action.contentBytes,
    }),
    inspection.stateCommitmentHash,
    postStateHash,
  );
}

function validateMkdirExecution(
  value: unknown,
  ticket: SafeCodingExecutionTicket,
  inspection: PreparedInspection,
): SafeCodingRuntimeAdapterResult {
  const record = requireClosedRecord(
    value,
    [
      'operation',
      'postStateHash',
      'preStateHash',
      'resolvedObjectId',
      'ticketId',
    ],
    'filesystem.mkdir execution result',
    'execute',
  );
  requireLiteral(record.operation, 'filesystem.mkdir', 'Operation', 'execute');
  assertExecutionIdentity(record, ticket, inspection);
  const postStateHash = requireDigest(
    record.postStateHash,
    'Post-state hash',
    'execute',
  );
  return createAdapterResult(
    Object.freeze({
      operation: 'filesystem.mkdir',
      ticketId: ticket.ticketId,
      resolvedObjectId: inspection.resolvedObjectId,
    }),
    inspection.stateCommitmentHash,
    postStateHash,
  );
}

function assertExecutionIdentity(
  record: Record<string, unknown>,
  ticket: SafeCodingExecutionTicket,
  inspection: PreparedInspection,
): void {
  assertEqual(
    requireIdentifier(record.ticketId, 'Ticket ID', 'execute'),
    ticket.ticketId,
    'Ticket ID',
    'execute',
  );
  assertEqual(
    requireIdentifier(record.resolvedObjectId, 'Resolved object ID', 'execute'),
    inspection.resolvedObjectId,
    'Resolved object ID',
    'execute',
  );
  assertEqual(
    requireDigest(record.preStateHash, 'Pre-state hash', 'execute'),
    inspection.stateCommitmentHash,
    'Pre-state hash',
    'execute',
  );
}

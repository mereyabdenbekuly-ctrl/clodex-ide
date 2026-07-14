import type { CanonicalJsonValue, HashPort } from '@clodex/contracts';

import {
  ReferenceAdapterError,
  hashCanonicalCommitment,
  snapshotHashPort,
} from '../common.js';
import type {
  FilesystemContentResolveInput,
  FilesystemContentResolverPort,
  FilesystemCreateCapabilityPort,
  FilesystemCreateExecuteInput,
  FilesystemCreateInspectInput,
  FilesystemMkdirCapabilityPort,
  FilesystemMkdirExecuteInput,
  FilesystemMkdirInspectInput,
  FilesystemReplaceCapabilityPort,
  FilesystemReplaceExecuteInput,
  FilesystemReplaceInspectInput,
} from '../filesystem-adapters.js';
import type {
  GitDiffCapabilityPort,
  GitDiffExecuteInput,
  GitDiffInspectInput,
  GitStatusCapabilityPort,
  GitStatusExecuteInput,
  GitStatusInspectInput,
} from '../git-adapters.js';
import {
  validateRegisteredTestSandboxProfile,
  type RegisteredTestSandboxProfile,
  type TestRunCapabilityPort,
  type TestRunExecuteInput,
  type TestRunInspectInput,
  type TestSandboxProfileRegistryPort,
  type TestSandboxProfileResolveInput,
} from '../test-adapter.js';
import type { CapabilityScope } from '../common.js';

export const IN_MEMORY_ADAPTER_PORT_PROFILE = Object.freeze({
  durability: 'memory-only',
  crashSafety: 'none',
  osIsolation: 'none',
  hostFilesystem: false,
  gitProcess: false,
  sandbox: false,
  productionSuitable: false,
} as const);

export class InMemoryContentResolver implements FilesystemContentResolverPort {
  readonly #content = new Map<string, Uint8Array>();

  public constructor(
    entries: readonly {
      readonly contentSha256: string;
      readonly content: Uint8Array;
    }[] = [],
  ) {
    for (const entry of entries) {
      this.set(entry.contentSha256, entry.content);
    }
  }

  public set(contentSha256: string, content: Uint8Array): void {
    this.#content.set(contentSha256, content.slice());
  }

  public delete(contentSha256: string): void {
    this.#content.delete(contentSha256);
  }

  public resolveExact(descriptor: FilesystemContentResolveInput): Uint8Array {
    const content = this.#content.get(descriptor.contentSha256);
    if (!content) throw new Error('Memory content is not registered');
    return content.slice();
  }
}

type MemoryFilesystemEntry =
  | {
      readonly kind: 'file';
      readonly contentSha256: string;
      readonly contentBytes: number;
    }
  | { readonly kind: 'tree' };

export class InMemoryFilesystemCapabilityPort
  implements
    FilesystemCreateCapabilityPort,
    FilesystemReplaceCapabilityPort,
    FilesystemMkdirCapabilityPort
{
  public inspectCount = 0;
  public executeCount = 0;

  readonly #hash: HashPort;
  readonly #entries = new Map<string, MemoryFilesystemEntry>();
  readonly #revisions = new Map<string, number>();

  public constructor(hash: HashPort) {
    this.#hash = snapshotHashPort(hash);
  }

  public setFile(
    path: string,
    contentSha256: string,
    contentBytes: number,
  ): void {
    this.#entries.set(
      path,
      Object.freeze({ kind: 'file', contentSha256, contentBytes }),
    );
    this.bump(path);
  }

  public setTree(path: string): void {
    this.#entries.set(path, Object.freeze({ kind: 'tree' }));
    this.bump(path);
  }

  public delete(path: string): void {
    this.#entries.delete(path);
    this.bump(path);
  }

  public async inspectCreate(
    input: FilesystemCreateInspectInput,
  ): Promise<unknown> {
    this.inspectCount += 1;
    if (this.#entries.has(input.selector.path)) {
      throw new Error('Create target already exists');
    }
    return Object.freeze({
      operation: 'filesystem.create',
      resolvedObjectId: await this.objectId(
        input.selector.path,
        'file',
        input.capabilityScope,
      ),
      stateCommitmentHash: await this.stateHash(
        input.selector.path,
        'prepare',
        input.capabilityScope,
      ),
      targetState: 'absent',
    });
  }

  public async executeCreate(
    input: FilesystemCreateExecuteInput,
  ): Promise<unknown> {
    this.executeCount += 1;
    await this.assertCas(
      input.selector.path,
      input.expectedStateCommitmentHash,
      input.capabilityScope,
    );
    if (this.#entries.has(input.selector.path)) {
      throw new Error('Create target appeared after PREPARE');
    }
    this.#entries.set(
      input.selector.path,
      Object.freeze({
        kind: 'file',
        contentSha256: input.contentSha256,
        contentBytes: input.contentBytes,
      }),
    );
    this.bump(input.selector.path);
    return Object.freeze({
      operation: 'filesystem.create',
      ticketId: input.ticketId,
      resolvedObjectId: input.resolvedObjectId,
      preStateHash: input.expectedStateCommitmentHash,
      postStateHash: await this.stateHash(
        input.selector.path,
        'execute',
        input.capabilityScope,
      ),
      contentSha256: input.contentSha256,
      contentBytes: input.content.byteLength,
    });
  }

  public async inspectReplace(
    input: FilesystemReplaceInspectInput,
  ): Promise<unknown> {
    this.inspectCount += 1;
    const entry = this.#entries.get(input.selector.path);
    if (entry?.kind !== 'file') throw new Error('Replace target is not a file');
    return Object.freeze({
      operation: 'filesystem.replace',
      resolvedObjectId: await this.objectId(
        input.selector.path,
        'file',
        input.capabilityScope,
      ),
      stateCommitmentHash: await this.stateHash(
        input.selector.path,
        'prepare',
        input.capabilityScope,
      ),
      targetState: 'file',
      currentContentSha256: entry.contentSha256,
    });
  }

  public async executeReplace(
    input: FilesystemReplaceExecuteInput,
  ): Promise<unknown> {
    this.executeCount += 1;
    await this.assertCas(
      input.selector.path,
      input.expectedStateCommitmentHash,
      input.capabilityScope,
    );
    const entry = this.#entries.get(input.selector.path);
    if (entry?.kind !== 'file' || entry.contentSha256 !== input.beforeSha256) {
      throw new Error('Replace before-state no longer matches');
    }
    this.#entries.set(
      input.selector.path,
      Object.freeze({
        kind: 'file',
        contentSha256: input.contentSha256,
        contentBytes: input.contentBytes,
      }),
    );
    this.bump(input.selector.path);
    return Object.freeze({
      operation: 'filesystem.replace',
      ticketId: input.ticketId,
      resolvedObjectId: input.resolvedObjectId,
      preStateHash: input.expectedStateCommitmentHash,
      postStateHash: await this.stateHash(
        input.selector.path,
        'execute',
        input.capabilityScope,
      ),
      beforeSha256: input.beforeSha256,
      contentSha256: input.contentSha256,
      contentBytes: input.content.byteLength,
    });
  }

  public async inspectMkdir(
    input: FilesystemMkdirInspectInput,
  ): Promise<unknown> {
    this.inspectCount += 1;
    if (this.#entries.has(input.selector.path)) {
      throw new Error('Mkdir target already exists');
    }
    return Object.freeze({
      operation: 'filesystem.mkdir',
      resolvedObjectId: await this.objectId(
        input.selector.path,
        'tree',
        input.capabilityScope,
      ),
      stateCommitmentHash: await this.stateHash(
        input.selector.path,
        'prepare',
        input.capabilityScope,
      ),
      targetState: 'absent',
    });
  }

  public async executeMkdir(
    input: FilesystemMkdirExecuteInput,
  ): Promise<unknown> {
    this.executeCount += 1;
    await this.assertCas(
      input.selector.path,
      input.expectedStateCommitmentHash,
      input.capabilityScope,
    );
    if (this.#entries.has(input.selector.path)) {
      throw new Error('Mkdir target appeared after PREPARE');
    }
    this.#entries.set(input.selector.path, Object.freeze({ kind: 'tree' }));
    this.bump(input.selector.path);
    return Object.freeze({
      operation: 'filesystem.mkdir',
      ticketId: input.ticketId,
      resolvedObjectId: input.resolvedObjectId,
      preStateHash: input.expectedStateCommitmentHash,
      postStateHash: await this.stateHash(
        input.selector.path,
        'execute',
        input.capabilityScope,
      ),
    });
  }

  public snapshot(path: string): MemoryFilesystemEntry | null {
    return this.#entries.get(path) ?? null;
  }

  private bump(path: string): void {
    this.#revisions.set(path, (this.#revisions.get(path) ?? 0) + 1);
  }

  private async assertCas(
    path: string,
    expected: string,
    capabilityScope: CapabilityScope,
  ): Promise<void> {
    const current = await this.stateHash(path, 'execute', capabilityScope);
    if (current !== expected) {
      throw new ReferenceAdapterError(
        'prepared-state-mismatch',
        'execute',
        'Memory filesystem CAS rejected stale prepared state',
      );
    }
  }

  private async objectId(
    path: string,
    kind: 'file' | 'tree',
    capabilityScope: CapabilityScope,
  ): Promise<string> {
    const digest = await hashCanonicalCommitment(
      'clodex.memory-filesystem-object.v1',
      { capabilityScope, kind, path },
      this.#hash,
      'prepare',
    );
    return `object:${digest}`;
  }

  private async stateHash(
    path: string,
    stage: 'prepare' | 'execute',
    capabilityScope: CapabilityScope,
  ): Promise<string> {
    const entry = this.#entries.get(path) ?? null;
    return await hashCanonicalCommitment(
      'clodex.memory-filesystem-state.v1',
      {
        capabilityScope,
        path,
        revision: this.#revisions.get(path) ?? 0,
        entry: entry as CanonicalJsonValue,
      },
      this.#hash,
      stage,
    );
  }
}

export interface InMemoryGitCapabilityOptions {
  readonly hash: HashPort;
  readonly clean?: boolean;
  readonly summaryDigest: string;
  readonly worktreeDiffDigest: string;
  readonly stagedDiffDigest: string;
  readonly worktreeChangedFiles?: number;
  readonly stagedChangedFiles?: number;
}

export class InMemoryGitCapabilityPort
  implements GitStatusCapabilityPort, GitDiffCapabilityPort
{
  public inspectCount = 0;
  public executeCount = 0;

  readonly #hash: HashPort;
  #revision = 0;
  #clean: boolean;
  #summaryDigest: string;
  #worktreeDiffDigest: string;
  #stagedDiffDigest: string;
  #worktreeChangedFiles: number;
  #stagedChangedFiles: number;

  public constructor(options: InMemoryGitCapabilityOptions) {
    this.#hash = snapshotHashPort(options.hash);
    this.#clean = options.clean ?? true;
    this.#summaryDigest = options.summaryDigest;
    this.#worktreeDiffDigest = options.worktreeDiffDigest;
    this.#stagedDiffDigest = options.stagedDiffDigest;
    this.#worktreeChangedFiles = options.worktreeChangedFiles ?? 0;
    this.#stagedChangedFiles = options.stagedChangedFiles ?? 0;
  }

  public mutate(
    state: Partial<Omit<InMemoryGitCapabilityOptions, 'hash'>> = {},
  ): void {
    this.#revision += 1;
    this.#clean = state.clean ?? this.#clean;
    this.#summaryDigest = state.summaryDigest ?? this.#summaryDigest;
    this.#worktreeDiffDigest =
      state.worktreeDiffDigest ?? this.#worktreeDiffDigest;
    this.#stagedDiffDigest = state.stagedDiffDigest ?? this.#stagedDiffDigest;
    this.#worktreeChangedFiles =
      state.worktreeChangedFiles ?? this.#worktreeChangedFiles;
    this.#stagedChangedFiles =
      state.stagedChangedFiles ?? this.#stagedChangedFiles;
  }

  public async inspectStatus(input: GitStatusInspectInput): Promise<unknown> {
    this.inspectCount += 1;
    return Object.freeze({
      operation: 'git.status',
      resolvedObjectId: 'git:repository',
      stateCommitmentHash: await this.stateHash(
        'prepare',
        input.capabilityScope,
      ),
      hardenedPolicyDigest: input.hardenedPolicyDigest,
    });
  }

  public async executeStatus(input: GitStatusExecuteInput): Promise<unknown> {
    this.executeCount += 1;
    await this.assertCas(
      input.expectedStateCommitmentHash,
      input.capabilityScope,
    );
    return Object.freeze({
      operation: 'git.status',
      ticketId: input.ticketId,
      resolvedObjectId: input.resolvedObjectId,
      preStateHash: input.expectedStateCommitmentHash,
      postStateHash: input.expectedStateCommitmentHash,
      hardenedPolicyDigest: input.hardenedPolicyDigest,
      clean: this.#clean,
      summaryDigest: this.#summaryDigest,
    });
  }

  public async inspectDiff(input: GitDiffInspectInput): Promise<unknown> {
    this.inspectCount += 1;
    return Object.freeze({
      operation: 'git.diff',
      resolvedObjectId: 'git:repository',
      stateCommitmentHash: await this.stateHash(
        'prepare',
        input.capabilityScope,
      ),
      hardenedPolicyDigest: input.hardenedPolicyDigest,
    });
  }

  public async executeDiff(input: GitDiffExecuteInput): Promise<unknown> {
    this.executeCount += 1;
    await this.assertCas(
      input.expectedStateCommitmentHash,
      input.capabilityScope,
    );
    const staged = input.scope === 'staged';
    return Object.freeze({
      operation: 'git.diff',
      scope: input.scope,
      ticketId: input.ticketId,
      resolvedObjectId: input.resolvedObjectId,
      preStateHash: input.expectedStateCommitmentHash,
      postStateHash: input.expectedStateCommitmentHash,
      hardenedPolicyDigest: input.hardenedPolicyDigest,
      changedFiles: staged
        ? this.#stagedChangedFiles
        : this.#worktreeChangedFiles,
      diffDigest: staged ? this.#stagedDiffDigest : this.#worktreeDiffDigest,
    });
  }

  private async assertCas(
    expected: string,
    capabilityScope: CapabilityScope,
  ): Promise<void> {
    if ((await this.stateHash('execute', capabilityScope)) !== expected) {
      throw new ReferenceAdapterError(
        'prepared-state-mismatch',
        'execute',
        'Memory Git CAS rejected stale prepared state',
      );
    }
  }

  private async stateHash(
    stage: 'prepare' | 'execute',
    capabilityScope: CapabilityScope,
  ): Promise<string> {
    return await hashCanonicalCommitment(
      'clodex.memory-git-state.v1',
      {
        capabilityScope,
        revision: this.#revision,
        clean: this.#clean,
        summaryDigest: this.#summaryDigest,
        worktreeDiffDigest: this.#worktreeDiffDigest,
        stagedDiffDigest: this.#stagedDiffDigest,
        worktreeChangedFiles: this.#worktreeChangedFiles,
        stagedChangedFiles: this.#stagedChangedFiles,
      },
      this.#hash,
      stage,
    );
  }
}

export class InMemoryTestSandboxProfileRegistry
  implements TestSandboxProfileRegistryPort
{
  readonly #profiles = new Map<string, RegisteredTestSandboxProfile>();

  public constructor(profiles: readonly unknown[] = []) {
    for (const profile of profiles) this.register(profile);
  }

  public register(profileValue: unknown): void {
    const profile = validateRegisteredTestSandboxProfile(profileValue);
    this.#profiles.set(profile.profile.profileId, profile);
  }

  public delete(profileId: string): void {
    this.#profiles.delete(profileId);
  }

  public resolveProfile(
    input: TestSandboxProfileResolveInput,
  ): RegisteredTestSandboxProfile | null {
    return this.#profiles.get(input.profileId) ?? null;
  }
}

export interface InMemoryTestRunCapabilityOptions {
  readonly hash: HashPort;
  readonly outcome?: 'passed' | 'failed';
  readonly exitCode?: number;
  readonly reportDigest: string;
}

export class InMemoryTestRunCapabilityPort implements TestRunCapabilityPort {
  public inspectCount = 0;
  public executeCount = 0;

  readonly #hash: HashPort;
  #revision = 0;
  #outcome: 'passed' | 'failed';
  #exitCode: number;
  #reportDigest: string;

  public constructor(options: InMemoryTestRunCapabilityOptions) {
    this.#hash = snapshotHashPort(options.hash);
    this.#outcome = options.outcome ?? 'passed';
    this.#exitCode = options.exitCode ?? (this.#outcome === 'passed' ? 0 : 1);
    this.#reportDigest = options.reportDigest;
  }

  public mutate(options: {
    readonly outcome?: 'passed' | 'failed';
    readonly exitCode?: number;
    readonly reportDigest?: string;
  }): void {
    this.#revision += 1;
    this.#outcome = options.outcome ?? this.#outcome;
    this.#exitCode = options.exitCode ?? this.#exitCode;
    this.#reportDigest = options.reportDigest ?? this.#reportDigest;
  }

  public async inspectRun(input: TestRunInspectInput): Promise<unknown> {
    this.inspectCount += 1;
    return Object.freeze({
      operation: 'test.run',
      profileId: input.profile.profileId,
      profileDigest: input.profileDigest,
      resolvedObjectId: `test-profile:${input.profile.profileId}`,
      stateCommitmentHash: await this.stateHash(input, 'prepare'),
    });
  }

  public async executeRun(input: TestRunExecuteInput): Promise<unknown> {
    this.executeCount += 1;
    if (
      (await this.stateHash(input, 'execute')) !==
      input.expectedStateCommitmentHash
    ) {
      throw new ReferenceAdapterError(
        'prepared-state-mismatch',
        'execute',
        'Memory test profile CAS rejected stale prepared state',
      );
    }
    const postStateHash = await hashCanonicalCommitment(
      'clodex.memory-test-scratch-result.v1',
      {
        capabilityScope: input.capabilityScope,
        ticketId: input.ticketId,
        profileDigest: input.profileDigest,
        outcome: this.#outcome,
        exitCode: this.#exitCode,
        reportDigest: this.#reportDigest,
      },
      this.#hash,
      'execute',
    );
    return Object.freeze({
      operation: 'test.run',
      ticketId: input.ticketId,
      profileId: input.profile.profileId,
      profileDigest: input.profileDigest,
      runnerDigest: input.profile.runnerDigest,
      resolvedObjectId: input.resolvedObjectId,
      preStateHash: input.expectedStateCommitmentHash,
      postStateHash,
      outcome: this.#outcome,
      exitCode: this.#exitCode,
      reportDigest: this.#reportDigest,
    });
  }

  private async stateHash(
    input: TestRunInspectInput,
    stage: 'prepare' | 'execute',
  ): Promise<string> {
    return await hashCanonicalCommitment(
      'clodex.memory-test-profile-state.v1',
      {
        capabilityScope: input.capabilityScope,
        revision: this.#revision,
        profileId: input.profile.profileId,
        profileDigest: input.profileDigest,
        runnerDigest: input.profile.runnerDigest,
        sandboxImageDigest: input.profile.sandboxImageDigest,
      },
      this.#hash,
      stage,
    );
  }
}

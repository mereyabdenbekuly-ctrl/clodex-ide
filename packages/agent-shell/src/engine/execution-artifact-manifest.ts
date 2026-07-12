import { createHash } from 'node:crypto';
import { canonicalizeRunnerValue } from './runner-security';

export const EXECUTION_ARTIFACT_MANIFEST_VERSION = 1 as const;
const MAX_ARTIFACT_ENTRIES = 512;
const MAX_ARTIFACT_PATH_LENGTH = 4_096;
const MAX_ARTIFACT_PATH_BYTES = 64 * 1024;

export interface WorkspaceArtifactStateEntry {
  relativePath: string;
  tracked: boolean;
  kind: 'file' | 'deleted' | 'unsupported';
  sizeBytes: number | null;
  mode: number | null;
  sha256: string | null;
  modifiedAtMs: number | null;
  omissionReason: 'size-limit' | 'unsupported-file' | null;
}

export interface WorkspaceArtifactState {
  entries: readonly WorkspaceArtifactStateEntry[];
  truncated: boolean;
}

export interface ExecutionArtifactManifestEntry {
  relativePath: string;
  change: 'created' | 'modified' | 'deleted';
  sizeBytes: number | null;
  mode: number | null;
  sha256: string | null;
  omissionReason: 'size-limit' | 'unsupported-file' | null;
}

export interface ExecutionArtifactManifest {
  version: typeof EXECUTION_ARTIFACT_MANIFEST_VERSION;
  snapshotHash: string;
  entries: readonly ExecutionArtifactManifestEntry[];
  truncated: boolean;
}

export function createExecutionArtifactManifest(input: {
  snapshotHash: string;
  before: WorkspaceArtifactState;
  after: WorkspaceArtifactState;
}): ExecutionArtifactManifest {
  assertSha256(input.snapshotHash, 'Artifact manifest snapshot hash');
  const before = stateMap(input.before.entries);
  const after = stateMap(input.after.entries);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const entries: ExecutionArtifactManifestEntry[] = [];
  let pathBytes = 0;
  let truncated =
    input.before.truncated ||
    input.after.truncated ||
    [...before.values(), ...after.values()].some(
      (entry) => entry.omissionReason !== null,
    );
  for (const relativePath of paths) {
    const previous = before.get(relativePath);
    const current = after.get(relativePath);
    if (sameState(previous, current)) continue;
    const nextPathBytes = Buffer.byteLength(relativePath, 'utf8');
    if (
      entries.length >= MAX_ARTIFACT_ENTRIES ||
      pathBytes + nextPathBytes > MAX_ARTIFACT_PATH_BYTES
    ) {
      truncated = true;
      break;
    }
    const state = current ?? deletedFallback(relativePath, previous);
    entries.push(
      Object.freeze({
        relativePath,
        change:
          state.kind === 'deleted'
            ? 'deleted'
            : !previous && !state.tracked
              ? 'created'
              : 'modified',
        sizeBytes: state.kind === 'file' ? state.sizeBytes : null,
        mode: state.kind === 'file' ? state.mode : null,
        sha256: state.kind === 'file' ? state.sha256 : null,
        omissionReason:
          state.kind === 'unsupported'
            ? 'unsupported-file'
            : state.omissionReason,
      }),
    );
    pathBytes += nextPathBytes;
  }
  const manifest = Object.freeze({
    version: EXECUTION_ARTIFACT_MANIFEST_VERSION,
    snapshotHash: input.snapshotHash,
    entries: Object.freeze(entries),
    truncated,
  });
  assertExecutionArtifactManifest(manifest);
  return manifest;
}

export function hashExecutionArtifactManifest(
  manifest: ExecutionArtifactManifest,
): string {
  assertExecutionArtifactManifest(manifest);
  return createHash('sha256')
    .update(canonicalizeRunnerValue(manifest))
    .digest('hex');
}

export function assertExecutionArtifactManifest(
  manifest: ExecutionArtifactManifest,
): void {
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !hasExactKeys(manifest as unknown as Record<string, unknown>, [
      'version',
      'snapshotHash',
      'entries',
      'truncated',
    ]) ||
    manifest.version !== EXECUTION_ARTIFACT_MANIFEST_VERSION ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length > MAX_ARTIFACT_ENTRIES ||
    typeof manifest.truncated !== 'boolean'
  ) {
    throw new Error('Execution Artifact Manifest is invalid');
  }
  assertSha256(manifest.snapshotHash, 'Artifact manifest snapshot hash');
  let previousPath = '';
  let pathBytes = 0;
  for (const entry of manifest.entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !hasExactKeys(entry as unknown as Record<string, unknown>, [
        'relativePath',
        'change',
        'sizeBytes',
        'mode',
        'sha256',
        'omissionReason',
      ])
    ) {
      throw new Error('Execution Artifact Manifest entry is invalid');
    }
    assertArtifactRelativePath(entry.relativePath);
    if (previousPath && entry.relativePath <= previousPath) {
      throw new Error(
        'Execution Artifact Manifest paths must be unique and sorted',
      );
    }
    previousPath = entry.relativePath;
    pathBytes += Buffer.byteLength(entry.relativePath, 'utf8');
    if (pathBytes > MAX_ARTIFACT_PATH_BYTES) {
      throw new Error('Execution Artifact Manifest path budget exceeded');
    }
    if (
      entry.change !== 'created' &&
      entry.change !== 'modified' &&
      entry.change !== 'deleted'
    ) {
      throw new Error('Execution Artifact Manifest change is invalid');
    }
    assertManifestEntryMetadata(entry);
  }
}

function stateMap(
  entries: readonly WorkspaceArtifactStateEntry[],
): Map<string, WorkspaceArtifactStateEntry> {
  if (entries.length > MAX_ARTIFACT_ENTRIES) {
    throw new Error('Artifact state entry limit exceeded');
  }
  const result = new Map<string, WorkspaceArtifactStateEntry>();
  for (const entry of entries) {
    assertArtifactRelativePath(entry.relativePath);
    if (result.has(entry.relativePath)) {
      throw new Error(`Duplicate artifact state path: ${entry.relativePath}`);
    }
    if (entry.sha256 !== null) {
      assertSha256(entry.sha256, 'Artifact content hash');
    }
    result.set(entry.relativePath, entry);
  }
  return result;
}

function sameState(
  left: WorkspaceArtifactStateEntry | undefined,
  right: WorkspaceArtifactStateEntry | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.tracked === right.tracked &&
    left.kind === right.kind &&
    left.sizeBytes === right.sizeBytes &&
    left.mode === right.mode &&
    left.sha256 === right.sha256 &&
    left.modifiedAtMs === right.modifiedAtMs &&
    left.omissionReason === right.omissionReason
  );
}

function deletedFallback(
  relativePath: string,
  previous: WorkspaceArtifactStateEntry | undefined,
): WorkspaceArtifactStateEntry {
  return {
    relativePath,
    tracked: previous?.tracked ?? true,
    kind: 'deleted',
    sizeBytes: null,
    mode: null,
    sha256: null,
    modifiedAtMs: null,
    omissionReason: null,
  };
}

function assertArtifactRelativePath(relativePath: string): void {
  if (typeof relativePath !== 'string') {
    throw new Error('Unsafe artifact manifest path');
  }
  const segments = relativePath.replaceAll('\\', '/').split('/');
  if (
    !relativePath ||
    relativePath.length > MAX_ARTIFACT_PATH_LENGTH ||
    relativePath.startsWith('/') ||
    relativePath.includes('\0') ||
    segments.some((segment) => !segment || segment === '..') ||
    segments[0] === '.git' ||
    segments[0] === '.clodex'
  ) {
    throw new Error(`Unsafe artifact manifest path: ${relativePath}`);
  }
}

function assertManifestEntryMetadata(
  entry: ExecutionArtifactManifestEntry,
): void {
  const omissionReason = entry.omissionReason;
  if (
    omissionReason !== null &&
    omissionReason !== 'size-limit' &&
    omissionReason !== 'unsupported-file'
  ) {
    throw new Error('Execution Artifact Manifest omission reason is invalid');
  }
  if (entry.change === 'deleted') {
    if (
      entry.sizeBytes !== null ||
      entry.mode !== null ||
      entry.sha256 !== null ||
      omissionReason !== null
    ) {
      throw new Error('Deleted artifact metadata is invalid');
    }
    return;
  }
  if (
    entry.sizeBytes !== null &&
    (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0)
  ) {
    throw new Error('Artifact size is invalid');
  }
  if (
    entry.mode !== null &&
    (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)
  ) {
    throw new Error('Artifact mode is invalid');
  }
  if (entry.sha256 !== null) {
    assertSha256(entry.sha256, 'Artifact content hash');
  }
  if (omissionReason === null) {
    if (
      entry.sizeBytes === null ||
      entry.mode === null ||
      entry.sha256 === null
    ) {
      throw new Error('Content-addressed artifact metadata is incomplete');
    }
    return;
  }
  if (entry.sha256 !== null) {
    throw new Error('Omitted artifact content hash must be null');
  }
  if (
    omissionReason === 'size-limit' &&
    (entry.sizeBytes === null || entry.mode === null)
  ) {
    throw new Error('Oversized artifact metadata is incomplete');
  }
  if (
    omissionReason === 'unsupported-file' &&
    (entry.sizeBytes !== null || entry.mode !== null)
  ) {
    throw new Error('Unsupported artifact metadata is invalid');
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
}

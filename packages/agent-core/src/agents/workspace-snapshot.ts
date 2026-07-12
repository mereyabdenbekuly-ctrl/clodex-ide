import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

export const WORKSPACE_SNAPSHOT_VERSION = 1 as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const workspaceSnapshotEntrySchema = z
  .object({
    mountPrefix: z.string().min(1).max(64),
    relativePath: z.string().min(1).max(4_096),
    kind: z.literal('file'),
    sizeBytes: z.number().int().nonnegative(),
    sha256: sha256Schema,
  })
  .strict();
export type WorkspaceSnapshotEntry = z.infer<
  typeof workspaceSnapshotEntrySchema
>;

export const workspaceSnapshotMountSchema = z
  .object({
    mountPrefix: z.string().min(1).max(64),
    workspaceIdHash: sha256Schema,
    repositoryId: z.string().min(1).max(1_024).nullable(),
    worktreeId: z.string().min(1).max(1_024).nullable(),
    repositoryRevision: z.string().min(1).max(1_024).nullable(),
    dirtyPatchHash: sha256Schema,
    dependencyFingerprintHash: sha256Schema,
    ignorePolicyHash: sha256Schema,
  })
  .strict();
export type WorkspaceSnapshotMount = z.infer<
  typeof workspaceSnapshotMountSchema
>;

export const workspaceEnvironmentFingerprintSchema = z
  .object({
    os: z.string().min(1).max(128),
    arch: z.string().min(1).max(128),
    shell: z.string().min(1).max(512).nullable(),
    toolchains: z.record(z.string(), z.string()),
    fingerprintHash: sha256Schema,
  })
  .strict();
export type WorkspaceEnvironmentFingerprint = z.infer<
  typeof workspaceEnvironmentFingerprintSchema
>;

export const workspaceSnapshotV1Schema = z
  .object({
    version: z.literal(WORKSPACE_SNAPSHOT_VERSION),
    snapshotHash: sha256Schema,
    createdAt: z.number().int().nonnegative(),
    selection: z.enum(['explicit', 'mounted-workspaces']),
    totalBytes: z.number().int().nonnegative(),
    entries: z.array(workspaceSnapshotEntrySchema),
    mounts: z.array(workspaceSnapshotMountSchema),
    environment: workspaceEnvironmentFingerprintSchema,
  })
  .strict();
export type WorkspaceSnapshotV1 = z.infer<typeof workspaceSnapshotV1Schema>;

export interface CreateWorkspaceSnapshotInput {
  createdAt?: number;
  selection: WorkspaceSnapshotV1['selection'];
  entries: readonly WorkspaceSnapshotEntry[];
  mounts?: readonly WorkspaceSnapshotMount[];
  environment?: Omit<WorkspaceEnvironmentFingerprint, 'fingerprintHash'>;
  maxEntries?: number;
  maxTotalBytes?: number;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MOUNT_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function createWorkspaceSnapshot(
  input: CreateWorkspaceSnapshotInput,
): WorkspaceSnapshotV1 {
  const maxEntries = positiveLimit(input.maxEntries, 10_000, 'entry');
  const maxTotalBytes = positiveLimit(
    input.maxTotalBytes,
    512 * 1024 * 1024,
    'total byte',
  );
  if (input.entries.length > maxEntries) {
    throw new Error('Workspace snapshot entry limit exceeded');
  }
  const createdAt = input.createdAt ?? Date.now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error('Workspace snapshot timestamp is invalid');
  }

  const seenEntries = new Set<string>();
  let totalBytes = 0;
  const entries = input.entries.map((entry) => {
    const normalized = normalizeWorkspaceSnapshotEntry(entry);
    const identity = `${normalized.mountPrefix}\0${normalized.relativePath}`;
    if (seenEntries.has(identity)) {
      throw new Error(
        `Duplicate snapshot entry: ${normalized.mountPrefix}/${normalized.relativePath}`,
      );
    }
    seenEntries.add(identity);
    totalBytes += normalized.sizeBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) {
      throw new Error('Workspace snapshot byte limit exceeded');
    }
    return normalized;
  });
  entries.sort(compareSnapshotEntries);

  const mountPrefixes = new Set(entries.map((entry) => entry.mountPrefix));
  const providedMounts =
    input.mounts ??
    [...mountPrefixes].map((mountPrefix) =>
      createDefaultWorkspaceSnapshotMount(mountPrefix),
    );
  const seenMounts = new Set<string>();
  const mounts = providedMounts.map((mount) => {
    const normalized = normalizeWorkspaceSnapshotMount(mount);
    if (seenMounts.has(normalized.mountPrefix)) {
      throw new Error(
        `Duplicate workspace snapshot mount: ${normalized.mountPrefix}`,
      );
    }
    seenMounts.add(normalized.mountPrefix);
    return normalized;
  });
  mounts.sort((left, right) =>
    compareOrdinal(left.mountPrefix, right.mountPrefix),
  );
  for (const mountPrefix of mountPrefixes) {
    if (!seenMounts.has(mountPrefix)) {
      throw new Error(
        `Workspace snapshot entry references unknown mount: ${mountPrefix}`,
      );
    }
  }

  const environment = createWorkspaceEnvironmentFingerprint(
    input.environment ?? {
      os: 'unknown',
      arch: 'unknown',
      shell: null,
      toolchains: {},
    },
  );
  const snapshotHash = sha256(
    canonicalJson({
      version: WORKSPACE_SNAPSHOT_VERSION,
      selection: input.selection,
      entries,
      mounts,
      environment,
    }),
  );
  return {
    version: WORKSPACE_SNAPSHOT_VERSION,
    snapshotHash,
    createdAt,
    selection: input.selection,
    totalBytes,
    entries,
    mounts,
    environment,
  };
}

export function createWorkspaceEnvironmentFingerprint(
  input: Omit<WorkspaceEnvironmentFingerprint, 'fingerprintHash'>,
): WorkspaceEnvironmentFingerprint {
  const os = normalizeIdentifier(input.os, 'Environment OS', 128);
  const arch = normalizeIdentifier(input.arch, 'Environment architecture', 128);
  const shell =
    input.shell === null
      ? null
      : normalizeIdentifier(input.shell, 'Environment shell', 512);
  const toolchains = Object.fromEntries(
    Object.entries(input.toolchains)
      .map(([name, version]): [string, string] => [
        normalizeIdentifier(name, 'Toolchain name', 128),
        normalizeIdentifier(version, 'Toolchain version', 512),
      ])
      .sort(([left], [right]) => compareOrdinal(left, right)),
  );
  const fingerprintHash = sha256(
    canonicalJson({ os, arch, shell, toolchains }),
  );
  return { os, arch, shell, toolchains, fingerprintHash };
}

export function hashWorkspaceDirtyPatch(patch: string | Uint8Array): string {
  return sha256(patch);
}

export function hashWorkspaceIgnorePolicy(policy: string | Uint8Array): string {
  return sha256(policy);
}

export function hashWorkspaceDependencyFingerprint(
  entries: readonly {
    relativePath: string;
    sizeBytes: number;
    sha256: string;
  }[],
): string {
  const normalized = entries
    .map((entry) => {
      const relativePath = normalizeRelativePath(entry.relativePath);
      if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
        throw new Error('Dependency fingerprint entry size is invalid');
      }
      return {
        relativePath,
        sizeBytes: entry.sizeBytes,
        sha256: normalizeSha256(
          entry.sha256,
          'Dependency fingerprint entry SHA-256',
        ),
      };
    })
    .sort((left, right) =>
      compareOrdinal(left.relativePath, right.relativePath),
    );
  const seen = new Set<string>();
  for (const entry of normalized) {
    if (seen.has(entry.relativePath)) {
      throw new Error(
        `Duplicate dependency fingerprint entry: ${entry.relativePath}`,
      );
    }
    seen.add(entry.relativePath);
  }
  return sha256(canonicalJson({ version: 1, entries: normalized }));
}

/**
 * Removes machine- and time-local pnpm metadata before it enters the
 * dependency fingerprint. The normalized bytes are safe to hash across
 * disposable worktrees and remote runners while lock/package inputs remain
 * byte-exact.
 */
export function normalizeWorkspaceDependencyFingerprintContent(
  relativePath: string,
  content: Uint8Array,
): Uint8Array {
  if (
    path.posix.basename(relativePath.replaceAll('\\', '/')) !== '.modules.yaml'
  ) {
    return content;
  }
  const text = Buffer.from(content).toString('utf8');
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const normalized = { ...(parsed as Record<string, unknown>) };
      delete normalized.prunedAt;
      delete normalized.storeDir;
      return Buffer.from(`${canonicalJson(normalized)}\n`, 'utf8');
    }
  } catch {
    // Older pnpm versions may emit YAML rather than JSON.
  }
  return Buffer.from(
    text
      .split(/\r?\n/)
      .filter((line) => !/^\s*(?:prunedAt|storeDir):/.test(line))
      .join('\n'),
    'utf8',
  );
}

export function hashWorkspaceIdentity(identity: string): string {
  const normalized = normalizeIdentifier(identity, 'Workspace identity', 4_096);
  return sha256(`workspace\0${normalized}`);
}

function normalizeWorkspaceSnapshotEntry(
  entry: WorkspaceSnapshotEntry,
): WorkspaceSnapshotEntry {
  const mountPrefix = normalizeMountPrefix(entry.mountPrefix);
  const relativePath = normalizeRelativePath(entry.relativePath);
  if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
    throw new Error('Workspace snapshot entry size is invalid');
  }
  return {
    mountPrefix,
    relativePath,
    kind: 'file',
    sizeBytes: entry.sizeBytes,
    sha256: normalizeSha256(entry.sha256, 'Workspace snapshot entry SHA-256'),
  };
}

function normalizeWorkspaceSnapshotMount(
  mount: WorkspaceSnapshotMount,
): WorkspaceSnapshotMount {
  return {
    mountPrefix: normalizeMountPrefix(mount.mountPrefix),
    workspaceIdHash: normalizeSha256(
      mount.workspaceIdHash,
      'Workspace identity hash',
    ),
    repositoryId: normalizeOptionalIdentifier(
      mount.repositoryId,
      'Repository id',
      1_024,
    ),
    worktreeId: normalizeOptionalIdentifier(
      mount.worktreeId,
      'Worktree id',
      1_024,
    ),
    repositoryRevision: normalizeOptionalIdentifier(
      mount.repositoryRevision,
      'Repository revision',
      1_024,
    ),
    dirtyPatchHash: normalizeSha256(mount.dirtyPatchHash, 'Dirty patch hash'),
    dependencyFingerprintHash: normalizeSha256(
      mount.dependencyFingerprintHash,
      'Dependency fingerprint hash',
    ),
    ignorePolicyHash: normalizeSha256(
      mount.ignorePolicyHash,
      'Ignore policy hash',
    ),
  };
}

function createDefaultWorkspaceSnapshotMount(
  mountPrefix: string,
): WorkspaceSnapshotMount {
  return {
    mountPrefix,
    workspaceIdHash: hashWorkspaceIdentity(`mount:${mountPrefix}`),
    repositoryId: null,
    worktreeId: null,
    repositoryRevision: null,
    dirtyPatchHash: hashWorkspaceDirtyPatch(''),
    dependencyFingerprintHash: hashWorkspaceDependencyFingerprint([]),
    ignorePolicyHash: hashWorkspaceIgnorePolicy('default'),
  };
}

function normalizeMountPrefix(value: string): string {
  const normalized = value.trim();
  if (!MOUNT_PREFIX_PATTERN.test(normalized)) {
    throw new Error('Workspace snapshot mount prefix is invalid');
  }
  return normalized;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    Array.from(normalized).some((character) => character.charCodeAt(0) < 32) ||
    normalized
      .split('/')
      .some((segment) => segment === '.' || segment === '..' || !segment)
  ) {
    throw new Error(
      'Workspace snapshot path must be a normalized relative path',
    );
  }
  return normalized;
}

function normalizeIdentifier(
  value: string,
  label: string,
  maximumLength: number,
): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > maximumLength) {
    throw new Error(`${label} must be at most ${maximumLength} characters`);
  }
  return normalized;
}

function normalizeOptionalIdentifier(
  value: string | null,
  label: string,
  maximumLength: number,
): string | null {
  return value === null
    ? null
    : normalizeIdentifier(value, label, maximumLength);
}

function normalizeSha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`Workspace snapshot ${label} limit is invalid`);
  }
  return normalized;
}

function compareSnapshotEntries(
  left: WorkspaceSnapshotEntry,
  right: WorkspaceSnapshotEntry,
): number {
  return (
    compareOrdinal(left.mountPrefix, right.mountPrefix) ||
    compareOrdinal(left.relativePath, right.relativePath)
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareOrdinal(left, right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

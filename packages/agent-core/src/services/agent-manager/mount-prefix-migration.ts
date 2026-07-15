import {
  legacyMountPrefixForPath,
  mountPrefixForPath,
} from '../mount-manager/mount-registry';

interface PersistedWorkspacePath {
  path: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildUnambiguousPrefixReplacements(
  workspaces: readonly PersistedWorkspacePath[],
): Map<string, string> {
  const candidates = new Map<string, Set<string>>();

  for (const workspace of workspaces) {
    const legacyPrefix = legacyMountPrefixForPath(workspace.path);
    const currentPrefix = mountPrefixForPath(workspace.path);
    let replacements = candidates.get(legacyPrefix);
    if (!replacements) {
      replacements = new Set<string>();
      candidates.set(legacyPrefix, replacements);
    }
    replacements.add(currentPrefix);
  }

  const unambiguous = new Map<string, string>();
  for (const [legacyPrefix, replacements] of candidates) {
    if (replacements.size !== 1) continue;
    const currentPrefix = replacements.values().next().value;
    if (currentPrefix) unambiguous.set(legacyPrefix, currentPrefix);
  }
  return unambiguous;
}

function migrateString(
  value: string,
  replacements: ReadonlyMap<string, string>,
): string {
  if (replacements.size === 0) return value;
  const prefixes = [...replacements.keys()].map(escapeRegExp).join('|');
  const prefixPattern = new RegExp(
    `(^|[^A-Za-z0-9_])(${prefixes})(?=[\\/\\\\]|[^A-Za-z0-9_]|$)`,
    'g',
  );
  return value.replace(
    prefixPattern,
    (_match, boundary: string, legacyPrefix: string) =>
      `${boundary}${replacements.get(legacyPrefix) ?? legacyPrefix}`,
  );
}

function migrateValue(
  value: unknown,
  replacements: ReadonlyMap<string, string>,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === 'string') return migrateString(value, replacements);
  if (value === null || typeof value !== 'object') return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const migrated: unknown[] = [];
    seen.set(value, migrated);
    for (const item of value) {
      migrated.push(migrateValue(item, replacements, seen));
    }
    return migrated;
  }

  // Persisted messages are JSON-shaped. Preserve non-plain runtime values
  // (Dates, buffers, host objects) rather than attempting to clone them.
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const migrated: Record<string, unknown> = {};
  seen.set(value, migrated);
  for (const [key, nested] of Object.entries(value)) {
    migrated[key] = migrateValue(nested, replacements, seen);
  }
  return migrated;
}

/**
 * Rewrites legacy 16-bit workspace mount tokens in persisted JSON-shaped
 * agent state to the current 64-bit deterministic prefix. A legacy prefix
 * shared by two persisted workspace paths is deliberately left untouched:
 * guessing which workspace it meant would recreate the aliasing bug this
 * migration is intended to remove.
 */
export function migrateLegacyMountPrefixes<T>(
  value: T,
  workspaces: readonly PersistedWorkspacePath[],
): T {
  const replacements = buildUnambiguousPrefixReplacements(workspaces);
  return migrateValue(value, replacements, new WeakMap()) as T;
}

import { createHash } from 'node:crypto';

const MAX_CANONICAL_DEPTH = 100;
const MAX_CANONICAL_NODES = 100_000;

/**
 * Canonicalizes an untrusted value without JSON.stringify's lossy coercions.
 *
 * Artifact Bridge commitments must never silently turn BigInt, undefined,
 * sparse arrays, non-finite numbers, accessors, or cyclic graphs into a
 * different effect payload. Objects are restricted to plain data records and
 * their keys are ordered by their UTF-8 byte representation.
 */
export function canonicalizeArtifactBridgeJson(value: unknown): string {
  const active = new WeakSet<object>();
  const budget = { nodes: 0 };
  return canonicalize(value, active, budget, 0);
}

export function hashArtifactBridgeJson(domain: string, value: unknown): string {
  if (!domain || domain.includes('\0')) {
    throw new Error('Artifact Bridge hash domain is invalid');
  }
  return createHash('sha256')
    .update(`${domain}\0${canonicalizeArtifactBridgeJson(value)}`)
    .digest('hex');
}

function canonicalize(
  value: unknown,
  active: WeakSet<object>,
  budget: { nodes: number },
  depth: number,
): string {
  budget.nodes += 1;
  if (budget.nodes > MAX_CANONICAL_NODES) {
    throw new Error('Artifact Bridge JSON value is too complex');
  }
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new Error('Artifact Bridge JSON value is too deeply nested');
  }

  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('Artifact Bridge JSON numbers must be finite');
      }
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'object':
      return canonicalizeObject(value, active, budget, depth);
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      throw new Error(
        `Artifact Bridge JSON cannot contain ${typeof value} values`,
      );
  }
  throw new Error('Artifact Bridge JSON value has an unsupported type');
}

function canonicalizeObject(
  value: object,
  active: WeakSet<object>,
  budget: { nodes: number },
  depth: number,
): string {
  if (active.has(value)) {
    throw new Error('Artifact Bridge JSON cannot contain circular references');
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        throw new Error(
          'Artifact Bridge JSON arrays must be dense and index-only',
        );
      }
      return `[${value
        .map((entry) => canonicalize(entry, active, budget, depth + 1))
        .join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Artifact Bridge JSON objects must be plain records');
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      throw new Error('Artifact Bridge JSON cannot contain symbol keys');
    }
    const record = value as Record<string, unknown>;
    const keys = ownKeys as string[];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new Error(
          'Artifact Bridge JSON records must contain enumerable data properties only',
        );
      }
    }
    keys.sort(compareUtf8);
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalize(record[key], active, budget, depth + 1)}`,
      )
      .join(',')}}`;
  } finally {
    active.delete(value);
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

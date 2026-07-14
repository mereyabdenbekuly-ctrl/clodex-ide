import { describe, expect, it } from 'vitest';
import {
  canonicalizeArtifactBridgeJson,
  hashArtifactBridgeJson,
} from './canonical-json';

function createSparseArray(): unknown[] {
  const value = new Array<unknown>(2);
  value[1] = 1;
  return value;
}

describe('Artifact Bridge canonical JSON', () => {
  it('orders record keys while preserving array order', () => {
    expect(
      canonicalizeArtifactBridgeJson({ z: 1, a: [{ y: true, x: null }, 2] }),
    ).toBe('{"a":[{"x":null,"y":true},2],"z":1}');
  });

  it('normalizes negative zero and permits repeated acyclic references', () => {
    const shared = { value: -0 };
    expect(
      canonicalizeArtifactBridgeJson({ left: shared, right: shared }),
    ).toBe('{"left":{"value":0},"right":{"value":0}}');
  });

  it.each([
    ['undefined', { value: undefined }],
    ['BigInt', { value: 1n }],
    ['non-finite number', { value: Number.NaN }],
    ['sparse array', createSparseArray()],
    ['non-plain object', { value: new Date(0) }],
  ])('rejects %s without lossy coercion', (_label, value) => {
    expect(() => canonicalizeArtifactBridgeJson(value)).toThrow();
  });

  it('rejects circular references and accessors', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeArtifactBridgeJson(cyclic)).toThrow('circular');

    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 1,
    });
    expect(() => canonicalizeArtifactBridgeJson(accessor)).toThrow(
      'data properties',
    );
  });

  it('domain-separates hashes', () => {
    expect(hashArtifactBridgeJson('arguments.v1', { a: 1 })).not.toBe(
      hashArtifactBridgeJson('policy.v1', { a: 1 }),
    );
    expect(() => hashArtifactBridgeJson('bad\0domain', {})).toThrow('domain');
  });
});

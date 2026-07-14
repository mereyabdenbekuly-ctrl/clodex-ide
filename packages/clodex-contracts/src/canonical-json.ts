export type CanonicalJsonPrimitive = boolean | null | number | string;

export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

const MAX_CANONICAL_JSON_DEPTH = 64;
const MAX_CANONICAL_JSON_NODES = 100_000;
const MAX_CANONICAL_JSON_LEXICAL_TOKENS = MAX_CANONICAL_JSON_NODES * 2;
const MAX_CANONICAL_JSON_STRING_CODE_UNITS = 1024 * 1024;
const MAX_CANONICAL_JSON_OUTPUT_CODE_UNITS = 16 * 1024 * 1024;

interface CanonicalJsonBudget {
  nodes: number;
  outputCodeUnits: number;
}

export class CanonicalJsonError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * Serialize the deliberately restricted JSON subset used by authority-bearing
 * CLODEx artifacts. Objects are ordered by UTF-16 code units (the ordering used
 * by RFC 8785), strings must already be NFC, and numbers must be safe integers.
 */
export function canonicalizeJson(value: unknown): string {
  return serializeCanonical(value, new Set<object>(), 0, {
    nodes: 0,
    outputCodeUnits: 0,
  });
}

/**
 * Parse exact canonical JSON bytes represented as a JavaScript string.
 *
 * Comparing the submitted bytes with a fresh canonical serialization rejects
 * whitespace, duplicate object keys, alternate escapes, non-canonical key
 * ordering, negative zero, and every other spelling that JSON.parse would
 * otherwise normalize silently.
 */
export function parseCanonicalJson(input: string): CanonicalJsonValue {
  if (typeof input !== 'string') {
    throw new CanonicalJsonError('Canonical JSON input must be a string');
  }
  assertCanonicalJsonTextBudget(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    throw new CanonicalJsonError('Canonical JSON input is not valid JSON');
  }
  const canonical = canonicalizeJson(parsed);
  if (canonical !== input) {
    throw new CanonicalJsonError('JSON input is not in exact canonical form');
  }
  return parsed as CanonicalJsonValue;
}

/** Encode a string as strict UTF-8 without relying on DOM or Node globals. */
export function encodeUtf8(value: string): Uint8Array {
  assertCanonicalString(value, 'UTF-8 input');
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
      index += 1;
    }
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

/** Decode strict UTF-8 and reject overlong, surrogate, and truncated forms. */
export function decodeUtf8(input: Uint8Array): string {
  const codePoints: number[] = [];
  for (let index = 0; index < input.length; ) {
    const first = input[index]!;
    if (first <= 0x7f) {
      codePoints.push(first);
      index += 1;
      continue;
    }

    let length: number;
    let codePoint: number;
    let minimum: number;
    if (first >= 0xc2 && first <= 0xdf) {
      length = 2;
      codePoint = first & 0x1f;
      minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      length = 3;
      codePoint = first & 0x0f;
      minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      length = 4;
      codePoint = first & 0x07;
      minimum = 0x10000;
    } else {
      throw new CanonicalJsonError(
        'UTF-8 input contains an invalid leading byte',
      );
    }
    if (index + length > input.length) {
      throw new CanonicalJsonError('UTF-8 input is truncated');
    }
    for (let offset = 1; offset < length; offset += 1) {
      const next = input[index + offset]!;
      if ((next & 0xc0) !== 0x80) {
        throw new CanonicalJsonError(
          'UTF-8 input contains an invalid continuation byte',
        );
      }
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (
      codePoint < minimum ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      throw new CanonicalJsonError('UTF-8 input is not minimally encoded');
    }
    codePoints.push(codePoint);
    index += length;
  }

  let result = '';
  for (const codePoint of codePoints) {
    if (codePoint <= 0xffff) {
      result += String.fromCharCode(codePoint);
    } else {
      const shifted = codePoint - 0x10000;
      result += String.fromCharCode(
        0xd800 | (shifted >> 10),
        0xdc00 | (shifted & 0x3ff),
      );
    }
  }
  assertCanonicalString(result, 'UTF-8 result');
  return result;
}

export function assertCanonicalString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new CanonicalJsonError(`${label} contains an unpaired surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalJsonError(`${label} contains an unpaired surrogate`);
    }
  }
  if (value.normalize('NFC') !== value) {
    throw new CanonicalJsonError(`${label} must use Unicode NFC`);
  }
}

function serializeCanonical(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
  budget: CanonicalJsonBudget,
): string {
  budget.nodes += 1;
  if (budget.nodes > MAX_CANONICAL_JSON_NODES) {
    throw new CanonicalJsonError('Canonical JSON exceeds the node budget');
  }
  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    throw new CanonicalJsonError('Canonical JSON exceeds the depth budget');
  }
  if (value === null) {
    consumeOutputBudget(budget, 4);
    return 'null';
  }
  if (typeof value === 'boolean') {
    consumeOutputBudget(budget, value ? 4 : 5);
    return value ? 'true' : 'false';
  }
  if (typeof value === 'string') {
    assertJsonStringBudget(value);
    assertCanonicalString(value, 'JSON string');
    const serialized = JSON.stringify(value);
    consumeOutputBudget(budget, serialized.length);
    return serialized;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new CanonicalJsonError('JSON numbers must be safe integers');
    }
    const serialized = String(value);
    consumeOutputBudget(budget, serialized.length);
    return serialized;
  }
  if (typeof value !== 'object') {
    throw new CanonicalJsonError('Value is outside the canonical JSON subset');
  }
  if (ancestors.has(value)) {
    throw new CanonicalJsonError('Canonical JSON cannot contain cycles');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new CanonicalJsonError(
          'Canonical JSON arrays must use the plain Array prototype',
        );
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new CanonicalJsonError(
          'Canonical JSON arrays cannot have symbol keys',
        );
      }
      const names = Object.getOwnPropertyNames(value);
      if (names.length !== value.length + 1 || !names.includes('length')) {
        throw new CanonicalJsonError(
          'Canonical JSON arrays cannot have extra or hidden fields',
        );
      }
      if (value.length > MAX_CANONICAL_JSON_NODES - budget.nodes) {
        throw new CanonicalJsonError('Canonical JSON exceeds the node budget');
      }
      consumeOutputBudget(
        budget,
        2 + (value.length === 0 ? 0 : value.length - 1),
      );
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor) {
          throw new CanonicalJsonError(
            'Canonical JSON arrays cannot be sparse',
          );
        }
        if (!descriptor.enumerable || !('value' in descriptor)) {
          throw new CanonicalJsonError(
            'Canonical JSON arrays cannot contain accessors or hidden entries',
          );
        }
        entries.push(
          serializeCanonical(descriptor.value, ancestors, depth + 1, budget),
        );
      }
      return `[${entries.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError(
        'Canonical JSON objects must be plain records',
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CanonicalJsonError(
        'Canonical JSON objects cannot have symbol keys',
      );
    }
    const names = Object.getOwnPropertyNames(value);
    const keys = Object.keys(value);
    if (names.length !== keys.length) {
      throw new CanonicalJsonError(
        'Canonical JSON objects cannot hide non-enumerable fields',
      );
    }
    if (keys.length > MAX_CANONICAL_JSON_NODES - budget.nodes) {
      throw new CanonicalJsonError('Canonical JSON exceeds the node budget');
    }
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !('value' in descriptor)) {
        throw new CanonicalJsonError(
          'Canonical JSON objects cannot contain accessors',
        );
      }
    }
    keys.sort();
    consumeOutputBudget(budget, 2 + (keys.length === 0 ? 0 : keys.length - 1));
    return `{${keys
      .map((key) => {
        assertJsonStringBudget(key);
        assertCanonicalString(key, 'JSON object key');
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        const serializedKey = JSON.stringify(key);
        consumeOutputBudget(budget, serializedKey.length + 1);
        return `${serializedKey}:${serializeCanonical(
          descriptor.value,
          ancestors,
          depth + 1,
          budget,
        )}`;
      })
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function assertCanonicalJsonTextBudget(input: string): void {
  if (input.length > MAX_CANONICAL_JSON_OUTPUT_CODE_UNITS) {
    throw new CanonicalJsonError(
      'Canonical JSON input exceeds the size budget',
    );
  }
  let depth = 0;
  let lexicalTokens = 0;
  let inString = false;
  let inPrimitive = false;
  let stringCodeUnits = 0;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (inString) {
      if (character === '"') {
        inString = false;
        continue;
      }
      if (character === '\\') {
        const escaped = input[index + 1];
        if (escaped === 'u') index += 5;
        else index += 1;
      }
      stringCodeUnits += 1;
      if (stringCodeUnits > MAX_CANONICAL_JSON_STRING_CODE_UNITS) {
        throw new CanonicalJsonError(
          'Canonical JSON string exceeds the size budget',
        );
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      inPrimitive = false;
      stringCodeUnits = 0;
      lexicalTokens += 1;
    } else if (character === '{' || character === '[') {
      inPrimitive = false;
      depth += 1;
      lexicalTokens += 1;
      if (depth > MAX_CANONICAL_JSON_DEPTH) {
        throw new CanonicalJsonError('Canonical JSON exceeds the depth budget');
      }
    } else if (character === '}' || character === ']') {
      inPrimitive = false;
      depth -= 1;
    } else if (
      character === ',' ||
      character === ':' ||
      character === ' ' ||
      character === '\n' ||
      character === '\r' ||
      character === '\t'
    ) {
      inPrimitive = false;
    } else if (!inPrimitive) {
      inPrimitive = true;
      lexicalTokens += 1;
    }

    if (lexicalTokens > MAX_CANONICAL_JSON_LEXICAL_TOKENS) {
      throw new CanonicalJsonError('Canonical JSON exceeds the node budget');
    }
  }
}

function assertJsonStringBudget(value: string): void {
  if (value.length > MAX_CANONICAL_JSON_STRING_CODE_UNITS) {
    throw new CanonicalJsonError(
      'Canonical JSON string exceeds the size budget',
    );
  }
}

function consumeOutputBudget(
  budget: CanonicalJsonBudget,
  codeUnits: number,
): void {
  budget.outputCodeUnits += codeUnits;
  if (budget.outputCodeUnits > MAX_CANONICAL_JSON_OUTPUT_CODE_UNITS) {
    throw new CanonicalJsonError(
      'Canonical JSON exceeds the output size budget',
    );
  }
}

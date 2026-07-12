export type CanonicalRemoteValue =
  | null
  | boolean
  | number
  | string
  | CanonicalRemoteValue[]
  | { [key: string]: CanonicalRemoteValue };

function sortCanonicalValue(value: unknown): CanonicalRemoteValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortCanonicalValue(entry)]),
    );
  }
  throw new Error('Remote protocol payload is not canonicalizable');
}

export function canonicalizeRemotePayload(value: unknown): string {
  return JSON.stringify(sortCanonicalValue(value));
}

export function createRemoteSignaturePayload(
  context: string,
  value: unknown,
): string {
  return `${context}\n${canonicalizeRemotePayload(value)}`;
}

export const REMOTE_SIGNATURE_CONTEXTS = {
  pairingRequest: 'clodex.remote.pairing-request.v2',
  pairingResponse: 'clodex.remote.pairing-response.v2',
  sessionHello: 'clodex.remote.session-hello.v2',
  sessionHelloAck: 'clodex.remote.session-hello-ack.v2',
  environmentAttestation: 'clodex.remote.environment-attestation.v1',
} as const;

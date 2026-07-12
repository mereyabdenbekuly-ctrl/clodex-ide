import { gcm } from '@noble/ciphers/aes.js';
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { createRemoteSignaturePayload } from './remote-control-canonical';

const encoder = new TextEncoder();
const P256_SPKI_PREFIX = new Uint8Array([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);
const CLIENT_TO_SERVER_IV_PREFIX = 0x434c4e54;
const SERVER_TO_CLIENT_IV_PREFIX = 0x53525652;

export interface RemoteBrowserKeyPair {
  privateKey: string;
  publicKey: string;
}

export interface RemoteBrowserSessionKeyInput {
  privateKey: string;
  peerPublicKey: string;
  clientNonce: string;
  serverNonce: string;
  sessionId: string;
}

export function encodeRemoteBrowserBase64Url(value: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < value.length; index += 1) {
    binary += String.fromCharCode(value[index]!);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function decodeRemoteBrowserBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function joinBytes(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    values.reduce((length, value) => length + value.length, 0),
  );
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function rawP256PublicKeyToSpki(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error('P-256 public key must be an uncompressed SEC1 point');
  }
  return joinBytes(P256_SPKI_PREFIX, publicKey);
}

function spkiToRawP256PublicKey(publicKey: string): Uint8Array {
  const spki = decodeRemoteBrowserBase64Url(publicKey);
  if (spki.length !== P256_SPKI_PREFIX.length + 65) {
    throw new Error('P-256 SPKI public key has an invalid length');
  }
  for (let index = 0; index < P256_SPKI_PREFIX.length; index += 1) {
    if (spki[index] !== P256_SPKI_PREFIX[index]) {
      throw new Error('P-256 SPKI public key has an invalid prefix');
    }
  }
  const raw = spki.slice(P256_SPKI_PREFIX.length);
  if (raw[0] !== 0x04 || !p256.utils.isValidPublicKey(raw, false)) {
    throw new Error('P-256 SPKI public key is invalid');
  }
  return raw;
}

function createRandomBytes(length: number): Uint8Array {
  const value = new Uint8Array(length);
  globalThis.crypto.getRandomValues(value);
  return value;
}

export function createRemoteBrowserUuid(): string {
  const value = createRandomBytes(16);
  value[6] = (value[6]! & 0x0f) | 0x40;
  value[8] = (value[8]! & 0x3f) | 0x80;
  const hex = Array.from(value, (byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

export function createRemoteBrowserNonce(): string {
  return encodeRemoteBrowserBase64Url(createRandomBytes(16));
}

export function createRemoteBrowserKeyPair(): RemoteBrowserKeyPair {
  const privateKey = p256.utils.randomSecretKey();
  return {
    privateKey: encodeRemoteBrowserBase64Url(privateKey),
    publicKey: encodeRemoteBrowserBase64Url(
      rawP256PublicKeyToSpki(p256.getPublicKey(privateKey, false)),
    ),
  };
}

export function signRemoteBrowserPayload(
  privateKey: string,
  context: string,
  payload: unknown,
): string {
  const signature = p256.sign(
    encoder.encode(createRemoteSignaturePayload(context, payload)),
    decodeRemoteBrowserBase64Url(privateKey),
    { format: 'compact' },
  );
  return encodeRemoteBrowserBase64Url(signature);
}

export function verifyRemoteBrowserPayload(
  publicKey: string,
  context: string,
  payload: unknown,
  signature: string,
): boolean {
  try {
    return p256.verify(
      decodeRemoteBrowserBase64Url(signature),
      encoder.encode(createRemoteSignaturePayload(context, payload)),
      spkiToRawP256PublicKey(publicKey),
      // OpenSSL/Node ECDSA signing permits high-S signatures by default.
      // Verification must accept both canonical low-S and equivalent high-S
      // signatures to interoperate with the persistent desktop identity.
      { format: 'compact', lowS: false },
    );
  } catch {
    return false;
  }
}

export function getRemoteBrowserPublicKeyFingerprint(
  publicKey: string,
): string {
  return encodeRemoteBrowserBase64Url(
    sha256(decodeRemoteBrowserBase64Url(publicKey)),
  );
}

export function deriveRemoteBrowserSessionKey(
  input: RemoteBrowserSessionKeyInput,
): Uint8Array {
  const sharedPoint = p256.getSharedSecret(
    decodeRemoteBrowserBase64Url(input.privateKey),
    spkiToRawP256PublicKey(input.peerPublicKey),
    false,
  );
  const sharedSecret = sharedPoint.slice(1, 33);
  const salt = sha256(
    encoder.encode(`${input.clientNonce}.${input.serverNonce}`),
  );
  return hkdf(
    sha256,
    sharedSecret,
    salt,
    encoder.encode(`clodex.remote.session.v2:${input.sessionId}`),
    32,
  );
}

function createRemoteBrowserIv(
  direction: 'client-to-server' | 'server-to-client',
  sequence: number,
): Uint8Array {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error('Remote message sequence is invalid');
  }
  const value = new Uint8Array(12);
  const view = new DataView(value.buffer);
  view.setUint32(
    0,
    direction === 'client-to-server'
      ? CLIENT_TO_SERVER_IV_PREFIX
      : SERVER_TO_CLIENT_IV_PREFIX,
  );
  view.setUint32(4, Math.floor(sequence / 0x1_0000_0000));
  view.setUint32(8, sequence >>> 0);
  return value;
}

function createRemoteBrowserAad(
  sessionId: string,
  direction: 'client-to-server' | 'server-to-client',
  sequence: number,
): Uint8Array {
  return encoder.encode(
    `clodex.remote.secure.v2:${sessionId}:${direction}:${sequence}`,
  );
}

export function encryptRemoteBrowserMessage(
  key: Uint8Array,
  sessionId: string,
  direction: 'client-to-server' | 'server-to-client',
  sequence: number,
  plaintext: string,
): string {
  const cipher = gcm(
    key,
    createRemoteBrowserIv(direction, sequence),
    createRemoteBrowserAad(sessionId, direction, sequence),
  );
  return encodeRemoteBrowserBase64Url(
    cipher.encrypt(encoder.encode(plaintext)),
  );
}

export function decryptRemoteBrowserMessage(
  key: Uint8Array,
  sessionId: string,
  direction: 'client-to-server' | 'server-to-client',
  sequence: number,
  ciphertext: string,
): string {
  const cipher = gcm(
    key,
    createRemoteBrowserIv(direction, sequence),
    createRemoteBrowserAad(sessionId, direction, sequence),
  );
  return new TextDecoder().decode(
    cipher.decrypt(decodeRemoteBrowserBase64Url(ciphertext)),
  );
}

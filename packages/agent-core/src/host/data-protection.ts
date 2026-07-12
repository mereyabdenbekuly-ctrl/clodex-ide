import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ENVELOPE_FORMAT = 'clodex-protected';
const ENVELOPE_VERSION = 1;
const STRING_PREFIX = `${ENVELOPE_FORMAT}:v${ENVELOPE_VERSION}:`;
const GENERIC_STRING_PREFIX = `${ENVELOPE_FORMAT}:`;
const BUFFER_PREFIX = Buffer.from(`${STRING_PREFIX}\0`, 'utf-8');
const GENERIC_BUFFER_PREFIX = Buffer.from(GENERIC_STRING_PREFIX, 'utf-8');

const KEY_LENGTH = 32;
const KEY_ID_LENGTH = 8;
const NONCE_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MINIMUM_PAYLOAD_LENGTH = KEY_ID_LENGTH + NONCE_LENGTH + AUTH_TAG_LENGTH;

/**
 * Host-provided encryption capability for persistence owned by agent-core.
 *
 * The interface is synchronous because Drizzle's custom JSON codecs and the
 * agent persistence transaction are synchronous at their serialization
 * boundary. Hosts should load/unlock their key before constructing AgentHost.
 */
export interface DataProtection {
  isProtectedString(value: string): boolean;
  protectString(value: string, context: string): string;
  unprotectString(value: string, context: string): string;
  isProtectedBuffer(value: Uint8Array): boolean;
  protectBuffer(value: Uint8Array, context: string): Buffer;
  unprotectBuffer(value: Uint8Array, context: string): Buffer;
}

/**
 * Detects the reserved string namespace, including envelopes from unknown
 * future versions. Callers use this to fail closed when no protector exists.
 */
export function isDataProtectionEnvelopeString(value: string): boolean {
  return value.startsWith(GENERIC_STRING_PREFIX);
}

/**
 * Detects the reserved binary namespace, including envelopes from unknown
 * future versions. Callers use this to fail closed when no protector exists.
 */
export function isDataProtectionEnvelopeBuffer(value: Uint8Array): boolean {
  const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return (
    buffer.length >= GENERIC_BUFFER_PREFIX.length &&
    buffer
      .subarray(0, GENERIC_BUFFER_PREFIX.length)
      .equals(GENERIC_BUFFER_PREFIX)
  );
}

/**
 * AES-256-GCM data protector with versioned, context-bound envelopes.
 *
 * Each ciphertext uses a fresh 96-bit nonce. The envelope carries a short
 * SHA-256-derived key id so key rotation/mismatch failures are explicit. The
 * caller-supplied context is authenticated as AAD, preventing ciphertext from
 * being copied between fields, agents, or message sequence numbers.
 */
export class AeadDataProtection implements DataProtection {
  private readonly key: Buffer;
  private readonly keyId: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== KEY_LENGTH) {
      throw new Error(
        `Data protection key must be exactly ${KEY_LENGTH} bytes`,
      );
    }

    this.key = Buffer.from(key);
    this.keyId = createHash('sha256')
      .update(this.key)
      .digest()
      .subarray(0, KEY_ID_LENGTH);
  }

  isProtectedString(value: string): boolean {
    return isDataProtectionEnvelopeString(value);
  }

  protectString(value: string, context: string): string {
    const payload = this.encrypt(Buffer.from(value, 'utf-8'), context);
    return `${STRING_PREFIX}${payload.toString('base64url')}`;
  }

  unprotectString(value: string, context: string): string {
    if (!value.startsWith(STRING_PREFIX)) {
      if (isDataProtectionEnvelopeString(value)) {
        throw new Error('Unsupported data protection envelope version');
      }
      throw new Error('Value is not a protected string');
    }

    const encoded = value.slice(STRING_PREFIX.length);
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
      throw new Error('Protected string payload is not valid base64url');
    }

    const payload = Buffer.from(encoded, 'base64url');
    if (payload.toString('base64url') !== encoded) {
      throw new Error('Protected string payload is not canonical base64url');
    }

    return this.decrypt(payload, context).toString('utf-8');
  }

  isProtectedBuffer(value: Uint8Array): boolean {
    return isDataProtectionEnvelopeBuffer(value);
  }

  protectBuffer(value: Uint8Array, context: string): Buffer {
    const plaintext = Buffer.from(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
    return Buffer.concat([BUFFER_PREFIX, this.encrypt(plaintext, context)]);
  }

  unprotectBuffer(value: Uint8Array, context: string): Buffer {
    const envelope = Buffer.from(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
    if (!envelope.subarray(0, BUFFER_PREFIX.length).equals(BUFFER_PREFIX)) {
      if (isDataProtectionEnvelopeBuffer(envelope)) {
        throw new Error('Unsupported data protection envelope version');
      }
      throw new Error('Value is not a protected buffer');
    }

    return this.decrypt(envelope.subarray(BUFFER_PREFIX.length), context);
  }

  private encrypt(plaintext: Buffer, context: string): Buffer {
    const aad = createAad(context);
    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([this.keyId, nonce, authTag, ciphertext]);
  }

  private decrypt(payload: Buffer, context: string): Buffer {
    if (payload.length < MINIMUM_PAYLOAD_LENGTH) {
      throw new Error('Protected data payload is truncated');
    }

    const keyId = payload.subarray(0, KEY_ID_LENGTH);
    if (!timingSafeEqual(keyId, this.keyId)) {
      throw new Error('Data protection key does not match envelope');
    }

    const nonceStart = KEY_ID_LENGTH;
    const authTagStart = nonceStart + NONCE_LENGTH;
    const ciphertextStart = authTagStart + AUTH_TAG_LENGTH;
    const nonce = payload.subarray(nonceStart, authTagStart);
    const authTag = payload.subarray(authTagStart, ciphertextStart);
    const ciphertext = payload.subarray(ciphertextStart);

    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce, {
        authTagLength: AUTH_TAG_LENGTH,
      });
      decipher.setAAD(createAad(context));
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (error) {
      throw new Error('Protected data authentication failed', {
        cause: error,
      });
    }
  }
}

function createAad(context: string): Buffer {
  if (context.length === 0) {
    throw new Error('Data protection context must not be empty');
  }
  return Buffer.from(
    `${ENVELOPE_FORMAT}/v${ENVELOPE_VERSION}\0${context}`,
    'utf-8',
  );
}

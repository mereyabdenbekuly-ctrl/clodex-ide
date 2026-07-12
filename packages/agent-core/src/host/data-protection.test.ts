import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AeadDataProtection,
  isDataProtectionEnvelopeBuffer,
  isDataProtectionEnvelopeString,
} from './data-protection';

describe('AeadDataProtection', () => {
  it('round-trips strings and emits randomized ciphertext', () => {
    const protection = new AeadDataProtection(randomBytes(32));
    const first = protection.protectString('session secret', 'agent/a/input');
    const second = protection.protectString('session secret', 'agent/a/input');

    expect(first).not.toBe(second);
    expect(first).not.toContain('session secret');
    expect(protection.isProtectedString(first)).toBe(true);
    expect(isDataProtectionEnvelopeString(first)).toBe(true);
    expect(protection.unprotectString(first, 'agent/a/input')).toBe(
      'session secret',
    );
    expect(protection.unprotectString(second, 'agent/a/input')).toBe(
      'session secret',
    );
  });

  it('round-trips arbitrary buffers', () => {
    const protection = new AeadDataProtection(randomBytes(32));
    const plaintext = Buffer.from([0, 1, 2, 127, 128, 255]);
    const protectedValue = protection.protectBuffer(
      plaintext,
      'attachments/a/blob',
    );

    expect(protectedValue.equals(plaintext)).toBe(false);
    expect(protection.isProtectedBuffer(protectedValue)).toBe(true);
    expect(isDataProtectionEnvelopeBuffer(protectedValue)).toBe(true);
    expect(
      protection
        .unprotectBuffer(protectedValue, 'attachments/a/blob')
        .equals(plaintext),
    ).toBe(true);
  });

  it('binds ciphertext to its context', () => {
    const protection = new AeadDataProtection(randomBytes(32));
    const protectedValue = protection.protectString(
      'secret',
      'agent/a/queuedMessages',
    );

    expect(() =>
      protection.unprotectString(protectedValue, 'agent/b/queuedMessages'),
    ).toThrow('authentication failed');
  });

  it('rejects tampered ciphertext', () => {
    const protection = new AeadDataProtection(randomBytes(32));
    const protectedValue = protection.protectString('secret', 'agent/a/input');
    const last = protectedValue.at(-1)!;
    const tampered = `${protectedValue.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;

    expect(() =>
      protection.unprotectString(tampered, 'agent/a/input'),
    ).toThrow();
  });

  it('rejects a different key before attempting decryption', () => {
    const first = new AeadDataProtection(randomBytes(32));
    const second = new AeadDataProtection(randomBytes(32));
    const protectedValue = first.protectString('secret', 'agent/a/input');

    expect(() =>
      second.unprotectString(protectedValue, 'agent/a/input'),
    ).toThrow('key does not match');
  });

  it('rejects malformed and unknown envelopes', () => {
    const protection = new AeadDataProtection(randomBytes(32));

    expect(() =>
      protection.unprotectString('clodex-protected:v2:AAAA', 'ctx'),
    ).toThrow('Unsupported');
    expect(() =>
      protection.unprotectString('clodex-protected:v1:not+padded', 'ctx'),
    ).toThrow('base64url');
    expect(() =>
      protection.unprotectBuffer(
        Buffer.from('clodex-protected:v2\0AAAA'),
        'ctx',
      ),
    ).toThrow('Unsupported');
    expect(() => protection.unprotectString('plaintext', 'ctx')).toThrow(
      'not a protected string',
    );
  });

  it('requires a 256-bit key and a non-empty context', () => {
    expect(() => new AeadDataProtection(randomBytes(31))).toThrow(
      'exactly 32 bytes',
    );

    const protection = new AeadDataProtection(randomBytes(32));
    expect(() => protection.protectString('secret', '')).toThrow(
      'must not be empty',
    );
  });
});

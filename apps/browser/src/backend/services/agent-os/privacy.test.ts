import { describe, expect, it } from 'vitest';
import { redactSensitiveText, sanitizeDebugPayload } from './privacy';

describe('Agent OS privacy filters', () => {
  it('redacts supported secret formats before persistence', () => {
    const input = [
      'sk-abcdefghijklmnopqrstuvwxyz0123456789',
      'ghp_abcdefghijklmnopqrstuvwxyz012345',
      'github_pat_abcdefghijklmnopqrstuvwxyz012345',
      'xoxb-123456789012-abcdefghijklmnopqrstuvwxyz',
      'AKIA1234567890ABCDEF',
      '-----BEGIN TEST PRIVATE KEY-----',
      'private-key-body',
      '-----END TEST PRIVATE KEY-----',
      'aaaabbbbccccdddd11112222.zzzzyyyyxxxx.abcdefghijkl',
      'Authorization: Bearer opaque-access-token-123456',
      'api_key=plain-secret-value',
    ].join('\n');

    const result = redactSensitiveText(input);

    expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(result).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(result).not.toContain('github_pat_abcdefghijklmnopqrstuvwxyz');
    expect(result).not.toContain('xoxb-123456789012');
    expect(result).not.toContain('AKIA1234567890ABCDEF');
    expect(result).not.toContain('private-key-body');
    expect(result).not.toContain('aaaabbbbccccdddd11112222');
    expect(result).not.toContain('opaque-access-token-123456');
    expect(result).not.toContain('plain-secret-value');
    expect(result.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(9);
  });

  it('redacts emails only when strict privacy requests it', () => {
    expect(
      redactSensitiveText('Contact alice@example.com', {
        redactEmails: true,
      }),
    ).toBe('Contact [REDACTED_EMAIL]');
    expect(redactSensitiveText('Contact alice@example.com')).toBe(
      'Contact alice@example.com',
    );
  });

  it('recursively removes secret-keyed values and handles cycles', () => {
    const payload: Record<string, unknown> = {
      authorization: 'Bearer should-never-appear',
      nested: {
        apiKey: 'secret-value',
        safe: 'visible',
        tokenInText: 'sk-abcdefghijklmnopqrstuvwxyz0123456789',
      },
    };
    payload.circular = payload;

    expect(sanitizeDebugPayload(payload)).toEqual({
      authorization: '[REDACTED]',
      nested: {
        apiKey: '[REDACTED]',
        safe: 'visible',
        tokenInText: '[REDACTED]',
      },
      circular: '[Circular]',
    });
  });
});

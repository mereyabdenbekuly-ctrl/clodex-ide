import {
  createDecipheriv,
  createHmac,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
} from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CloudTaskSecretBroker,
  createServerRecipientSnapshotCryptoProvider,
  type CloudTaskSecretBrokerTransport,
} from './cloud-task-security';

describe('CloudTaskSecretBroker', () => {
  it('issues a task-bound short-lived lease and revokes it once', async () => {
    const now = 1_000_000;
    const transport: CloudTaskSecretBrokerTransport = {
      issueCredential: vi.fn(async (request) => ({
        credentialId: 'cred-1',
        taskId: request.taskId,
        audience: request.audience,
        residency: request.residency,
        scopes: [...request.scopes],
        token: 'short-lived-secret-token',
        issuedAt: now,
        expiresAt: now + 60_000,
      })),
      revokeCredential: vi.fn(async () => {}),
    };
    const broker = new CloudTaskSecretBroker({
      transport,
      getAccountAccessToken: () => 'account-token',
      audience: 'cloud-task-runtime',
      now: () => now,
    });

    const lease = await broker.acquire({
      taskId: 'task-1',
      residency: 'eu',
      scopes: ['task:stream', 'task:start', 'task:cancel'],
    });

    expect(lease).toMatchObject({
      credentialId: 'cred-1',
      token: 'short-lived-secret-token',
      scopes: ['task:cancel', 'task:start', 'task:stream'],
    });
    expect(transport.issueCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        residency: 'eu',
        scopes: ['task:cancel', 'task:start', 'task:stream'],
      }),
      'account-token',
      undefined,
    );
    await lease.dispose();
    await lease.dispose();
    expect(transport.revokeCredential).toHaveBeenCalledOnce();
  });

  it('fails closed for missing auth, expanded scopes and excessive TTL', async () => {
    const now = 1_000_000;
    const baseResponse = {
      credentialId: 'cred-1',
      taskId: 'task-1',
      audience: 'cloud-task-runtime',
      residency: 'us' as const,
      scopes: ['task:start' as const],
      token: 'token',
      issuedAt: now,
      expiresAt: now + 60_000,
    };
    const transport: CloudTaskSecretBrokerTransport = {
      issueCredential: vi.fn(async () => baseResponse),
      revokeCredential: vi.fn(async () => {}),
    };
    const noAuth = new CloudTaskSecretBroker({
      transport,
      getAccountAccessToken: () => undefined,
      audience: 'cloud-task-runtime',
      now: () => now,
    });
    await expect(
      noAuth.acquire({
        taskId: 'task-1',
        residency: 'us',
        scopes: ['task:start'],
      }),
    ).rejects.toMatchObject({ reason: 'auth-unavailable' });

    const expanded = new CloudTaskSecretBroker({
      transport: {
        ...transport,
        issueCredential: vi.fn(async () => ({
          ...baseResponse,
          scopes: ['task:start' as const, 'artifact:read' as const],
        })),
      },
      getAccountAccessToken: () => 'account-token',
      audience: 'cloud-task-runtime',
      now: () => now,
    });
    await expect(
      expanded.acquire({
        taskId: 'task-1',
        residency: 'us',
        scopes: ['task:start'],
      }),
    ).rejects.toMatchObject({ reason: 'scope-mismatch' });

    const excessiveTtl = new CloudTaskSecretBroker({
      transport: {
        ...transport,
        issueCredential: vi.fn(async () => ({
          ...baseResponse,
          expiresAt: now + 16 * 60_000,
        })),
      },
      getAccountAccessToken: () => 'account-token',
      audience: 'cloud-task-runtime',
      now: () => now,
    });
    await expect(
      excessiveTtl.acquire({
        taskId: 'task-1',
        residency: 'us',
        scopes: ['task:start'],
      }),
    ).rejects.toMatchObject({ reason: 'ttl-invalid' });
  });
});

describe('server-recipient snapshot crypto', () => {
  it('wraps the data key for the server and signs the manifest', async () => {
    const server = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const provider = createServerRecipientSnapshotCryptoProvider({
      taskId: 'task-1',
      recipient: {
        algorithm: 'p256',
        keyId: 'server-key-1',
        publicKeySpki: server.publicKey
          .export({ format: 'der', type: 'spki' })
          .toString('base64url'),
        expiresAt: 2_000_000,
      },
      now: () => 1_000_000,
      randomBytes: (size) => Buffer.alloc(size, 9),
    });
    const dataKey = Buffer.alloc(32, 7);
    const wrapped = await provider.wrapDataKey({
      taskId: 'task-1',
      dataKey,
    });
    const envelope = JSON.parse(
      Buffer.from(wrapped.value, 'base64url').toString('utf8'),
    ) as {
      ephemeralPublicKey: string;
      nonce: string;
      ciphertext: string;
      authTag: string;
    };

    const ephemeralPublicKey = await importP256PublicKey(
      envelope.ephemeralPublicKey,
    );
    const sharedSecret = diffieHellman({
      privateKey: server.privateKey,
      publicKey: ephemeralPublicKey,
    });
    const salt = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256')
        .update('clodex.cloud-task.recipient.v1\0task-1\0server-key-1', 'utf8')
        .digest(),
    );
    const keyMaterial = Buffer.from(
      hkdfSync(
        'sha256',
        sharedSecret,
        salt,
        Buffer.from('snapshot-wrap-and-sign', 'utf8'),
        64,
      ),
    );
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyMaterial.subarray(0, 32),
      Buffer.from(envelope.nonce, 'base64url'),
    );
    decipher.setAAD(
      Buffer.from('clodex.cloud-task.wrap.v1\0task-1\0server-key-1', 'utf8'),
    );
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64url'));
    const unwrapped = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]);
    expect(unwrapped).toEqual(dataKey);

    const manifest = Buffer.from('{"version":1}', 'utf8');
    const signature = await provider.signManifest({
      taskId: 'task-1',
      canonicalManifest: manifest,
    });
    expect(signature.value).toBe(
      createHmac('sha256', keyMaterial.subarray(32, 64))
        .update('clodex.cloud-task.manifest.v1\0task-1\0', 'utf8')
        .update(manifest)
        .digest('base64url'),
    );
    provider.dispose();
    await expect(
      provider.signManifest({
        taskId: 'task-1',
        canonicalManifest: manifest,
      }),
    ).rejects.toMatchObject({ reason: 'provider-disposed' });
  });

  it('rejects expired and non-P-256 recipient keys', () => {
    const p256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(() =>
      createServerRecipientSnapshotCryptoProvider({
        taskId: 'task-1',
        recipient: {
          algorithm: 'p256',
          keyId: 'server-key',
          publicKeySpki: p256.publicKey
            .export({ format: 'der', type: 'spki' })
            .toString('base64url'),
          expiresAt: 999,
        },
        now: () => 1_000,
      }),
    ).toThrow('expired');

    const ed25519 = generateKeyPairSync('ed25519');
    expect(() =>
      createServerRecipientSnapshotCryptoProvider({
        taskId: 'task-1',
        recipient: {
          algorithm: 'p256',
          keyId: 'server-key',
          publicKeySpki: ed25519.publicKey
            .export({ format: 'der', type: 'spki' })
            .toString('base64url'),
          expiresAt: 2_000,
        },
        now: () => 1_000,
      }),
    ).toThrow('invalid');
  });
});

async function importP256PublicKey(encoded: string) {
  const { createPublicKey } = await import('node:crypto');
  return createPublicKey({
    key: Buffer.from(encoded, 'base64url'),
    format: 'der',
    type: 'spki',
  });
}

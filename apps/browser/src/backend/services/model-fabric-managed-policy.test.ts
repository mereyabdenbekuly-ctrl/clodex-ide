import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  LiveControlPlaneModelFabricPolicyRefresher,
  canonicalizeCrossSignedModelFabricKeyset,
  canonicalizeSignedModelFabricKeyset,
  canonicalizeSignedModelFabricPolicy,
  canonicalizeSignedModelFabricRootset,
  resolveControlPlaneModelFabricBudgetPolicies,
  resolveManagedModelFabricBudgetPolicies,
  resolveSignedModelFabricBudgetPolicies,
} from './model-fabric-managed-policy';

describe('resolveManagedModelFabricBudgetPolicies', () => {
  it('distinguishes an absent override from a valid managed configuration', () => {
    expect(resolveManagedModelFabricBudgetPolicies(undefined)).toBeNull();
    expect(resolveManagedModelFabricBudgetPolicies('   ')).toBeNull();

    expect(
      resolveManagedModelFabricBudgetPolicies(
        JSON.stringify([
          {
            id: 'org-task-daily',
            scope: 'task',
            scopeRef: '*',
            windowMs: 86_400_000,
            limitUsd: 25,
            mode: 'hard',
          },
        ]),
      ),
    ).toEqual({
      source: 'environment',
      policies: [
        {
          id: 'org-task-daily',
          scope: 'task',
          scopeRef: '*',
          windowMs: 86_400_000,
          limitUsd: 25,
          mode: 'hard',
        },
      ],
      error: null,
    });
  });

  it('fails closed with content-free errors for invalid managed input', () => {
    const rawSecret = 'do-not-leak-managed-payload';
    const malformed = resolveManagedModelFabricBudgetPolicies(
      `{"secret":"${rawSecret}"`,
    );
    const invalid = resolveManagedModelFabricBudgetPolicies(
      JSON.stringify([{ secret: rawSecret }]),
    );

    expect(malformed).toEqual({
      source: 'environment',
      policies: [],
      error: 'Managed budget policy JSON could not be parsed',
    });
    expect(invalid).toEqual({
      source: 'environment',
      policies: [],
      error: 'Managed budget policy configuration failed validation',
    });
    expect(JSON.stringify([malformed, invalid])).not.toContain(rawSecret);
  });
});

describe('resolveSignedModelFabricBudgetPolicies', () => {
  it('verifies an unexpired Ed25519 envelope and returns locked policies', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const payload = {
      schemaVersion: 1 as const,
      keyId: 'enterprise-key-1',
      issuedAt: 1_000,
      expiresAt: 10_000,
      policies: [
        {
          id: 'org-global',
          scope: 'global' as const,
          scopeRef: 'global',
          windowMs: 86_400_000,
          limitUsd: 250,
          mode: 'hard' as const,
        },
      ],
    };
    const signature = sign(
      null,
      Buffer.from(canonicalizeSignedModelFabricPolicy(payload)),
      privateKey,
    ).toString('base64');

    await expect(
      resolveSignedModelFabricBudgetPolicies({
        filePath: '/managed/model-fabric.json',
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        now: () => 2_000,
        readFile: async () =>
          Buffer.from(JSON.stringify({ ...payload, signature })),
      }),
    ).resolves.toEqual({
      source: 'signed-file',
      policies: payload.policies,
      error: null,
    });
  });

  it('fails closed for tampering, expiry, and missing key without leaking file content', async () => {
    const rawSecret = 'never-log-signed-policy-content';
    const readFile = async () =>
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          keyId: rawSecret,
          issuedAt: 1,
          expiresAt: 2,
          policies: [],
          signature: Buffer.alloc(64).toString('base64'),
        }),
      );
    const missingKey = await resolveSignedModelFabricBudgetPolicies({
      filePath: '/managed/policy.json',
      publicKey: undefined,
      readFile,
    });
    const expired = await resolveSignedModelFabricBudgetPolicies({
      filePath: '/managed/policy.json',
      publicKey:
        '-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----',
      now: () => 3,
      readFile,
    });

    expect(missingKey).toMatchObject({
      source: 'signed-file',
      policies: [],
      error: 'Managed signed policy public key is missing',
    });
    expect(expired).toMatchObject({
      source: 'signed-file',
      policies: [],
      error: 'Managed signed policy has expired',
    });
    expect(JSON.stringify([missingKey, expired])).not.toContain(rawSecret);
  });
});

describe('resolveControlPlaneModelFabricBudgetPolicies', () => {
  it('rejects non-HTTPS and credential-bearing URLs before any request', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const fetch = vi.fn();
    const publicKeyPem = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();

    for (const url of [
      'http://policies.example.com/model-fabric',
      'https://user:secret@policies.example.com/model-fabric',
      'https://policies.example.com/model-fabric#fragment',
    ]) {
      await expect(
        resolveControlPlaneModelFabricBudgetPolicies({
          url,
          publicKey: publicKeyPem,
          fetch: fetch as typeof globalThis.fetch,
        }),
      ).resolves.toEqual({
        source: 'control-plane',
        policies: [],
        error: 'Managed control-plane URL is invalid',
        cached: false,
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('verifies a remote revision and persists a cache for offline startup', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const envelope = signedEnvelope(privateKey, {
      revision: 7,
      issuedAt: 1_000,
      expiresAt: 10_000,
    });
    let cache: Buffer | null = null;
    const online = await resolveControlPlaneModelFabricBudgetPolicies({
      url: 'https://policies.example.com/model-fabric',
      publicKey: publicKeyPem,
      bearerToken: 'secret-token',
      now: () => 2_000,
      fetch: vi.fn(async (_url, init) => {
        expect((init?.headers as Record<string, string>).authorization).toBe(
          'Bearer secret-token',
        );
        return new Response(JSON.stringify(envelope), {
          status: 200,
          headers: { etag: '"revision-7"' },
        });
      }) as typeof fetch,
      writeCache: async (content) => {
        cache = content;
      },
    });
    expect(online).toMatchObject({
      source: 'control-plane',
      error: null,
      cached: false,
      policies: [{ id: 'org-global' }],
    });
    expect(cache).not.toBeNull();

    await expect(
      resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey: publicKeyPem,
        now: () => 3_000,
        fetch: vi.fn(async () => {
          throw new Error('offline');
        }) as typeof fetch,
        readCache: async () => cache,
        writeCache: async () => undefined,
      }),
    ).resolves.toMatchObject({
      source: 'control-plane',
      error: null,
      cached: true,
      policies: [{ id: 'org-global' }],
    });

    await expect(
      resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey: publicKeyPem,
        now: () => 3_000,
        fetch: vi.fn(
          async () => new Response(null, { status: 503 }),
        ) as typeof fetch,
        readCache: async () => cache,
        writeCache: async () => undefined,
      }),
    ).resolves.toMatchObject({
      source: 'control-plane',
      error: null,
      cached: true,
      policies: [{ id: 'org-global' }],
    });
  });

  it('rejects a validly signed lower revision instead of downgrading to cache', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    let cache: Buffer | null = null;
    await resolveControlPlaneModelFabricBudgetPolicies({
      url: 'https://policies.example.com/model-fabric',
      publicKey: publicKeyPem,
      now: () => 2_000,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              signedEnvelope(privateKey, {
                revision: 8,
                issuedAt: 1_000,
                expiresAt: 10_000,
              }),
            ),
          ),
      ) as typeof fetch,
      writeCache: async (content) => {
        cache = content;
      },
    });

    await expect(
      resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey: publicKeyPem,
        now: () => 3_000,
        fetch: vi.fn(
          async () =>
            new Response(
              JSON.stringify(
                signedEnvelope(privateKey, {
                  revision: 7,
                  issuedAt: 1_000,
                  expiresAt: 10_000,
                }),
              ),
            ),
        ) as typeof fetch,
        readCache: async () => cache,
        writeCache: async () => undefined,
      }),
    ).resolves.toEqual({
      source: 'control-plane',
      policies: [],
      error: 'Managed control-plane policy rollback was rejected',
      cached: false,
    });
  });

  it('durably quarantines cached policy after a security rejection until a fresh revision succeeds', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = toPublicKeyPem(publicKey);
    let cache: Buffer | null = null;
    const resolveWithEnvelope = async (
      revision: number,
      now: number,
      expiresAt = 10_000,
    ) =>
      await resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey: publicKeyPem,
        now: () => now,
        fetch: vi.fn(
          async () =>
            new Response(
              JSON.stringify(
                signedEnvelope(privateKey, {
                  revision,
                  issuedAt: 1_000,
                  expiresAt,
                }),
              ),
            ),
        ) as typeof fetch,
        readCache: async () => cache,
        writeCache: async (content) => {
          cache = content;
        },
      });

    await resolveWithEnvelope(8, 2_000);
    const rollback = await resolveWithEnvelope(7, 3_000);
    expect(rollback?.error).toContain('rollback');
    expect(JSON.parse(cache!.toString('utf8'))).toMatchObject({
      version: 2,
      quarantined: true,
    });

    await expect(
      resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey: publicKeyPem,
        now: () => 3_500,
        fetch: vi.fn(async () => {
          throw new Error('offline');
        }) as typeof fetch,
        readCache: async () => cache,
        writeCache: async () => undefined,
      }),
    ).resolves.toMatchObject({
      error: 'Managed control-plane policy is unavailable offline',
      cached: false,
    });

    await expect(resolveWithEnvelope(9, 4_000)).resolves.toMatchObject({
      error: null,
      revision: 9,
      cached: false,
    });
    expect(JSON.parse(cache!.toString('utf8'))).toMatchObject({
      quarantined: false,
    });
  });

  it('retains an expired cache as an anti-rollback watermark without executing it', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    let cache: Buffer | null = null;
    await resolveControlPlaneModelFabricBudgetPolicies({
      url: 'https://policies.example.com/model-fabric',
      publicKey: publicKeyPem,
      now: () => 2_000,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              signedEnvelope(privateKey, {
                revision: 8,
                issuedAt: 1_000,
                expiresAt: 2_500,
              }),
            ),
          ),
      ) as typeof fetch,
      writeCache: async (content) => {
        cache = content;
      },
    });

    await expect(
      resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey: publicKeyPem,
        now: () => 3_000,
        fetch: vi.fn(
          async () =>
            new Response(
              JSON.stringify(
                signedEnvelope(privateKey, {
                  revision: 7,
                  issuedAt: 2_500,
                  expiresAt: 10_000,
                }),
              ),
            ),
        ) as typeof fetch,
        readCache: async () => cache,
        writeCache: async () => undefined,
      }),
    ).resolves.toEqual({
      source: 'control-plane',
      policies: [],
      error: 'Managed control-plane policy rollback was rejected',
      cached: false,
    });

    await expect(
      resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey: publicKeyPem,
        now: () => 3_000,
        fetch: vi.fn(async () => {
          throw new Error('offline');
        }) as typeof fetch,
        readCache: async () => cache,
        writeCache: async () => undefined,
      }),
    ).resolves.toEqual({
      source: 'control-plane',
      policies: [],
      error: 'Managed control-plane policy is unavailable offline',
      cached: false,
    });
  });

  it('rejects conflicting payloads that reuse the highest signed revision', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    let cache: Buffer | null = null;
    await resolveControlPlaneModelFabricBudgetPolicies({
      url: 'https://policies.example.com/model-fabric',
      publicKey: publicKeyPem,
      now: () => 2_000,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              signedEnvelope(privateKey, {
                revision: 8,
                issuedAt: 1_000,
                expiresAt: 10_000,
              }),
            ),
          ),
      ) as typeof fetch,
      writeCache: async (content) => {
        cache = content;
      },
    });

    await expect(
      resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey: publicKeyPem,
        now: () => 3_000,
        fetch: vi.fn(
          async () =>
            new Response(
              JSON.stringify(
                signedEnvelope(privateKey, {
                  revision: 8,
                  issuedAt: 1_000,
                  expiresAt: 10_000,
                  limitUsd: 251,
                }),
              ),
            ),
        ) as typeof fetch,
        readCache: async () => cache,
        writeCache: async () => undefined,
      }),
    ).resolves.toEqual({
      source: 'control-plane',
      policies: [],
      error: 'Managed control-plane policy revision conflict was rejected',
      cached: false,
    });
  });

  it('revalidates a valid unexpired cache with its ETag', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    let cache: Buffer | null = null;
    await resolveControlPlaneModelFabricBudgetPolicies({
      url: 'https://policies.example.com/model-fabric',
      publicKey: publicKeyPem,
      now: () => 2_000,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              signedEnvelope(privateKey, {
                revision: 8,
                issuedAt: 1_000,
                expiresAt: 10_000,
              }),
            ),
            { headers: { etag: '"revision-8"' } },
          ),
      ) as typeof fetch,
      writeCache: async (content) => {
        cache = content;
      },
    });
    const fetch = vi.fn(async (_url, init) => {
      expect((init?.headers as Record<string, string>)['if-none-match']).toBe(
        '"revision-8"',
      );
      return new Response(null, { status: 304 });
    }) as typeof globalThis.fetch;

    await expect(
      resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey: publicKeyPem,
        now: () => 3_000,
        fetch,
        readCache: async () => cache,
        writeCache: async () => undefined,
      }),
    ).resolves.toMatchObject({
      source: 'control-plane',
      error: null,
      cached: true,
      policies: [{ id: 'org-global' }],
    });
  });

  it('fails closed for expired remote policy, rejected requests, oversized responses, and cache write failure', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const base = {
      url: 'https://policies.example.com/model-fabric',
      publicKey: publicKeyPem,
      now: () => 3_000,
      writeCache: async () => undefined,
    };

    const expired = await resolveControlPlaneModelFabricBudgetPolicies({
      ...base,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              signedEnvelope(privateKey, {
                revision: 9,
                issuedAt: 1_000,
                expiresAt: 2_500,
              }),
            ),
          ),
      ) as typeof fetch,
    });
    const rejected = await resolveControlPlaneModelFabricBudgetPolicies({
      ...base,
      fetch: vi.fn(
        async () => new Response(null, { status: 403 }),
      ) as typeof fetch,
    });
    const oversized = await resolveControlPlaneModelFabricBudgetPolicies({
      ...base,
      fetch: vi.fn(
        async () =>
          new Response('x'.repeat(256 * 1024 + 1), {
            status: 200,
          }),
      ) as typeof fetch,
    });
    const cacheFailure = await resolveControlPlaneModelFabricBudgetPolicies({
      ...base,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              signedEnvelope(privateKey, {
                revision: 9,
                issuedAt: 1_000,
                expiresAt: 10_000,
              }),
            ),
          ),
      ) as typeof fetch,
      writeCache: async () => {
        throw new Error('disk failure');
      },
    });

    expect(expired?.error).toBe('Managed signed policy has expired');
    expect(rejected?.error).toBe(
      'Managed control-plane policy request was rejected',
    );
    expect(oversized?.error).toBe(
      'Managed control-plane response is too large',
    );
    expect(cacheFailure?.error).toBe(
      'Managed control-plane policy cache could not be persisted',
    );
  });

  it('fails closed offline when no unexpired verified cache exists', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    await expect(
      resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        fetch: vi.fn(async () => {
          throw new Error('offline');
        }) as typeof fetch,
        readCache: async () => null,
        writeCache: async () => undefined,
      }),
    ).resolves.toEqual({
      source: 'control-plane',
      policies: [],
      error: 'Managed control-plane policy is unavailable offline',
      cached: false,
    });
  });

  it('rotates policy signing keys and atomically revokes the previous key', async () => {
    const root = generateKeyPairSync('ed25519');
    const oldKey = generateKeyPairSync('ed25519');
    const nextKey = generateKeyPairSync('ed25519');
    const rootPublicKey = toPublicKeyPem(root.publicKey);
    const oldRecord = signingKeyRecord('policy-key-a', oldKey.publicKey, {
      status: 'active',
      notBefore: 500,
      notAfter: 20_000,
    });
    const nextRecord = signingKeyRecord('policy-key-b', nextKey.publicKey, {
      status: 'active',
      notBefore: 1_500,
      notAfter: 20_000,
    });
    let cache: Buffer | null = null;

    await expect(
      resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey: rootPublicKey,
        now: () => 2_000,
        fetch: vi.fn(
          async () =>
            new Response(
              JSON.stringify(
                signedControlPlaneSnapshot({
                  rootPrivateKey: root.privateKey,
                  policyPrivateKey: oldKey.privateKey,
                  keysetRevision: 1,
                  policyRevision: 7,
                  issuedAt: 1_000,
                  expiresAt: 10_000,
                  keys: [oldRecord, nextRecord],
                  policyKeyId: oldRecord.keyId,
                }),
              ),
            ),
        ) as typeof fetch,
        writeCache: async (content) => {
          cache = content;
        },
      }),
    ).resolves.toMatchObject({
      source: 'control-plane',
      error: null,
      cached: false,
      revision: 7,
      keysetRevision: 1,
      signingKeyId: 'policy-key-a',
    });

    const rotated = await resolveControlPlaneModelFabricBudgetPolicies({
      url: 'https://policies.example.com/model-fabric',
      publicKey: rootPublicKey,
      now: () => 3_000,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              signedControlPlaneSnapshot({
                rootPrivateKey: root.privateKey,
                policyPrivateKey: nextKey.privateKey,
                keysetRevision: 2,
                policyRevision: 8,
                issuedAt: 2_500,
                expiresAt: 12_000,
                keys: [
                  { ...oldRecord, status: 'revoked' as const },
                  nextRecord,
                ],
                policyKeyId: nextRecord.keyId,
                limitUsd: 300,
              }),
            ),
          ),
      ) as typeof fetch,
      readCache: async () => cache,
      writeCache: async (content) => {
        cache = content;
      },
    });
    expect(rotated).toMatchObject({
      source: 'control-plane',
      error: null,
      cached: false,
      revision: 8,
      keysetRevision: 2,
      signingKeyId: 'policy-key-b',
      policies: [{ limitUsd: 300 }],
    });

    await expect(
      resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey: rootPublicKey,
        now: () => 4_000,
        fetch: vi.fn(async () => {
          throw new Error('offline');
        }) as typeof fetch,
        readCache: async () => cache,
        writeCache: async () => undefined,
      }),
    ).resolves.toMatchObject({
      source: 'control-plane',
      error: null,
      cached: true,
      revision: 8,
      keysetRevision: 2,
      signingKeyId: 'policy-key-b',
    });
  });

  it('rejects policies signed by a revoked or untrusted delegated key', async () => {
    const root = generateKeyPairSync('ed25519');
    const revoked = generateKeyPairSync('ed25519');
    const unknown = generateKeyPairSync('ed25519');
    const revokedRecord = signingKeyRecord(
      'policy-key-revoked',
      revoked.publicKey,
      {
        status: 'revoked',
        notBefore: 500,
        notAfter: 20_000,
      },
    );
    const base = {
      url: 'https://policies.example.com/model-fabric',
      publicKey: toPublicKeyPem(root.publicKey),
      now: () => 2_000,
      writeCache: async () => undefined,
    };

    const revokedResult = await resolveControlPlaneModelFabricBudgetPolicies({
      ...base,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              signedControlPlaneSnapshot({
                rootPrivateKey: root.privateKey,
                policyPrivateKey: revoked.privateKey,
                keysetRevision: 1,
                policyRevision: 1,
                issuedAt: 1_000,
                expiresAt: 10_000,
                keys: [revokedRecord],
                policyKeyId: revokedRecord.keyId,
              }),
            ),
          ),
      ) as typeof fetch,
    });
    const untrustedResult = await resolveControlPlaneModelFabricBudgetPolicies({
      ...base,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              signedControlPlaneSnapshot({
                rootPrivateKey: root.privateKey,
                policyPrivateKey: unknown.privateKey,
                keysetRevision: 1,
                policyRevision: 1,
                issuedAt: 1_000,
                expiresAt: 10_000,
                keys: [
                  signingKeyRecord('policy-key-active', revoked.publicKey, {
                    status: 'active',
                    notBefore: 500,
                    notAfter: 20_000,
                  }),
                ],
                policyKeyId: 'policy-key-unknown',
              }),
            ),
          ),
      ) as typeof fetch,
    });

    expect(revokedResult?.error).toBe(
      'Managed control-plane policy signing key is revoked',
    );
    expect(untrustedResult?.error).toBe(
      'Managed control-plane policy signing key is not trusted',
    );
  });

  it('detects tampering independently at the root-signed keyset and delegated policy layers', async () => {
    const root = generateKeyPairSync('ed25519');
    const delegated = generateKeyPairSync('ed25519');
    const key = signingKeyRecord('policy-key-a', delegated.publicKey, {
      status: 'active',
      notBefore: 500,
      notAfter: 20_000,
    });
    const createSnapshot = () =>
      signedControlPlaneSnapshot({
        rootPrivateKey: root.privateKey,
        policyPrivateKey: delegated.privateKey,
        keysetRevision: 1,
        policyRevision: 1,
        issuedAt: 1_000,
        expiresAt: 10_000,
        keys: [key],
        policyKeyId: key.keyId,
      });
    const tamperedKeyset = createSnapshot();
    tamperedKeyset.keyset.keys[0] = {
      ...tamperedKeyset.keyset.keys[0]!,
      status: 'revoked',
    };
    const tamperedPolicy = createSnapshot();
    tamperedPolicy.policy.policies[0]!.limitUsd = 999;
    const resolve = async (snapshot: ReturnType<typeof createSnapshot>) =>
      await resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey: toPublicKeyPem(root.publicKey),
        now: () => 2_000,
        fetch: vi.fn(
          async () => new Response(JSON.stringify(snapshot)),
        ) as typeof fetch,
        writeCache: async () => undefined,
      });

    expect((await resolve(tamperedKeyset))?.error).toBe(
      'Managed control-plane signing keyset signature verification failed',
    );
    expect((await resolve(tamperedPolicy))?.error).toBe(
      'Managed signed policy signature verification failed',
    );
  });

  it('makes key revocation and key identity append-only across revisions', async () => {
    const root = generateKeyPairSync('ed25519');
    const oldKey = generateKeyPairSync('ed25519');
    const nextKey = generateKeyPairSync('ed25519');
    const replacement = generateKeyPairSync('ed25519');
    const rootPublicKey = toPublicKeyPem(root.publicKey);
    const oldRecord = signingKeyRecord('policy-key-a', oldKey.publicKey, {
      status: 'revoked',
      notBefore: 500,
      notAfter: 20_000,
    });
    const nextRecord = signingKeyRecord('policy-key-b', nextKey.publicKey, {
      status: 'active',
      notBefore: 500,
      notAfter: 20_000,
    });
    let cache: Buffer | null = null;
    await resolveControlPlaneModelFabricBudgetPolicies({
      url: 'https://policies.example.com/model-fabric',
      publicKey: rootPublicKey,
      now: () => 2_000,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              signedControlPlaneSnapshot({
                rootPrivateKey: root.privateKey,
                policyPrivateKey: nextKey.privateKey,
                keysetRevision: 2,
                policyRevision: 8,
                issuedAt: 1_000,
                expiresAt: 10_000,
                keys: [oldRecord, nextRecord],
                policyKeyId: nextRecord.keyId,
              }),
            ),
          ),
      ) as typeof fetch,
      writeCache: async (content) => {
        cache = content;
      },
    });

    const attempt = async (
      keys: ReturnType<typeof signingKeyRecord>[],
      privateKey: typeof oldKey.privateKey,
      policyKeyId: string,
    ) =>
      await resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey: rootPublicKey,
        now: () => 3_000,
        fetch: vi.fn(
          async () =>
            new Response(
              JSON.stringify(
                signedControlPlaneSnapshot({
                  rootPrivateKey: root.privateKey,
                  policyPrivateKey: privateKey,
                  keysetRevision: 3,
                  policyRevision: 9,
                  issuedAt: 2_500,
                  expiresAt: 12_000,
                  keys,
                  policyKeyId,
                }),
              ),
            ),
        ) as typeof fetch,
        readCache: async () => cache,
        writeCache: async () => undefined,
      });

    const unrevoked = await attempt(
      [{ ...oldRecord, status: 'active' }, nextRecord],
      oldKey.privateKey,
      oldRecord.keyId,
    );
    const reusedIdentity = await attempt(
      [
        signingKeyRecord(oldRecord.keyId, replacement.publicKey, {
          status: 'revoked',
          notBefore: oldRecord.notBefore,
          notAfter: oldRecord.notAfter,
        }),
        nextRecord,
      ],
      nextKey.privateKey,
      nextRecord.keyId,
    );
    const truncated = await attempt(
      [nextRecord],
      nextKey.privateKey,
      nextRecord.keyId,
    );

    expect(unrevoked?.error).toBe(
      'Managed control-plane signing key revocation rollback was rejected',
    );
    expect(reusedIdentity?.error).toBe(
      'Managed control-plane signing key identity conflict was rejected',
    );
    expect(truncated?.error).toBe(
      'Managed control-plane signing key history truncation was rejected',
    );
  });

  it('retains expired keyset watermarks and rejects trust-format downgrade', async () => {
    const root = generateKeyPairSync('ed25519');
    const delegated = generateKeyPairSync('ed25519');
    const rootPublicKey = toPublicKeyPem(root.publicKey);
    const keyRecord = signingKeyRecord('policy-key-a', delegated.publicKey, {
      status: 'active',
      notBefore: 500,
      notAfter: 20_000,
    });
    let cache: Buffer | null = null;
    await resolveControlPlaneModelFabricBudgetPolicies({
      url: 'https://policies.example.com/model-fabric',
      publicKey: rootPublicKey,
      now: () => 2_000,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              signedControlPlaneSnapshot({
                rootPrivateKey: root.privateKey,
                policyPrivateKey: delegated.privateKey,
                keysetRevision: 5,
                policyRevision: 7,
                issuedAt: 1_000,
                expiresAt: 2_500,
                keys: [keyRecord],
                policyKeyId: keyRecord.keyId,
              }),
            ),
          ),
      ) as typeof fetch,
      writeCache: async (content) => {
        cache = content;
      },
    });

    const keysetRollback = await resolveControlPlaneModelFabricBudgetPolicies({
      url: 'https://policies.example.com/model-fabric',
      publicKey: rootPublicKey,
      now: () => 3_000,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              signedControlPlaneSnapshot({
                rootPrivateKey: root.privateKey,
                policyPrivateKey: delegated.privateKey,
                keysetRevision: 4,
                policyRevision: 8,
                issuedAt: 2_500,
                expiresAt: 10_000,
                keys: [keyRecord],
                policyKeyId: keyRecord.keyId,
              }),
            ),
          ),
      ) as typeof fetch,
      readCache: async () => cache,
      writeCache: async () => undefined,
    });
    const legacyDowngrade = await resolveControlPlaneModelFabricBudgetPolicies({
      url: 'https://policies.example.com/model-fabric',
      publicKey: rootPublicKey,
      now: () => 3_000,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              signedEnvelope(root.privateKey, {
                revision: 8,
                issuedAt: 2_500,
                expiresAt: 10_000,
              }),
            ),
          ),
      ) as typeof fetch,
      readCache: async () => cache,
      writeCache: async () => undefined,
    });

    expect(keysetRollback?.error).toBe(
      'Managed control-plane signing keyset rollback was rejected',
    );
    expect(legacyDowngrade?.error).toBe(
      'Managed control-plane trust downgrade was rejected',
    );
  });

  it('cross-signs root rollover, revokes the old root, and restores v3 trust offline', async () => {
    const rootA = generateKeyPairSync('ed25519');
    const rootB = generateKeyPairSync('ed25519');
    const delegated = generateKeyPairSync('ed25519');
    const pinnedRootPublicKey = toPublicKeyPem(rootA.publicKey);
    const rootARecord = signingKeyRecord('root-a', rootA.publicKey, {
      status: 'active',
      notBefore: 0,
      notAfter: 50_000,
    });
    const rootBRecord = signingKeyRecord('root-b', rootB.publicKey, {
      status: 'active',
      notBefore: 0,
      notAfter: 50_000,
    });
    const delegatedRecord = signingKeyRecord(
      'policy-key-a',
      delegated.publicKey,
      {
        status: 'active',
        notBefore: 0,
        notAfter: 50_000,
      },
    );
    let cache: Buffer | null = null;
    const resolveSnapshot = async (
      snapshot: ReturnType<typeof signedRootsetControlPlaneSnapshot>,
      now: number,
    ) =>
      await resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey: pinnedRootPublicKey,
        now: () => now,
        fetch: vi.fn(
          async () => new Response(JSON.stringify(snapshot)),
        ) as typeof fetch,
        readCache: async () => cache,
        writeCache: async (content) => {
          cache = content;
        },
      });

    const initial = await resolveSnapshot(
      signedRootsetControlPlaneSnapshot({
        rootsetSignerPrivateKey: rootA.privateKey,
        rootsetSignedBy: rootARecord.keyId,
        rootsetRevision: 1,
        roots: [rootARecord, rootBRecord],
        keysetRootPrivateKey: rootA.privateKey,
        keysetRootKeyId: rootARecord.keyId,
        policyPrivateKey: delegated.privateKey,
        delegatedKeys: [delegatedRecord],
        policyKeyId: delegatedRecord.keyId,
        keysetRevision: 1,
        policyRevision: 10,
        issuedAt: 1_000,
        expiresAt: 20_000,
      }),
      2_000,
    );
    expect(initial).toMatchObject({
      error: null,
      revision: 10,
      keysetRevision: 1,
      rootsetRevision: 1,
      rootSigningKeyId: 'root-a',
      activeRootCount: 2,
      revokedRootCount: 0,
    });

    const rotated = await resolveSnapshot(
      signedRootsetControlPlaneSnapshot({
        rootsetSignerPrivateKey: rootA.privateKey,
        rootsetSignedBy: rootARecord.keyId,
        rootsetRevision: 2,
        roots: [{ ...rootARecord, status: 'revoked' as const }, rootBRecord],
        keysetRootPrivateKey: rootB.privateKey,
        keysetRootKeyId: rootBRecord.keyId,
        policyPrivateKey: delegated.privateKey,
        delegatedKeys: [delegatedRecord],
        policyKeyId: delegatedRecord.keyId,
        keysetRevision: 2,
        policyRevision: 11,
        issuedAt: 3_000,
        expiresAt: 25_000,
      }),
      4_000,
    );
    expect(rotated).toMatchObject({
      error: null,
      revision: 11,
      keysetRevision: 2,
      rootsetRevision: 2,
      rootSigningKeyId: 'root-b',
      activeRootCount: 1,
      revokedRootCount: 1,
    });

    const advanced = await resolveSnapshot(
      signedRootsetControlPlaneSnapshot({
        rootsetSignerPrivateKey: rootB.privateKey,
        rootsetSignedBy: rootBRecord.keyId,
        rootsetRevision: 3,
        roots: [{ ...rootARecord, status: 'revoked' as const }, rootBRecord],
        keysetRootPrivateKey: rootB.privateKey,
        keysetRootKeyId: rootBRecord.keyId,
        policyPrivateKey: delegated.privateKey,
        delegatedKeys: [delegatedRecord],
        policyKeyId: delegatedRecord.keyId,
        keysetRevision: 3,
        policyRevision: 12,
        issuedAt: 5_000,
        expiresAt: 30_000,
      }),
      6_000,
    );
    expect(advanced).toMatchObject({
      error: null,
      rootsetRevision: 3,
      rootSigningKeyId: 'root-b',
    });

    await expect(
      resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey: pinnedRootPublicKey,
        now: () => 7_000,
        fetch: vi.fn(async () => {
          throw new Error('offline');
        }) as typeof fetch,
        readCache: async () => cache,
        writeCache: async () => undefined,
      }),
    ).resolves.toMatchObject({
      error: null,
      cached: true,
      revision: 12,
      rootsetRevision: 3,
      rootSigningKeyId: 'root-b',
    });
  });

  it('rejects revoked root authority, root history rollback, and v3 downgrade', async () => {
    const rootA = generateKeyPairSync('ed25519');
    const rootB = generateKeyPairSync('ed25519');
    const delegated = generateKeyPairSync('ed25519');
    const pinnedRootPublicKey = toPublicKeyPem(rootA.publicKey);
    const rootARecord = signingKeyRecord('root-a', rootA.publicKey, {
      status: 'active',
      notBefore: 0,
      notAfter: 50_000,
    });
    const rootBRecord = signingKeyRecord('root-b', rootB.publicKey, {
      status: 'active',
      notBefore: 0,
      notAfter: 50_000,
    });
    const delegatedRecord = signingKeyRecord(
      'policy-key-a',
      delegated.publicKey,
      {
        status: 'active',
        notBefore: 0,
        notAfter: 50_000,
      },
    );
    let cache: Buffer | null = null;
    const base = {
      url: 'https://policies.example.com/model-fabric',
      publicKey: pinnedRootPublicKey,
      writeCache: async (content: Buffer) => {
        cache = content;
      },
    };

    await resolveControlPlaneModelFabricBudgetPolicies({
      ...base,
      now: () => 2_000,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              signedRootsetControlPlaneSnapshot({
                rootsetSignerPrivateKey: rootA.privateKey,
                rootsetSignedBy: rootARecord.keyId,
                rootsetRevision: 1,
                roots: [
                  { ...rootARecord, status: 'revoked' as const },
                  rootBRecord,
                ],
                keysetRootPrivateKey: rootB.privateKey,
                keysetRootKeyId: rootBRecord.keyId,
                policyPrivateKey: delegated.privateKey,
                delegatedKeys: [delegatedRecord],
                policyKeyId: delegatedRecord.keyId,
                keysetRevision: 1,
                policyRevision: 1,
                issuedAt: 1_000,
                expiresAt: 20_000,
              }),
            ),
          ),
      ) as typeof fetch,
    });

    const attempt = async (snapshot: unknown) =>
      await resolveControlPlaneModelFabricBudgetPolicies({
        url: base.url,
        publicKey: pinnedRootPublicKey,
        now: () => 3_000,
        fetch: vi.fn(
          async () => new Response(JSON.stringify(snapshot)),
        ) as typeof fetch,
        readCache: async () => cache,
        writeCache: async () => undefined,
      });

    const revokedSigner = await attempt(
      signedRootsetControlPlaneSnapshot({
        rootsetSignerPrivateKey: rootA.privateKey,
        rootsetSignedBy: rootARecord.keyId,
        rootsetRevision: 2,
        roots: [{ ...rootARecord, status: 'revoked' as const }, rootBRecord],
        keysetRootPrivateKey: rootB.privateKey,
        keysetRootKeyId: rootBRecord.keyId,
        policyPrivateKey: delegated.privateKey,
        delegatedKeys: [delegatedRecord],
        policyKeyId: delegatedRecord.keyId,
        keysetRevision: 2,
        policyRevision: 2,
        issuedAt: 2_500,
        expiresAt: 25_000,
      }),
    );
    expect(revokedSigner?.error).toBe(
      'Managed control-plane rootset signer was not active in the previous rootset',
    );

    const reactivated = await attempt(
      signedRootsetControlPlaneSnapshot({
        rootsetSignerPrivateKey: rootB.privateKey,
        rootsetSignedBy: rootBRecord.keyId,
        rootsetRevision: 2,
        roots: [rootARecord, rootBRecord],
        keysetRootPrivateKey: rootB.privateKey,
        keysetRootKeyId: rootBRecord.keyId,
        policyPrivateKey: delegated.privateKey,
        delegatedKeys: [delegatedRecord],
        policyKeyId: delegatedRecord.keyId,
        keysetRevision: 2,
        policyRevision: 2,
        issuedAt: 2_500,
        expiresAt: 25_000,
      }),
    );
    expect(reactivated?.error).toBe(
      'Managed control-plane root key revocation rollback was rejected',
    );

    const downgraded = await attempt(
      signedControlPlaneSnapshot({
        rootPrivateKey: rootA.privateKey,
        policyPrivateKey: delegated.privateKey,
        keysetRevision: 2,
        policyRevision: 2,
        issuedAt: 2_500,
        expiresAt: 25_000,
        keys: [delegatedRecord],
        policyKeyId: delegatedRecord.keyId,
      }),
    );
    expect(downgraded?.error).toBe(
      'Managed control-plane trust downgrade was rejected',
    );
  });

  it('rejects an unpinned rootset bootstrap and invalid prepublished Ed25519 roots', async () => {
    const pinned = generateKeyPairSync('ed25519');
    const rogue = generateKeyPairSync('ed25519');
    const delegated = generateKeyPairSync('ed25519');
    const pinnedRecord = signingKeyRecord('root-pinned', pinned.publicKey, {
      status: 'active',
      notBefore: 0,
      notAfter: 50_000,
    });
    const rogueRecord = signingKeyRecord('root-rogue', rogue.publicKey, {
      status: 'active',
      notBefore: 0,
      notAfter: 50_000,
    });
    const delegatedRecord = signingKeyRecord(
      'policy-key-a',
      delegated.publicKey,
      {
        status: 'active',
        notBefore: 0,
        notAfter: 50_000,
      },
    );
    const resolve = async (snapshot: unknown) =>
      await resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey: toPublicKeyPem(pinned.publicKey),
        now: () => 2_000,
        fetch: vi.fn(
          async () => new Response(JSON.stringify(snapshot)),
        ) as typeof fetch,
        writeCache: async () => undefined,
      });

    const unpinned = await resolve(
      signedRootsetControlPlaneSnapshot({
        rootsetSignerPrivateKey: rogue.privateKey,
        rootsetSignedBy: rogueRecord.keyId,
        rootsetRevision: 1,
        roots: [pinnedRecord, rogueRecord],
        keysetRootPrivateKey: rogue.privateKey,
        keysetRootKeyId: rogueRecord.keyId,
        policyPrivateKey: delegated.privateKey,
        delegatedKeys: [delegatedRecord],
        policyKeyId: delegatedRecord.keyId,
        keysetRevision: 1,
        policyRevision: 1,
        issuedAt: 1_000,
        expiresAt: 20_000,
      }),
    );
    expect(unpinned?.error).toBe(
      'Managed control-plane initial rootset is not signed by the pinned root',
    );

    const invalidRoot = signedRootsetControlPlaneSnapshot({
      rootsetSignerPrivateKey: pinned.privateKey,
      rootsetSignedBy: pinnedRecord.keyId,
      rootsetRevision: 1,
      roots: [
        pinnedRecord,
        {
          ...rogueRecord,
          publicKey:
            '-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----',
        },
      ],
      keysetRootPrivateKey: pinned.privateKey,
      keysetRootKeyId: pinnedRecord.keyId,
      policyPrivateKey: delegated.privateKey,
      delegatedKeys: [delegatedRecord],
      policyKeyId: delegatedRecord.keyId,
      keysetRevision: 1,
      policyRevision: 1,
      issuedAt: 1_000,
      expiresAt: 20_000,
    });
    expect((await resolve(invalidRoot))?.error).toBe(
      'Managed control-plane rootset contains an invalid Ed25519 public key',
    );
  });

  it('retains an expired v3 rootset as an anti-rollback watermark without executing it', async () => {
    const root = generateKeyPairSync('ed25519');
    const delegated = generateKeyPairSync('ed25519');
    const rootRecord = signingKeyRecord('root-a', root.publicKey, {
      status: 'active',
      notBefore: 0,
      notAfter: 50_000,
    });
    const delegatedRecord = signingKeyRecord(
      'policy-key-a',
      delegated.publicKey,
      {
        status: 'active',
        notBefore: 0,
        notAfter: 50_000,
      },
    );
    const publicKey = toPublicKeyPem(root.publicKey);
    let cache: Buffer | null = null;
    await resolveControlPlaneModelFabricBudgetPolicies({
      url: 'https://policies.example.com/model-fabric',
      publicKey,
      now: () => 2_000,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              signedRootsetControlPlaneSnapshot({
                rootsetSignerPrivateKey: root.privateKey,
                rootsetSignedBy: rootRecord.keyId,
                rootsetRevision: 5,
                roots: [rootRecord],
                keysetRootPrivateKey: root.privateKey,
                keysetRootKeyId: rootRecord.keyId,
                policyPrivateKey: delegated.privateKey,
                delegatedKeys: [delegatedRecord],
                policyKeyId: delegatedRecord.keyId,
                keysetRevision: 5,
                policyRevision: 7,
                issuedAt: 1_000,
                expiresAt: 2_500,
              }),
            ),
          ),
      ) as typeof fetch,
      writeCache: async (content) => {
        cache = content;
      },
    });

    await expect(
      resolveControlPlaneModelFabricBudgetPolicies({
        url: 'https://policies.example.com/model-fabric',
        publicKey,
        now: () => 3_000,
        fetch: vi.fn(async () => {
          throw new Error('offline');
        }) as typeof fetch,
        readCache: async () => cache,
        writeCache: async () => undefined,
      }),
    ).resolves.toMatchObject({
      error: 'Managed control-plane policy is unavailable offline',
      cached: false,
    });

    const rollback = await resolveControlPlaneModelFabricBudgetPolicies({
      url: 'https://policies.example.com/model-fabric',
      publicKey,
      now: () => 3_000,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              signedRootsetControlPlaneSnapshot({
                rootsetSignerPrivateKey: root.privateKey,
                rootsetSignedBy: rootRecord.keyId,
                rootsetRevision: 4,
                roots: [rootRecord],
                keysetRootPrivateKey: root.privateKey,
                keysetRootKeyId: rootRecord.keyId,
                policyPrivateKey: delegated.privateKey,
                delegatedKeys: [delegatedRecord],
                policyKeyId: delegatedRecord.keyId,
                keysetRevision: 6,
                policyRevision: 8,
                issuedAt: 2_500,
                expiresAt: 10_000,
              }),
            ),
          ),
      ) as typeof fetch,
      readCache: async () => cache,
      writeCache: async () => undefined,
    });
    expect(rollback?.error).toBe(
      'Managed control-plane rootset rollback was rejected',
    );
  });
});

describe('LiveControlPlaneModelFabricPolicyRefresher', () => {
  it('schedules the first refresh before the currently applied trust expires', () => {
    const scheduled: number[] = [];
    const refresher = new LiveControlPlaneModelFabricPolicyRefresher({
      resolve: vi.fn(async () => controlPlaneResult({ revision: 2 })),
      onUpdate: vi.fn(),
      refreshIntervalMs: 5_000,
      now: () => 1_000,
      schedule: (_callback, delayMs) => {
        scheduled.push(delayMs);
        return delayMs;
      },
      cancelScheduled: () => undefined,
    });

    refresher.start(controlPlaneResult({ revision: 1, expiresAt: 5_000 }));
    expect(scheduled).toEqual([3_000]);
    refresher.teardown();
  });

  it('hot-applies refreshed policy and exponentially backs off after fail-closed updates', async () => {
    const updates: Array<{ error: string | null; revision?: number }> = [];
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const responses = [
      controlPlaneResult({ revision: 2, expiresAt: 100_000 }),
      controlPlaneResult({
        error: 'Managed control-plane policy rollback was rejected',
      }),
      controlPlaneResult({
        error: 'Managed control-plane policy rollback was rejected',
      }),
    ];
    const refresher = new LiveControlPlaneModelFabricPolicyRefresher({
      resolve: vi.fn(async () => responses.shift() ?? null),
      onUpdate: (result) => updates.push(result),
      refreshIntervalMs: 5_000,
      maxBackoffMs: 20_000,
      now: () => 1_000,
      schedule: (callback, delayMs) => {
        const handle = { callback, delayMs };
        scheduled.push(handle);
        return handle;
      },
      cancelScheduled: () => undefined,
    });

    refresher.start();
    expect(scheduled.at(-1)?.delayMs).toBe(5_000);
    await refresher.refreshNow();
    expect(updates.at(-1)).toMatchObject({ error: null, revision: 2 });
    expect(scheduled.at(-1)?.delayMs).toBe(5_000);
    await refresher.refreshNow();
    expect(updates.at(-1)?.error).toContain('rollback');
    expect(scheduled.at(-1)?.delayMs).toBe(5_000);
    await refresher.refreshNow();
    expect(scheduled.at(-1)?.delayMs).toBe(10_000);
    refresher.teardown();
  });

  it('deduplicates concurrent refreshes and suppresses updates after teardown abort', async () => {
    let resolveRequest:
      | ((value: ReturnType<typeof controlPlaneResult>) => void)
      | undefined;
    let observedSignal: AbortSignal | undefined;
    const onUpdate = vi.fn();
    const resolve = vi.fn(
      async (signal: AbortSignal) =>
        await new Promise<ReturnType<typeof controlPlaneResult>>((resolve) => {
          observedSignal = signal;
          resolveRequest = resolve;
        }),
    );
    const refresher = new LiveControlPlaneModelFabricPolicyRefresher({
      resolve,
      onUpdate,
      refreshIntervalMs: 5_000,
      schedule: () => ({ timer: true }),
      cancelScheduled: () => undefined,
    });
    refresher.start();

    const first = refresher.refreshNow();
    const second = refresher.refreshNow();
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    refresher.teardown();
    expect(observedSignal?.aborted).toBe(true);
    resolveRequest?.(controlPlaneResult({ revision: 3 }));
    await expect(first).resolves.toMatchObject({ revision: 3 });
    await expect(second).resolves.toMatchObject({ revision: 3 });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('keeps a security failure quarantined until a fresh remote policy succeeds', async () => {
    const updates: Array<{ error: string | null; cached?: boolean }> = [];
    const responses = [
      controlPlaneResult({ error: 'signature verification failed' }),
      controlPlaneResult({ revision: 1, cached: true }),
      controlPlaneResult({ revision: 2, cached: false }),
      controlPlaneResult({ revision: 2, cached: true }),
    ];
    const refresher = new LiveControlPlaneModelFabricPolicyRefresher({
      resolve: vi.fn(async () => responses.shift() ?? null),
      onUpdate: (result) => updates.push(result),
      refreshIntervalMs: 5_000,
      schedule: () => ({ timer: true }),
      cancelScheduled: () => undefined,
    });
    refresher.start();

    await refresher.refreshNow();
    await refresher.refreshNow();
    expect(updates.at(-1)?.error).toContain('remains quarantined');
    await refresher.refreshNow();
    expect(updates.at(-1)).toMatchObject({
      error: null,
      cached: false,
      revision: 2,
    });
    await refresher.refreshNow();
    expect(updates.at(-1)).toMatchObject({ error: null, cached: true });
    refresher.teardown();
  });

  it('applies an operator refresh while scheduling is disabled and deduplicates it', async () => {
    let finish:
      | ((value: ReturnType<typeof controlPlaneResult>) => void)
      | undefined;
    const onUpdate = vi.fn();
    const resolve = vi.fn(
      async () =>
        await new Promise<ReturnType<typeof controlPlaneResult>>((resolve) => {
          finish = resolve;
        }),
    );
    const refresher = new LiveControlPlaneModelFabricPolicyRefresher({
      resolve,
      onUpdate,
      refreshIntervalMs: 5_000,
      schedule: () => ({ timer: true }),
      cancelScheduled: () => undefined,
    });

    const first = refresher.refreshOnce();
    const second = refresher.refreshOnce();
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    finish?.(controlPlaneResult({ revision: 4 }));
    await expect(first).resolves.toMatchObject({ revision: 4 });
    await expect(second).resolves.toMatchObject({ revision: 4 });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 4 }),
    );
  });

  it('starts a fresh operator request instead of joining an aborted scheduler generation', async () => {
    const onUpdate = vi.fn();
    const resolve = vi.fn(async (signal: AbortSignal) => {
      if (resolve.mock.calls.length === 1) {
        return await new Promise<ReturnType<typeof controlPlaneResult>>(
          (finish) => {
            signal.addEventListener(
              'abort',
              () => finish(controlPlaneResult({ revision: 1 })),
              { once: true },
            );
          },
        );
      }
      return controlPlaneResult({ revision: 2 });
    });
    const refresher = new LiveControlPlaneModelFabricPolicyRefresher({
      resolve,
      onUpdate,
      refreshIntervalMs: 5_000,
      schedule: () => ({ timer: true }),
      cancelScheduled: () => undefined,
    });
    refresher.start();
    const scheduled = refresher.refreshNow();
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    refresher.teardown();

    const manual = refresher.refreshOnce();
    await expect(scheduled).resolves.toMatchObject({ revision: 1 });
    await expect(manual).resolves.toMatchObject({ revision: 2 });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 2 }),
    );
  });
});

function signedEnvelope(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  input: {
    revision: number;
    issuedAt: number;
    expiresAt: number;
    limitUsd?: number;
    keyId?: string;
  },
) {
  const payload = {
    schemaVersion: 1 as const,
    keyId: input.keyId ?? 'enterprise-key-1',
    revision: input.revision,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    policies: [
      {
        id: 'org-global',
        scope: 'global' as const,
        scopeRef: 'global',
        windowMs: 86_400_000,
        limitUsd: input.limitUsd ?? 250,
        mode: 'hard' as const,
      },
    ],
  };
  return {
    ...payload,
    signature: sign(
      null,
      Buffer.from(canonicalizeSignedModelFabricPolicy(payload)),
      privateKey,
    ).toString('base64'),
  };
}

function toPublicKeyPem(
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'],
): string {
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

function signingKeyRecord(
  keyId: string,
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'],
  input: {
    status: 'active' | 'revoked';
    notBefore: number;
    notAfter: number;
  },
) {
  return {
    keyId,
    publicKey: toPublicKeyPem(publicKey),
    status: input.status,
    notBefore: input.notBefore,
    notAfter: input.notAfter,
  };
}

function signedControlPlaneSnapshot(input: {
  rootPrivateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  policyPrivateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  keysetRevision: number;
  policyRevision: number;
  issuedAt: number;
  expiresAt: number;
  keys: ReturnType<typeof signingKeyRecord>[];
  policyKeyId: string;
  limitUsd?: number;
}) {
  const keysetPayload = {
    schemaVersion: 1 as const,
    revision: input.keysetRevision,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    keys: input.keys,
  };
  const keyset = {
    ...keysetPayload,
    signature: sign(
      null,
      Buffer.from(canonicalizeSignedModelFabricKeyset(keysetPayload)),
      input.rootPrivateKey,
    ).toString('base64'),
  };
  return {
    schemaVersion: 2 as const,
    keyset,
    policy: signedEnvelope(input.policyPrivateKey, {
      revision: input.policyRevision,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      limitUsd: input.limitUsd,
      keyId: input.policyKeyId,
    }),
  };
}

function signedRootsetControlPlaneSnapshot(input: {
  rootsetSignerPrivateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  rootsetSignedBy: string;
  rootsetRevision: number;
  roots: ReturnType<typeof signingKeyRecord>[];
  keysetRootPrivateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  keysetRootKeyId: string;
  policyPrivateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  delegatedKeys: ReturnType<typeof signingKeyRecord>[];
  policyKeyId: string;
  keysetRevision: number;
  policyRevision: number;
  issuedAt: number;
  expiresAt: number;
  limitUsd?: number;
}) {
  const rootsetPayload = {
    schemaVersion: 1 as const,
    revision: input.rootsetRevision,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    signedBy: input.rootsetSignedBy,
    roots: input.roots,
  };
  const rootset = {
    ...rootsetPayload,
    signature: sign(
      null,
      Buffer.from(canonicalizeSignedModelFabricRootset(rootsetPayload)),
      input.rootsetSignerPrivateKey,
    ).toString('base64'),
  };
  const keysetPayload = {
    schemaVersion: 2 as const,
    rootKeyId: input.keysetRootKeyId,
    revision: input.keysetRevision,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    keys: input.delegatedKeys,
  };
  const keyset = {
    ...keysetPayload,
    signature: sign(
      null,
      Buffer.from(canonicalizeCrossSignedModelFabricKeyset(keysetPayload)),
      input.keysetRootPrivateKey,
    ).toString('base64'),
  };
  return {
    schemaVersion: 3 as const,
    rootset,
    keyset,
    policy: signedEnvelope(input.policyPrivateKey, {
      revision: input.policyRevision,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      limitUsd: input.limitUsd,
      keyId: input.policyKeyId,
    }),
  };
}

function controlPlaneResult(input: {
  revision?: number;
  expiresAt?: number;
  error?: string;
  cached?: boolean;
}) {
  return {
    source: 'control-plane' as const,
    policies: input.error
      ? []
      : [
          {
            id: 'org-global',
            scope: 'global' as const,
            scopeRef: 'global',
            windowMs: 86_400_000,
            limitUsd: 250,
            mode: 'hard' as const,
          },
        ],
    error: input.error ?? null,
    cached: input.cached ?? false,
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  };
}

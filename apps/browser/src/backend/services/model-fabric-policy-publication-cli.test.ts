import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runModelFabricPolicyPublicationCli } from '../../../scripts/model-fabric-policy-publication';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('Model Fabric policy publication CLI', () => {
  it('signs, approves, publishes, and verifies a canary using private atomic files', async () => {
    const fixture = await createCliFixture();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runModelFabricPolicyPublicationCli([
      'sign-authority',
      '--authority',
      fixture.authorityDraftPath,
      '--root-private-key',
      fixture.rootPrivatePath,
      '--root-public-key',
      fixture.rootPublicPath,
      '--out',
      fixture.authorityPath,
    ]);
    await runModelFabricPolicyPublicationCli([
      'prepare-snapshot',
      '--payload',
      fixture.snapshotDraftPath,
      '--root-public-key',
      fixture.rootPublicPath,
      '--rootset-private-key',
      fixture.rootPrivatePath,
      '--keyset-private-key',
      fixture.rootPrivatePath,
      '--policy-private-key',
      fixture.policyPrivatePath,
      '--out',
      fixture.snapshotPath,
    ]);
    await runModelFabricPolicyPublicationCli([
      'approve',
      '--authority',
      fixture.authorityPath,
      '--root-public-key',
      fixture.rootPublicPath,
      '--snapshot',
      fixture.snapshotPath,
      '--approver-id',
      'approver-release',
      '--approver-private-key',
      fixture.releasePrivatePath,
      '--stage',
      'canary',
      '--out',
      fixture.approvalPath,
    ]);
    await runModelFabricPolicyPublicationCli([
      'publish',
      '--authority',
      fixture.authorityPath,
      '--root-public-key',
      fixture.rootPublicPath,
      '--snapshot',
      fixture.snapshotPath,
      '--approval',
      fixture.approvalPath,
      '--publisher-id',
      'publisher-a',
      '--publisher-private-key',
      fixture.publisherPrivatePath,
      '--stage',
      'canary',
      '--bootstrap',
      'true',
      '--state',
      fixture.statePath,
      '--receipt',
      fixture.receiptPath,
      '--out',
      fixture.publishedSnapshotPath,
    ]);
    await runModelFabricPolicyPublicationCli([
      'verify-state',
      '--state',
      fixture.statePath,
      '--root-public-key',
      fixture.rootPublicPath,
    ]);

    const [snapshot, receipt, state] = await Promise.all([
      readJson(fixture.publishedSnapshotPath),
      readJson(fixture.receiptPath),
      readJson(fixture.statePath),
    ]);
    expect(snapshot).toMatchObject({ schemaVersion: 3 });
    expect(receipt).toMatchObject({ schemaVersion: 1, stage: 'canary' });
    expect(state).toMatchObject({
      schemaVersion: 2,
      lastReceipt: { stage: 'canary' },
      lastSnapshot: { schemaVersion: 3 },
      publisherKeyId: 'publisher-a',
    });
    expect(JSON.stringify(receipt)).not.toMatch(/policies|limitUsd|publicKey/i);
    if (process.platform !== 'win32') {
      for (const outputPath of [
        fixture.publishedSnapshotPath,
        fixture.receiptPath,
        fixture.statePath,
      ]) {
        expect((await fs.stat(outputPath)).mode & 0o077).toBe(0);
      }
    }

    const tamperedState = await readJson(fixture.statePath);
    tamperedState.usedApprovalNonceHashes = [];
    await fs.writeFile(
      fixture.tamperedStatePath,
      JSON.stringify(tamperedState),
      'utf8',
    );
    await expect(
      runModelFabricPolicyPublicationCli([
        'prepare-snapshot',
        '--payload',
        fixture.snapshotDraftPath,
        '--root-public-key',
        fixture.rootPublicPath,
        '--rootset-private-key',
        fixture.rootPrivatePath,
        '--keyset-private-key',
        fixture.rootPrivatePath,
        '--policy-private-key',
        fixture.policyPrivatePath,
        '--state',
        fixture.tamperedStatePath,
        '--out',
        fixture.snapshotWithStatePath,
      ]),
    ).rejects.toThrow('state signature verification failed');
    await expect(
      runModelFabricPolicyPublicationCli([
        'approve',
        '--authority',
        fixture.authorityPath,
        '--root-public-key',
        fixture.rootPublicPath,
        '--snapshot',
        fixture.snapshotPath,
        '--approver-id',
        'approver-release',
        '--approver-private-key',
        fixture.releasePrivatePath,
        '--stage',
        'canary',
        '--state',
        fixture.tamperedStatePath,
        '--out',
        fixture.approvalWithStatePath,
      ]),
    ).rejects.toThrow('state signature verification failed');
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a private key file accessible by group or other users',
    async () => {
      const fixture = await createCliFixture();
      await fs.chmod(fixture.rootPrivatePath, 0o644);
      await expect(
        runModelFabricPolicyPublicationCli([
          'sign-authority',
          '--authority',
          fixture.authorityDraftPath,
          '--root-private-key',
          fixture.rootPrivatePath,
          '--root-public-key',
          fixture.rootPublicPath,
          '--out',
          fixture.authorityPath,
        ]),
      ).rejects.toThrow('must not be accessible by group or other users');
    },
  );
});

async function createCliFixture() {
  const rootDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'model-fabric-publication-'),
  );
  temporaryRoots.push(rootDirectory);
  const now = Date.now();
  const root = keyPair();
  const policy = keyPair();
  const release = keyPair();
  const security = keyPair();
  const publisher = keyPair();
  const paths = {
    rootPrivatePath: path.join(rootDirectory, 'root.private.pem'),
    rootPublicPath: path.join(rootDirectory, 'root.public.pem'),
    policyPrivatePath: path.join(rootDirectory, 'policy.private.pem'),
    releasePrivatePath: path.join(rootDirectory, 'release.private.pem'),
    publisherPrivatePath: path.join(rootDirectory, 'publisher.private.pem'),
    authorityDraftPath: path.join(rootDirectory, 'authority.unsigned.json'),
    authorityPath: path.join(rootDirectory, 'authority.signed.json'),
    snapshotDraftPath: path.join(rootDirectory, 'snapshot.unsigned.json'),
    snapshotPath: path.join(rootDirectory, 'snapshot.signed.json'),
    approvalPath: path.join(rootDirectory, 'approval.canary.json'),
    statePath: path.join(rootDirectory, 'publication-state.json'),
    tamperedStatePath: path.join(
      rootDirectory,
      'publication-state.tampered.json',
    ),
    receiptPath: path.join(rootDirectory, 'publication-receipt.json'),
    snapshotWithStatePath: path.join(rootDirectory, 'snapshot.with-state.json'),
    approvalWithStatePath: path.join(rootDirectory, 'approval.with-state.json'),
    publishedSnapshotPath: path.join(
      rootDirectory,
      'control-plane-snapshot.json',
    ),
  };
  await Promise.all([
    writePrivateKey(paths.rootPrivatePath, root.privateKeyPem),
    fs.writeFile(paths.rootPublicPath, root.publicKeyPem, 'utf8'),
    writePrivateKey(paths.policyPrivatePath, policy.privateKeyPem),
    writePrivateKey(paths.releasePrivatePath, release.privateKeyPem),
    writePrivateKey(paths.publisherPrivatePath, publisher.privateKeyPem),
  ]);
  const trustWindow = {
    status: 'active' as const,
    notBefore: now - 60_000,
    notAfter: now + 2 * 24 * 60 * 60_000,
  };
  await Promise.all([
    fs.writeFile(
      paths.authorityDraftPath,
      JSON.stringify({
        schemaVersion: 1,
        authorityId: 'enterprise-policy-authority',
        revision: 1,
        issuedAt: now - 60_000,
        expiresAt: now + 24 * 60 * 60_000,
        signedBy: 'root-a',
        approvers: [
          {
            keyId: 'approver-release',
            publicKey: release.publicKeyPem,
            ...trustWindow,
            roles: ['release'],
          },
          {
            keyId: 'approver-security',
            publicKey: security.publicKeyPem,
            ...trustWindow,
            roles: ['security'],
          },
        ],
        publishers: [
          {
            keyId: 'publisher-a',
            publicKey: publisher.publicKeyPem,
            ...trustWindow,
          },
        ],
        stages: [
          {
            stage: 'canary',
            requiredApprovals: 1,
            requiredRoles: ['release'],
          },
          {
            stage: 'production',
            requiredApprovals: 2,
            requiredRoles: ['release', 'security'],
            requiresPriorStage: 'canary',
          },
        ],
      }),
    ),
    fs.writeFile(
      paths.snapshotDraftPath,
      JSON.stringify({
        schemaVersion: 1,
        rootset: {
          schemaVersion: 1,
          revision: 1,
          issuedAt: now - 60_000,
          expiresAt: now + 24 * 60 * 60_000,
          signedBy: 'root-a',
          roots: [
            {
              keyId: 'root-a',
              publicKey: root.publicKeyPem,
              ...trustWindow,
            },
          ],
        },
        keyset: {
          schemaVersion: 2,
          rootKeyId: 'root-a',
          revision: 1,
          issuedAt: now - 60_000,
          expiresAt: now + 23 * 60 * 60_000,
          keys: [
            {
              keyId: 'policy-a',
              publicKey: policy.publicKeyPem,
              ...trustWindow,
            },
          ],
        },
        policy: {
          schemaVersion: 1,
          keyId: 'policy-a',
          revision: 1,
          issuedAt: now - 60_000,
          expiresAt: now + 22 * 60 * 60_000,
          policies: [
            {
              id: 'enterprise-global',
              scope: 'global',
              scopeRef: 'global',
              windowMs: 86_400_000,
              limitUsd: 250,
              mode: 'hard',
            },
          ],
        },
      }),
    ),
  ]);
  return paths;
}

function keyPair() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: pair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    publicKeyPem: pair.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
  };
}

async function writePrivateKey(filePath: string, value: string): Promise<void> {
  await fs.writeFile(filePath, value, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') await fs.chmod(filePath, 0o600);
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<
    string,
    unknown
  >;
}

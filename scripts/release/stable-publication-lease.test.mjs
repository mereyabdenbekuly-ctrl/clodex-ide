import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_RELEASE_REPOSITORY,
  GitHubStablePublicationApi,
  STABLE_PUBLICATION_LEASE_MAX_TTL_MS,
  STABLE_PUBLICATION_LEASE_RECEIPT_KIND,
  STABLE_PUBLICATION_LEASE_RECOVERY_MAX_AGE_MS,
  publishStableReleaseWithLease,
  stablePublicationAssetsSnapshotSha256,
  validateLeaseBoundLiveRelease,
  validateStablePublicationHandoff,
  validateStablePublicationLeaseReceipt,
  validateStablePublicationSnapshot,
} from './publish-stable-release-with-lease.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const fixtureDirectory = path.join(
  scriptDirectory,
  'fixtures/stable-publication',
);
const leaseFixtureBytes = readFileSync(
  path.join(fixtureDirectory, 'lease.valid.json'),
);
const snapshotFixtureBytes = readFileSync(
  path.join(fixtureDirectory, 'publication-snapshot.valid.json'),
);
const leaseFixture = JSON.parse(leaseFixtureBytes.toString('utf8'));
const snapshotFixture = JSON.parse(snapshotFixtureBytes.toString('utf8'));
const NOW = new Date('2026-07-16T00:06:00.000Z');
const RELEASE_NAME = 'Clodex Agentic IDE 1.16.0';
const RELEASE_BODY = 'Stable release notes\n';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function expectedBindings(lease = leaseFixture) {
  return {
    epoch: lease.lease.epoch,
    holder: clone(lease.holder),
    manifest: clone(lease.manifest),
    producer: clone(lease.producer),
    publication: {
      draftSnapshotSha256: lease.publication.draftSnapshotSha256,
    },
    resource: clone(lease.resource),
    source: clone(lease.source),
  };
}

function liveAssets(snapshot = snapshotFixture) {
  return snapshot.assets.map((asset) => ({
    digest: `sha256:${asset.sha256}`,
    id: asset.releaseAssetId,
    name: asset.fileName,
    size: asset.bytes,
    state: 'uploaded',
  }));
}

function liveRelease({
  immutable = false,
  publishedAt = null,
  snapshot = snapshotFixture,
  state = 'draft',
} = {}) {
  return {
    assets: liveAssets(snapshot),
    body: RELEASE_BODY,
    created_at: '2026-07-16T00:00:00Z',
    draft: state === 'draft',
    id: snapshot.releaseId,
    immutable,
    name: RELEASE_NAME,
    prerelease: false,
    published_at:
      state === 'published' ? (publishedAt ?? '2026-07-16T00:06:00Z') : null,
    tag_name: snapshot.tag,
    target_commitish: snapshot.sourceCommit,
    url: `https://api.github.com/repos/${snapshot.repository}/releases/${snapshot.releaseId}`,
  };
}

function invocation({
  api,
  clock,
  expected = expectedBindings(),
  lease = leaseFixture,
  leaseBytes = leaseFixtureBytes,
  now = NOW,
  snapshot = snapshotFixture,
  snapshotBytes = snapshotFixtureBytes,
} = {}) {
  return {
    api,
    clock: clock ?? (() => new Date(now.getTime())),
    expected,
    expectedLeaseSha256: sha256(leaseBytes),
    expectedSnapshotSha256: sha256(snapshotBytes),
    lease,
    leaseBytes,
    now,
    snapshot,
    snapshotBytes,
  };
}

class FakeApi {
  constructor({ effect, effectError, initial, terminal }) {
    this.effect = effect;
    this.effectError = effectError;
    this.getResponses = [initial, terminal].filter(Boolean);
    this.getCalls = [];
    this.patchCalls = [];
  }

  async getRelease(repository, releaseId) {
    this.getCalls.push({ releaseId, repository });
    const response = this.getResponses.shift();
    if (!response) throw new Error('unexpected terminal GET');
    return response;
  }

  async publishRelease(repository, releaseId, etag) {
    this.patchCalls.push({ etag, releaseId, repository });
    if (this.effectError) throw this.effectError;
    return this.effect;
  }
}

test('strict lease schema and attested draft snapshot fixture are internally bound', () => {
  assert.equal(leaseFixture.receiptKind, STABLE_PUBLICATION_LEASE_RECEIPT_KIND);
  assert.equal(STABLE_PUBLICATION_LEASE_MAX_TTL_MS, 15 * 60 * 1000);
  assert.equal(
    STABLE_PUBLICATION_LEASE_RECOVERY_MAX_AGE_MS,
    72 * 60 * 60 * 1000,
  );
  assert.doesNotThrow(() =>
    validateStablePublicationLeaseReceipt(leaseFixture, {
      expected: expectedBindings(),
      now: NOW,
      requireActive: true,
    }),
  );
  assert.doesNotThrow(() => validateStablePublicationSnapshot(snapshotFixture));
  assert.equal(
    stablePublicationAssetsSnapshotSha256(snapshotFixture),
    leaseFixture.publication.assetsSnapshotSha256,
  );
  assert.equal(
    sha256(snapshotFixtureBytes),
    leaseFixture.publication.draftSnapshotSha256,
  );
  assert.doesNotThrow(() => validateStablePublicationHandoff(invocation()));
});

test('lease schema rejects unsupported fields, substitutions, unsafe paths, and invalid windows', async (t) => {
  const cases = [
    {
      name: 'unsupported root field',
      mutate(value) {
        value.rawToken = 'forbidden';
      },
      error: /missing or unsupported fields/u,
    },
    {
      name: 'manifest traversal',
      mutate(value) {
        value.manifest.path = '.release-notes/../outside.json';
      },
      error: /manifest path is invalid/u,
    },
    {
      name: 'non-stable tag',
      mutate(value) {
        value.resource.tag = 'v1.16.0-preview.3';
      },
      error: /stable tag is invalid/u,
    },
    {
      name: 'short nonce',
      mutate(value) {
        value.lease.nonce = 'short';
      },
      error: /256-bit base64url/u,
    },
    {
      name: 'producer workflow substitution',
      mutate(value) {
        value.producer.workflow =
          'other-org/other-repo/.github/workflows/issue.yml';
      },
      error: /producer workflow is invalid/u,
    },
    {
      name: 'producer source/workflow split',
      mutate(value) {
        value.producer.workflowCommit = 'd'.repeat(40);
      },
      error: /source and workflow commits differ/u,
    },
    {
      name: 'overlong lease',
      mutate(value) {
        value.lease.expiresAt = '2026-07-16T00:17:00.001Z';
      },
      error: /lifetime exceeds/u,
    },
    {
      name: 'non-canonical timestamp',
      mutate(value) {
        value.lease.issuedAt = '2026-07-16T00:02:00Z';
      },
      error: /canonical UTC instant/u,
    },
    {
      name: 'relaxed patch constraint',
      mutate(value) {
        value.constraints.maximumPatchAttempts = 2;
      },
      error: /not fail-closed/u,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, () => {
      const lease = clone(leaseFixture);
      item.mutate(lease);
      assert.throws(
        () =>
          validateStablePublicationLeaseReceipt(lease, {
            expected: expectedBindings(lease),
            now: NOW,
          }),
        item.error,
      );
    });
  }

  await t.test('trusted holder binding substitution', () => {
    const lease = clone(leaseFixture);
    lease.holder.runId += 1;
    assert.throws(
      () =>
        validateStablePublicationLeaseReceipt(lease, {
          expected: expectedBindings(),
          now: NOW,
        }),
      /expected trusted bindings/u,
    );
  });

  await t.test('trusted epoch substitution', () => {
    const lease = clone(leaseFixture);
    lease.lease.epoch += 1;
    assert.throws(
      () =>
        validateStablePublicationLeaseReceipt(lease, {
          expected: expectedBindings(),
          now: NOW,
        }),
      /expected trusted bindings/u,
    );
  });
});

test('handoff rejects changed lease bytes, snapshot bytes, asset digest, and identity', async (t) => {
  await t.test('lease bytes', () => {
    assert.throws(
      () =>
        validateStablePublicationHandoff({
          ...invocation(),
          leaseBytes: Buffer.concat([leaseFixtureBytes, Buffer.from(' ')]),
        }),
      /lease receipt bytes differ/u,
    );
  });

  await t.test('snapshot bytes', () => {
    assert.throws(
      () =>
        validateStablePublicationHandoff({
          ...invocation(),
          snapshotBytes: Buffer.concat([
            snapshotFixtureBytes,
            Buffer.from(' '),
          ]),
        }),
      /snapshot bytes differ/u,
    );
  });

  await t.test('assets snapshot digest', () => {
    const lease = clone(leaseFixture);
    lease.publication.assetsSnapshotSha256 = 'f'.repeat(64);
    const leaseBytes = jsonBytes(lease);
    assert.throws(
      () =>
        validateStablePublicationHandoff({
          ...invocation({
            expected: expectedBindings(lease),
            lease,
            leaseBytes,
          }),
        }),
      /assets snapshot digest is invalid/u,
    );
  });

  await t.test('snapshot source substitution', () => {
    const lease = clone(leaseFixture);
    lease.source.commit = 'd'.repeat(40);
    const leaseBytes = jsonBytes(lease);
    assert.throws(
      () =>
        validateStablePublicationHandoff(
          invocation({
            expected: expectedBindings(lease),
            lease,
            leaseBytes,
          }),
        ),
      /snapshot identities differ/u,
    );
  });
});

test('lease-bound publisher performs one conditional PATCH and terminal verification', async () => {
  const published = liveRelease({ immutable: true, state: 'published' });
  const api = new FakeApi({
    initial: { etag: 'W/"draft-etag"', release: liveRelease() },
    effect: { etag: 'W/"published-etag"', release: published, status: 200 },
    terminal: { etag: 'W/"published-etag"', release: published },
  });

  const result = await publishStableReleaseWithLease(invocation({ api }));
  assert.deepEqual(result, {
    leaseEpoch: 42,
    leaseNonceSha256: sha256(leaseFixture.lease.nonce),
    patched: true,
    releaseId: 4242,
    state: 'published',
    status: 'published',
    tag: 'clodex@1.16.0',
  });
  assert.equal(api.patchCalls.length, 1);
  assert.deepEqual(api.patchCalls[0], {
    etag: 'W/"draft-etag"',
    releaseId: 4242,
    repository: CANONICAL_RELEASE_REPOSITORY,
  });
  assert.equal(api.getCalls.length, 2);
});

test('lease expiry during the initial GET prevents every publication PATCH', async () => {
  const beforeExpiry = new Date('2026-07-16T00:11:59.500Z');
  const afterExpiry = new Date('2026-07-16T00:12:00.001Z');
  const clockSamples = [beforeExpiry, afterExpiry, afterExpiry];
  const api = new FakeApi({
    initial: { etag: 'W/"draft-etag"', release: liveRelease() },
  });

  await assert.rejects(
    publishStableReleaseWithLease(
      invocation({
        api,
        clock: () => clockSamples.shift() ?? afterExpiry,
      }),
    ),
    /not active for a publication effect/u,
  );
  assert.equal(api.getCalls.length, 1);
  assert.equal(api.patchCalls.length, 0);
});

test('same lease replay is idempotent only for exact immutable publication inside its window', async (t) => {
  await t.test('exact already-published state uses no PATCH', async () => {
    const api = new FakeApi({
      initial: {
        etag: 'W/"published-etag"',
        release: liveRelease({ immutable: true, state: 'published' }),
      },
    });
    const result = await publishStableReleaseWithLease(invocation({ api }));
    assert.equal(result.status, 'already-published');
    assert.equal(result.patched, false);
    assert.equal(api.patchCalls.length, 0);
  });

  await t.test(
    'expired lease may verify recent completed effect but cannot mutate',
    async () => {
      const afterExpiry = new Date('2026-07-16T01:00:00.000Z');
      const publishedApi = new FakeApi({
        initial: {
          etag: 'W/"published-etag"',
          release: liveRelease({ immutable: true, state: 'published' }),
        },
      });
      await assert.doesNotReject(
        publishStableReleaseWithLease(
          invocation({ api: publishedApi, now: afterExpiry }),
        ),
      );
      assert.equal(publishedApi.patchCalls.length, 0);

      const draftApi = new FakeApi({
        initial: { etag: 'W/"draft-etag"', release: liveRelease() },
      });
      await assert.rejects(
        publishStableReleaseWithLease(
          invocation({ api: draftApi, now: afterExpiry }),
        ),
        /not active for a publication effect/u,
      );
      assert.equal(draftApi.patchCalls.length, 0);
    },
  );

  await t.test(
    'publication before lease issuance is not replay success',
    async () => {
      const api = new FakeApi({
        initial: {
          etag: 'W/"published-etag"',
          release: liveRelease({
            immutable: true,
            publishedAt: '2026-07-15T23:30:00.000Z',
            state: 'published',
          }),
        },
      });
      await assert.rejects(
        publishStableReleaseWithLease(invocation({ api })),
        /outside the lease window/u,
      );
      assert.equal(api.patchCalls.length, 0);
    },
  );

  await t.test('non-immutable public release is rejected', async () => {
    const api = new FakeApi({
      initial: {
        etag: 'W/"published-etag"',
        release: liveRelease({ immutable: false, state: 'published' }),
      },
    });
    await assert.rejects(
      publishStableReleaseWithLease(invocation({ api })),
      /not immutable/u,
    );
    assert.equal(api.patchCalls.length, 0);
  });
});

test('publisher fails before mutation on draft identity, metadata, asset, and ETag drift', async (t) => {
  const cases = [
    {
      name: 'source commit',
      mutate(release) {
        release.target_commitish = 'd'.repeat(40);
      },
      error: /identity differs/u,
    },
    {
      name: 'release name',
      mutate(release) {
        release.name = 'Substituted release';
      },
      error: /name or body differs/u,
    },
    {
      name: 'release body',
      mutate(release) {
        release.body = 'substituted body';
      },
      error: /name or body differs/u,
    },
    {
      name: 'asset size',
      mutate(release) {
        release.assets[0].size += 1;
      },
      error: /asset snapshot differs/u,
    },
    {
      name: 'extra asset',
      mutate(release) {
        release.assets.push({
          digest: `sha256:${'f'.repeat(64)}`,
          id: 999,
          name: 'unexpected.bin',
          size: 1,
          state: 'uploaded',
        });
      },
      error: /asset snapshot differs/u,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const release = liveRelease();
      item.mutate(release);
      const api = new FakeApi({
        initial: { etag: 'W/"draft-etag"', release },
      });
      await assert.rejects(
        publishStableReleaseWithLease(invocation({ api })),
        item.error,
      );
      assert.equal(api.patchCalls.length, 0);
    });
  }

  await t.test('missing ETag', async () => {
    const api = new FakeApi({
      initial: { etag: null, release: liveRelease() },
    });
    await assert.rejects(
      publishStableReleaseWithLease(invocation({ api })),
      /conditional ETag/u,
    );
    assert.equal(api.patchCalls.length, 0);
  });
});

test('precondition races and uncertain responses never cause a second PATCH', async (t) => {
  await t.test('412 followed by exact publication recovers', async () => {
    const api = new FakeApi({
      initial: { etag: 'W/"draft-etag"', release: liveRelease() },
      effect: {
        etag: null,
        release: { message: 'Precondition Failed' },
        status: 412,
      },
      terminal: {
        etag: 'W/"published-etag"',
        release: liveRelease({ immutable: true, state: 'published' }),
      },
    });
    const result = await publishStableReleaseWithLease(invocation({ api }));
    assert.equal(result.status, 'published-after-precondition-race');
    assert.equal(api.patchCalls.length, 1);
  });

  await t.test('412 followed by unchanged draft fails closed', async () => {
    const api = new FakeApi({
      initial: { etag: 'W/"draft-etag"', release: liveRelease() },
      effect: {
        etag: null,
        release: { message: 'Precondition Failed' },
        status: 412,
      },
      terminal: { etag: 'W/"new-draft-etag"', release: liveRelease() },
    });
    await assert.rejects(
      publishStableReleaseWithLease(invocation({ api })),
      /outcome is uncertain/u,
    );
    assert.equal(api.patchCalls.length, 1);
  });

  await t.test(
    'network error followed by exact publication recovers',
    async () => {
      const api = new FakeApi({
        initial: { etag: 'W/"draft-etag"', release: liveRelease() },
        effectError: new Error('connection reset'),
        terminal: {
          etag: 'W/"published-etag"',
          release: liveRelease({ immutable: true, state: 'published' }),
        },
      });
      const result = await publishStableReleaseWithLease(invocation({ api }));
      assert.equal(result.status, 'published-after-uncertain-response');
      assert.equal(api.patchCalls.length, 1);
    },
  );

  await t.test(
    'network error followed by draft remains uncertain',
    async () => {
      const api = new FakeApi({
        initial: { etag: 'W/"draft-etag"', release: liveRelease() },
        effectError: new Error('connection reset'),
        terminal: { etag: 'W/"draft-etag"', release: liveRelease() },
      });
      await assert.rejects(
        publishStableReleaseWithLease(invocation({ api })),
        /retain the same lease for terminal inspection/u,
      );
      assert.equal(api.patchCalls.length, 1);
    },
  );
});

test('PATCH response and terminal state must both be exact and immutable', async (t) => {
  await t.test('non-immutable PATCH response', async () => {
    const api = new FakeApi({
      initial: { etag: 'W/"draft-etag"', release: liveRelease() },
      effect: {
        etag: 'W/"published-etag"',
        release: liveRelease({ immutable: false, state: 'published' }),
        status: 200,
      },
    });
    await assert.rejects(
      publishStableReleaseWithLease(invocation({ api })),
      /not immutable/u,
    );
    assert.equal(api.patchCalls.length, 1);
  });

  await t.test('terminal asset substitution', async () => {
    const effectRelease = liveRelease({ immutable: true, state: 'published' });
    const terminalRelease = liveRelease({
      immutable: true,
      state: 'published',
    });
    terminalRelease.assets[0].digest = `sha256:${'f'.repeat(64)}`;
    const api = new FakeApi({
      initial: { etag: 'W/"draft-etag"', release: liveRelease() },
      effect: {
        etag: 'W/"published-etag"',
        release: effectRelease,
        status: 200,
      },
      terminal: { etag: 'W/"published-etag-2"', release: terminalRelease },
    });
    await assert.rejects(
      publishStableReleaseWithLease(invocation({ api })),
      /asset snapshot differs/u,
    );
    assert.equal(api.patchCalls.length, 1);
  });
});

test('GitHub API wrapper emits only exact conditional draft-to-public PATCH', async () => {
  const calls = [];
  const responseRelease = liveRelease({ immutable: true, state: 'published' });
  const fetchImpl = async (url, options) => {
    calls.push({ options, url: String(url) });
    return new Response(JSON.stringify(responseRelease), {
      headers: { ETag: 'W/"published-etag"' },
      status: 200,
    });
  };
  const api = new GitHubStablePublicationApi({
    fetchImpl,
    token: 'test-token',
  });
  const response = await api.publishRelease(
    CANONICAL_RELEASE_REPOSITORY,
    4242,
    'W/"draft-etag"',
  );
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://api.github.com/repos/mereyabdenbekuly-ctrl/clodex-ide/releases/4242',
  );
  assert.equal(calls[0].options.method, 'PATCH');
  assert.equal(calls[0].options.body, '{"draft":false}');
  assert.equal(calls[0].options.headers['If-Match'], 'W/"draft-etag"');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.cache, 'no-store');
});

test('public JSON schema mirrors the strict receipt boundary', () => {
  const schema = JSON.parse(
    readFileSync(
      path.join(
        repositoryRoot,
        'docs/release/stable-publication-lease-receipt.schema.json',
      ),
      'utf8',
    ),
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.equal(
    schema.properties.receiptKind.const,
    STABLE_PUBLICATION_LEASE_RECEIPT_KIND,
  );
  assert.equal(
    schema.properties.resource.properties.repository.const,
    CANONICAL_RELEASE_REPOSITORY,
  );
  assert.equal(schema.properties.constraints.additionalProperties, false);
  assert.equal(
    schema.properties.constraints.properties.maximumPatchAttempts.const,
    1,
  );
  assert.equal(
    schema.properties.constraints.properties.requireConditionalRequest.const,
    true,
  );
  assert.equal(
    schema.properties.constraints.properties.requireTerminalImmutable.const,
    true,
  );
});

test('stable workflow remains fail-closed and does not activate the publisher', () => {
  const workflow = readFileSync(
    path.join(repositoryRoot, '.github/workflows/_release-browser.yml'),
    'utf8',
  );
  const stableSection = workflow.split('\n  verify-stable-draft:')[1];
  assert.match(stableSection, /Stable publication is NOT_READY/u);
  assert.match(stableSection, /exit 1/u);
  assert.doesNotMatch(stableSection, /publish-stable-release-with-lease\.mjs/u);
  assert.doesNotMatch(stableSection, /gh api --method PATCH/u);
});

test('live release validator independently rejects invalid state transitions', () => {
  assert.throws(
    () =>
      validateLeaseBoundLiveRelease({
        lease: leaseFixture,
        now: NOW,
        release: { ...liveRelease(), draft: false, published_at: null },
        snapshot: snapshotFixture,
        state: 'draft',
      }),
    /state differs/u,
  );
});

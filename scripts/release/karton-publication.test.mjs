import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertExactPublishedRelease,
  createOrRecoverExactPublicRelease,
} from './create-exact-public-release.mjs';
import {
  NpmPublicationPendingError,
  assertLocalNpmArtifact,
  compareCanonicalStableSemVer,
  inspectNpmPublicationStateOnce,
  pollExactNpmPublication,
  verifyExactNpmPublicationOnce,
} from './verify-npm-publication.mjs';

const repositoryRoot = new URL('../../', import.meta.url);
const packageName = '@clodex/karton';
const version = '0.0.1';
const registryOrigin = 'https://registry.npmjs.org/';
const tarballUrl = `${registryOrigin}@clodex/karton/-/karton-${version}.tgz`;

function localArtifact(bytes = Buffer.from('exact-karton-tarball')) {
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const shasum = createHash('sha1').update(bytes).digest('hex');
  return assertLocalNpmArtifact({
    artifactBytes: bytes,
    identity: {
      filename: 'karton-package.tgz',
      integrity,
      name: packageName,
      shasum,
      size: bytes.length,
      version,
    },
    packageName,
    version,
  });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function exactRegistryFetch({
  artifact = localArtifact(),
  distTag = version,
  metadata = {},
  tarball = artifact.bytes,
} = {}) {
  return async (url) => {
    const href = String(url);
    if (href.includes('/dist-tags')) {
      return jsonResponse({ latest: distTag });
    }
    if (href === tarballUrl) return new Response(tarball, { status: 200 });
    return jsonResponse({
      _id: `${packageName}@${version}`,
      dist: {
        integrity: artifact.integrity,
        shasum: artifact.shasum,
        tarball: tarballUrl,
      },
      name: packageName,
      version,
      ...metadata,
    });
  };
}

test('terminal npm verifier binds exact artifact identity and canonical latest', async () => {
  const artifact = localArtifact();
  const result = await verifyExactNpmPublicationOnce({
    artifact,
    fetchImpl: exactRegistryFetch({ artifact }),
    registryOrigin,
  });
  assert.deepEqual(result, {
    distTag: 'latest',
    distTagRelation: 'exact',
    distTagVersion: version,
    existingExact: true,
    integrity: artifact.integrity,
    packageName,
    publishRequired: false,
    shasum: artifact.shasum,
    size: artifact.size,
    state: 'verified',
    tarballUrl,
    version,
  });
});

test('prepublish inspection refuses an absent lower version before npm --tag latest', async () => {
  const artifact = localArtifact();
  const absentFetch = async (url) => {
    if (String(url).includes('/dist-tags')) {
      return jsonResponse({ latest: '0.0.2' });
    }
    return new Response('', { status: 404 });
  };

  await assert.rejects(
    inspectNpmPublicationStateOnce({
      artifact,
      fetchImpl: absentFetch,
      registryOrigin,
    }),
    /refusing to publish absent .* with npm --tag latest.*newer \(0\.0\.2\)/,
  );
});

test('prepublish inspection allows only a monotonic absent version', async () => {
  const artifact = localArtifact();
  const result = await inspectNpmPublicationStateOnce({
    artifact,
    fetchImpl: async (url) => {
      if (String(url).includes('/dist-tags')) {
        return jsonResponse({ latest: '0.0.0' });
      }
      return new Response('', { status: 404 });
    },
    registryOrigin,
  });
  assert.equal(result.publishRequired, true);
  assert.equal(result.existingExact, false);
  assert.equal(result.distTagRelation, 'advances');
  assert.equal(result.distTagVersion, '0.0.0');
});

test('effect-step reauthorization rejects a newer latest that wins after the initial gate', async () => {
  const artifact = localArtifact();
  let latest = '0.0.0';
  const fetchImpl = async (url) => {
    if (String(url).includes('/dist-tags')) {
      return jsonResponse({ latest });
    }
    return new Response('', { status: 404 });
  };

  const initial = await inspectNpmPublicationStateOnce({
    artifact,
    fetchImpl,
    registryOrigin,
  });
  assert.equal(initial.publishRequired, true);

  latest = '0.0.2';
  await assert.rejects(
    inspectNpmPublicationStateOnce({
      artifact,
      fetchImpl,
      registryOrigin,
    }),
    /refusing to publish absent .* npm latest is newer \(0\.0\.2\)/,
  );
});

test('exact old version remains terminal after a newer latest appears', async () => {
  const artifact = localArtifact();
  const fetchImpl = exactRegistryFetch({ artifact, distTag: '0.0.2' });
  const inspected = await inspectNpmPublicationStateOnce({
    artifact,
    fetchImpl,
    registryOrigin,
  });
  assert.equal(inspected.publishRequired, false);
  assert.equal(inspected.distTagRelation, 'superseded');
  assert.equal(inspected.distTagVersion, '0.0.2');

  const terminal = await verifyExactNpmPublicationOnce({
    artifact,
    fetchImpl,
    registryOrigin,
  });
  assert.equal(terminal.state, 'verified');
  assert.equal(terminal.distTagRelation, 'superseded');
  assert.equal(terminal.distTagVersion, '0.0.2');
});

test('stable SemVer comparison is npm-range-safe', () => {
  assert.equal(compareCanonicalStableSemVer('1.10.0', '1.9.99'), 1);
  assert.equal(compareCanonicalStableSemVer('1.0.0', '1.0.0'), 0);
  assert.equal(compareCanonicalStableSemVer('0.9.0', '1.0.0'), -1);
  assert.throws(
    () => compareCanonicalStableSemVer('9007199254740992.0.0', '1.0.0'),
    /outside npm SemVer numeric range/,
  );
});

test('terminal npm verifier polls propagation but fails closed on poisoned identity', async () => {
  const artifact = localArtifact();
  let exactVersionRequests = 0;
  const stableFetch = exactRegistryFetch({ artifact });
  const sleeps = [];
  const result = await pollExactNpmPublication({
    artifact,
    attempts: 2,
    delayMs: 7,
    fetchImpl: async (url, request) => {
      if (!String(url).includes('/dist-tags') && String(url) !== tarballUrl) {
        exactVersionRequests += 1;
        if (exactVersionRequests === 1)
          return new Response('', { status: 404 });
      }
      return stableFetch(url, request);
    },
    registryOrigin,
    sleepImpl: async (delay) => sleeps.push(delay),
  });
  assert.equal(result.state, 'verified');
  assert.deepEqual(sleeps, [7]);

  await assert.rejects(
    verifyExactNpmPublicationOnce({
      artifact,
      fetchImpl: exactRegistryFetch({
        artifact,
        metadata: { dist: { integrity: 'sha512-poisoned' } },
      }),
      registryOrigin,
    }),
    /SHA-512 integrity differs/,
  );
});

test('terminal npm verifier treats an older latest as pending and rejects noncanonical tarballs', async () => {
  const artifact = localArtifact();
  await assert.rejects(
    verifyExactNpmPublicationOnce({
      artifact,
      fetchImpl: exactRegistryFetch({ artifact, distTag: '0.0.0' }),
      registryOrigin,
    }),
    NpmPublicationPendingError,
  );
  await assert.rejects(
    verifyExactNpmPublicationOnce({
      artifact,
      fetchImpl: exactRegistryFetch({
        artifact,
        metadata: {
          dist: {
            integrity: artifact.integrity,
            shasum: artifact.shasum,
            tarball: 'https://example.com/karton.tgz',
          },
        },
      }),
      registryOrigin,
    }),
    /tarball URL is not canonical/,
  );
});

const releaseId = 734;
const releaseTag = '@clodex/karton@0.0.1';
const releaseTarget = 'a'.repeat(40);
const releaseRepository = 'owner/repository';
const releaseName = 'Karton 0.0.1';
const releaseBody = '**@clodex/karton 0.0.1**\n';

function exactRelease(overrides = {}) {
  return {
    body: releaseBody,
    draft: false,
    id: releaseId,
    name: releaseName,
    prerelease: false,
    published_at: '2026-07-15T12:00:00Z',
    tag_name: releaseTag,
    target_commitish: releaseTarget,
    url: `https://api.github.com/repos/${releaseRepository}/releases/${releaseId}`,
    ...overrides,
  };
}

function releaseInput(api) {
  return {
    api,
    body: releaseBody,
    name: releaseName,
    repository: releaseRepository,
    tag: releaseTag,
    targetCommitish: releaseTarget,
  };
}

test('exact public release publisher recovers a matching release without mutation', async () => {
  const release = exactRelease();
  let listCalls = 0;
  const calls = [];
  const api = {
    createRelease: async () => {
      calls.push('create');
      throw new Error('must not create');
    },
    getRelease: async (_repository, id) => {
      calls.push(`get:${id}`);
      return release;
    },
    listReleases: async () => {
      listCalls += 1;
      calls.push(`list:${listCalls}`);
      return [release];
    },
  };
  const result = await createOrRecoverExactPublicRelease(releaseInput(api));
  assert.deepEqual(result, {
    created: false,
    releaseId,
    state: 'published',
    tag: releaseTag,
    targetCommitish: releaseTarget,
  });
  assert.deepEqual(calls, ['list:1', `get:${releaseId}`, 'list:2']);
});

test('exact public release publisher accepts 422 only for one exact concurrent winner', async () => {
  const release = exactRelease();
  let listCalls = 0;
  const api = {
    createRelease: async () => ({
      data: { message: 'already exists' },
      status: 422,
    }),
    getRelease: async () => release,
    listReleases: async () => {
      listCalls += 1;
      return listCalls === 1 ? [] : [release];
    },
  };
  const result = await createOrRecoverExactPublicRelease(releaseInput(api));
  assert.equal(result.releaseId, releaseId);
  assert.equal(result.created, false);

  await assert.rejects(
    createOrRecoverExactPublicRelease(
      releaseInput({
        createRelease: api.createRelease,
        listReleases: async () => [],
      }),
    ),
    /422 without one exact concurrent release/,
  );
});

test('exact public release publisher validates created ID, state, and target', async () => {
  const release = exactRelease();
  let listCalls = 0;
  const api = {
    createRelease: async () => ({ data: release, status: 201 }),
    getRelease: async () => release,
    listReleases: async () => {
      listCalls += 1;
      return listCalls === 1 ? [] : [release];
    },
  };
  const result = await createOrRecoverExactPublicRelease(releaseInput(api));
  assert.equal(result.created, true);
  assert.equal(result.releaseId, releaseId);
  assert.equal(result.state, 'published');
  assert.equal(result.targetCommitish, releaseTarget);
  assert.throws(
    () =>
      assertExactPublishedRelease({
        ...releaseInput(api),
        release: exactRelease({ target_commitish: 'b'.repeat(40) }),
        releaseId,
      }),
    /exact published release identity/,
  );
});

test('Karton release workflow contains no update or delete publication path', () => {
  const publisher = readFileSync(
    new URL('scripts/release/create-exact-public-release.mjs', repositoryRoot),
    'utf8',
  );
  const workflow = readFileSync(
    new URL('.github/workflows/_release-karton.yml', repositoryRoot),
    'utf8',
  );
  assert.doesNotMatch(publisher, /method\s*:\s*['"](?:PATCH|DELETE)['"]/i);
  assert.doesNotMatch(workflow, /softprops\/action-gh-release|\bgh release\b/i);
  assert.match(workflow, /create-exact-public-release\.mjs/);
  assert.match(workflow, /verify-npm-publication\.mjs/);
  assert.match(workflow, /--mode=prepublish/);
  assert.match(
    workflow,
    /concurrency:[\s\S]*group: karton-npm-publication-\$\{\{ github\.repository \}\}[\s\S]*cancel-in-progress: false/,
  );
  const effectStepStart = workflow.indexOf(
    'Publish exact packed artifact to npm when absent',
  );
  const effectStepEnd = workflow.indexOf(
    '\n  publish-verification:',
    effectStepStart,
  );
  const effectStep = workflow.slice(effectStepStart, effectStepEnd);
  assert.match(effectStep, /-u NODE_AUTH_TOKEN/);
  assert.doesNotMatch(effectStep, /verify-npm-publication\.mjs/);
  assert.match(effectStep, /package\/package\.json/);
  assert.match(effectStep, /embeddedPackage\.name/);
  assert.match(effectStep, /embeddedPackage\.version/);
  assert.match(effectStep, /npm exact-version metadata/);
  assert.match(effectStep, /npm dist-tags metadata/);
  assert.ok(
    effectStep.indexOf('npm exact-version metadata') <
      effectStep.indexOf('npm publish'),
  );

  const releaseVerification = workflow.indexOf(
    'Verify returned exact GitHub Release ID and state',
  );
  const terminalTagResolution = workflow.indexOf(
    'Re-resolve exact remote tag after GitHub Release',
  );
  assert.ok(releaseVerification >= 0);
  assert.ok(terminalTagResolution > releaseVerification);
  assert.match(
    workflow.slice(terminalTagResolution),
    /git ls-remote origin "refs\/tags\/\$\{RELEASE_TAG\}"[\s\S]*terminal_tag_commit=.*\^\{commit\}[\s\S]*test "\$terminal_tag_commit" = "\$RELEASE_REF"/,
  );
});

test('fresh Karton effect rejects forged embedded npm identity before registry access', () => {
  const workflow = readFileSync(
    new URL('.github/workflows/_release-karton.yml', repositoryRoot),
    'utf8',
  );
  const effectStart = workflow.indexOf(
    'Publish exact packed artifact to npm when absent',
  );
  const sourceStart = workflow.indexOf(
    "import assert from 'node:assert/strict';",
    effectStart,
  );
  const sourceEnd = workflow.indexOf('\n          NODE\n', sourceStart);
  assert.ok(
    effectStart >= 0 && sourceStart > effectStart && sourceEnd > sourceStart,
  );
  const inlineVerifier = `${workflow.slice(sourceStart, sourceEnd)}\n`;

  const directory = mkdtempSync(join(tmpdir(), 'karton-effect-test-'));
  try {
    const artifact = join(directory, 'karton-package.tgz');
    const identityPath = join(directory, 'package-identity.json');
    const embeddedPath = join(directory, 'embedded-package.json');
    const bytes = Buffer.from('bounded-test-artifact');
    writeFileSync(artifact, bytes);
    writeFileSync(
      identityPath,
      JSON.stringify({
        filename: 'karton-package.tgz',
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        name: packageName,
        shasum: createHash('sha1').update(bytes).digest('hex'),
        size: bytes.length,
        version,
      }),
    );

    for (const embeddedPackage of [
      { name: packageName, version: '9.9.9' },
      {
        name: packageName,
        publishConfig: { registry: 'https://attacker.invalid/' },
        version,
      },
    ]) {
      writeFileSync(embeddedPath, JSON.stringify(embeddedPackage));
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-', artifact, identityPath, embeddedPath],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PACKAGE_NAME: packageName,
            RELEASE_VERSION: version,
          },
          input: inlineVerifier,
        },
      );
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /attacker-token/);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

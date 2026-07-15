import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateUpdateServerSbom } from './validate-update-server-sbom.mjs';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const policy = JSON.parse(
  readFileSync(
    join(repositoryRoot, 'apps/update-server/deploy-toolchain.json'),
    'utf8',
  ),
);

function component(name, version) {
  const packagePath =
    name === '@clodex/update-server'
      ? '/app/package.json'
      : `/app/node_modules/${name}/package.json`;
  const purlName = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return {
    type: 'library',
    name,
    version,
    purl: `pkg:npm/${purlName}@${version}`,
    properties: [
      {
        name: 'syft:package:foundBy',
        value: 'javascript-package-cataloger',
      },
      {
        name: 'syft:package:metadataType',
        value: 'javascript-npm-package',
      },
      {
        name: 'syft:location:0:path',
        value: packagePath,
      },
    ],
  };
}

function validSbom() {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: 'urn:uuid:9c918945-9d30-4ead-a1c3-0e0567f0fe67',
    version: 1,
    components: [
      component(
        policy.runtime.application.name,
        policy.runtime.application.version,
      ),
      ...Object.entries(policy.runtime.requiredNodePackages).map(
        ([name, version]) => component(name, version),
      ),
    ],
  };
}

test('accepts exact production components', () => {
  assert.deepEqual(validateUpdateServerSbom(validSbom(), policy), []);
});

test('rejects missing, drifted, and development components', () => {
  const sbom = validSbom();
  sbom.components = sbom.components.filter((entry) => entry.name !== 'semver');
  sbom.components.find((entry) => entry.name === 'express').version = '0.0.0';
  sbom.components.push(component('typescript', '5.9.3'));
  const errors = validateUpdateServerSbom(sbom, policy);
  assert.ok(
    errors.some((error) =>
      error.includes('missing required runtime component semver'),
    ),
  );
  assert.ok(errors.some((error) => error.includes('express has 0.0.0')));
  assert.ok(
    errors.some((error) =>
      error.includes('forbidden development component typescript'),
    ),
  );
});

test('rejects lockfile-only declarations as installed runtime evidence', () => {
  const sbom = validSbom();
  const express = sbom.components.find((entry) => entry.name === 'express');
  express.properties = [
    {
      name: 'syft:package:foundBy',
      value: 'javascript-lock-cataloger',
    },
    {
      name: 'syft:package:metadataType',
      value: 'javascript-pnpm-lock-entry',
    },
    {
      name: 'syft:location:0:path',
      value: '/app/pnpm-lock.yaml',
    },
  ];
  assert.ok(
    validateUpdateServerSbom(sbom, policy).some((error) =>
      error.includes('is not bound to an installed package.json'),
    ),
  );
});

test('writes a hash-bound CI inspection record without claiming release evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'clodex-update-server-sbom-'));
  const sbomPath = join(root, 'runtime.cdx.json');
  const recordPath = join(root, 'inspection.json');
  const bytes = Buffer.from(`${JSON.stringify(validSbom(), null, 2)}\n`);
  writeFileSync(sbomPath, bytes);

  execFileSync(
    process.execPath,
    [
      'scripts/ci/validate-update-server-sbom.mjs',
      `--image-id=sha256:${'a'.repeat(64)}`,
      '--image-ref=clodex-update-server:test',
      `--record=${recordPath}`,
      `--sbom=${sbomPath}`,
      `--source-commit=${'b'.repeat(40)}`,
      `--syft-version=${policy.syft.version}`,
    ],
    { cwd: repositoryRoot, stdio: 'pipe' },
  );

  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(record.kind, 'clodex-update-server-ci-image-inspection');
  assert.equal(record.releaseEvidence, false);
  assert.equal(
    record.sbom.sha256,
    createHash('sha256').update(bytes).digest('hex'),
  );
  assert.equal(record.image.id, `sha256:${'a'.repeat(64)}`);
  assert.equal(record.sourceCommit, 'b'.repeat(40));
});

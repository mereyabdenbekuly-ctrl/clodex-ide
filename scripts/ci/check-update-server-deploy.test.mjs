import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkUpdateServerDeploy } from './check-update-server-deploy.mjs';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const fixtureFiles = [
  '.github/workflows/monorepo-ci.yml',
  '.node-version',
  'apps/update-server/Dockerfile',
  'apps/update-server/Dockerfile.dockerignore',
  'apps/update-server/deploy-toolchain.json',
  'apps/update-server/package.json',
  'package.json',
  'pnpm-lock.yaml',
  'scripts/ci/build-update-server-image.sh',
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'clodex-update-server-deploy-'));
  for (const file of fixtureFiles) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repositoryRoot, file), target);
  }
  return root;
}

function replace(root, file, before, after) {
  const path = join(root, file);
  const source = readFileSync(path, 'utf8');
  assert.ok(
    source.includes(before),
    `${file} fixture contains mutation target`,
  );
  writeFileSync(path, source.replace(before, after));
}

test('accepts the repository update-server deploy graph', () => {
  assert.deepEqual(checkUpdateServerDeploy(repositoryRoot), []);
});

test('rejects a mutable Node base image', () => {
  const root = fixture();
  replace(
    root,
    'apps/update-server/Dockerfile',
    'node:22.23.1-alpine3.23@sha256:8516dce0483394d5708d4b2ee6cacb79fb1d617ea4e2787c2120bcca92ce372e',
    'node:22-alpine',
  );
  assert.ok(
    checkUpdateServerDeploy(root).some((error) =>
      error.includes('Dockerfile stages must derive only from immutable'),
    ),
  );
});

test('rejects npm install paths and alternate lockfiles', () => {
  const root = fixture();
  replace(
    root,
    'apps/update-server/Dockerfile',
    'RUN pnpm install',
    'RUN npm install && pnpm install',
  );
  writeFileSync(join(root, 'apps/update-server/package-lock.json'), '{}\n');
  const errors = checkUpdateServerDeploy(root);
  assert.ok(
    errors.some((error) => error.includes('package-lock.json is forbidden')),
  );
  assert.ok(
    errors.some((error) => error.includes('must not use npm ci/install')),
  );
});

test('rejects unverified tool archives', () => {
  const root = fixture();
  const path = join(root, 'apps/update-server/deploy-toolchain.json');
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  policy.githubCli.archives.amd64.sha256 = 'mutable';
  policy.syft.sourceBaseUrl = 'https://github.com/anchore/syft/releases/latest';
  writeFileSync(path, `${JSON.stringify(policy, null, 2)}\n`);
  const errors = checkUpdateServerDeploy(root);
  assert.ok(
    errors.some((error) => error.includes('must be lowercase SHA-256')),
  );
  assert.ok(
    errors.some((error) => error.includes('Syft source URL must be pinned')),
  );
});

test('rejects a broadened root build context', () => {
  const root = fixture();
  replace(
    root,
    'apps/update-server/Dockerfile.dockerignore',
    '!apps/update-server/src/**',
    '!apps/**',
  );
  assert.ok(
    checkUpdateServerDeploy(root).some((error) =>
      error.includes('reviewed root-context allowlist'),
    ),
  );
});

test('rejects app-context Docker builds and missing CI SBOM retention', () => {
  const root = fixture();
  replace(
    root,
    'scripts/ci/build-update-server-image.sh',
    '  .\n',
    '  apps/update-server\n',
  );
  replace(
    root,
    '.github/workflows/monorepo-ci.yml',
    'security-reports/update-server-image/update-server.cyclonedx.json',
    'security-reports/update-server-image/omitted.json',
  );
  const errors = checkUpdateServerDeploy(root);
  assert.ok(errors.some((error) => error.includes('build script is missing')));
  assert.ok(errors.some((error) => error.includes('CI is missing')));
});

test('rejects runtime SBOM policy drift from the root lockfile', () => {
  const root = fixture();
  const path = join(root, 'apps/update-server/deploy-toolchain.json');
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  policy.runtime.requiredNodePackages.express = '0.0.0';
  writeFileSync(path, `${JSON.stringify(policy, null, 2)}\n`);
  assert.ok(
    checkUpdateServerDeploy(root).some((error) =>
      error.includes('locked version must match runtime SBOM policy'),
    ),
  );
});

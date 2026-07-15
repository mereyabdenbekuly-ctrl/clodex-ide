import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { checkPnpmBootstrap } from './check-pnpm-bootstrap.mjs';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'clodex-pnpm-bootstrap-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\n',
  );
  return root;
}

test('accepts a hook-free pnpm workspace', () => {
  assert.deepEqual(checkPnpmBootstrap(fixture()), []);
});

test('rejects repository pnpmfile hooks', () => {
  const root = fixture();
  writeFileSync(join(root, '.pnpmfile.cjs'), 'module.exports = {};\n');
  assert.equal(checkPnpmBootstrap(root).length, 1);
});

test('rejects nested workspace lockfiles', () => {
  const root = fixture();
  const packageRoot = join(root, 'apps', 'browser', 'scripts', 'example');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\n",
  );

  assert.deepEqual(checkPnpmBootstrap(root), [
    'apps/browser/scripts/example/pnpm-lock.yaml: nested workspace lockfiles are not allowed; use the root pnpm-lock.yaml',
  ]);
});

test('ignores generated and dependency lockfiles outside the source graph', () => {
  const root = fixture();
  for (const directory of [
    join(root, 'node_modules', 'example'),
    join(root, 'apps', 'website', '.next', 'standalone'),
    join(root, 'apps', 'browser', 'out', 'package'),
  ]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\n",
    );
  }

  assert.deepEqual(checkPnpmBootstrap(root), []);
});

test('rejects root and workspace config dependencies', () => {
  const root = fixture();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      pnpm: { configDependencies: { 'pnpm-plugin-root': '1.0.0' } },
      private: true,
    }),
  );
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    "{ packages: ['packages/*'], configDependencies: { plugin: '1.0.0' } }\n",
  );
  assert.equal(checkPnpmBootstrap(root).length, 2);
});

test('rejects npmrc hook configuration', () => {
  const root = fixture();
  writeFileSync(
    join(root, '.npmrc'),
    [
      'config-dependencies.plugin=1.0.0',
      'pnpmfile = ./hooks.cjs',
      '"pnpmfile"=./quoted-hooks.cjs',
      'global-pnpmfile=./global-hooks.cjs',
      '',
    ].join('\n'),
  );
  assert.equal(checkPnpmBootstrap(root).length, 4);
});

for (const workflowPath of [
  '.github/workflows/contribution-policy.yml',
  '.github/workflows/monorepo-ci.yml',
]) {
  test(`${workflowPath} disables pnpm hooks before pnpm setup`, () => {
    const workflow = parseYaml(
      readFileSync(join(repositoryRoot, workflowPath), 'utf8'),
    );
    assert.equal(workflow.env?.NPM_CONFIG_IGNORE_PNPMFILE, 'true');

    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const steps = job.steps ?? [];
      const setupIndex = steps.findIndex(
        (step) =>
          typeof step.uses === 'string' &&
          step.uses.startsWith('pnpm/action-setup@'),
      );
      if (setupIndex === -1) continue;

      const preflightIndex = steps.findIndex(
        (step) => step.run === 'node scripts/ci/check-pnpm-bootstrap.mjs',
      );
      assert.ok(
        preflightIndex >= 0 && preflightIndex < setupIndex,
        `${workflowPath}:${jobName} must run the bootstrap preflight before pnpm/action-setup`,
      );

      const installSteps = steps.filter(
        (step) =>
          typeof step.run === 'string' && step.run.includes('pnpm install'),
      );
      assert.ok(
        installSteps.every((step) => step.run.includes('--ignore-pnpmfile')),
        `${workflowPath}:${jobName} installs must ignore repository pnpm hooks`,
      );
    }
  });
}

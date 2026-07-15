import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DOCUMENTED_RESIDUALS,
  buildPnpmListInvocation,
  collectDependencyInventory,
  evaluateFindings,
  loadProductionDependencyList,
  queryAdvisories,
} from './audit-production-dependencies.mjs';

test('uses the deterministic lockfile inventory and refuses Windows execution', () => {
  assert.deepEqual(
    buildPnpmListInvocation({
      nodeExecutable: '/opt/node/bin/node',
      npmExecPath: '/opt/pnpm/bin/pnpm.cjs',
      platform: 'linux',
    }),
    {
      command: '/opt/node/bin/node',
      arguments: [
        '/opt/pnpm/bin/pnpm.cjs',
        'list',
        '-r',
        '--prod',
        '--json',
        '--depth',
        'Infinity',
        '--lockfile-only',
      ],
    },
  );
  assert.deepEqual(
    buildPnpmListInvocation({ npmExecPath: null, platform: 'linux' }),
    {
      command: 'pnpm',
      arguments: [
        'list',
        '-r',
        '--prod',
        '--json',
        '--depth',
        'Infinity',
        '--lockfile-only',
      ],
    },
  );
  assert.throws(
    () =>
      buildPnpmListInvocation({
        nodeExecutable: 'C:\\node.exe',
        npmExecPath: 'C:\\pnpm\\pnpm.cjs',
        platform: 'win32',
      }),
    /canonical Linux CI job/,
  );
});

test('propagates pnpm list failure without falling back or weakening audit', () => {
  const expected = Object.assign(new Error('pnpm list exited 1'), {
    status: 1,
  });
  assert.throws(
    () =>
      loadProductionDependencyList({
        execFileSyncImpl: (_command, arguments_) => {
          assert.ok(arguments_.includes('--lockfile-only'));
          throw expected;
        },
        nodeExecutable: '/opt/node/bin/node',
        npmExecPath: '/opt/pnpm/bin/pnpm.cjs',
        platform: 'linux',
      }),
    (error) => error === expected,
  );
});

test('loads only a valid JSON array from the lockfile inventory command', () => {
  assert.deepEqual(
    loadProductionDependencyList({
      execFileSyncImpl: () => '[{"name":"workspace"}]',
      npmExecPath: null,
      platform: 'linux',
    }),
    [{ name: 'workspace' }],
  );
  assert.throws(
    () =>
      loadProductionDependencyList({
        execFileSyncImpl: () => '{"name":"workspace"}',
        npmExecPath: null,
        platform: 'linux',
      }),
    /must be an array/,
  );
});

test('collects exact production dependency versions from recursive pnpm JSON', () => {
  const inventory = collectDependencyInventory([
    {
      dependencies: {
        '@clodex/local': {
          dependencies: {
            nested: { version: '2.0.0' },
          },
          version: 'link:packages/local',
        },
        parent: {
          dependencies: {
            esbuild: { version: '0.18.20' },
          },
          version: '1.0.0',
        },
      },
    },
  ]);
  assert.deepEqual([...inventory.get('parent')], ['1.0.0']);
  assert.deepEqual([...inventory.get('esbuild')], ['0.18.20']);
  assert.equal(inventory.has('@clodex/local'), false);
  assert.deepEqual([...inventory.get('nested')], ['2.0.0']);
});

test('fails closed on an empty production dependency inventory', () => {
  assert.throws(() => collectDependencyInventory([]), /inventory is empty/);
  assert.throws(
    () => collectDependencyInventory([{ dependencies: {} }]),
    /inventory is empty/,
  );
});

test('resolves advisories to exact locked versions', async () => {
  const inventory = new Map([['esbuild', new Set(['0.18.20', '0.25.9'])]]);
  const advisoryUrl = 'https://github.com/advisories/GHSA-67mh-4wv8-2f99';
  const advisory = {
    severity: 'moderate',
    title: 'development server advisory',
    url: advisoryUrl,
  };
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const versions = body.esbuild;
    const vulnerable = versions.includes('0.18.20');
    return {
      ok: true,
      status: 200,
      json: async () => (vulnerable ? { esbuild: [advisory] } : {}),
    };
  };
  assert.deepEqual(await queryAdvisories(inventory, fetchImpl), [
    {
      affectedVersions: ['0.18.20'],
      name: 'esbuild',
      severity: 'moderate',
      title: 'development server advisory',
      url: advisoryUrl,
    },
  ]);
});

test('fails closed when the advisory service is unavailable', async () => {
  await assert.rejects(
    queryAdvisories(new Map([['example', new Set(['1.0.0'])]]), async () => ({
      json: async () => ({ error: 'retired' }),
      ok: false,
      status: 410,
    })),
    /endpoint failed with HTTP 410/,
  );
});

test('has no advisory exception and fails closed on every finding', () => {
  assert.deepEqual(DOCUMENTED_RESIDUALS, []);
  const finding = {
    affectedVersions: ['0.18.20'],
    name: 'esbuild',
    severity: 'moderate',
    title: 'development server advisory',
    url: 'https://github.com/advisories/GHSA-67mh-4wv8-2f99',
  };
  assert.equal(
    evaluateFindings([finding], { now: new Date('2026-07-15T00:00:00Z') })
      .blockers[0].reasonCode,
    'UNAPPROVED_ADVISORY',
  );
  assert.equal(
    evaluateFindings([{ ...finding, severity: 'high' }]).blockers[0].reasonCode,
    'UNAPPROVED_ADVISORY',
  );
});

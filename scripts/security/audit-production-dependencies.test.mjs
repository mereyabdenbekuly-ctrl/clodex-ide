import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AUDITED_DEPENDENCY_FIELDS,
  DOCUMENTED_RESIDUALS,
  buildPnpmListInvocation,
  collectDependencyInventory,
  dependencyInventoryDigest,
  evaluateFindings,
  loadReleaseDependencyList,
  queryAdvisories,
  validateDependencyListCoverage,
} from './audit-production-dependencies.mjs';

const repositoryDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

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

test('CI retains the release dependency report under its non-production-only identity', () => {
  const workflow = readFileSync(
    path.join(repositoryDirectory, '.github/workflows/monorepo-ci.yml'),
    'utf8',
  );
  assert.match(
    workflow,
    /Audit the complete release and workspace dependency graph/u,
  );
  assert.match(
    workflow,
    /--report=security-reports\/release-dependency-audit\.json/u,
  );
  assert.match(
    workflow,
    /name: release-dependency-audit-\$\{\{ github\.sha \}\}/u,
  );
  assert.doesNotMatch(workflow, /production-dependency-audit/u);
});

test('propagates the full pnpm list failure without falling back or weakening audit', () => {
  const expected = Object.assign(new Error('pnpm list exited 1'), {
    status: 1,
  });
  assert.throws(
    () =>
      loadReleaseDependencyList({
        execFileSyncImpl: (_command, arguments_) => {
          assert.ok(arguments_.includes('--lockfile-only'));
          assert.equal(arguments_.includes('--prod'), false);
          throw expected;
        },
        nodeExecutable: '/opt/node/bin/node',
        npmExecPath: '/opt/pnpm/bin/pnpm.cjs',
        platform: 'linux',
      }),
    (error) => error === expected,
  );
});

test('loads only a valid JSON array from the full lockfile inventory command', () => {
  assert.deepEqual(
    loadReleaseDependencyList({
      execFileSyncImpl: () => '[{"name":"workspace"}]',
      npmExecPath: null,
      platform: 'linux',
    }),
    [{ name: 'workspace' }],
  );
  assert.throws(
    () =>
      loadReleaseDependencyList({
        execFileSyncImpl: () => '{"name":"workspace"}',
        npmExecPath: null,
        platform: 'linux',
      }),
    /must be an array/,
  );
});

test('collects exact release dependency versions including workspace dev dependencies', () => {
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
      devDependencies: {
        '@noble/curves': {
          dependencies: {
            '@noble/hashes': { version: '2.0.1' },
          },
          version: '2.2.0',
        },
      },
    },
  ]);
  assert.deepEqual([...inventory.get('parent')], ['1.0.0']);
  assert.deepEqual([...inventory.get('esbuild')], ['0.18.20']);
  assert.equal(inventory.has('@clodex/local'), false);
  assert.deepEqual([...inventory.get('nested')], ['2.0.0']);
  assert.deepEqual([...inventory.get('@noble/curves')], ['2.2.0']);
  assert.deepEqual([...inventory.get('@noble/hashes')], ['2.0.1']);
  assert.match(dependencyInventoryDigest(inventory), /^[a-f0-9]{64}$/u);
  assert.equal(
    dependencyInventoryDigest(inventory),
    dependencyInventoryDigest(
      new Map(
        [...inventory].reverse().map(([name, versions]) => [name, versions]),
      ),
    ),
  );
});

test('fails closed on an empty or non-exact release dependency inventory', () => {
  assert.throws(() => collectDependencyInventory([]), /inventory is empty/);
  assert.throws(
    () => collectDependencyInventory([{ dependencies: {} }]),
    /inventory is empty/,
  );
  assert.throws(
    () =>
      collectDependencyInventory([
        { devDependencies: { mutable: { version: '^1.0.0' } } },
      ]),
    /not an exact npm version/,
  );
  assert.throws(
    () => collectDependencyInventory([{ devDependencies: { broken: null } }]),
    /record is invalid/,
  );
  assert.throws(
    () =>
      collectDependencyInventory([
        { devDependencies: { local: { version: 'file:../local' } } },
      ]),
    /outside the npm advisory model/,
  );
});

test('binds every workspace and direct dependency category to pnpm-lock importers', () => {
  const repositoryDirectory = '/repo';
  const lockfileText = `
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      production:
        specifier: 1.0.0
        version: 1.0.0
  apps/browser:
    dependencies:
      runtime:
        specifier: 2.0.0
        version: 2.0.0
    devDependencies:
      bundled-through-vite:
        specifier: 3.0.0
        version: 3.0.0
    optionalDependencies:
      native-variant:
        specifier: 4.0.0
        version: 4.0.0
`;
  const pnpmList = [
    {
      path: '/repo',
      dependencies: { production: { version: '1.0.0' } },
    },
    {
      path: '/repo/apps/browser',
      dependencies: { runtime: { version: '2.0.0' } },
      devDependencies: { 'bundled-through-vite': { version: '3.0.0' } },
      optionalDependencies: { 'native-variant': { version: '4.0.0' } },
    },
  ];
  const coverage = validateDependencyListCoverage({
    lockfileText,
    pnpmList,
    repositoryDirectory,
  });
  assert.deepEqual(coverage.dependencyFields, AUDITED_DEPENDENCY_FIELDS);
  assert.equal(coverage.directDependencyCount, 4);
  assert.match(coverage.directDependencySha256, /^[a-f0-9]{64}$/u);
  assert.equal(coverage.importerCount, 2);
  assert.throws(
    () =>
      validateDependencyListCoverage({
        lockfileText,
        pnpmList: pnpmList.slice(0, 1),
        repositoryDirectory,
      }),
    /importer drift/,
  );
  assert.throws(
    () =>
      validateDependencyListCoverage({
        lockfileText,
        pnpmList: [pnpmList[0], { ...pnpmList[1], devDependencies: {} }],
        repositoryDirectory,
      }),
    /direct dependency drift.*devDependencies/,
  );
  assert.throws(
    () =>
      validateDependencyListCoverage({
        lockfileText,
        pnpmList: [...pnpmList, pnpmList[1]],
        repositoryDirectory,
      }),
    /duplicates importer/,
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

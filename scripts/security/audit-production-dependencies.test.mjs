import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AUDITED_DEPENDENCY_FIELDS,
  DOCUMENTED_RESIDUALS,
  NPM_BULK_ADVISORY_ENDPOINT,
  buildDependencyAuditReport,
  buildPnpmListInvocation,
  collectDependencyInventory,
  collectLockfileDependencyInventory,
  dependencyInventoryDigest,
  evaluateFindings,
  loadReleaseDependencyList,
  parseNpmAliasSpecifier,
  queryAdvisories,
  validateDependencyInventoryCoverage,
  validateDependencyListCoverage,
} from './audit-production-dependencies.mjs';

const repositoryDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const VALID_INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;

function createRepository(t, manifests) {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'clodex-dependency-audit-')),
  );
  t.after(() => rmSync(root, { force: true, recursive: true }));
  for (const [importerPath, manifest] of Object.entries(manifests)) {
    const directory = path.join(root, importerPath === '.' ? '' : importerPath);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
  return root;
}

function writeManifest(root, importerPath, manifest) {
  writeFileSync(
    path.join(root, importerPath === '.' ? '' : importerPath, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function registryTarball(name, version) {
  const tarballName = name.startsWith('@')
    ? name.slice(name.indexOf('/') + 1)
    : name;
  return `https://registry.npmjs.org/${name}/-/${tarballName}-${version}.tgz`;
}

function virtualStorePath(root, name, identity) {
  return path.join(
    root,
    'node_modules',
    '.pnpm',
    identity,
    'node_modules',
    ...name.split('/'),
  );
}

function registryDependency(root, name, version, identity, extra = {}) {
  return {
    from: name,
    path: virtualStorePath(root, name, identity),
    resolved: registryTarball(name, version),
    version,
    ...extra,
  };
}

function packageRecord(name, version) {
  return `  '${name}@${version}':\n    resolution: {integrity: ${VALID_INTEGRITY}}`;
}

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

test('CI retains the complete release dependency report after frozen lock verification', () => {
  const workflow = readFileSync(
    path.join(repositoryDirectory, '.github/workflows/monorepo-ci.yml'),
    'utf8',
  );
  const frozenInstall = workflow.indexOf('pnpm install --frozen-lockfile');
  const audit = workflow.indexOf(
    'Audit the complete release and workspace dependency graph',
  );
  assert.ok(frozenInstall >= 0 && audit > frozenInstall);
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

test('propagates pnpm list failures and only accepts a JSON array', () => {
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

test('collects exact recursive versions and normalizes observed npm aliases', () => {
  const inventory = collectDependencyInventory([
    {
      dependencies: {
        '@clodex/local': {
          dependencies: { nested: { version: '2.0.0' } },
          version: 'link:packages/local',
        },
        'parent-alias': {
          dependencies: { esbuild: { version: '0.25.9' } },
          from: 'parent',
          version: '1.0.0',
        },
      },
      devDependencies: {
        '@noble/curves': {
          dependencies: { '@noble/hashes': { version: '2.0.1' } },
          version: '2.2.0',
        },
      },
    },
  ]);
  assert.deepEqual([...inventory.get('parent')], ['1.0.0']);
  assert.deepEqual([...inventory.get('esbuild')], ['0.25.9']);
  assert.equal(inventory.has('@clodex/local'), false);
  assert.deepEqual([...inventory.get('nested')], ['2.0.0']);
  assert.deepEqual([...inventory.get('@noble/curves')], ['2.2.0']);
  assert.deepEqual([...inventory.get('@noble/hashes')], ['2.0.1']);
  assert.match(dependencyInventoryDigest(inventory), /^[a-f0-9]{64}$/u);
  assert.equal(
    dependencyInventoryDigest(inventory),
    dependencyInventoryDigest(new Map([...inventory].reverse())),
  );
  assert.throws(
    () =>
      collectDependencyInventory([
        {
          dependencies: {
            alias: { from: 'real-one', name: 'real-two', version: '1.0.0' },
          },
        },
      ]),
    /from\/name identity drift/,
  );
});

test('fails closed on empty, mutable, local-file, or malformed observed records', () => {
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
    /outside the advisory model/,
  );
});

test('requires lockfile v9 registry sha512 integrity, no tarballs, and no source locators', () => {
  const validLockfile = `
lockfileVersion: '9.0'
packages:
${packageRecord('direct', '1.0.0')}
snapshots:
  'direct@1.0.0': {}
`;
  const inventory = collectLockfileDependencyInventory(validLockfile);
  assert.equal(inventory.packageLocatorCount, 1);
  assert.equal(inventory.snapshotCount, 1);
  assert.equal(inventory.sourceLocatorCount, 0);
  assert.deepEqual([...inventory.inventory.get('direct')], ['1.0.0']);
  assert.match(inventory.packageLocatorSha256, /^[a-f0-9]{64}$/u);
  assert.match(inventory.snapshotSha256, /^[a-f0-9]{64}$/u);
  const metadataChanged = collectLockfileDependencyInventory(
    validLockfile.replace(
      "  'direct@1.0.0': {}",
      "  'direct@1.0.0': {transitivePeerDependencies: [peer]}",
    ),
  );
  assert.notEqual(metadataChanged.snapshotSha256, inventory.snapshotSha256);

  assert.throws(
    () =>
      collectLockfileDependencyInventory(
        validLockfile.replace(
          "lockfileVersion: '9.0'",
          "lockfileVersion: '8.0'",
        ),
      ),
    /lockfileVersion must be exactly 9\.0/,
  );
  assert.throws(
    () =>
      collectLockfileDependencyInventory(
        validLockfile.replace(`{integrity: ${VALID_INTEGRITY}}`, '{}'),
      ),
    /no valid sha512 integrity/,
  );
  assert.throws(
    () =>
      collectLockfileDependencyInventory(
        validLockfile.replace(VALID_INTEGRITY, 'sha512-not-base64'),
      ),
    /no valid sha512 integrity/,
  );
  assert.throws(
    () =>
      collectLockfileDependencyInventory(
        validLockfile.replace(
          `{integrity: ${VALID_INTEGRITY}}`,
          `{integrity: ${VALID_INTEGRITY}, tarball: ${registryTarball('direct', '1.0.0')}}`,
        ),
      ),
    /must not declare a tarball/,
  );
  const codeload =
    'https://codeload.github.com/electron/node-gyp/tar.gz/06b29aafb7708acef8b3669835c8a7857ebc92d2';
  assert.throws(
    () =>
      collectLockfileDependencyInventory(
        validLockfile.replaceAll('direct@1.0.0', `direct@${codeload}`),
      ),
    /sourceLocatorCount must be 0/,
  );
  assert.throws(
    () =>
      collectLockfileDependencyInventory(
        validLockfile.replace("  'direct@1.0.0': {}", "  'ghost@1.0.0': {}"),
      ),
    /snapshot has no package record/,
  );
  assert.throws(
    () =>
      collectLockfileDependencyInventory(
        validLockfile.replace(
          "  'direct@1.0.0': {}",
          "  'direct@1.0.0': {dependencies: {ghost: 1.0.0}}",
        ),
      ),
    /reference has no snapshot: ghost@1\.0\.0/,
  );
  assert.throws(
    () =>
      collectLockfileDependencyInventory(
        validLockfile.replace(
          'packages:\n',
          'patchedDependencies:\n  direct@1.0.0: patches/direct.patch\npackages:\n',
        ),
      ),
    /patchedDependencies must be empty/,
  );
  assert.throws(
    () =>
      collectLockfileDependencyInventory(
        validLockfile.replace(
          "  'direct@1.0.0': {}",
          "  'direct@1.0.0(patch_hash=forged)': {}",
        ),
      ),
    /patched dependency is outside the npm advisory identity/,
  );

  const digitLeadingAliasLockfile = `
lockfileVersion: '9.0'
packages:
${packageRecord('parent', '1.0.0')}
${packageRecord('2-thenable', '1.0.0')}
snapshots:
  'parent@1.0.0':
    dependencies:
      alias: 2-thenable@1.0.0
  '2-thenable@1.0.0': {}
`;
  assert.doesNotThrow(() =>
    collectLockfileDependencyInventory(digitLeadingAliasLockfile),
  );
});

test('the repository lock uses the exact integrity-bound Electron node-gyp replacement', () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(repositoryDirectory, 'package.json'), 'utf8'),
  );
  assert.equal(packageJson.packageManager, 'pnpm@10.30.3');
  assert.equal(
    packageJson.pnpm.overrides['@electron/rebuild@3.7.2>@electron/node-gyp'],
    '10.2.0-electron.2',
  );
  const lockfileText = readFileSync(
    path.join(repositoryDirectory, 'pnpm-lock.yaml'),
    'utf8',
  );
  assert.doesNotMatch(lockfileText, /codeload\.github\.com/u);
  const inventory = collectLockfileDependencyInventory(lockfileText);
  assert.equal(inventory.sourceLocatorCount, 0);
  assert.deepEqual(
    [...inventory.inventory.get('@electron/node-gyp')],
    ['10.2.0-electron.2'],
  );
});

function workspaceFixture(t) {
  const rootManifest = {
    name: '@test/root',
    dependencies: {
      '@test/child': 'workspace:*',
      production: '^1.0.0',
      'scoped-alias': 'npm:@scope/real@^2.0.0',
    },
  };
  const childManifest = { name: '@test/child', version: '1.0.0' };
  const root = createRepository(t, {
    '.': rootManifest,
    'packages/child': childManifest,
  });
  const lockfileText = `
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@test/child':
        specifier: workspace:*
        version: link:packages/child
      production:
        specifier: ^1.0.0
        version: 1.0.0(peer@9.0.0)
      scoped-alias:
        specifier: npm:@scope/real@^2.0.0
        version: '@scope/real@2.1.0(peer@9.0.0)'
  packages/child: {}
`;
  const pnpmList = [
    {
      dependencies: {
        '@test/child': {
          from: '@test/child',
          path: path.join(root, 'packages/child'),
          version: 'link:packages/child',
        },
        production: { from: 'production', version: '1.0.0' },
        'scoped-alias': { from: '@scope/real', version: '2.1.0' },
      },
      name: '@test/root',
      path: root,
    },
    {
      name: '@test/child',
      path: path.join(root, 'packages/child'),
    },
  ];
  return { childManifest, lockfileText, pnpmList, root, rootManifest };
}

test('positively binds workspace links, scoped aliases, peer suffixes, and both specifier digests', (t) => {
  const fixture = workspaceFixture(t);
  assert.deepEqual(parseNpmAliasSpecifier('npm:@scope/real@^2.0.0'), {
    targetName: '@scope/real',
    targetSpecifier: '^2.0.0',
  });
  assert.deepEqual(parseNpmAliasSpecifier('npm:real@~2.0.0'), {
    targetName: 'real',
    targetSpecifier: '~2.0.0',
  });
  assert.deepEqual(parseNpmAliasSpecifier('npm:is-positive'), {
    targetName: 'is-positive',
    targetSpecifier: null,
  });
  const coverage = validateDependencyListCoverage({
    lockfileText: fixture.lockfileText,
    pnpmList: fixture.pnpmList,
    repositoryDirectory: fixture.root,
  });
  assert.deepEqual(coverage.dependencyFields, AUDITED_DEPENDENCY_FIELDS);
  assert.equal(coverage.directDependencyCount, 3);
  assert.equal(coverage.manifestDependencyCount, 3);
  assert.equal(coverage.importerCount, 2);
  assert.equal(coverage.workspaceLinkCount, 1);
  assert.match(coverage.directDependencySha256, /^[a-f0-9]{64}$/u);
  assert.match(coverage.manifestDependencySha256, /^[a-f0-9]{64}$/u);
  assert.match(coverage.workspaceLinkSha256, /^[a-f0-9]{64}$/u);

  writeManifest(fixture.root, '.', {
    ...fixture.rootManifest,
    dependencies: {
      ...fixture.rootManifest.dependencies,
      'scoped-alias': 'npm:@scope/real',
    },
  });
  assert.doesNotThrow(() =>
    validateDependencyListCoverage({
      lockfileText: fixture.lockfileText.replaceAll(
        'npm:@scope/real@^2.0.0',
        'npm:@scope/real',
      ),
      pnpmList: fixture.pnpmList,
      repositoryDirectory: fixture.root,
    }),
  );
  writeManifest(fixture.root, '.', fixture.rootManifest);

  const lockSpecifierChanged = validateDependencyListCoverage({
    lockfileText: fixture.lockfileText.replace(
      'specifier: ^1.0.0',
      'specifier: 1.0.0',
    ),
    pnpmList: fixture.pnpmList,
    repositoryDirectory: fixture.root,
  });
  assert.notEqual(
    lockSpecifierChanged.directDependencySha256,
    coverage.directDependencySha256,
  );
  assert.equal(
    lockSpecifierChanged.manifestDependencySha256,
    coverage.manifestDependencySha256,
  );

  writeManifest(fixture.root, '.', {
    ...fixture.rootManifest,
    dependencies: {
      ...fixture.rootManifest.dependencies,
      production: '~1.0.0',
    },
  });
  const manifestSpecifierChanged = validateDependencyListCoverage({
    lockfileText: fixture.lockfileText,
    pnpmList: fixture.pnpmList,
    repositoryDirectory: fixture.root,
  });
  assert.equal(
    manifestSpecifierChanged.directDependencySha256,
    coverage.directDependencySha256,
  );
  assert.notEqual(
    manifestSpecifierChanged.manifestDependencySha256,
    coverage.manifestDependencySha256,
  );
});

test('rejects arbitrary workspace links and alias/name/path substitution', (t) => {
  const fixture = workspaceFixture(t);
  writeManifest(fixture.root, '.', {
    ...fixture.rootManifest,
    dependencies: {
      ...fixture.rootManifest.dependencies,
      '@test/child': 'workspace:^',
    },
  });
  assert.throws(
    () =>
      validateDependencyListCoverage({
        lockfileText: fixture.lockfileText,
        pnpmList: fixture.pnpmList,
        repositoryDirectory: fixture.root,
      }),
    /exact workspace:\* lock binding|declared as workspace:\*/,
  );
  writeManifest(fixture.root, '.', fixture.rootManifest);

  assert.throws(
    () =>
      validateDependencyListCoverage({
        lockfileText: fixture.lockfileText.replace(
          'link:packages/child',
          'link:packages/child/../child',
        ),
        pnpmList: fixture.pnpmList,
        repositoryDirectory: fixture.root,
      }),
    /link target is not canonical/,
  );

  const aliasSubstitution = structuredClone(fixture.pnpmList);
  aliasSubstitution[0].dependencies['scoped-alias'].from = '@scope/other';
  assert.throws(
    () =>
      validateDependencyListCoverage({
        lockfileText: fixture.lockfileText,
        pnpmList: aliasSubstitution,
        repositoryDirectory: fixture.root,
      }),
    /target identity drift.*@scope\/real/,
  );

  const nameSubstitution = structuredClone(fixture.pnpmList);
  nameSubstitution[1].name = '@test/forged-child';
  assert.throws(
    () =>
      validateDependencyListCoverage({
        lockfileText: fixture.lockfileText,
        pnpmList: nameSubstitution,
        repositoryDirectory: fixture.root,
      }),
    /workspace name drift/,
  );

  const hiddenDirectory = path.join(fixture.root, '.hidden-package');
  mkdirSync(hiddenDirectory);
  writeFileSync(
    path.join(hiddenDirectory, 'package.json'),
    '{"name":"@test/child"}\n',
  );
  const pathSubstitution = structuredClone(fixture.pnpmList);
  pathSubstitution[0].dependencies['@test/child'].path = hiddenDirectory;
  assert.throws(
    () =>
      validateDependencyListCoverage({
        lockfileText: fixture.lockfileText,
        pnpmList: pathSubstitution,
        repositoryDirectory: fixture.root,
      }),
    /observed workspace path does not match/,
  );
});

function multiplicityFixture(t) {
  const root = createRepository(t, {
    '.': {
      name: '@test/root',
      dependencies: { 'parent-a': '1.0.0', 'parent-b': '1.0.0' },
    },
  });
  const lockfileText = `
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      parent-a:
        specifier: 1.0.0
        version: 1.0.0
      parent-b:
        specifier: 1.0.0
        version: 1.0.0
packages:
${packageRecord('parent-a', '1.0.0')}
${packageRecord('parent-b', '1.0.0')}
${packageRecord('peerful', '2.0.0')}
snapshots:
  'parent-a@1.0.0': {}
  'parent-b@1.0.0': {}
  'peerful@2.0.0(peer-a@1.0.0)': {}
  'peerful@2.0.0(peer-a@2.0.0)': {}
`;
  const pnpmList = [
    {
      dependencies: {
        'parent-a': registryDependency(
          root,
          'parent-a',
          '1.0.0',
          'parent-a@1',
          {
            dependencies: {
              peerful: registryDependency(
                root,
                'peerful',
                '2.0.0',
                'peerful@2_peer-a@1',
              ),
            },
          },
        ),
        'parent-b': registryDependency(
          root,
          'parent-b',
          '1.0.0',
          'parent-b@1',
          {
            dependencies: {
              peerful: registryDependency(
                root,
                'peerful',
                '2.0.0',
                'peerful@2_peer-a@2',
              ),
            },
          },
        ),
      },
      name: '@test/root',
      path: root,
    },
  ];
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), lockfileText);
  return { lockfileText, pnpmList, root };
}

test('binds package/snapshot digests and distinct path multiplicity for peer variants', (t) => {
  const fixture = multiplicityFixture(t);
  const coverage = validateDependencyInventoryCoverage({
    lockfileText: fixture.lockfileText,
    pnpmList: fixture.pnpmList,
    repositoryDirectory: fixture.root,
  });
  assert.equal(coverage.packageLocatorCount, 3);
  assert.equal(coverage.snapshotCount, 4);
  assert.equal(coverage.observedPathCount, 4);
  assert.equal(coverage.sourceLocatorCount, 0);
  assert.equal(
    coverage.observedPathMultiplicitySha256,
    coverage.expectedPathMultiplicitySha256,
  );
  for (const digest of [
    coverage.packageLocatorSha256,
    coverage.snapshotSha256,
    coverage.observedInventorySha256,
    coverage.observedPathMultiplicitySha256,
  ]) {
    assert.match(digest, /^[a-f0-9]{64}$/u);
  }

  const missingPeerVariant = structuredClone(fixture.pnpmList);
  delete missingPeerVariant[0].dependencies['parent-b'].dependencies.peerful;
  assert.throws(
    () =>
      validateDependencyInventoryCoverage({
        lockfileText: fixture.lockfileText,
        pnpmList: missingPeerVariant,
        repositoryDirectory: fixture.root,
      }),
    /snapshot path multiplicity drift.*peerful@2\.0\.0 expected 2, got 1/,
  );

  const collapsedPeerPaths = structuredClone(fixture.pnpmList);
  collapsedPeerPaths[0].dependencies['parent-b'].dependencies.peerful.path =
    collapsedPeerPaths[0].dependencies['parent-a'].dependencies.peerful.path;
  assert.throws(
    () =>
      validateDependencyInventoryCoverage({
        lockfileText: fixture.lockfileText,
        pnpmList: collapsedPeerPaths,
        repositoryDirectory: fixture.root,
      }),
    /snapshot path multiplicity drift/,
  );
});

test('rejects forged registry URLs, non-canonical paths, and hidden nested links', (t) => {
  const fixture = multiplicityFixture(t);
  const crossTargetCollision = structuredClone(fixture.pnpmList);
  Object.assign(crossTargetCollision[0].dependencies['parent-b'], {
    from: 'parent-a',
    path: crossTargetCollision[0].dependencies['parent-a'].path,
    resolved: registryTarball('parent-a', '2.0.0'),
    version: '2.0.0',
  });
  assert.throws(
    () =>
      validateDependencyInventoryCoverage({
        lockfileText: fixture.lockfileText,
        pnpmList: crossTargetCollision,
        repositoryDirectory: fixture.root,
      }),
    /dependency path collision.*parent-a@1\.0\.0 and parent-a@2\.0\.0/,
  );

  const forgedUrl = structuredClone(fixture.pnpmList);
  forgedUrl[0].dependencies['parent-a'].resolved =
    'https://example.invalid/parent-a-1.0.0.tgz';
  assert.throws(
    () =>
      validateDependencyInventoryCoverage({
        lockfileText: fixture.lockfileText,
        pnpmList: forgedUrl,
        repositoryDirectory: fixture.root,
      }),
    /resolved URL drift/,
  );

  const escapedPath = structuredClone(fixture.pnpmList);
  escapedPath[0].dependencies['parent-a'].path = path.join(
    tmpdir(),
    'node_modules/.pnpm/parent-a/node_modules/parent-a',
  );
  assert.throws(
    () =>
      validateDependencyInventoryCoverage({
        lockfileText: fixture.lockfileText,
        pnpmList: escapedPath,
        repositoryDirectory: fixture.root,
      }),
    /path is non-canonical/,
  );

  const hidden = path.join(fixture.root, '.hidden-workspace');
  mkdirSync(hidden);
  writeFileSync(path.join(hidden, 'package.json'), '{"name":"@test/hidden"}\n');
  const hiddenLink = structuredClone(fixture.pnpmList);
  hiddenLink[0].dependencies['parent-a'].dependencies['@test/hidden'] = {
    from: '@test/hidden',
    path: hidden,
    version: 'link:.hidden-workspace',
  };
  assert.throws(
    () =>
      validateDependencyInventoryCoverage({
        lockfileText: fixture.lockfileText,
        pnpmList: hiddenLink,
        repositoryDirectory: fixture.root,
      }),
    /links to a non-workspace path/,
  );
});

test('emits one schema-v3 zero-source report and sends the complete registry inventory to npm only', async (t) => {
  const fixture = multiplicityFixture(t);
  const requests = [];
  const report = await buildDependencyAuditReport({
    fetchImpl: async (url, options) => {
      requests.push({ body: JSON.parse(options.body), url });
      return { json: async () => ({}), ok: true, status: 200 };
    },
    lockfileText: fixture.lockfileText,
    now: new Date('2026-07-15T00:00:00.000Z'),
    pnpmList: fixture.pnpmList,
    repositoryDirectory: fixture.root,
  });
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.status, 'passed');
  assert.equal(report.endpoint, NPM_BULK_ADVISORY_ENDPOINT);
  assert.equal(report.inventory.packageLocatorCount, 3);
  assert.equal(report.inventory.snapshotCount, 4);
  assert.equal(report.inventory.observedPathCount, 4);
  assert.equal(report.inventory.sourceLocatorCount, 0);
  assert.equal(report.inventory.packageNames, 3);
  assert.equal(report.inventory.packageVersions, 3);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.blockers, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, NPM_BULK_ADVISORY_ENDPOINT);
  assert.deepEqual(requests[0].body, {
    'parent-a': ['1.0.0'],
    'parent-b': ['1.0.0'],
    peerful: ['2.0.0'],
  });
  assert.equal(
    (JSON.stringify(report).match(/"sourceLocatorCount"/gu) ?? []).length,
    1,
  );
  assert.doesNotMatch(
    readFileSync(
      path.join(
        repositoryDirectory,
        'scripts/security/audit-production-dependencies.mjs',
      ),
      'utf8',
    ),
    /api\.osv\.dev|OSV query/u,
  );
});

test('resolves npm advisories to exact locked versions', async () => {
  const inventory = new Map([['esbuild', new Set(['0.18.20', '0.25.9'])]]);
  const advisoryUrl = 'https://github.com/advisories/GHSA-67mh-4wv8-2f99';
  const advisory = {
    severity: 'moderate',
    title: 'development server advisory',
    url: advisoryUrl,
  };
  const fetchImpl = async (url, options) => {
    assert.equal(url, NPM_BULK_ADVISORY_ENDPOINT);
    const versions = JSON.parse(options.body).esbuild;
    return {
      json: async () =>
        versions.includes('0.18.20') ? { esbuild: [advisory] } : {},
      ok: true,
      status: 200,
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

test('fails closed on network, HTTP, JSON, and response-schema advisory drift', async () => {
  const inventory = new Map([['example', new Set(['1.0.0'])]]);
  await assert.rejects(
    queryAdvisories(inventory, async () => {
      throw new Error('offline');
    }),
    /endpoint request failed: offline/,
  );
  await assert.rejects(
    queryAdvisories(inventory, async () => ({
      json: async () => ({ error: 'retired' }),
      ok: false,
      status: 410,
    })),
    /endpoint failed with HTTP 410/,
  );
  await assert.rejects(
    queryAdvisories(inventory, async () => ({
      json: async () => {
        throw new Error('bad json');
      },
      ok: true,
      status: 200,
    })),
    /returned invalid JSON/,
  );
  await assert.rejects(
    queryAdvisories(inventory, async () => ({
      json: async () => ({ unexpected: [] }),
      ok: true,
      status: 200,
    })),
    /response is invalid for unexpected/,
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

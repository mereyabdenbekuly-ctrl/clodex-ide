import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AttributionGateError,
  ATTRIBUTION_DIRECTORY_NAME,
  collectReleaseDependencyInventory,
  inspectPackagedAttribution,
  prepareReleaseAttributionBundle,
  resolveElectronRuntimeNoticePaths,
  sha256FileSync,
  writeFinalArtifactSbom,
} from './release-attribution.mjs';

const browserDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const repositoryDirectory = path.resolve(browserDirectory, '../..');
const fixtureGoodDependencyIntegrity =
  'sha512-Zml4dHVyZS1nb29kLWRlcGVuZGVuY3k=';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value);
}

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clodex-attribution-test.'));
  const appDirectory = path.join(root, 'apps/browser');
  const outputDirectory = path.join(
    appDirectory,
    '.generated/release-attribution',
  );
  for (const [relativePath, content] of [
    ['LICENSE', 'fixture AGPL license\n'],
    ['THIRD-PARTY-NOTICES.md', '# notices\n'],
    ['CLODEX_VS_UPSTREAM.md', '# lineage\n'],
    ['CONTRIBUTORS.md', '# contributors\n'],
    ['packages/karton/LICENSE.md', 'fixture Karton MIT license\n'],
  ]) {
    writeText(path.join(root, relativePath), content);
  }
  writeJson(
    path.join(root, 'docs/provenance/NUCLEO_REDISTRIBUTION_EVIDENCE.json'),
    {
      schemaVersion: 1,
      status: 'NOT_REQUIRED',
      packageNames: [],
      redistributionScope: [],
      evidenceReferences: [],
      approvedBy: null,
      approvedAt: null,
      expiresAt: null,
    },
  );
  writeText(
    path.join(root, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'\n\npackages:\n  good-dep@1.0.0:\n    resolution: {integrity: ${fixtureGoodDependencyIntegrity}}\n  nested-dep@2.0.0:\n    resolution: {integrity: sha512-Zml4dHVyZS1uZXN0ZWQtZGVwZW5kZW5jeQ==}\n  electron@39.0.0:\n    resolution: {integrity: sha512-Zml4dHVyZS1lbGVjdHJvbg==}\n`,
  );
  writeJson(
    path.join(root, 'docs/provenance/DEPENDENCY_LICENSE_OVERRIDES.json'),
    {
      schemaVersion: 1,
      status: 'ENGINEERING_REVIEWED',
      reviewedAt: '2026-07-15',
      legalConclusion: false,
      entries: [],
    },
  );
  writeJson(path.join(appDirectory, 'package.json'), {
    name: 'fixture-app',
    version: '1.0.0',
    dependencies: { 'good-dep': '1.0.0' },
  });
  writeJson(path.join(appDirectory, 'node_modules/good-dep/package.json'), {
    name: 'good-dep',
    version: '1.0.0',
    license: 'MIT',
    exports: { '.': './dist/not-built-yet.js' },
    dependencies: { 'nested-dep': '2.0.0' },
  });
  writeText(
    path.join(appDirectory, 'node_modules/good-dep/LICENSE'),
    'good dependency MIT license\n',
  );
  writeJson(
    path.join(
      appDirectory,
      'node_modules/good-dep/node_modules/nested-dep/package.json',
    ),
    {
      name: 'nested-dep',
      version: '2.0.0',
      license: 'Apache-2.0',
    },
  );
  writeText(
    path.join(
      appDirectory,
      'node_modules/good-dep/node_modules/nested-dep/LICENSE',
    ),
    'nested dependency Apache license\n',
  );
  writeJson(path.join(appDirectory, 'node_modules/electron/package.json'), {
    name: 'electron',
    version: '39.0.0',
    license: 'MIT',
    exports: { '.': './dist/not-used-by-the-test.js' },
  });
  writeText(
    path.join(appDirectory, 'node_modules/electron/LICENSE'),
    'Electron MIT license\n',
  );
  writeText(
    path.join(
      appDirectory,
      'node_modules/electron/dist/LICENSES.chromium.html',
    ),
    '<html>Chromium notices</html>\n',
  );
  return { appDirectory, outputDirectory, root };
}

test('builds a deterministic notice and dependency-license bundle', () => {
  const fixture = makeFixture();
  try {
    const first = prepareReleaseAttributionBundle({
      appDirectory: fixture.appDirectory,
      outputDirectory: fixture.outputDirectory,
      releaseChannel: 'release',
      repositoryDirectory: fixture.root,
      now: new Date('2026-07-15T00:00:00.000Z'),
    });
    const firstManifest = readFileSync(
      path.join(fixture.outputDirectory, 'manifest.json'),
      'utf8',
    );
    const second = prepareReleaseAttributionBundle({
      appDirectory: fixture.appDirectory,
      outputDirectory: fixture.outputDirectory,
      releaseChannel: 'release',
      repositoryDirectory: fixture.root,
      now: new Date('2026-07-15T01:00:00.000Z'),
    });
    const secondManifest = readFileSync(
      path.join(fixture.outputDirectory, 'manifest.json'),
      'utf8',
    );

    assert.equal(first.manifest.status, 'READY');
    assert.equal(second.manifest.status, 'READY');
    assert.equal(firstManifest, secondManifest);
    assert.deepEqual(
      first.inventory.entries.map((entry) => `${entry.name}@${entry.version}`),
      ['good-dep@1.0.0', 'nested-dep@2.0.0'],
    );
    const electronNotices = resolveElectronRuntimeNoticePaths({
      appDirectory: fixture.appDirectory,
    });
    assert.match(electronNotices.electron, /electron\/LICENSE$/);
    assert.match(
      electronNotices.chromium,
      /electron\/dist\/LICENSES\.chromium\.html$/,
    );
    for (const relativePath of [
      'LICENSE',
      'THIRD-PARTY-NOTICES.md',
      'CLODEX_VS_UPSTREAM.md',
      'CONTRIBUTORS.md',
      'packages/karton/LICENSE.md',
      'provenance/DEPENDENCY_LICENSE_OVERRIDES.json',
      'dependency-licenses.json',
      'manifest.json',
    ]) {
      assert.ok(
        readFileSync(path.join(fixture.outputDirectory, relativePath)).length >
          0,
      );
    }
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('fails closed on a missing license declaration or license text', () => {
  const fixture = makeFixture();
  try {
    const manifestPath = path.join(
      fixture.appDirectory,
      'node_modules/good-dep/package.json',
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    delete manifest.license;
    writeJson(manifestPath, manifest);
    rmSync(path.join(fixture.appDirectory, 'node_modules/good-dep/LICENSE'));

    assert.throws(
      () =>
        collectReleaseDependencyInventory({
          appDirectory: fixture.appDirectory,
          repositoryDirectory: fixture.root,
          strict: true,
        }),
      (error) => {
        assert.ok(error instanceof AttributionGateError);
        assert.deepEqual(
          error.blockers
            .filter((blocker) => blocker.message.includes('good-dep@1.0.0'))
            .map((blocker) => blocker.code),
          ['PACKAGE_LICENSE_TEXT_MISSING', 'PACKAGE_LICENSE_UNKNOWN'],
        );
        return true;
      },
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('recognizes common LICENSE-* file names shipped by exact packages', () => {
  const fixture = makeFixture();
  try {
    const packageDirectory = path.join(
      fixture.appDirectory,
      'node_modules/good-dep',
    );
    const licenseText = readFileSync(path.join(packageDirectory, 'LICENSE'));
    rmSync(path.join(packageDirectory, 'LICENSE'));
    writeFileSync(path.join(packageDirectory, 'LICENSE-MIT.txt'), licenseText);

    const inventory = collectReleaseDependencyInventory({
      appDirectory: fixture.appDirectory,
      repositoryDirectory: fixture.root,
      strict: true,
    });
    const entry = inventory.entries.find(
      (candidate) => candidate.name === 'good-dep',
    );
    assert.match(entry.licenseText, /good dependency MIT license/);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('applies only exact reviewed package-file overrides and rejects hash drift', () => {
  const fixture = makeFixture();
  try {
    const packageDirectory = path.join(
      fixture.appDirectory,
      'node_modules/good-dep',
    );
    const manifestPath = path.join(packageDirectory, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    delete manifest.license;
    writeJson(manifestPath, manifest);
    const licensePath = path.join(packageDirectory, 'LICENSE');
    const registryPath = path.join(
      fixture.root,
      'docs/provenance/DEPENDENCY_LICENSE_OVERRIDES.json',
    );
    writeJson(registryPath, {
      schemaVersion: 1,
      status: 'ENGINEERING_REVIEWED',
      reviewedAt: '2026-07-15',
      legalConclusion: false,
      entries: [
        {
          package: 'good-dep',
          version: '1.0.0',
          license: 'MIT',
          reviewStatus: 'ENGINEERING_REVIEWED',
          reviewedAt: '2026-07-15',
          basis: 'EXACT_PACKAGE_FILE',
          packageSource: {
            registry: 'npm',
            tarball: 'https://registry.npmjs.org/good-dep/-/good-dep-1.0.0.tgz',
            integrity: fixtureGoodDependencyIntegrity,
          },
          licenseTextSource: {
            type: 'package-file',
            path: 'LICENSE',
            sha256: sha256FileSync(licensePath),
            sourceReferences: ['fixture:good-dep-license'],
          },
        },
      ],
    });

    const inventory = collectReleaseDependencyInventory({
      appDirectory: fixture.appDirectory,
      repositoryDirectory: fixture.root,
      strict: true,
    });
    const entry = inventory.entries.find(
      (candidate) => candidate.name === 'good-dep',
    );
    assert.equal(entry.license, 'MIT');
    assert.equal(entry.licenseEvidence.reviewStatus, 'ENGINEERING_REVIEWED');

    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.entries[0].packageSource.integrity =
      'sha512-ZmFicmljYXRlZC1pbnRlZ3JpdHk=';
    writeJson(registryPath, registry);
    assert.throws(
      () =>
        collectReleaseDependencyInventory({
          appDirectory: fixture.appDirectory,
          repositoryDirectory: fixture.root,
          strict: true,
        }),
      (error) =>
        error instanceof AttributionGateError &&
        error.blockers.some(
          (blocker) =>
            blocker.code === 'LICENSE_OVERRIDE_PACKAGE_INTEGRITY_MISMATCH',
        ),
    );
    registry.entries[0].packageSource.integrity =
      fixtureGoodDependencyIntegrity;
    writeJson(registryPath, registry);

    writeFileSync(licensePath, 'tampered license\n');
    assert.throws(
      () =>
        collectReleaseDependencyInventory({
          appDirectory: fixture.appDirectory,
          repositoryDirectory: fixture.root,
          strict: true,
        }),
      (error) =>
        error instanceof AttributionGateError &&
        error.blockers.some(
          (blocker) =>
            blocker.code === 'LICENSE_OVERRIDE_PACKAGE_FILE_HASH_MISMATCH',
        ),
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects reviewed repository-license evidence after hash drift', () => {
  const fixture = makeFixture();
  try {
    const packageDirectory = path.join(
      fixture.appDirectory,
      'node_modules/good-dep',
    );
    rmSync(path.join(packageDirectory, 'LICENSE'));
    const evidenceRelativePath =
      'docs/provenance/dependency-license-texts/good-dep-MIT.txt';
    const evidencePath = path.join(fixture.root, evidenceRelativePath);
    writeText(evidencePath, 'reviewed good dependency MIT terms\n');
    writeJson(
      path.join(
        fixture.root,
        'docs/provenance/DEPENDENCY_LICENSE_OVERRIDES.json',
      ),
      {
        schemaVersion: 1,
        status: 'ENGINEERING_REVIEWED',
        reviewedAt: '2026-07-15',
        legalConclusion: false,
        entries: [
          {
            package: 'good-dep',
            version: '1.0.0',
            license: 'MIT',
            reviewStatus: 'ENGINEERING_REVIEWED',
            reviewedAt: '2026-07-15',
            basis: 'PINNED_UPSTREAM_LICENSE',
            packageSource: {
              registry: 'npm',
              tarball:
                'https://registry.npmjs.org/good-dep/-/good-dep-1.0.0.tgz',
              integrity: fixtureGoodDependencyIntegrity,
            },
            licenseTextSource: {
              type: 'repository-file',
              path: evidenceRelativePath,
              sha256: sha256FileSync(evidencePath),
              sourceReferences: ['fixture:reviewed-upstream-license'],
            },
          },
        ],
      },
    );

    const inventory = collectReleaseDependencyInventory({
      appDirectory: fixture.appDirectory,
      repositoryDirectory: fixture.root,
      strict: true,
    });
    assert.match(
      inventory.entries.find((entry) => entry.name === 'good-dep').licenseText,
      /reviewed good dependency MIT terms/,
    );

    writeText(evidencePath, 'tampered evidence\n');
    assert.throws(
      () =>
        collectReleaseDependencyInventory({
          appDirectory: fixture.appDirectory,
          repositoryDirectory: fixture.root,
          strict: true,
        }),
      (error) =>
        error instanceof AttributionGateError &&
        error.blockers.some(
          (blocker) => blocker.code === 'LICENSE_OVERRIDE_SOURCE_HASH_MISMATCH',
        ),
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('deduplicates identical package versions reached through peer contexts', () => {
  const fixture = makeFixture();
  try {
    const appManifestPath = path.join(fixture.appDirectory, 'package.json');
    const appManifest = JSON.parse(readFileSync(appManifestPath, 'utf8'));
    appManifest.dependencies['context-a'] = '1.0.0';
    appManifest.dependencies['context-b'] = '1.0.0';
    writeJson(appManifestPath, appManifest);

    for (const contextName of ['context-a', 'context-b']) {
      const contextDirectory = path.join(
        fixture.appDirectory,
        'node_modules',
        contextName,
      );
      writeJson(path.join(contextDirectory, 'package.json'), {
        name: contextName,
        version: '1.0.0',
        license: 'MIT',
        dependencies: { 'shared-context-dep': '3.0.0' },
      });
      writeText(
        path.join(contextDirectory, 'LICENSE'),
        'context MIT license\n',
      );
      writeJson(
        path.join(
          contextDirectory,
          'node_modules/shared-context-dep/package.json',
        ),
        {
          name: 'shared-context-dep',
          version: '3.0.0',
          license: 'ISC',
        },
      );
      writeText(
        path.join(contextDirectory, 'node_modules/shared-context-dep/LICENSE'),
        'shared ISC license\n',
      );
    }

    const inventory = collectReleaseDependencyInventory({
      appDirectory: fixture.appDirectory,
      repositoryDirectory: fixture.root,
      strict: true,
    });
    assert.equal(
      inventory.entries.filter(
        (entry) =>
          entry.name === 'shared-context-dep' && entry.version === '3.0.0',
      ).length,
      1,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('honors only exact pnpm dependency-removal overrides', () => {
  const fixture = makeFixture();
  try {
    const dependencyManifestPath = path.join(
      fixture.appDirectory,
      'node_modules/good-dep/package.json',
    );
    const dependencyManifest = JSON.parse(
      readFileSync(dependencyManifestPath, 'utf8'),
    );
    dependencyManifest.dependencies['removed-build-dep'] = '1.0.0';
    writeJson(dependencyManifestPath, dependencyManifest);
    writeJson(path.join(fixture.root, 'package.json'), {
      name: 'fixture-root',
      private: true,
      version: '1.0.0',
      pnpm: {
        overrides: {
          'good-dep@1.0.0>removed-build-dep': '-',
        },
      },
    });

    const inventory = collectReleaseDependencyInventory({
      appDirectory: fixture.appDirectory,
      repositoryDirectory: fixture.root,
      strict: true,
    });
    assert.ok(
      !inventory.entries.some((entry) => entry.name === 'removed-build-dep'),
    );

    writeJson(path.join(fixture.root, 'package.json'), {
      name: 'fixture-root',
      private: true,
      version: '1.0.0',
      pnpm: {
        overrides: {
          'good-dep>removed-build-dep': '-',
        },
      },
    });
    assert.throws(
      () =>
        collectReleaseDependencyInventory({
          appDirectory: fixture.appDirectory,
          repositoryDirectory: fixture.root,
          strict: true,
        }),
      (error) =>
        error instanceof AttributionGateError &&
        error.blockers.some(
          (blocker) => blocker.code === 'DEPENDENCY_MANIFEST_UNRESOLVED',
        ),
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('future Nucleo dependencies require exact approved redistribution evidence', () => {
  const fixture = makeFixture();
  try {
    const appManifestPath = path.join(fixture.appDirectory, 'package.json');
    const appManifest = JSON.parse(readFileSync(appManifestPath, 'utf8'));
    appManifest.dependencies['nucleo-future'] = '1.0.0';
    writeJson(appManifestPath, appManifest);
    writeJson(
      path.join(
        fixture.appDirectory,
        'node_modules/nucleo-future/package.json',
      ),
      { name: 'nucleo-future', version: '1.0.0' },
    );

    assert.throws(
      () =>
        collectReleaseDependencyInventory({
          appDirectory: fixture.appDirectory,
          repositoryDirectory: fixture.root,
          strict: true,
        }),
      (error) =>
        error instanceof AttributionGateError &&
        error.blockers.some(
          (blocker) =>
            blocker.code === 'NUCLEO_REDISTRIBUTION_RIGHTS_UNVERIFIED',
        ),
    );

    writeJson(
      path.join(
        fixture.root,
        'docs/provenance/NUCLEO_REDISTRIBUTION_EVIDENCE.json',
      ),
      {
        schemaVersion: 1,
        status: 'APPROVED',
        packageNames: ['nucleo-future'],
        redistributionScope: ['desktop-application-binary'],
        evidenceReferences: ['private-record:fixture-only'],
        approvedBy: 'fixture-reviewer',
        approvedAt: '2026-07-15T00:00:00.000Z',
        expiresAt: '2027-07-15T00:00:00.000Z',
        licenseName: 'Fixture commercial license',
      },
    );
    const inventory = collectReleaseDependencyInventory({
      appDirectory: fixture.appDirectory,
      repositoryDirectory: fixture.root,
      now: new Date('2026-07-15T01:00:00.000Z'),
      strict: true,
    });
    assert.equal(inventory.nucleo.status, 'APPROVED');
    assert.ok(
      inventory.entries.some(
        (entry) =>
          entry.name === 'nucleo-future' && entry.kind === 'commercial_asset',
      ),
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects a packaged attribution file after tampering', () => {
  const fixture = makeFixture();
  try {
    prepareReleaseAttributionBundle({
      appDirectory: fixture.appDirectory,
      outputDirectory: fixture.outputDirectory,
      releaseChannel: 'release',
      repositoryDirectory: fixture.root,
    });
    writeFileSync(
      path.join(fixture.outputDirectory, 'THIRD-PARTY-NOTICES.md'),
      'tampered\n',
    );
    assert.throws(
      () =>
        inspectPackagedAttribution({
          attributionDirectory: fixture.outputDirectory,
        }),
      /Attribution (hash|size) mismatch/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects packaged override-registry drift even with a recomputed manifest hash', () => {
  const fixture = makeFixture();
  try {
    prepareReleaseAttributionBundle({
      appDirectory: fixture.appDirectory,
      outputDirectory: fixture.outputDirectory,
      releaseChannel: 'release',
      repositoryDirectory: fixture.root,
    });
    const registryPath = path.join(
      fixture.outputDirectory,
      'provenance/DEPENDENCY_LICENSE_OVERRIDES.json',
    );
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.entries.push({
      package: 'fabricated',
      version: '1.0.0',
      reviewStatus: 'ENGINEERING_REVIEWED',
    });
    writeJson(registryPath, registry);

    const manifestPath = path.join(fixture.outputDirectory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const registryRecord = manifest.files.find(
      (entry) => entry.path === 'provenance/DEPENDENCY_LICENSE_OVERRIDES.json',
    );
    registryRecord.bytes = statSync(registryPath).size;
    registryRecord.sha256 = sha256FileSync(registryPath);
    writeJson(manifestPath, manifest);

    assert.throws(
      () =>
        inspectPackagedAttribution({
          attributionDirectory: fixture.outputDirectory,
        }),
      /override registry does not match/i,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects blocker laundering even when manifest hashes are recomputed', () => {
  const fixture = makeFixture();
  try {
    const dependencyManifestPath = path.join(
      fixture.appDirectory,
      'node_modules/good-dep/package.json',
    );
    const dependencyManifest = JSON.parse(
      readFileSync(dependencyManifestPath, 'utf8'),
    );
    delete dependencyManifest.license;
    writeJson(dependencyManifestPath, dependencyManifest);
    prepareReleaseAttributionBundle({
      appDirectory: fixture.appDirectory,
      outputDirectory: fixture.outputDirectory,
      releaseChannel: 'dev',
      repositoryDirectory: fixture.root,
    });

    const inventoryPath = path.join(
      fixture.outputDirectory,
      'dependency-licenses.json',
    );
    const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
    assert.ok(inventory.blockers.length > 0);
    inventory.status = 'READY';
    writeJson(inventoryPath, inventory);

    const manifestPath = path.join(fixture.outputDirectory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.status = 'READY';
    const inventoryRecord = manifest.files.find(
      (entry) => entry.path === 'dependency-licenses.json',
    );
    inventoryRecord.bytes = statSync(inventoryPath).size;
    inventoryRecord.sha256 = sha256FileSync(inventoryPath);
    writeJson(manifestPath, manifest);

    assert.throws(
      () =>
        inspectPackagedAttribution({
          attributionDirectory: fixture.outputDirectory,
        }),
      AttributionGateError,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('writes a final-artifact CycloneDX SBOM and rejects uninventoried native packages', async () => {
  const fixture = makeFixture();
  try {
    prepareReleaseAttributionBundle({
      appDirectory: fixture.appDirectory,
      outputDirectory: fixture.outputDirectory,
      releaseChannel: 'release',
      repositoryDirectory: fixture.root,
    });
    const applicationDirectory = path.join(fixture.root, 'packaged-app');
    const resourcesDirectory = path.join(applicationDirectory, 'resources');
    const packagedAttributionDirectory = path.join(
      resourcesDirectory,
      ATTRIBUTION_DIRECTORY_NAME,
    );
    mkdirSync(resourcesDirectory, { recursive: true });
    cpSync(fixture.outputDirectory, packagedAttributionDirectory, {
      recursive: true,
    });
    writeText(path.join(resourcesDirectory, 'app.asar'), 'synthetic asar\n');
    const electronNotices = resolveElectronRuntimeNoticePaths({
      appDirectory: fixture.appDirectory,
    });
    cpSync(electronNotices.electron, path.join(resourcesDirectory, 'LICENSE'));
    cpSync(
      electronNotices.chromium,
      path.join(resourcesDirectory, 'LICENSES.chromium.html'),
    );
    writeJson(
      path.join(
        resourcesDirectory,
        'app.asar.unpacked/node_modules/good-dep/package.json',
      ),
      { name: 'good-dep', version: '1.0.0' },
    );

    const attribution = inspectPackagedAttribution({
      attributionDirectory: packagedAttributionDirectory,
    });
    const sbomPath = path.join(fixture.root, 'validation/app.cdx.json');
    const report = await writeFinalArtifactSbom({
      applicationDirectory,
      appName: 'Fixture App',
      appVersion: '1.0.0',
      arch: 'x64',
      attribution,
      electronRuntime: {
        license: 'MIT',
        name: 'electron',
        version: '39.0.0',
      },
      outputPath: sbomPath,
      platform: 'linux',
      resourcesDirectory,
      timestamp: new Date('2026-07-15T00:00:00.000Z'),
    });
    const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
    assert.equal(sbom.bomFormat, 'CycloneDX');
    assert.equal(sbom.specVersion, '1.6');
    assert.equal(report.nativePackageCount, 1);
    assert.ok(
      sbom.components.some(
        (component) =>
          component.name === 'app.asar' &&
          component.hashes[0].alg === 'SHA-256',
      ),
    );
    assert.ok(
      sbom.components.some(
        (component) =>
          component.name === 'electron' &&
          component.version === '39.0.0' &&
          component.type === 'framework',
      ),
    );

    writeJson(
      path.join(
        resourcesDirectory,
        'app.asar.unpacked/node_modules/uninventoried/package.json',
      ),
      { name: 'uninventoried', version: '9.9.9' },
    );
    await assert.rejects(
      writeFinalArtifactSbom({
        applicationDirectory,
        appName: 'Fixture App',
        appVersion: '1.0.0',
        arch: 'x64',
        attribution,
        electronRuntime: {
          license: 'MIT',
          name: 'electron',
          version: '39.0.0',
        },
        outputPath: sbomPath,
        platform: 'linux',
        resourcesDirectory,
      }),
      /missing from the license inventory: uninventoried@9.9.9/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('release workflow and Forge packaging wire the attribution gate before publication', () => {
  const forgeSource = readFileSync(
    path.join(browserDirectory, 'forge.config.mts'),
    'utf8',
  );
  const workflowSource = readFileSync(
    path.join(repositoryDirectory, '.github/workflows/_release-browser.yml'),
    'utf8',
  );
  const artifactValidatorSource = readFileSync(
    path.join(browserDirectory, 'scripts/validate-release-artifacts.mjs'),
    'utf8',
  );
  const macosValidatorSource = readFileSync(
    path.join(browserDirectory, 'scripts/validate-macos-release.mjs'),
    'utf8',
  );
  assert.match(forgeSource, /prepareReleaseAttributionBundle/);
  assert.match(forgeSource, /releaseAttributionPath/);
  assert.match(
    workflowSource,
    /Validate desktop attribution and redistribution rights[\s\S]*release:attribution:check/,
  );
  assert.match(
    workflowSource,
    /args=\([\s\S]*stage[\s\S]*release-publication\.mjs "\$\{args\[@\]\}"[\s\S]*if-no-files-found: error/,
  );
  assert.match(
    workflowSource,
    /args=\([\s\S]*collect[\s\S]*--expected=macos:arm64,macos:x64,linux:x64,windows:x64[\s\S]*release-publication\.mjs "\$\{args\[@\]\}"/,
  );
  assert.doesNotMatch(workflowSource, /find artifacts -type f/);
  assert.match(
    artifactValidatorSource,
    /extractZipSafely\(nupkgPath[\s\S]*inspectExtractedApplication/,
  );
  assert.match(artifactValidatorSource, /dpkg-deb[\s\S]*--extract/);
  assert.match(artifactValidatorSource, /rpm2cpio[\s\S]*cpio --extract/);
  assert.match(
    macosValidatorSource,
    /ditto[\s\S]*zipAttribution[\s\S]*applicationDirectory: zipAppPath[\s\S]*sbomAppAsarSha256/,
  );
});

test('the exact installed repository dependency graph is strict-green', () => {
  const overrideRegistry = JSON.parse(
    readFileSync(
      path.join(
        repositoryDirectory,
        'docs/provenance/DEPENDENCY_LICENSE_OVERRIDES.json',
      ),
      'utf8',
    ),
  );
  const inventory = collectReleaseDependencyInventory({
    appDirectory: browserDirectory,
    repositoryDirectory,
    strict: true,
  });
  assert.equal(inventory.blockers.length, 0);
  assert.equal(inventory.licenseOverrides.status, 'ENGINEERING_REVIEWED');
  assert.equal(inventory.licenseOverrides.entryCount, 54);
  assert.ok(inventory.licenseOverrides.appliedCount >= 40);
  assert.equal(
    overrideRegistry.entries.find(
      (entry) =>
        entry.package === '@libsql/linux-x64-musl' &&
        entry.version === '0.5.29',
    )?.packageSource.integrity,
    'sha512-gquqwA/39tH4pFl+J9n3SOMSymjX+6kZ3kWgY3b94nXFTwac9bnFNMffIomgvlFaC4ArVqMnOZD3nuJ3H3VO1w==',
  );
  assert.deepEqual(inventory.nucleo.packageNames, []);
  assert.equal(inventory.nucleo.status, 'NOT_REQUIRED');
});

test('the repository package graph has no nucleo-* package or import', () => {
  const forbidden = [];
  const roots = ['apps', 'packages', 'agent'].map((entry) =>
    path.join(repositoryDirectory, entry),
  );
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        if (entry.name.startsWith('nucleo-')) forbidden.push(entryPath);
        visit(entryPath);
      } else if (
        entry.isFile() &&
        ['.json', '.js', '.jsx', '.ts', '.tsx'].includes(
          path.extname(entry.name),
        )
      ) {
        const source = readFileSync(entryPath, 'utf8');
        if (/from ['"]nucleo-|"nucleo-[^"]+"\s*:/.test(source)) {
          forbidden.push(entryPath);
        }
      }
    }
  };
  for (const root of roots) visit(root);
  assert.deepEqual(forbidden, []);
});

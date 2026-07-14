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
  assert.match(forgeSource, /prepareReleaseAttributionBundle/);
  assert.match(forgeSource, /releaseAttributionPath/);
  assert.match(
    workflowSource,
    /Validate desktop attribution and redistribution rights[\s\S]*release:attribution:check/,
  );
  assert.match(workflowSource, /\*\.cdx\.json/);
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

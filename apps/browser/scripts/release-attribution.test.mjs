import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  inspectBundledComponentArtifacts,
  inspectPackagedAttribution,
  loadBundledComponentRegistry,
  prepareReleaseAttributionBundle,
  REQUIRED_ATTRIBUTION_PATHS,
  resolveElectronRuntimeNoticePaths,
  sha256FileSync,
  verifyBundledComponentFixedArtifactBytes,
  verifyBundledComponentSourceBytes,
  verifyBundledEmbeddedDependencySourceBytes,
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
    [
      'docs/provenance/bundled-component-license-texts/vscode-eslint-3.0.10-MIT.txt',
      'fixture vscode-eslint MIT license\n',
    ],
    [
      'docs/provenance/bundled-component-license-texts/vcruntime-cefsharp-140-1.0.5-MIT.txt',
      'fixture VCRuntime package MIT license\n',
    ],
    [
      'docs/provenance/bundled-component-license-texts/eslint-bundle-ISC.txt',
      'fixture embedded ISC license\n',
    ],
    [
      'docs/provenance/bundled-component-license-texts/vscode-languageserver-node-MIT.txt',
      'fixture embedded Microsoft MIT license\n',
    ],
    [
      'docs/provenance/bundled-component-license-texts/vscode-uri-3.0.8-MIT.txt',
      'fixture embedded vscode-uri MIT license\n',
    ],
    [
      'docs/provenance/bundled-component-evidence/VCRuntime.CefSharp.140-1.0.5.nuspec.txt',
      '<package>fixture metadata</package>\n',
    ],
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
  writeJson(path.join(root, 'docs/provenance/BUNDLED_COMPONENTS.json'), {
    schemaVersion: 1,
    status: 'ENGINEERING_REVIEWED',
    reviewedAt: '2026-07-15',
    legalConclusion: false,
    components: [],
  });
  writeJson(
    path.join(
      root,
      'docs/provenance/bundled-component-evidence/vscode-eslint-3.0.10-server-package-lock.json',
    ),
    { lockfileVersion: 3, packages: {} },
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

function writeBundledComponents(fixture, components) {
  writeJson(
    path.join(fixture.root, 'docs/provenance/BUNDLED_COMPONENTS.json'),
    {
      schemaVersion: 1,
      status: 'ENGINEERING_REVIEWED',
      reviewedAt: '2026-07-15',
      legalConclusion: false,
      components,
    },
  );
}

function generatedBundleComponent(fixture) {
  const licensePath = path.join(
    fixture.root,
    'docs/provenance/bundled-component-license-texts/vscode-eslint-3.0.10-MIT.txt',
  );
  const sourceSha256 = '1'.repeat(64);
  const embeddedLicensePath = path.join(
    fixture.root,
    'docs/provenance/bundled-component-license-texts/eslint-bundle-ISC.txt',
  );
  const embeddedLockPath = path.join(
    fixture.root,
    'docs/provenance/bundled-component-evidence/vscode-eslint-3.0.10-server-package-lock.json',
  );
  const embeddedIntegrity = `sha512-${Buffer.alloc(64, 8).toString('base64')}`;
  const embeddedTarball =
    'https://registry.npmjs.org/fixture-bundle-dep/-/fixture-bundle-dep-1.2.3.tgz';
  writeJson(embeddedLockPath, {
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture-eslint-server', version: '3.0.10' },
      'node_modules/fixture-bundle-dep': {
        version: '1.2.3',
        resolved: embeddedTarball,
        integrity: embeddedIntegrity,
      },
    },
  });
  return {
    id: 'fixture-eslint-server',
    name: 'fixture-eslint',
    version: '3.0.10',
    kind: 'bundled-source-build',
    platforms: ['linux', 'macos', 'windows'],
    architectures: ['arm64', 'x64'],
    publisher: 'Fixture Publisher',
    repository: 'https://example.test/fixture-eslint',
    purl: `pkg:github/example/fixture-eslint@${'2'.repeat(40)}`,
    license: 'MIT',
    reviewStatus: 'ENGINEERING_REVIEWED',
    reviewedAt: '2026-07-15',
    buildTransforms: [
      {
        id: 'node22-ts-loader-transpile-only',
        targetPath: 'shared.webpack.config.js',
        beforeSha256: '6'.repeat(64),
        afterSha256: '7'.repeat(64),
        description: 'Fixture reviewed source transform.',
      },
    ],
    embeddedDependencyLock: {
      path: 'bundled-component-evidence/vscode-eslint-3.0.10-server-package-lock.json',
      sha256: sha256FileSync(embeddedLockPath),
      sourceReferences: [
        `https://example.test/fixture-eslint/source/${'2'.repeat(40)}/server/package-lock.json`,
      ],
    },
    embeddedDependencies: [
      {
        name: 'fixture-bundle-dep',
        version: '1.2.3',
        license: 'ISC',
        bundleScope: 'embedded',
        publisher: 'Fixture Publisher',
        repository: 'https://example.test/fixture-bundle-dep',
        purl: 'pkg:npm/fixture-bundle-dep@1.2.3',
        packageSource: {
          registry: 'npm',
          tarball: embeddedTarball,
          integrity: embeddedIntegrity,
          sha256: '8'.repeat(64),
        },
        licenseEvidence: {
          path: 'bundled-component-license-texts/eslint-bundle-ISC.txt',
          packagePath: 'LICENSE',
          sha256: sha256FileSync(embeddedLicensePath),
          sourceReferences: [
            embeddedTarball,
            'https://www.npmjs.com/package/fixture-bundle-dep/v/1.2.3',
          ],
        },
      },
    ],
    source: {
      type: 'git-archive',
      versionRef: 'release/3.0.10',
      immutableRevision: '2'.repeat(40),
      url: `https://example.test/fixture-eslint/archive/${'2'.repeat(40)}.zip`,
      sha256: sourceSha256,
      materializedSymlinks: [],
      sourceReferences: [
        `https://example.test/fixture-eslint/source/${'2'.repeat(40)}`,
      ],
    },
    licenseEvidence: {
      path: 'bundled-component-license-texts/vscode-eslint-3.0.10-MIT.txt',
      sha256: sha256FileSync(licensePath),
      sourceReferences: ['https://example.test/fixture-eslint/license'],
    },
    noticeEvidence: {
      status: 'LICENSE_CONTAINS_COPYRIGHT_NOTICE',
      sourceArchiveInspectedSha256: sourceSha256,
      sourceReferences: ['https://example.test/fixture-eslint/license'],
    },
    packagedArtifacts: {
      mode: 'generated-manifest',
      manifest: {
        location: 'resources',
        path: 'bundled/eslint-server/provenance.json',
      },
      artifactDirectory: {
        location: 'resources',
        path: 'bundled/eslint-server',
      },
      requiredFiles: [
        { path: 'eslintServer.cjs', role: 'server-bundle' },
        { path: 'eslintServer.js.map', role: 'source-map' },
      ],
      fixedFiles: [
        {
          location: 'resources',
          path: 'bundled/eslint-server/License.txt',
          role: 'license',
          bytes: statSync(licensePath).size,
          sha256: sha256FileSync(licensePath),
        },
      ],
    },
    redistributionReview: {
      status: 'UPSTREAM_LICENSE_RECORDED',
      legalConclusion: false,
      sourceReferences: ['https://example.test/fixture-eslint/license'],
      notes: 'Fixture engineering evidence only.',
    },
  };
}

function fixedBinaryComponent(fixture, files) {
  const licensePath = path.join(
    fixture.root,
    'docs/provenance/bundled-component-license-texts/vcruntime-cefsharp-140-1.0.5-MIT.txt',
  );
  const metadataPath = path.join(
    fixture.root,
    'docs/provenance/bundled-component-evidence/VCRuntime.CefSharp.140-1.0.5.nuspec.txt',
  );
  const sourceSha256 = '3'.repeat(64);
  return {
    id: 'fixture-vcruntime',
    name: 'Fixture.VCRuntime',
    version: '1.0.5',
    kind: 'bundled-binary-archive',
    platforms: ['windows'],
    architectures: ['x64'],
    publisher: 'Fixture Publisher',
    repository: 'https://example.test/fixture-vcruntime',
    purl: 'pkg:nuget/Fixture.VCRuntime@1.0.5',
    license: 'MIT',
    reviewStatus: 'ENGINEERING_REVIEWED',
    reviewedAt: '2026-07-15',
    source: {
      type: 'nuget-package',
      packageId: 'Fixture.VCRuntime',
      version: '1.0.5',
      url: 'https://api.nuget.org/v3-flatcontainer/fixture.vcruntime/1.0.5/fixture.vcruntime.1.0.5.nupkg',
      sha256: sourceSha256,
      nugetSha512: Buffer.alloc(64, 6).toString('base64'),
      sourceRevision: '4'.repeat(40),
      signatureEntrySha256: '5'.repeat(64),
      sourceReferences: [
        `https://example.test/fixture-vcruntime/source/${'4'.repeat(40)}`,
      ],
    },
    licenseEvidence: {
      path: 'bundled-component-license-texts/vcruntime-cefsharp-140-1.0.5-MIT.txt',
      sha256: sha256FileSync(licensePath),
      sourceReferences: ['https://example.test/fixture-vcruntime/license'],
    },
    metadataEvidence: {
      path: 'bundled-component-evidence/VCRuntime.CefSharp.140-1.0.5.nuspec.txt',
      sha256: sha256FileSync(metadataPath),
      sourceReferences: ['https://example.test/fixture-vcruntime/metadata'],
    },
    noticeEvidence: {
      status: 'PACKAGE_METADATA_CONTAINS_COPYRIGHT_NOTICE',
      sourceArchiveInspectedSha256: sourceSha256,
      sourceReferences: ['https://example.test/fixture-vcruntime/metadata'],
    },
    packagedArtifacts: {
      mode: 'fixed-files',
      files,
      exclusiveFileMatch: {
        location: 'application',
        path: '.',
        fileNamePattern: '^(?:msvcp140.*|vcruntime140.*)\\.dll$',
      },
    },
    redistributionReview: {
      status: 'CONDITIONAL_UPSTREAM_TERMS',
      legalConclusion: false,
      sourceReferences: ['https://example.test/fixture-vcruntime/terms'],
      notes: 'Fixture terms require release-owner review.',
    },
  };
}

function writeGeneratedBundle(resourcesDirectory, component) {
  const bundleDirectory = path.join(
    resourcesDirectory,
    'bundled/eslint-server',
  );
  const serverPath = path.join(bundleDirectory, 'eslintServer.cjs');
  const mapPath = path.join(bundleDirectory, 'eslintServer.js.map');
  const licenseSourcePath = path.join(
    path.dirname(
      path.join(
        resourcesDirectory,
        'release-attribution/provenance/BUNDLED_COMPONENTS.json',
      ),
    ),
    component.licenseEvidence.path,
  );
  writeText(serverPath, 'fixture bundled server\n');
  writeText(mapPath, '{"version":3}\n');
  mkdirSync(bundleDirectory, { recursive: true });
  cpSync(licenseSourcePath, path.join(bundleDirectory, 'License.txt'));
  const artifacts = [
    { path: 'eslintServer.cjs', role: 'server-bundle' },
    { path: 'eslintServer.js.map', role: 'source-map' },
  ].map((entry) => {
    const filePath = path.join(bundleDirectory, entry.path);
    return {
      ...entry,
      bytes: statSync(filePath).size,
      sha256: sha256FileSync(filePath),
    };
  });
  writeJson(path.join(bundleDirectory, 'provenance.json'), {
    schemaVersion: 2,
    componentId: component.id,
    name: component.name,
    version: component.version,
    reviewStatus: component.reviewStatus,
    source: component.source,
    buildTransforms: component.buildTransforms,
    embeddedDependencyLock: component.embeddedDependencyLock,
    embeddedDependencies: component.embeddedDependencies.map(
      ({ licenseText: _licenseText, ...dependency }) => dependency,
    ),
    embeddedModuleNames: component.embeddedDependencies
      .filter((dependency) => dependency.bundleScope === 'embedded')
      .map((dependency) => dependency.name)
      .sort(),
    licenseEvidence: component.licenseEvidence,
    artifacts,
  });
  return bundleDirectory;
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
      'provenance/BUNDLED_COMPONENTS.json',
      'provenance/bundled-component-license-texts/vscode-eslint-3.0.10-MIT.txt',
      'provenance/bundled-component-license-texts/vcruntime-cefsharp-140-1.0.5-MIT.txt',
      'provenance/bundled-component-license-texts/eslint-bundle-ISC.txt',
      'provenance/bundled-component-license-texts/vscode-languageserver-node-MIT.txt',
      'provenance/bundled-component-license-texts/vscode-uri-3.0.8-MIT.txt',
      'provenance/bundled-component-evidence/VCRuntime.CefSharp.140-1.0.5.nuspec.txt',
      'provenance/bundled-component-evidence/vscode-eslint-3.0.10-server-package-lock.json',
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

test('packaged attribution avoids NuGet-reserved nested nuspec names', () => {
  assert.equal(
    REQUIRED_ATTRIBUTION_PATHS.some((relativePath) =>
      relativePath.toLowerCase().endsWith('.nuspec'),
    ),
    false,
  );
  assert.ok(
    REQUIRED_ATTRIBUTION_PATHS.includes(
      'provenance/bundled-component-evidence/VCRuntime.CefSharp.140-1.0.5.nuspec.txt',
    ),
  );
});

test('bundled source records require immutable pins and exact license evidence', () => {
  const fixture = makeFixture();
  try {
    const component = generatedBundleComponent(fixture);
    writeBundledComponents(fixture, [component]);
    const inventory = collectReleaseDependencyInventory({
      appDirectory: fixture.appDirectory,
      arch: 'x64',
      platform: 'linux',
      repositoryDirectory: fixture.root,
      strict: true,
    });
    const entry = inventory.entries.find(
      (candidate) => candidate.kind === 'bundled_component',
    );
    assert.equal(entry.name, 'fixture-eslint');
    assert.equal(
      entry.bundledComponentEvidence.source.immutableRevision,
      '2'.repeat(40),
    );
    assert.equal(inventory.bundledComponents.applicableCount, 1);
    assert.equal(
      inventory.bundledComponents.applicableEmbeddedDependencyCount,
      1,
    );

    const embeddedLicensePath = path.join(
      fixture.root,
      'docs/provenance/bundled-component-license-texts/eslint-bundle-ISC.txt',
    );
    writeText(embeddedLicensePath, 'tampered embedded license\n');
    assert.throws(
      () =>
        collectReleaseDependencyInventory({
          appDirectory: fixture.appDirectory,
          arch: 'x64',
          platform: 'linux',
          repositoryDirectory: fixture.root,
          strict: true,
        }),
      (error) =>
        error instanceof AttributionGateError &&
        error.blockers.some(
          (blocker) =>
            blocker.code === 'BUNDLED_COMPONENT_EVIDENCE_HASH_MISMATCH' &&
            blocker.message.includes('fixture-bundle-dep@1.2.3'),
        ),
    );
    writeText(embeddedLicensePath, 'fixture embedded ISC license\n');

    writeText(
      path.join(
        fixture.root,
        'docs/provenance/bundled-component-license-texts/vscode-eslint-3.0.10-MIT.txt',
      ),
      'tampered license\n',
    );
    assert.throws(
      () =>
        collectReleaseDependencyInventory({
          appDirectory: fixture.appDirectory,
          arch: 'x64',
          platform: 'linux',
          repositoryDirectory: fixture.root,
          strict: true,
        }),
      (error) =>
        error instanceof AttributionGateError &&
        error.blockers.some(
          (blocker) =>
            blocker.code === 'BUNDLED_COMPONENT_EVIDENCE_HASH_MISMATCH',
        ),
    );

    writeText(
      path.join(
        fixture.root,
        'docs/provenance/bundled-component-license-texts/vscode-eslint-3.0.10-MIT.txt',
      ),
      'fixture vscode-eslint MIT license\n',
    );
    component.source.url =
      'https://example.test/fixture-eslint/archive/refs/tags/release/3.0.10.zip';
    writeBundledComponents(fixture, [component]);
    assert.throws(
      () =>
        collectReleaseDependencyInventory({
          appDirectory: fixture.appDirectory,
          arch: 'x64',
          platform: 'linux',
          repositoryDirectory: fixture.root,
          strict: true,
        }),
      (error) =>
        error instanceof AttributionGateError &&
        error.blockers.some(
          (blocker) => blocker.code === 'BUNDLED_COMPONENT_GIT_PIN_INVALID',
        ),
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('source archives and fixed bundled binaries fail closed on byte drift', () => {
  const fixture = makeFixture();
  try {
    const sourceBytes = Buffer.from('fixture immutable archive\n');
    const generated = generatedBundleComponent(fixture);
    generated.source.sha256 = createHash('sha256')
      .update(sourceBytes)
      .digest('hex');
    generated.noticeEvidence.sourceArchiveInspectedSha256 =
      generated.source.sha256;
    assert.equal(
      verifyBundledComponentSourceBytes({
        bytes: sourceBytes,
        component: generated,
      }).sha256,
      generated.source.sha256,
    );
    assert.throws(
      () =>
        verifyBundledComponentSourceBytes({
          bytes: Buffer.from('changed archive\n'),
          component: generated,
        }),
      /source archive hash mismatch/,
    );

    const embeddedPackageBytes = Buffer.from('fixture embedded npm tgz\n');
    const embeddedDependency = generated.embeddedDependencies[0];
    embeddedDependency.packageSource.sha256 = createHash('sha256')
      .update(embeddedPackageBytes)
      .digest('hex');
    embeddedDependency.packageSource.integrity = `sha512-${createHash('sha512')
      .update(embeddedPackageBytes)
      .digest('base64')}`;
    assert.equal(
      verifyBundledEmbeddedDependencySourceBytes({
        bytes: embeddedPackageBytes,
        componentId: generated.id,
        dependency: embeddedDependency,
      }).sha256,
      embeddedDependency.packageSource.sha256,
    );
    assert.throws(
      () =>
        verifyBundledEmbeddedDependencySourceBytes({
          bytes: Buffer.from('changed embedded npm tgz\n'),
          componentId: generated.id,
          dependency: embeddedDependency,
        }),
      /embedded package source drift/,
    );

    const artifactBytes = Buffer.from('fixture runtime dll\n');
    const artifact = {
      location: 'application',
      path: 'runtime.dll',
      archivePath: 'vc_redist/x64/runtime.dll',
      role: 'runtime-library',
      bytes: artifactBytes.length,
      sha256: createHash('sha256').update(artifactBytes).digest('hex'),
    };
    const fixed = fixedBinaryComponent(fixture, [artifact]);
    const nupkgBytes = Buffer.from('fixture nupkg bytes\n');
    fixed.source.sha256 = createHash('sha256').update(nupkgBytes).digest('hex');
    fixed.source.nugetSha512 = createHash('sha512')
      .update(nupkgBytes)
      .digest('base64');
    assert.equal(
      verifyBundledComponentSourceBytes({
        bytes: nupkgBytes,
        component: fixed,
      }).sha512,
      fixed.source.nugetSha512,
    );
    fixed.source.nugetSha512 = Buffer.alloc(64, 9).toString('base64');
    assert.throws(
      () =>
        verifyBundledComponentSourceBytes({
          bytes: nupkgBytes,
          component: fixed,
        }),
      /NuGet catalog SHA-512 mismatch/,
    );
    assert.equal(
      verifyBundledComponentFixedArtifactBytes({
        artifact,
        bytes: artifactBytes,
        component: fixed,
      }).sha256,
      artifact.sha256,
    );
    assert.throws(
      () =>
        verifyBundledComponentFixedArtifactBytes({
          artifact,
          bytes: Buffer.from('changed runtime dll\n'),
          component: fixed,
        }),
      /fixed artifact drift/,
    );
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

test('final SBOM verifies generated vscode-eslint provenance and bundle bytes', async () => {
  const fixture = makeFixture();
  try {
    const component = generatedBundleComponent(fixture);
    writeBundledComponents(fixture, [component]);
    prepareReleaseAttributionBundle({
      appDirectory: fixture.appDirectory,
      arch: 'x64',
      outputDirectory: fixture.outputDirectory,
      platform: 'linux',
      releaseChannel: 'release',
      repositoryDirectory: fixture.root,
    });
    const applicationDirectory = path.join(fixture.root, 'packaged-eslint-app');
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
    const bundleDirectory = writeGeneratedBundle(resourcesDirectory, component);

    const packagedRegistry = loadBundledComponentRegistry({
      arch: 'x64',
      platform: 'linux',
      registryPath: path.join(
        packagedAttributionDirectory,
        'provenance/BUNDLED_COMPONENTS.json',
      ),
      strict: true,
    });
    const inspectedBundle = inspectBundledComponentArtifacts({
      applicationDirectory,
      component: packagedRegistry.applicableComponents[0],
      resourcesDirectory,
    });
    assert.equal(inspectedBundle.files.length, 4);

    const attribution = inspectPackagedAttribution({
      attributionDirectory: packagedAttributionDirectory,
    });
    const sbomPath = path.join(fixture.root, 'validation/eslint.cdx.json');
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
    assert.equal(report.bundledComponentCount, 1);
    assert.equal(report.bundledArtifactCount, 4);
    assert.equal(report.bundledEmbeddedDependencyCount, 1);
    assert.ok(
      sbom.components.some(
        (entry) =>
          entry.name === 'fixture-eslint' && entry.version === '3.0.10',
      ),
    );
    assert.ok(
      sbom.components.some(
        (entry) =>
          entry.name === 'fixture-bundle-dep' &&
          entry.version === '1.2.3' &&
          entry.purl === 'pkg:npm/fixture-bundle-dep@1.2.3',
      ),
    );
    assert.ok(sbom.dependencies.some((entry) => entry.dependsOn.length === 1));
    assert.ok(
      sbom.components.some(
        (entry) =>
          entry.name === 'eslintServer.cjs' &&
          entry.hashes?.[0]?.alg === 'SHA-256',
      ),
    );

    const provenancePath = path.join(bundleDirectory, 'provenance.json');
    const originalProvenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
    writeJson(provenancePath, {
      ...originalProvenance,
      embeddedDependencies: [],
    });
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
      /generated provenance manifest does not match/,
    );
    writeJson(provenancePath, originalProvenance);

    rmSync(path.join(bundleDirectory, 'eslintServer.cjs'));
    writeJson(provenancePath, {
      ...originalProvenance,
      artifacts: originalProvenance.artifacts.filter(
        (entry) => entry.path !== 'eslintServer.cjs',
      ),
    });
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
      /generated file set does not match/,
    );

    writeText(
      path.join(bundleDirectory, 'eslintServer.cjs'),
      'fixture bundled server\n',
    );
    writeJson(provenancePath, originalProvenance);
    writeText(path.join(bundleDirectory, 'eslintServer.cjs'), 'tampered\n');
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
      /generated artifact drift/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('final Windows SBOM verifies every pinned VCRuntime DLL', async () => {
  const fixture = makeFixture();
  try {
    const binaryDefinitions = [
      ['vcruntime140.dll', 'fixture vcruntime140\n'],
      ['vcruntime140_1.dll', 'fixture vcruntime140_1\n'],
      ['msvcp140.dll', 'fixture msvcp140\n'],
      ['msvcp140_1.dll', 'fixture msvcp140_1\n'],
      ['msvcp140_2.dll', 'fixture msvcp140_2\n'],
    ];
    const scratchDirectory = path.join(fixture.root, 'binary-source');
    const files = binaryDefinitions.map(([fileName, content]) => {
      const sourcePath = path.join(scratchDirectory, fileName);
      writeText(sourcePath, content);
      return {
        location: 'application',
        path: fileName,
        archivePath: `vc_redist/x64/${fileName}`,
        role: 'runtime-library',
        bytes: statSync(sourcePath).size,
        sha256: sha256FileSync(sourcePath),
      };
    });
    const component = fixedBinaryComponent(fixture, files);
    writeBundledComponents(fixture, [component]);
    prepareReleaseAttributionBundle({
      appDirectory: fixture.appDirectory,
      arch: 'x64',
      outputDirectory: fixture.outputDirectory,
      platform: 'windows',
      releaseChannel: 'release',
      repositoryDirectory: fixture.root,
    });
    const applicationDirectory = path.join(
      fixture.root,
      'packaged-windows-app',
    );
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
    for (const [fileName] of binaryDefinitions) {
      cpSync(
        path.join(scratchDirectory, fileName),
        path.join(applicationDirectory, fileName),
      );
    }

    const attribution = inspectPackagedAttribution({
      attributionDirectory: packagedAttributionDirectory,
    });
    const sbomPath = path.join(fixture.root, 'validation/windows.cdx.json');
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
      platform: 'windows',
      resourcesDirectory,
      timestamp: new Date('2026-07-15T00:00:00.000Z'),
    });
    const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
    assert.equal(report.bundledComponentCount, 1);
    assert.equal(report.bundledArtifactCount, 5);
    assert.equal(
      sbom.components.filter((entry) =>
        binaryDefinitions.some(([fileName]) => entry.name === fileName),
      ).length,
      5,
    );

    const unexpectedDllPath = path.join(
      applicationDirectory,
      'MSVCP140_ATOMIC_WAIT.DLL',
    );
    writeText(unexpectedDllPath, 'unreviewed extra runtime\n');
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
        platform: 'windows',
        resourcesDirectory,
      }),
      /unreviewed matching packaged artifacts/,
    );
    rmSync(unexpectedDllPath);

    writeText(path.join(applicationDirectory, 'msvcp140.dll'), 'tampered\n');
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
        platform: 'windows',
        resourcesDirectory,
      }),
      /packaged artifact drift/,
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

test('repository bundled-component registry pins exact upstream archives and DLLs', () => {
  const attributes = readFileSync(
    path.join(repositoryDirectory, '.gitattributes'),
    'utf8',
  );
  assert.match(
    attributes,
    /^docs\/provenance\/bundled-component-evidence\/\*\* -text whitespace=-blank-at-eol,-blank-at-eof,cr-at-eol$/mu,
  );
  assert.match(
    attributes,
    /^docs\/provenance\/bundled-component-license-texts\/\*\* -text whitespace=-blank-at-eol,-blank-at-eof,cr-at-eol$/mu,
  );
  const registry = loadBundledComponentRegistry({
    registryPath: path.join(
      repositoryDirectory,
      'docs/provenance/BUNDLED_COMPONENTS.json',
    ),
    strict: true,
  });
  assert.equal(registry.entryCount, 2);
  const eslint = registry.components.find(
    (component) => component.id === 'vscode-eslint-server',
  );
  assert.equal(eslint.version, '3.0.10');
  assert.equal(
    eslint.source.immutableRevision,
    '790646388696511b2665a4d119bf0fb713dd990d',
  );
  assert.equal(
    eslint.source.sha256,
    '24ebbef9ee5c716d4653c193bca00192b19787cc7152c3d61a474a10920d6239',
  );
  assert.equal(eslint.embeddedDependencies.length, 9);
  assert.equal(
    eslint.embeddedDependencies.filter(
      (dependency) => dependency.bundleScope === 'embedded',
    ).length,
    7,
  );
  assert.deepEqual(
    eslint.embeddedDependencies
      .filter((dependency) => dependency.bundleScope === 'production-lock-only')
      .map((dependency) => dependency.name)
      .sort(),
    ['lru-cache', 'yallist'],
  );
  assert.equal(
    eslint.embeddedDependencyLock.sha256,
    '7b242318057e0d9d55df95fce3c8679ca2506cf363b19c3c2f7ea7dd2455eb66',
  );

  const vcRuntime = registry.components.find(
    (component) => component.id === 'vcruntime-cefsharp-140',
  );
  assert.equal(
    vcRuntime.source.sha256,
    '063bbdc41bab3911677feac7a6373ba9d60e0b497b994cfc947bc3735359d2c0',
  );
  assert.equal(vcRuntime.redistributionReview.legalConclusion, false);
  assert.equal(
    vcRuntime.redistributionReview.status,
    'CONDITIONAL_UPSTREAM_TERMS',
  );
  assert.deepEqual(
    vcRuntime.packagedArtifacts.files.map((entry) => [
      entry.path,
      entry.sha256,
    ]),
    [
      [
        'vcruntime140.dll',
        'e686dd4fbd9d2117d74ad817f4f1c4be82b129760b5608facc770b12c3796fce',
      ],
      [
        'vcruntime140_1.dll',
        'bc6e137696ce75be00733cdb5210de363b4addf62c6a3608abe0331efc7dc395',
      ],
      [
        'msvcp140.dll',
        '9a72d0c7f0e8df99b32a15f89ff8ed6ae6dc0b6615b7d9fd53605ec98a888b61',
      ],
      [
        'msvcp140_1.dll',
        '79d00d3497fd6c0b84129b914d044cd447b6b9d09a768134a6c6ce86f129eaab',
      ],
      [
        'msvcp140_2.dll',
        'a9afa030ce3b1f86e50a52534e319d03000a15d9bcf40135ac1c2a3803088711',
      ],
    ],
  );
});

test('vscode-eslint bundling rebuilds from verified bytes instead of trusting local provenance', () => {
  const bundleSource = readFileSync(
    path.join(browserDirectory, 'scripts/bundle-eslint-server.ts'),
    'utf8',
  );
  const extractorSource = readFileSync(
    path.join(browserDirectory, 'scripts/safe-zip-extractor.mjs'),
    'utf8',
  );
  const browserIgnore = readFileSync(
    path.join(browserDirectory, '.gitignore'),
    'utf8',
  );
  assert.match(bundleSource, /fs\.mkdtemp/u);
  assert.match(bundleSource, /extractVerifiedZipArchive\(\{/u);
  assert.match(bundleSource, /buildNpmCliInvocation/u);
  assert.doesNotMatch(bundleSource, /npm\.cmd/u);
  assert.match(bundleSource, /verifyBundledModuleCoverage/u);
  assert.doesNotMatch(
    bundleSource,
    /Reviewed ESLint server bundle already exists/u,
  );
  assert.doesNotMatch(bundleSource, /assertExistingBundleIsReviewed/u);
  assert.match(extractorSource, /yauzl\.fromBuffer/u);
  assert.match(extractorSource, /strictFileNames:\s*true/u);
  assert.match(extractorSource, /validateEntrySizes:\s*true/u);
  assert.match(browserIgnore, /^\.eslint-server-work\/$/mu);
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
  assert.equal(inventory.bundledComponents.status, 'ENGINEERING_REVIEWED');
  assert.equal(inventory.bundledComponents.entryCount, 2);
  assert.ok(inventory.bundledComponents.applicableCount >= 1);
  assert.equal(
    inventory.bundledComponents.applicableEmbeddedDependencyCount,
    7,
  );
  assert.equal(
    inventory.bundledComponents.applicableProductionLockDependencyCount,
    9,
  );
  assert.equal(inventory.licenseOverrides.status, 'ENGINEERING_REVIEWED');
  assert.equal(inventory.licenseOverrides.entryCount, 55);
  assert.ok(inventory.licenseOverrides.appliedCount >= 40);
  assert.equal(
    overrideRegistry.entries.find(
      (entry) =>
        entry.package === 'html-parse-stringify' && entry.version === '3.0.1',
    )?.packageSource.integrity,
    'sha512-KknJ50kTInJ7qIScF3jeaFRpMpE8/lfiTdzf/twXyPBLAGrLRTmkz3AdTnKeh40X8k9L2fdYwEp/42WGXIRGcg==',
  );
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

test('the repository has no obvious Nucleo package, import, asset, or license-key release path', () => {
  const forbidden = [];
  const containsNucleoReleaseSignal = (source) =>
    /NUCLEO_LICENSE_KEY/iu.test(source) ||
    /(?:from\s*|import\s+|import\s*\(|require(?:\.resolve)?\s*\()\s*(?:['"](?:@nucleo(?:\/[^'"]*)?|nucleo-[^'"]*)['"]|`(?:@nucleo(?:\/[^`]*)?|nucleo-[^`]*)`)/iu.test(
      source,
    ) ||
    /['"](?:@nucleo\/|nucleo-)[^'"]*['"]\s*:/iu.test(source) ||
    /['"`][^'"`\r\n]*nucleo[^'"`\r\n]*\.(?:avif|gif|ico|jpeg|jpg|png|svg|webp)(?:\?[^'"`\r\n]*)?['"`]/iu.test(
      source,
    );
  for (const signal of [
    "import '@nucleo/icons';",
    'await import(`nucleo-icons`);',
    "require.resolve('@nucleo/icons');",
    'process.env.nucleo_license_key',
    'const assets = { "nucleo-icons": "1.0.0" };',
    "const icon = 'assets/nucleo/branch.svg';",
  ]) {
    assert.equal(containsNucleoReleaseSignal(signal), true, signal);
  }
  assert.equal(containsNucleoReleaseSignal("import '@clodex/icons';"), false);
  const roots = ['apps', 'packages', 'agent'].map((entry) =>
    path.join(repositoryDirectory, entry),
  );
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.name.toLowerCase().includes('nucleo'))
        forbidden.push(entryPath);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        visit(entryPath);
      } else if (
        entry.isFile() &&
        !entry.name.includes('.test.') &&
        [
          '.cjs',
          '.css',
          '.html',
          '.js',
          '.json',
          '.jsx',
          '.mjs',
          '.mts',
          '.scss',
          '.svg',
          '.ts',
          '.tsx',
          '.yaml',
          '.yml',
        ].includes(path.extname(entry.name))
      ) {
        const source = readFileSync(entryPath, 'utf8');
        if (containsNucleoReleaseSignal(source)) {
          forbidden.push(entryPath);
        }
      }
    }
  };
  for (const root of roots) visit(root);
  for (const policyPath of [
    path.join(repositoryDirectory, 'package.json'),
    path.join(repositoryDirectory, 'pnpm-lock.yaml'),
    path.join(repositoryDirectory, 'pnpm-workspace.yaml'),
  ]) {
    const source = readFileSync(policyPath, 'utf8');
    if (
      containsNucleoReleaseSignal(source) ||
      /(?:^|\n)\s*(?:['"]?(?:@nucleo\/|nucleo-)[^:\s'"]+['"]?\s*:|(?:@nucleo\/|nucleo-)[^:\s]+:)/u.test(
        source,
      )
    ) {
      forbidden.push(policyPath);
    }
  }
  const workflowDirectory = path.join(repositoryDirectory, '.github/workflows');
  for (const entry of readdirSync(workflowDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const workflowPath = path.join(workflowDirectory, entry.name);
    if (containsNucleoReleaseSignal(readFileSync(workflowPath, 'utf8'))) {
      forbidden.push(workflowPath);
    }
  }
  assert.deepEqual(forbidden, []);
});

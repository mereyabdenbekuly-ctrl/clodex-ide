import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createPackageWithOptions,
  extractFile,
  listPackage,
  statFile,
} from '@electron/asar';
import {
  COMMUNITY_OBSERVED_RENDERER_POSTHOG_NOOP,
  COMMUNITY_OBSERVED_TELEMETRY_ARTIFACT_ASSERTION,
  COMMUNITY_OBSERVED_TELEMETRY_CONTRACT,
  inspectCommunityObservedTelemetryAsar,
  normalizeCommunityObservedArchivePath,
  resolveCommunityObservedArchiveEntryPaths,
} from './community-observed-telemetry-validator.mjs';

const TEST_PROJECT_KEY = [
  'phc',
  'community_observed_artifact_test_only_000000',
].join('_');

async function makeFixture(options = {}) {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'clodex-community-observed-asar-'),
  );
  const source = path.join(root, 'source');
  const backend = path.join(source, '.vite', 'build');
  const renderer = path.join(
    source,
    '.vite',
    'renderer',
    'main_window',
    'assets',
  );
  mkdirSync(backend, { recursive: true });
  mkdirSync(renderer, { recursive: true });
  const semverTarget = path.join(
    source,
    'node_modules',
    'semver',
    'bin',
    'semver.js',
  );
  const sharpBinDirectory = path.join(
    source,
    'node_modules',
    'sharp',
    'node_modules',
    '.bin',
  );
  mkdirSync(path.dirname(semverTarget), { recursive: true });
  mkdirSync(sharpBinDirectory, { recursive: true });
  writeFileSync(semverTarget, 'export const semver = true;\n');
  symlinkSync(
    path.relative(sharpBinDirectory, semverTarget),
    path.join(sharpBinDirectory, 'semver.js'),
  );
  writeFileSync(path.join(backend, 'main.js'), 'import "./telemetry.js";\n');
  writeFileSync(
    path.join(backend, 'telemetry.js'),
    [
      `const key = ${JSON.stringify(
        options.adjacentBackendProjectKeys
          ? `${TEST_PROJECT_KEY}${TEST_PROJECT_KEY}`
          : TEST_PROJECT_KEY,
      )};`,
      options.duplicateBackendProjectKey
        ? `const duplicateKey = ${JSON.stringify(TEST_PROJECT_KEY)};`
        : '',
      `const contract = ${JSON.stringify(COMMUNITY_OBSERVED_TELEMETRY_CONTRACT)};`,
      `const assertion = ${JSON.stringify(
        options.invalidContract
          ? COMMUNITY_OBSERVED_TELEMETRY_ARTIFACT_ASSERTION.replace(
              '"privacyMode":true',
              '"privacyMode":false',
            )
          : COMMUNITY_OBSERVED_TELEMETRY_ARTIFACT_ASSERTION,
      )};`,
      options.omitPrivacyMarkers
        ? 'const options = {};'
        : 'const options = { privacyMode: true, disableGeoip: true, disableRemoteConfig: true, enableExceptionAutocapture: false };',
      options.backendNonStaticRequire
        ? 'const runtimeModuleName = "pdf-runtime"; require(runtimeModuleName);'
        : '',
      'export { key, contract, assertion, options };',
    ].join('\n'),
  );
  const rendererImports = [];
  if (options.rendererOutsideImport) {
    const target = path.join(source, 'node_modules', 'renderer-outside.js');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'posthog.init("", { autocapture: true });\n');
    let relativeTarget = path
      .relative(renderer, target)
      .split(path.sep)
      .join('/');
    if (!relativeTarget.startsWith('.')) relativeTarget = `./${relativeTarget}`;
    rendererImports.push(`import ${JSON.stringify(relativeTarget)};`);
  }
  if (options.rendererUnpackedExternalImport) {
    rendererImports.push(
      'import "../../../../../app.asar.unpacked/native/evil.js";',
    );
  }
  if (options.rendererNoWhitespaceImport) {
    rendererImports.push(
      'import"../../../../../app.asar.unpacked/native/evil.js";',
    );
  }
  if (options.rendererExtensionlessEscape) {
    rendererImports.push('import "../../../../resources/evil";');
  }
  if (options.rendererWindowsEscape) {
    rendererImports.push(
      String.raw`import "..\\..\\..\\..\\resources\\evil.js";`,
    );
  }
  if (options.rendererQueryEscape) {
    rendererImports.push('import "../../../../resources/evil.js?cache=1";');
  }
  if (options.rendererTemplateEscape) {
    rendererImports.push('import(`../../../../resources/evil.js`);');
  }
  if (options.rendererTemplateExpressionEscape) {
    rendererImports.push(
      `import(\`../../../../../app.asar.unpacked/native/\${"evil"}.js\`);`,
    );
  }
  if (options.rendererPercentEncodedEscape) {
    rendererImports.push(
      'import("./%2e%2e/%2E%2E/%2e%2e/%2E%2e/resources/evil.js");',
    );
  }
  if (options.rendererModuleRequireEscape) {
    rendererImports.push('module.require("../../../../resources/evil.js");');
  }
  if (options.rendererModuleBracketRequireEscape) {
    rendererImports.push('module["require"]("../../../../resources/evil.js");');
  }
  if (options.rendererNonStaticImport) {
    rendererImports.push(
      'const runtimeModulePath = "./runtime.js"; import(runtimeModulePath);',
    );
  }
  if (options.uppercaseRendererCode) {
    writeFileSync(
      path.join(renderer, 'active.JS'),
      `${JSON.stringify(COMMUNITY_OBSERVED_RENDERER_POSTHOG_NOOP)}; posthog.init("", { autocapture: true });\n`,
    );
  }
  writeFileSync(
    path.join(renderer, 'app.js'),
    [
      ...rendererImports,
      options.unpackedRendererCode ? 'import "./evil.js";' : '',
      options.rendererSymlink ? 'import "./linked.js";' : '',
      options.uppercaseRendererCode ? 'import "./active.JS";' : '',
      options.benignRelativeString
        ? 'const assetPath = "../../../../resources/evil.js";'
        : '',
      options.rendererProjectKey
        ? `const forbidden = ${JSON.stringify(TEST_PROJECT_KEY)};`
        : options.activeRendererBracketPostHog
          ? `${JSON.stringify(COMMUNITY_OBSERVED_RENDERER_POSTHOG_NOOP)}; posthog["init"]("", { ["autocapture"]: true });`
          : options.activeRendererOptionalPostHog
            ? `${JSON.stringify(COMMUNITY_OBSERVED_RENDERER_POSTHOG_NOOP)}; posthog?.init("", { autocapture: false });`
            : options.activeRendererAliasPostHog
              ? `${JSON.stringify(COMMUNITY_OBSERVED_RENDERER_POSTHOG_NOOP)}; const cfg = { "autocapture": true }; const init = posthog.init; init("", cfg);`
              : options.activeRendererPostHog
                ? `${JSON.stringify(COMMUNITY_OBSERVED_RENDERER_POSTHOG_NOOP)}; posthog.init('', { autocapture: true });`
                : `const rendererTelemetry = ${JSON.stringify(
                    COMMUNITY_OBSERVED_RENDERER_POSTHOG_NOOP,
                  )};`,
    ].join('\n'),
  );
  let rendererHtmlScript = '<script type="module" src="./app.js"></script>';
  if (options.htmlDataSrcEscape) {
    rendererHtmlScript =
      '<script data-src="./app.js" src="../../../../resources/evil.js" type="module"></script>';
  } else if (options.htmlDataTypeEscape) {
    rendererHtmlScript =
      '<script data-type="application/json" type="module" src="../../../../resources/evil.js"></script>';
  } else if (options.htmlEntityEscape) {
    rendererHtmlScript =
      '<script type="module" src="..&#47;..&#47;..&#47;..&#47;resources&#47;evil.js"></script>';
  } else if (options.htmlWhitespaceEscape) {
    rendererHtmlScript =
      '<script type="module" src="   ../../../../resources/evil.js"></script>';
  } else if (options.htmlTrimmedModuleEscape) {
    rendererHtmlScript =
      '<script type=" module " src="../../../../resources/evil.js"></script>';
  } else if (options.htmlMimeParameterEscape) {
    rendererHtmlScript =
      '<script type="text/javascript;charset=utf-8" src="../../../../resources/evil.js"></script>';
  } else if (options.htmlMainWindowAbsoluteScript) {
    rendererHtmlScript = '<script type="module" src="/assets/app.js"></script>';
  }
  writeFileSync(
    path.join(renderer, 'index.html'),
    `<!doctype html><html><body>${rendererHtmlScript}</body></html>`,
  );
  if (
    options.pagesAbsoluteScript ||
    options.pagesAbsoluteTraversal ||
    options.pagesDriveQualifiedScript
  ) {
    const pagesDirectory = path.join(source, '.vite', 'renderer', 'pages');
    const pagesAssets = path.join(pagesDirectory, 'assets');
    mkdirSync(pagesAssets, { recursive: true });
    writeFileSync(
      path.join(pagesAssets, 'index.js'),
      'export const pages = true;\n',
    );
    const pagesSource = options.pagesAbsoluteTraversal
      ? '/../../resources/evil.js'
      : options.pagesDriveQualifiedScript
        ? options.pagesDriveQualifiedScript
        : '/assets/index.js';
    writeFileSync(
      path.join(pagesDirectory, 'index.html'),
      `<!doctype html><html><body><script type="module" src="${pagesSource}"></script></body></html>`,
    );
  }
  if (options.nonJavascriptProjectKey) {
    writeFileSync(
      path.join(renderer, 'telemetry-config.json'),
      JSON.stringify({ key: TEST_PROJECT_KEY }),
    );
  }
  if (options.outsideViteProjectKey || options.benignProjectKeyPattern) {
    const resources = path.join(source, 'resources');
    mkdirSync(resources, { recursive: true });
    if (options.outsideViteProjectKey) {
      writeFileSync(path.join(resources, 'telemetry.bin'), TEST_PROJECT_KEY);
    }
    if (options.benignProjectKeyPattern) {
      writeFileSync(
        path.join(resources, 'posthog-pattern.txt'),
        'validator pattern: phc_[A-Za-z0-9_-]{20,}\n',
      );
    }
  }
  if (options.rendererSymlink) {
    const target = path.join(source, 'node_modules', 'renderer-link-target.js');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'export const linked = true;\n');
    symlinkSync(
      path.relative(renderer, target),
      path.join(renderer, 'linked.js'),
    );
  }
  if (options.aliasIntoVite) {
    const aliasDirectory = path.join(
      source,
      'node_modules',
      'telemetry-alias',
      '.bin',
    );
    mkdirSync(aliasDirectory, { recursive: true });
    symlinkSync(
      path.relative(aliasDirectory, path.join(backend, 'telemetry.js')),
      path.join(aliasDirectory, 'backend.js'),
    );
  }
  if (options.unpackedRendererCode) {
    writeFileSync(
      path.join(renderer, 'evil.js'),
      'posthog.init("", { autocapture: true });\n',
    );
  }
  const asarPath = path.join(root, 'app.asar');
  await createPackageWithOptions(
    source,
    asarPath,
    options.unpackedRendererCode ? { unpack: 'evil.js' } : {},
  );
  if (options.unpackedProjectKey) {
    const unpacked = path.join(`${asarPath}.unpacked`, 'native');
    mkdirSync(unpacked, { recursive: true });
    writeFileSync(path.join(unpacked, 'telemetry.bin'), TEST_PROJECT_KEY);
  }
  if (options.unpackedSymlink) {
    const unpacked = path.join(`${asarPath}.unpacked`, 'native');
    mkdirSync(unpacked, { recursive: true });
    writeFileSync(path.join(unpacked, 'target.bin'), 'safe\n');
    symlinkSync('target.bin', path.join(unpacked, 'linked.bin'));
  }
  if (
    options.rendererUnpackedExternalImport ||
    options.rendererNoWhitespaceImport ||
    options.rendererTemplateExpressionEscape
  ) {
    const unpacked = path.join(`${asarPath}.unpacked`, 'native');
    mkdirSync(unpacked, { recursive: true });
    writeFileSync(
      path.join(unpacked, 'evil.js'),
      'posthog.init("", { autocapture: true });\n',
    );
  }
  return { asarPath, root };
}

test('validates a single backend-only observed PostHog project key', async () => {
  const fixture = await makeFixture();
  try {
    const evidence = inspectCommunityObservedTelemetryAsar(fixture.asarPath);
    assert.equal(evidence.status, 'validated');
    assert.equal(evidence.transport, 'posthog-node-backend');
    assert.equal(evidence.allowedTelemetryLevel, 'anonymous');
    assert.equal(evidence.renderer.projectKeyEmbedded, false);
    assert.equal(evidence.exceptions, 'disabled');
    assert.equal(evidence.modelTracing, 'disabled');
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('keeps POSIX comparison paths separate from native Windows lookup paths', () => {
  const listedPath = path.win32.join(
    path.win32.sep,
    '.vite',
    'build',
    'main.js',
  );
  const entry = resolveCommunityObservedArchiveEntryPaths(
    listedPath,
    path.win32,
  );
  assert.equal(entry.comparisonPath, '.vite/build/main.js');
  assert.equal(entry.lookupPath, '.vite\\build\\main.js');
  assert.equal(path.win32.dirname(entry.lookupPath), '.vite\\build');
  assert.equal(
    normalizeCommunityObservedArchivePath('\\.vite\\build\\main.js'),
    '.vite/build/main.js',
  );
});

test('uses native lookup paths with real ASAR stat and extract operations', async () => {
  const fixture = await makeFixture();
  try {
    const listedEntries = listPackage(fixture.asarPath);
    const mainListedPath = listedEntries.find(
      (entry) =>
        normalizeCommunityObservedArchivePath(entry) === '.vite/build/main.js',
    );
    assert.ok(mainListedPath);
    const mainEntry = resolveCommunityObservedArchiveEntryPaths(
      mainListedPath,
      path,
    );
    assert.ok(statFile(fixture.asarPath, mainEntry.lookupPath, false).size > 0);
    assert.match(
      extractFile(fixture.asarPath, mainEntry.lookupPath, false).toString(
        'utf8',
      ),
      /telemetry\.js/,
    );
    assert.ok(
      listedEntries.some((entry) =>
        normalizeCommunityObservedArchivePath(entry).endsWith(
          'node_modules/sharp/node_modules/.bin/semver.js',
        ),
      ),
    );
    assert.equal(
      inspectCommunityObservedTelemetryAsar(fixture.asarPath).status,
      'validated',
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('keeps broken absolute dependency .bin links no-follow', async () => {
  const fixture = await makeFixture();
  const asarApi = {
    listPackage,
    statFile(asarPath, lookupPath, followLinks) {
      const metadata = statFile(asarPath, lookupPath, followLinks);
      return normalizeCommunityObservedArchivePath(lookupPath).endsWith(
        'node_modules/sharp/node_modules/.bin/semver.js',
      )
        ? {
            link: 'node_modules/sharp/node_modules/.bin/home/runner/work/clodex-ide/clodex-ide/node_modules/sharp/node_modules/semver/bin/semver.js',
          }
        : metadata;
    },
    extractFile,
  };
  try {
    assert.equal(
      inspectCommunityObservedTelemetryAsar(fixture.asarPath, { asarApi })
        .status,
      'validated',
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects missing dependency .bin links whose source touches .vite', async () => {
  const fixture = await makeFixture();
  const listedLink = '/node_modules/pkg/.vite/node_modules/x/.bin/nested-tool';
  const asarApi = {
    listPackage(asarPath) {
      return [...listPackage(asarPath), listedLink];
    },
    statFile(asarPath, lookupPath, followLinks) {
      if (
        normalizeCommunityObservedArchivePath(lookupPath) ===
        normalizeCommunityObservedArchivePath(listedLink)
      ) {
        return { link: 'node_modules/missing/tool.js' };
      }
      return statFile(asarPath, lookupPath, followLinks);
    },
    extractFile,
  };
  try {
    assert.throws(
      () =>
        inspectCommunityObservedTelemetryAsar(fixture.asarPath, { asarApi }),
      /protected ASAR entry must not be a symlink: node_modules\/pkg\/\.vite\//,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('uses win32 lookup paths throughout ASAR inspection', async () => {
  const fixture = await makeFixture();
  const nativeLookups = [];
  const toWindowsPath = (value) =>
    path.win32.join(
      path.win32.sep,
      ...normalizeCommunityObservedArchivePath(value).split('/'),
    );
  const toPosixLookup = (value) => value.replaceAll('\\', '/');
  const asarApi = {
    listPackage(asarPath) {
      return listPackage(asarPath).map(toWindowsPath);
    },
    statFile(asarPath, lookupPath, followLinks) {
      assert.equal(followLinks, false);
      assert.equal(lookupPath.includes('/'), false);
      nativeLookups.push(lookupPath);
      const metadata = statFile(
        asarPath,
        toPosixLookup(lookupPath),
        followLinks,
      );
      return 'link' in metadata
        ? { ...metadata, link: metadata.link.replaceAll('/', '\\') }
        : metadata;
    },
    extractFile(asarPath, lookupPath, followLinks) {
      assert.equal(followLinks, false);
      assert.equal(lookupPath.includes('/'), false);
      nativeLookups.push(lookupPath);
      return extractFile(asarPath, toPosixLookup(lookupPath), followLinks);
    },
  };
  try {
    assert.equal(
      inspectCommunityObservedTelemetryAsar(fixture.asarPath, {
        archivePathApi: path.win32,
        asarApi,
      }).status,
      'validated',
    );
    assert.ok(nativeLookups.some((lookup) => lookup.includes('\\')));
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects a project key embedded in renderer assets', async () => {
  const fixture = await makeFixture({ rendererProjectKey: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /escaped the backend entry graph/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects a project key embedded in non-JavaScript ASAR assets', async () => {
  const fixture = await makeFixture({ nonJavascriptProjectKey: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /escaped the backend entry graph/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects a project key embedded outside .vite', async () => {
  const fixture = await makeFixture({ outsideViteProjectKey: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /escaped the backend entry graph: resources\/telemetry\.bin/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('allows a benign project-key regex marker without a concrete key', async () => {
  const fixture = await makeFixture({ benignProjectKeyPattern: true });
  try {
    assert.equal(
      inspectCommunityObservedTelemetryAsar(fixture.asarPath).status,
      'validated',
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects duplicate occurrences of the backend project key', async () => {
  const fixture = await makeFixture({ duplicateBackendProjectKey: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /must embed exactly one PostHog project key; found 2/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('counts adjacent concrete project-key prefixes independently', async () => {
  const fixture = await makeFixture({ adjacentBackendProjectKeys: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /must embed exactly one PostHog project key; found 2/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects a symlink inside the renderer namespace', async () => {
  const fixture = await makeFixture({ rendererSymlink: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /protected ASAR entry must not be a symlink: \.vite\/renderer/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects an outside ASAR symlink that resolves into .vite', async () => {
  const fixture = await makeFixture({ aliasIntoVite: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /protected ASAR entry must not be a symlink: node_modules\/telemetry-alias\/\.bin\/backend\.js -> \.vite\/build\/telemetry\.js/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects unpacked executable renderer code', async () => {
  const fixture = await makeFixture({ unpackedRendererCode: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /protected ASAR entry must remain packed: \.vite\/renderer\/.*\/evil\.js/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects non-boolean unpacked ASAR metadata', async () => {
  const fixture = await makeFixture();
  const asarApi = {
    listPackage,
    statFile(asarPath, lookupPath, followLinks) {
      const metadata = statFile(asarPath, lookupPath, followLinks);
      return normalizeCommunityObservedArchivePath(lookupPath).endsWith(
        '.vite/renderer/main_window/assets/app.js',
      )
        ? { ...metadata, unpacked: 1 }
        : metadata;
    },
    extractFile,
  };
  try {
    assert.throws(
      () =>
        inspectCommunityObservedTelemetryAsar(fixture.asarPath, { asarApi }),
      /non-boolean unpacked metadata: \.vite\/renderer\/main_window\/assets\/app\.js/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects renderer imports that escape the protected namespace', async () => {
  const fixture = await makeFixture({ rendererOutsideImport: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /renderer relative import escapes \.vite\/renderer/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('allows non-static backend module loading under the trusted-source threat model', async () => {
  const fixture = await makeFixture({ backendNonStaticRequire: true });
  try {
    assert.equal(
      inspectCommunityObservedTelemetryAsar(fixture.asarPath).status,
      'validated',
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects non-static renderer module loading', async () => {
  const fixture = await makeFixture({ rendererNonStaticImport: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /protected JavaScript has a non-static module specifier: \.vite\/renderer/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects renderer imports into app.asar.unpacked', async () => {
  const fixture = await makeFixture({ rendererUnpackedExternalImport: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /renderer relative import escapes \.vite\/renderer/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects no-whitespace static imports into app.asar.unpacked', async () => {
  const fixture = await makeFixture({ rendererNoWhitespaceImport: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /renderer relative import escapes \.vite\/renderer/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects extensionless renderer import escapes', async () => {
  const fixture = await makeFixture({ rendererExtensionlessEscape: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /renderer relative import escapes \.vite\/renderer/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects Windows-separator renderer import escapes', async () => {
  const fixture = await makeFixture({ rendererWindowsEscape: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /renderer relative import escapes \.vite\/renderer/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects query-bearing renderer import escapes', async () => {
  const fixture = await makeFixture({ rendererQueryEscape: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /renderer relative import escapes \.vite\/renderer/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects template-literal renderer import escapes', async () => {
  const fixture = await makeFixture({ rendererTemplateEscape: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /renderer relative import escapes \.vite\/renderer/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects template-expression imports into app.asar.unpacked', async () => {
  const fixture = await makeFixture({ rendererTemplateExpressionEscape: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /renderer relative import escapes \.vite\/renderer/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects percent-encoded renderer import traversal', async () => {
  const fixture = await makeFixture({ rendererPercentEncodedEscape: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /module specifier must not use percent encoding/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects module.require renderer import escapes', async () => {
  const fixture = await makeFixture({ rendererModuleRequireEscape: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /renderer relative import escapes \.vite\/renderer/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects module bracket-require renderer import escapes', async () => {
  const fixture = await makeFixture({
    rendererModuleBracketRequireEscape: true,
  });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /renderer relative import escapes \.vite\/renderer/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

for (const [label, option, expected] of [
  ['data-src', 'htmlDataSrcEscape', /renderer relative import escapes/],
  ['data-type', 'htmlDataTypeEscape', /renderer relative import escapes/],
  ['HTML entity', 'htmlEntityEscape', /renderer relative import escapes/],
  [
    'leading whitespace',
    'htmlWhitespaceEscape',
    /module specifier has unsafe whitespace or controls/,
  ],
  [
    'trimmed module type',
    'htmlTrimmedModuleEscape',
    /renderer relative import escapes/,
  ],
  [
    'JavaScript MIME parameters',
    'htmlMimeParameterEscape',
    /renderer relative import escapes/,
  ],
]) {
  test(`rejects renderer HTML ${label} script escapes`, async () => {
    const fixture = await makeFixture({ [option]: true });
    try {
      assert.throws(
        () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
        expected,
      );
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
}

test('accepts Vite pages root-absolute script assets within pages namespace', async () => {
  const fixture = await makeFixture({ pagesAbsoluteScript: true });
  try {
    assert.equal(
      inspectCommunityObservedTelemetryAsar(fixture.asarPath).status,
      'validated',
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects root-absolute scripts outside the pages renderer', async () => {
  const fixture = await makeFixture({ htmlMainWindowAbsoluteScript: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /protected HTML script source must be relative/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects Vite pages root-absolute traversal outside pages namespace', async () => {
  const fixture = await makeFixture({ pagesAbsoluteTraversal: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /protected HTML root path escapes \.vite\/renderer\/pages/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

for (const pagesDriveQualifiedScript of [
  '/C:/Windows/System32/evil.js',
  String.raw`/C:\Windows\System32\evil.js`,
]) {
  test(`rejects Vite pages drive-qualified script ${pagesDriveQualifiedScript}`, async () => {
    const fixture = await makeFixture({ pagesDriveQualifiedScript });
    try {
      assert.throws(
        () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
        /protected HTML root path is drive-qualified/,
      );
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
}

test('allows non-import relative strings in protected JavaScript', async () => {
  const fixture = await makeFixture({ benignRelativeString: true });
  try {
    assert.equal(
      inspectCommunityObservedTelemetryAsar(fixture.asarPath).status,
      'validated',
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects active renderer code in uppercase JavaScript assets', async () => {
  const fixture = await makeFixture({ uppercaseRendererCode: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /contains active posthog\.init code|contains active autocapture enabled code/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects bracket-notation renderer PostHog activation', async () => {
  const fixture = await makeFixture({ activeRendererBracketPostHog: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /contains active posthog\.init code|contains active autocapture enabled code/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects optional-chaining renderer PostHog activation', async () => {
  const fixture = await makeFixture({ activeRendererOptionalPostHog: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /contains active posthog\.init code/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects aliased renderer PostHog activation config', async () => {
  const fixture = await makeFixture({ activeRendererAliasPostHog: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /contains active posthog\.init code|contains active autocapture enabled code/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects a project key embedded in app.asar.unpacked', async () => {
  const fixture = await makeFixture({ unpackedProjectKey: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /escaped into app\.asar\.unpacked/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects a symlink in app.asar.unpacked', async () => {
  const fixture = await makeFixture({ unpackedSymlink: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /unpacked resource must not be a symlink/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects a backend with a non-canonical privacy contract', async () => {
  const fixture = await makeFixture({ invalidContract: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /missing the canonical telemetry contract assertion/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects active renderer PostHog init/autocapture even without a key', async () => {
  const fixture = await makeFixture({ activeRendererPostHog: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /contains active posthog\.init code|contains active autocapture enabled code/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

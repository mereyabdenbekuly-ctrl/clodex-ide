import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const websiteDirectory = path.join(repositoryRoot, 'apps', 'website');

function collectWebsiteTextFiles() {
  const excludedDirectories = new Set([
    '.next',
    '.turbo',
    '.vercel',
    'dist',
    'node_modules',
    'out',
  ]);
  const textExtensions = new Set([
    '.cjs',
    '.css',
    '.html',
    '.js',
    '.json',
    '.jsx',
    '.md',
    '.mdx',
    '.mjs',
    '.sh',
    '.svg',
    '.toml',
    '.ts',
    '.tsx',
    '.txt',
    '.yaml',
    '.yml',
  ]);
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) visit(entryPath);
        continue;
      }
      if (
        entry.isFile() &&
        (textExtensions.has(path.extname(entry.name)) ||
          entry.name.startsWith('.env'))
      ) {
        files.push(entryPath);
      }
    }
  };
  visit(websiteDirectory);
  return files;
}

test('website source and config fail closed on every public artifact download', () => {
  const files = collectWebsiteTextFiles();
  assert.ok(files.length > 0, 'website source/config scan found no text files');

  const forbidden = [
    {
      label: 'preview.1 release tag',
      pattern: /\b(?:v1\.16\.0-)?preview\.1(?:-windows-x64)?\b/iu,
    },
    {
      label: 'legacy static DMG filename',
      pattern: /clodex-1\.16\.0-arm64\.dmg/iu,
    },
    {
      label: 'legacy public downloads endpoint',
      pattern: /(?:https?:)?\/\/ide\.clodex\.xyz\/downloads(?:\/|$)/iu,
    },
    {
      label: 'historical GitHub preview release URL',
      pattern:
        /(?:https?:)?\/\/github\.com\/mereyabdenbekuly-ctrl\/clodex-ide\/releases\/download\/v1\.16\.0-preview\.1/iu,
    },
    {
      label: 'active public artifact CDN URL',
      pattern: /(?:https?:)?\/\/dl\.clodex\.io(?:\/|$)/iu,
    },
    {
      label: 'active GitHub release asset URL',
      pattern:
        /(?:https?:)?\/\/github\.com\/mereyabdenbekuly-ctrl\/clodex-ide\/releases\/download(?:\/|$)/iu,
    },
  ];
  const violations = [];
  for (const file of files) {
    const relativePath = path.relative(websiteDirectory, file);
    const source = readFileSync(file, 'utf8');
    const scannedSource =
      relativePath === 'next.config.mjs'
        ? source.replaceAll(
            '/downloads/clodex-1.16.0-arm64.dmg',
            '/downloads/<blocked-legacy-dmg>',
          )
        : source;
    for (const rule of forbidden) {
      if (rule.pattern.test(scannedSource)) {
        violations.push(`${relativePath}: ${rule.label}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `legacy website download references found:\n${violations.join('\n')}`,
  );

  for (const relativePath of [
    'src/app/download/page.tsx',
    'src/app/(home)/_components/download-buttons.tsx',
    'src/app/(home)/navbar.tsx',
    'src/app/vscode-extension/migrate-to-cli/page.tsx',
    'src/app/vscode-extension/welcome/page.tsx',
  ]) {
    const source = readFileSync(
      path.join(websiteDirectory, relativePath),
      'utf8',
    );
    assert.match(source, /DownloadUnavailableButton/);
    assert.doesNotMatch(
      source,
      /href=\{downloadUrl\}|setDownloadUrl|isDownloadAvailable/,
    );
  }

  const unavailableUi = readFileSync(
    path.join(
      websiteDirectory,
      'src',
      'components',
      'download-unavailable-button.tsx',
    ),
    'utf8',
  );
  assert.match(unavailableUi, /Download temporarily unavailable/);
  assert.match(unavailableUi, /Загрузка временно недоступна/);
});

test('website temporarily redirects the legacy DMG route to download status', async () => {
  const configSource = readFileSync(
    path.join(websiteDirectory, 'next.config.mjs'),
    'utf8',
  );
  assert.equal(
    configSource.match(/\/downloads\/clodex-1\.16\.0-arm64\.dmg/gu)?.length ??
      0,
    1,
    'the legacy DMG path may appear only in its fail-closed redirect',
  );
  const { default: websiteConfig } = await import(
    '../../apps/website/next.config.mjs'
  );
  const redirects = await websiteConfig.redirects();
  assert.deepEqual(
    redirects.filter(
      (redirect) => redirect.source === '/downloads/clodex-1.16.0-arm64.dmg',
    ),
    [
      {
        source: '/downloads/clodex-1.16.0-arm64.dmg',
        destination: '/download',
        permanent: false,
      },
    ],
  );
});

test('release documentation preserves the preview.2 to preview.3 chain', () => {
  const roadmap = readFileSync(
    path.join(repositoryRoot, 'docs', 'roadmap', 'PRODUCT_RELEASE_PLAN.md'),
    'utf8',
  );
  assert.match(roadmap, /preview\.1.*historical.*untrusted/is);
  assert.match(roadmap, /preview\.2.*rollback baseline/is);
  assert.match(roadmap, /preview\.3.*exactly-five.*canary/is);
  assert.match(roadmap, /clodex@1\.16\.0.*accepted\s+preview\.3\s+evidence/is);
  assert.doesNotMatch(
    roadmap,
    /preview\.1 is the published rollback baseline/i,
  );

  for (const relativePath of [
    'docs/preview-release-acceptance.md',
    'docs/releases/v1.16.0-preview.2.md',
  ]) {
    const source = readFileSync(
      path.join(repositoryRoot, relativePath),
      'utf8',
    );
    assert.match(
      source,
      /preview\.1.*not trusted|must not link to preview\.1/is,
    );
    assert.match(source, /public website download surfaces.*disabled/is);
  }
});

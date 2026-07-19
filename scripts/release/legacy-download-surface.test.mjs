import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMMUNITY_RELEASE,
  getReadyCommunityRelease,
} from '../../apps/website/src/lib/community-release.ts';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const websiteDirectory = path.join(repositoryRoot, 'apps', 'website');

const communityVersion = '1.16.0-communityobserved11';
const communityTag = `v${communityVersion}`;
const communitySourceCommit = 'a2645d0a948a6b2c782edce7b02f4bfde49718ce';
const communityRunId = '29677260054';
const repositoryUrl = 'https://github.com/mereyabdenbekuly-ctrl/clodex-ide';
const releaseUrl = `${repositoryUrl}/releases/tag/${communityTag}`;
const releaseAssetBase = `${repositoryUrl}/releases/download/${communityTag}`;
const sourceUrl = `${repositoryUrl}/commit/${communitySourceCommit}`;
const buildRunUrl = `${repositoryUrl}/actions/runs/${communityRunId}`;
const installerFileNames = [
  `clodex-community-observed-${communityVersion}-arm64.dmg`,
  `clodex-community-observed-${communityVersion}-x64.dmg`,
  `clodex-community-observed-${communityVersion}-x64-setup.exe`,
  `clodex-community-observed_${communityVersion}_amd64.deb`,
  'clodex-community-observed-1.16.0.communityobserved11-1.x86_64.rpm',
];
const evidenceFileName = `clodex-community-observed-${communityVersion}-evidence.zip`;
const installerUrls = installerFileNames.map(
  (fileName) => `${releaseAssetBase}/${fileName}`,
);
const checksumsUrl = `${releaseAssetBase}/SHA256SUMS.txt`;
const evidenceUrl = `${releaseAssetBase}/${evidenceFileName}`;
const allowedReleaseAssetUrls = new Set([
  ...installerUrls,
  checksumsUrl,
  evidenceUrl,
]);

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

test('Community release readiness fails closed on every incomplete mapping', () => {
  assert.equal(getReadyCommunityRelease(COMMUNITY_RELEASE), COMMUNITY_RELEASE);

  const incompleteManifests = [
    ['unverified status', (manifest) => (manifest.status = 'unavailable')],
    ['missing name', (manifest) => (manifest.name = '')],
    ['missing version', (manifest) => (manifest.version = null)],
    ['missing tag', (manifest) => (manifest.tag = null)],
    ['missing release URL', (manifest) => (manifest.releaseUrl = null)],
    ['missing checksums URL', (manifest) => (manifest.checksumsUrl = null)],
    ['missing evidence URL', (manifest) => (manifest.evidenceUrl = null)],
    ['missing source commit', (manifest) => (manifest.sourceCommit = null)],
    ['missing source URL', (manifest) => (manifest.sourceUrl = null)],
    ['missing build run ID', (manifest) => (manifest.buildRunId = null)],
    ['missing build run URL', (manifest) => (manifest.buildRunUrl = null)],
    ['four installers', (manifest) => manifest.downloads.pop()],
    [
      'six installers',
      (manifest) => manifest.downloads.push({ ...manifest.downloads[0] }),
    ],
    [
      'installer metadata drift',
      (manifest) => (manifest.downloads[0].architecture = 'x64'),
    ],
    [
      'installer URL drift',
      (manifest) => (manifest.downloads[0].href += '.partial'),
    ],
  ];

  for (const [label, mutate] of incompleteManifests) {
    const manifest = structuredClone(COMMUNITY_RELEASE);
    mutate(manifest);
    assert.equal(
      getReadyCommunityRelease(manifest),
      null,
      `${label} must not be download-ready`,
    );
  }
});

test('website exposes only the exact verified Community Observed release assets', () => {
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
      label: 'stale pre-publication download copy',
      pattern:
        /next verified|being prepared|publication[^.]*pending|direct downloads are temporarily paused|downloads remain temporarily unavailable|new verified free build|новая Free-сборка готовится|новая проверенная Free-сборка|прямые скачивания временно|загрузка временно недоступна/iu,
    },
  ];
  const violations = [];
  const observedReleaseAssetUrls = new Set();
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
    for (const match of scannedSource.matchAll(
      /https:\/\/github\.com\/mereyabdenbekuly-ctrl\/clodex-ide\/releases\/download\/[^\s'"`)]+/gu,
    )) {
      observedReleaseAssetUrls.add(match[0]);
      if (!allowedReleaseAssetUrls.has(match[0])) {
        violations.push(
          `${relativePath}: unexpected GitHub release asset URL ${match[0]}`,
        );
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `unexpected website download references found:\n${violations.join('\n')}`,
  );
  assert.deepEqual(
    [...observedReleaseAssetUrls].sort(),
    [...allowedReleaseAssetUrls].sort(),
    'website release-asset URL allowlist is incomplete',
  );

  const releaseManifest = readFileSync(
    path.join(websiteDirectory, 'src/lib/community-release.ts'),
    'utf8',
  );
  const currentManifest = releaseManifest.slice(
    releaseManifest.indexOf('export const COMMUNITY_RELEASE'),
    releaseManifest.indexOf('/**\n * Historical reference only'),
  );
  assert.match(currentManifest, /status:\s*'verified'/u);
  assert.match(
    currentManifest,
    new RegExp(`version: '${communityVersion}'`, 'u'),
  );
  assert.match(currentManifest, new RegExp(`tag: '${communityTag}'`, 'u'));
  assert.match(
    currentManifest,
    new RegExp(`sourceCommit: '${communitySourceCommit}'`, 'u'),
  );
  assert.match(
    currentManifest,
    new RegExp(`buildRunId: '${communityRunId}'`, 'u'),
  );
  for (const exactUrl of [releaseUrl, sourceUrl, buildRunUrl]) {
    assert.ok(
      currentManifest.includes(`'${exactUrl}'`),
      `release manifest is missing ${exactUrl}`,
    );
  }

  const manifestAssetUrls = [
    ...currentManifest.matchAll(
      /https:\/\/github\.com\/mereyabdenbekuly-ctrl\/clodex-ide\/releases\/download\/[^'\n]+/gu,
    ),
  ].map((match) => match[0]);
  assert.deepEqual(
    [...manifestAssetUrls].sort(),
    [...allowedReleaseAssetUrls].sort(),
    'release manifest asset mapping is not exact',
  );
  const manifestInstallerHrefs = [
    ...currentManifest.matchAll(/href:\s*'([^']+)'/gu),
  ].map((match) => match[1]);
  assert.deepEqual(
    manifestInstallerHrefs,
    installerUrls,
    'release manifest must expose exactly five ordered installers',
  );

  const downloadPage = readFileSync(
    path.join(websiteDirectory, 'src/app/download/page.tsx'),
    'utf8',
  );
  assert.match(downloadPage, /getReadyCommunityRelease\(COMMUNITY_RELEASE\)/u);
  assert.doesNotMatch(downloadPage, /COMMUNITY_RELEASE\.status/u);
  assert.doesNotMatch(downloadPage, /COMMUNITY_RELEASE\.downloads/u);
  assert.match(downloadPage, /readyRelease\.sourceUrl/u);
  assert.match(downloadPage, /readyRelease\.buildRunId/u);
  assert.match(downloadPage, /readyRelease\.buildRunUrl/u);
  assert.match(downloadPage, /Not trust-signed or notarized/u);

  for (const relativePath of [
    'src/app/(home)/_components/download-buttons.tsx',
    'src/app/(home)/navbar.tsx',
    'src/app/(home)/_components/footer.tsx',
  ]) {
    const source = readFileSync(
      path.join(websiteDirectory, relativePath),
      'utf8',
    );
    assert.match(source, /href=\{`\/download\?lang=\$\{locale\}`\}/u);
    assert.doesNotMatch(
      source,
      /href=\{downloadUrl\}|setDownloadUrl|isDownloadAvailable/u,
    );
  }

  for (const relativePath of [
    'src/app/vscode-extension/migrate-to-cli/page.tsx',
    'src/app/vscode-extension/welcome/page.tsx',
  ]) {
    const source = readFileSync(
      path.join(websiteDirectory, relativePath),
      'utf8',
    );
    assert.match(source, /href="\/download\?lang=en"/u);
    assert.match(source, /Download Community Observed 11/u);
    assert.doesNotMatch(source, /DownloadUnavailableButton/u);
  }
});

test('post-release documentation stays coherent with the exact observed build', () => {
  const surfaces = [
    'README.md',
    'docs/COMMUNITY_FREE_PRODUCT_CONTRACT.md',
    'docs/community-observed-builds.md',
    'apps/website/public/llms.txt',
  ];
  for (const relativePath of surfaces) {
    const source = readFileSync(
      path.join(repositoryRoot, relativePath),
      'utf8',
    );
    assert.match(source, new RegExp(communityVersion, 'u'), relativePath);
    assert.match(source, new RegExp(communitySourceCommit, 'u'), relativePath);
    assert.match(source, new RegExp(communityRunId, 'u'), relativePath);
    assert.ok(
      source.includes(releaseUrl),
      `${relativePath}: release URL missing`,
    );
    assert.match(source, /unsigned|ad-hoc/iu, relativePath);
    assert.match(source, /notariz/iu, relativePath);
  }

  const readme = readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
  for (const exactUrl of [
    ...installerUrls,
    checksumsUrl,
    evidenceUrl,
    sourceUrl,
    buildRunUrl,
  ]) {
    assert.ok(readme.includes(exactUrl), `README is missing ${exactUrl}`);
  }
  assert.doesNotMatch(readme, /free_build-verification_pending/u);

  const llms = readFileSync(
    path.join(websiteDirectory, 'public', 'llms.txt'),
    'utf8',
  );
  assert.doesNotMatch(llms, /Current verified Free build:\s*pending/iu);

  const landingCopy = readFileSync(
    path.join(
      websiteDirectory,
      'src',
      'app',
      '(home)',
      '_components',
      'landing-copy.ts',
    ),
    'utf8',
  );
  assert.match(landingCopy, /Community Observed 11/gu);
  assert.doesNotMatch(
    landingCopy,
    /next verified Free build is being prepared|новая проверенная Free-сборка[^.]*готовится/iu,
  );

  const homePage = readFileSync(
    path.join(websiteDirectory, 'src', 'app', '(home)', 'page.tsx'),
    'utf8',
  );
  assert.match(homePage, /getReadyCommunityRelease\(COMMUNITY_RELEASE\)/u);
  assert.match(homePage, /softwareVersion:\s*readyCommunityRelease\.version/u);
  assert.match(
    homePage,
    /downloadUrl:\s*readyCommunityRelease\.downloads\.map/u,
  );
  assert.match(homePage, /releaseNotes:\s*readyCommunityRelease\.releaseUrl/u);
  assert.match(homePage, /readyCommunityRelease\s*\?\s*\{/u);
  assert.match(homePage, /Community Observed 11/u);

  const downloadLayout = readFileSync(
    path.join(websiteDirectory, 'src', 'app', 'download', 'layout.tsx'),
    'utf8',
  );
  assert.match(downloadLayout, /Download CLODEx Community Observed 11/u);

  for (const [relativePath, source] of [
    ['src/app/(home)/page.tsx', homePage],
    ['src/app/download/layout.tsx', downloadLayout],
    [
      'src/app/download/page.tsx',
      readFileSync(
        path.join(websiteDirectory, 'src', 'app', 'download', 'page.tsx'),
        'utf8',
      ),
    ],
  ]) {
    assert.doesNotMatch(
      source,
      /next verified|being prepared|publication[^.]*pending|direct downloads are temporarily paused|новая Free-сборка готовится|прямые скачивания временно приостановлены/iu,
      `${relativePath}: stale pre-publication copy`,
    );
  }
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

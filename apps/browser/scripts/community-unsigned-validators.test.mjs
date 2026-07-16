import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseMacosReleaseArguments } from './validate-macos-release.mjs';
import {
  assertRpmVersionRelease,
  expectedRpmVersionRelease,
  parseReleaseArtifactArguments,
} from './validate-release-artifacts.mjs';

const browserDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('community validator parsers fail closed on identity, source, tag, and plan inputs', () => {
  const exactSource = '0123456789abcdef0123456789abcdef01234567';
  const parsers = [
    ['macOS', parseMacosReleaseArguments, 'allowAdhoc'],
    ['cross-platform', parseReleaseArtifactArguments, 'allowUnsigned'],
  ];

  for (const [label, parser, unsignedOption] of parsers) {
    const parsed = parser(
      [
        '--channel=release',
        '--distribution-mode=community-unsigned',
        `--source-commit=${exactSource}`,
        '--version=1.16.0-community42',
      ],
      {},
    );
    assert.equal(parsed.channel, 'release', `${label} channel`);
    assert.equal(
      parsed.distributionMode,
      'community-unsigned',
      `${label} distribution mode`,
    );
    assert.equal(parsed.sourceCommit, exactSource, `${label} source`);
    assert.equal(parsed[unsignedOption], true, `${label} unsigned policy`);

    assert.throws(
      () =>
        parser(
          [
            '--channel=prerelease',
            '--distribution-mode=community-unsigned',
            `--source-commit=${exactSource}`,
          ],
          {},
        ),
      /must use the release feature channel/,
    );
    assert.throws(
      () =>
        parser(
          ['--channel=release', '--distribution-mode=community-unsigned'],
          {},
        ),
      /requires an exact 40-character source commit/,
    );
    assert.throws(
      () =>
        parser(
          [
            '--channel=release',
            '--distribution-mode=community-unsigned',
            '--source-commit=ABCDEF',
          ],
          {},
        ),
      /requires an exact 40-character source commit/,
    );
    for (const forbidden of [
      '--tag=clodex@1.16.0',
      '--release-plan=.release-notes/clodex-stable.json',
      `--release-plan-sha256=${'f'.repeat(64)}`,
    ]) {
      assert.throws(
        () =>
          parser(
            [
              '--channel=release',
              '--distribution-mode=community-unsigned',
              `--source-commit=${exactSource}`,
              forbidden,
            ],
            {},
          ),
        /must not carry an official tag or release plan/,
      );
    }
  }
});

test('community validators bind separate output, READY attribution, and explicit trust metadata', () => {
  const macosValidatorSource = readFileSync(
    path.join(browserDirectory, 'scripts/validate-macos-release.mjs'),
    'utf8',
  );
  const artifactValidatorSource = readFileSync(
    path.join(browserDirectory, 'scripts/validate-release-artifacts.mjs'),
    'utf8',
  );

  for (const source of [macosValidatorSource, artifactValidatorSource]) {
    assert.match(source, /outputDirectoryName: 'community-unsigned'/);
    assert.match(source, /distributionMode: options\.distributionMode/);
    assert.match(source, /CLODEX_COMMUNITY_UNSIGNED_NO_OS_TRUST/);
    assert.match(source, /updater: 'excluded'/);
    assert.match(
      source,
      /options\.distributionMode === 'community-unsigned'[\s\S]*requireReady/,
    );
  }
  assert.match(macosValidatorSource, /requiredMode:[\s\S]*'community-ad-hoc'/);
  assert.match(macosValidatorSource, /notarization: 'absent'/);
  assert.match(
    artifactValidatorSource,
    /community-unsigned .*must be explicitly NotSigned/,
  );
  assert.match(artifactValidatorSource, /osTrust: 'platform-package-unsigned'/);
});

test('community RPM validation binds the exact normalized version and pinned release', () => {
  const version = '1.16.0-community42';
  const expected = '1.16.0.community42-1';
  assert.equal(expectedRpmVersionRelease(version), expected);
  assert.equal(assertRpmVersionRelease(expected, version), expected);

  for (const invalid of [
    '1.16.0.community420-1',
    '1.16.0.community42-2',
    '1.16.0-community42-1',
  ]) {
    assert.throws(
      () => assertRpmVersionRelease(invalid, version),
      /Unexpected RPM version/,
    );
  }
});

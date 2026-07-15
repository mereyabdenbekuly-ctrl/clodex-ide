import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const workflow = YAML.parse(
  readFileSync(
    path.join(repositoryRoot, '.github/workflows/prepare-release.yml'),
    'utf8',
  ),
);

function stepRun(job, name) {
  const step = workflow.jobs[job].steps.find(
    (candidate) => candidate.name === name,
  );
  if (!step?.run) throw new Error(`workflow step is missing: ${job}/${name}`);
  return step.run;
}

function run(cwd, script, environment) {
  execFileSync('/bin/bash', ['-euo', 'pipefail', '-c', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function git(cwd, arguments_) {
  return execFileSync('/usr/bin/git', arguments_, {
    cwd,
    encoding: 'utf8',
  }).trim();
}

test('release preparation hands an allowlisted patch to a fresh protected checkout', {
  skip: process.platform === 'win32',
}, async (context) => {
  for (const customNotes of [false, true]) {
    await context.test(`custom notes present: ${customNotes}`, () => {
      const root = mkdtempSync(
        path.join(os.tmpdir(), 'prepare-release-contract.'),
      );
      try {
        const source = path.join(root, 'source');
        mkdirSync(path.join(source, 'apps/browser'), { recursive: true });
        mkdirSync(path.join(source, 'scripts/release'), { recursive: true });
        if (customNotes) {
          mkdirSync(path.join(source, '.release-notes'), { recursive: true });
        }
        writeFileSync(
          path.join(source, 'apps/browser/package.json'),
          `${JSON.stringify(
            { name: 'clodex', private: true, version: '1.0.0' },
            null,
            2,
          )}\n`,
        );
        writeFileSync(
          path.join(source, 'apps/browser/CHANGELOG.md'),
          '# Changelog\n\nold\n',
        );
        writeFileSync(path.join(source, '.release-version'), '1.0.0');
        writeFileSync(path.join(source, '.release-tag'), 'clodex@1.0.0');
        writeFileSync(
          path.join(source, '.release-notes.md'),
          'Old release notes\n',
        );
        if (customNotes) {
          writeFileSync(
            path.join(source, '.release-notes/clodex.md'),
            'custom\n',
          );
        }
        cpSync(
          path.join(
            repositoryRoot,
            'scripts/release/validate-release-identity.mjs',
          ),
          path.join(source, 'scripts/release/validate-release-identity.mjs'),
        );
        git(source, ['init', '-b', 'main']);
        git(source, ['config', 'user.name', 'Fixture']);
        git(source, ['config', 'user.email', 'fixture@example.com']);
        git(source, ['add', '.']);
        git(source, ['commit', '-m', 'base']);
        const baseSha = git(source, ['rev-parse', 'HEAD']);

        writeFileSync(
          path.join(source, 'apps/browser/package.json'),
          `${JSON.stringify(
            { name: 'clodex', private: true, version: '1.0.1' },
            null,
            2,
          )}\n`,
        );
        writeFileSync(
          path.join(source, 'apps/browser/CHANGELOG.md'),
          '# Changelog\n\n## 1.0.1\n\nnew\n\nold\n',
        );
        writeFileSync(path.join(source, '.release-version'), '1.0.1');
        writeFileSync(path.join(source, '.release-tag'), 'clodex@1.0.1');
        writeFileSync(
          path.join(source, '.release-notes.md'),
          'Release notes\n',
        );
        if (customNotes) rmSync(path.join(source, '.release-notes/clodex.md'));

        const prepareTemp = path.join(root, 'prepare-temp');
        mkdirSync(prepareTemp);
        const githubOutput = path.join(root, 'github-output');
        writeFileSync(githubOutput, '');
        run(
          source,
          stepRun('prepare', 'Build exact allowlisted release payload'),
          {
            BASE_SHA: baseSha,
            GITHUB_OUTPUT: githubOutput,
            GITHUB_REPOSITORY: 'mereyabdenbekuly-ctrl/clodex-ide',
            RELEASE_BRANCH: 'release/clodex-1.0.1',
            RELEASE_CHANNEL_INPUT: 'release',
            RELEASE_PRODUCT: 'clodex',
            RELEASE_TAG: 'clodex@1.0.1',
            RELEASE_VERSION: '1.0.1',
            RUNNER_TEMP: prepareTemp,
          },
        );

        const publish = path.join(root, 'publish');
        execFileSync('/usr/bin/git', ['clone', source, publish], {
          stdio: 'ignore',
        });
        git(publish, ['checkout', '--quiet', baseSha]);
        const publishTemp = path.join(root, 'publish-temp');
        mkdirSync(publishTemp);
        cpSync(
          path.join(prepareTemp, 'release-preparation'),
          path.join(publishTemp, 'release-preparation'),
          { recursive: true },
        );
        const manifest = JSON.parse(
          readFileSync(
            path.join(
              publishTemp,
              'release-preparation/release-preparation.json',
            ),
            'utf8',
          ),
        );
        const protectedEnvironment = {
          BASE_SHA: baseSha,
          EXPECTED_BRANCH: manifest.branch,
          EXPECTED_NOTES_SHA256: manifest.notesSha256,
          EXPECTED_PATCH_SHA256: manifest.patchSha256,
          EXPECTED_TAG: manifest.tag,
          EXPECTED_VERSION: manifest.version,
          GITHUB_REPOSITORY: manifest.repository,
          RELEASE_CHANNEL_INPUT: manifest.channel,
          RELEASE_PRODUCT: manifest.product,
          RUNNER_TEMP: publishTemp,
        };
        run(
          publish,
          stepRun(
            'publish',
            'Verify exact payload identity, digests, and allowlist',
          ),
          protectedEnvironment,
        );
        run(
          publish,
          stepRun(
            'publish',
            'Apply and semantically verify the allowlisted patch',
          ),
          protectedEnvironment,
        );
        run(
          publish,
          stepRun(
            'publish',
            'Create exact signed-off release commit after status review',
          ),
          {
            ...protectedEnvironment,
            RELEASE_BRANCH: manifest.branch,
            RELEASE_VERSION: manifest.version,
          },
        );
        const commitBody = git(publish, ['log', '-1', '--format=%B']);
        if (!commitBody.includes('Signed-off-by:')) {
          throw new Error('release commit is missing a sign-off');
        }
        if (git(publish, ['status', '--porcelain'])) {
          throw new Error('protected release checkout is dirty after commit');
        }
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    });
  }
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
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
const workflowSource = readFileSync(
  path.join(repositoryRoot, '.github/workflows/prepare-release.yml'),
  'utf8',
);
const workflow = YAML.parse(workflowSource);

function step(job, name) {
  const result = workflow.jobs[job].steps.find(
    (candidate) => candidate.name === name,
  );
  if (!result) throw new Error(`workflow step is missing: ${job}/${name}`);
  return result;
}

function stepRun(job, name) {
  const result = step(job, name);
  if (!result.run)
    throw new Error(`workflow step has no run block: ${job}/${name}`);
  return result.run;
}

function run(cwd, script, environment) {
  // GitHub's Ubuntu runner uses Bash 5, while macOS only ships Bash 3.2 and
  // cannot parse the workflow's associative arrays. Zsh provides the needed
  // shell features locally once its special `path` and `status` names are
  // hidden inside the wrapper function.
  const shell = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  const localScript =
    process.platform === 'darwin'
      ? script.replaceAll('["$path"]', '[$path]')
      : script;
  const command =
    process.platform === 'darwin'
      ? `function run_workflow_step {
  local -h path status
${localScript}
}
run_workflow_step`
      : localScript;
  return execFileSync(shell, ['-euo', 'pipefail', '-c', command], {
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
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function permissionBlocks(value, pathParts = []) {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      permissionBlocks(entry, [...pathParts, String(index)]),
    );
  }
  if (!value || typeof value !== 'object') return [];

  return Object.entries(value).flatMap(([key, entry]) => {
    const currentPath = [...pathParts, key];
    if (key === 'permissions') {
      return [{ path: currentPath.join('.'), value: entry }];
    }
    return permissionBlocks(entry, currentPath);
  });
}

function executableShellSource(source) {
  const executable = [];
  let heredocDelimiter;

  for (const line of source.split('\n')) {
    if (heredocDelimiter) {
      if (line.trim() === heredocDelimiter) heredocDelimiter = undefined;
      continue;
    }

    executable.push(line);
    const heredoc = line.match(/<<-?\s*['"]?([A-Z][A-Z0-9_]*)['"]?/);
    if (heredoc) heredocDelimiter = heredoc[1];
  }

  return executable
    .filter((line) => !/^\s*(?:echo|printf)\b/.test(line))
    .join('\n');
}

function parseOutputFile(file) {
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function createFixture(root, customNotes) {
  const source = path.join(root, 'source');
  const origin = path.join(root, 'origin.git');
  mkdirSync(path.join(source, 'apps/browser'), { recursive: true });
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
  writeFileSync(path.join(source, '.release-notes.md'), 'Old release notes\n');
  if (customNotes) {
    writeFileSync(path.join(source, '.release-notes/clodex.md'), 'custom\n');
  }

  git(source, ['init', '-b', 'main']);
  git(source, ['config', 'user.name', 'Fixture']);
  git(source, ['config', 'user.email', 'fixture@example.com']);
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'base']);
  const baseSha = git(source, ['rev-parse', 'HEAD']);

  git(root, ['init', '--bare', '-b', 'main', origin]);
  git(source, ['remote', 'add', 'origin', origin]);
  git(source, ['push', '--set-upstream', 'origin', 'main']);

  return { baseSha, origin, source };
}

function prepareFixture(source, customNotes) {
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
  writeFileSync(path.join(source, '.release-notes.md'), 'Release notes\n');
  if (customNotes) rmSync(path.join(source, '.release-notes/clodex.md'));
}

test('release preparation has no repository publication authority', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(workflow.jobs), ['prepare']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.prepare.permissions, undefined);

  for (const permissions of permissionBlocks(workflow)) {
    assert.equal(
      typeof permissions.value,
      'object',
      `${permissions.path} must use an explicit permission map`,
    );
    for (const [scope, access] of Object.entries(permissions.value)) {
      assert.equal(
        access,
        'read',
        `${permissions.path}.${scope} grants non-read access`,
      );
    }
  }

  const checkout = workflow.jobs.prepare.steps.find((candidate) =>
    candidate.uses?.startsWith('actions/checkout@'),
  );
  assert.ok(checkout, 'checkout step is missing');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.match(checkout.with.ref, /^\$\{\{ github\.sha \}\}$/);

  assert.doesNotMatch(
    workflowSource,
    /\b(?:GH_TOKEN|GITHUB_TOKEN|RELEASE_PAT|[A-Z][A-Z0-9_]*_PAT)\b|\bsecrets\./,
  );
  assert.doesNotMatch(
    workflowSource,
    /actions\/github-script|create-pull-request|softprops\/action-gh-release/i,
  );

  const executable = workflow.jobs.prepare.steps
    .filter((candidate) => candidate.run)
    .map((candidate) => executableShellSource(candidate.run))
    .join('\n');
  assert.doesNotMatch(
    executable,
    /\bgit\s+(?:add|apply|checkout|cherry-pick|commit|merge|push|rebase|reset|restore|switch|tag|update-ref)\b/i,
  );
  assert.doesNotMatch(executable, /\bgh\s+(?:api|pr|release)\b/i);
  assert.doesNotMatch(executable, /api\.github\.com/i);

  const upload = step('prepare', 'Upload release preparation artifact');
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/);
  assert.equal(upload.with['if-no-files-found'], 'error');
});

test('release preparation validates and emits an exact plan without Git mutations', {
  skip: process.platform === 'win32',
}, async (context) => {
  for (const customNotes of [false, true]) {
    await context.test(`custom notes present: ${customNotes}`, () => {
      const root = mkdtempSync(
        path.join(os.tmpdir(), 'prepare-release-contract.'),
      );
      try {
        const { baseSha, origin, source } = createFixture(root, customNotes);
        const refsBefore = git(source, ['show-ref']);
        const remoteMainBefore = git(source, [
          'ls-remote',
          'origin',
          'refs/heads/main',
        ]);

        run(source, stepRun('prepare', 'Assert exact canonical main source'), {
          DISPATCH_REF: 'refs/heads/main',
          DISPATCH_SHA: baseSha,
        });

        prepareFixture(source, customNotes);
        const preparedStatus = git(source, [
          'status',
          '--porcelain=v1',
          '--untracked-files=all',
        ]);
        assert.notEqual(preparedStatus, '');
        assert.equal(git(source, ['diff', '--cached', '--name-only']), '');

        run(source, stepRun('prepare', 'Validate exact generated change set'), {
          RELEASE_PRODUCT: 'clodex',
        });

        const runnerTemp = path.join(root, 'runner-temp');
        const githubOutput = path.join(root, 'github-output');
        mkdirSync(runnerTemp);
        writeFileSync(githubOutput, '');
        run(source, stepRun('prepare', 'Build release preparation artifact'), {
          GITHUB_OUTPUT: githubOutput,
          RELEASE_CHANNEL_INPUT: 'release',
          RELEASE_PRODUCT: 'clodex',
          RELEASE_SOURCE_SHA: baseSha,
          RELEASE_TAG: 'clodex@1.0.1',
          RELEASE_VERSION: '1.0.1',
          RUNNER_TEMP: runnerTemp,
        });

        const bundle = path.join(runnerTemp, 'release-preparation');
        const patchPath = path.join(bundle, 'release-preparation.patch');
        const changedFilesPath = path.join(bundle, 'changed-files.txt');
        const metadata = JSON.parse(
          readFileSync(path.join(bundle, 'release-preparation.json'), 'utf8'),
        );
        const patchBytes = readFileSync(patchPath);
        const patchSha256 = sha256(patchBytes);
        const expectedChangedFiles = [
          '.release-notes.md',
          '.release-tag',
          '.release-version',
          'apps/browser/CHANGELOG.md',
          'apps/browser/package.json',
          ...(customNotes ? ['.release-notes/clodex.md'] : []),
        ].sort();

        assert.deepEqual(metadata, {
          schemaVersion: 1,
          sourceBranch: 'main',
          sourceCommit: baseSha,
          product: 'clodex',
          channel: 'release',
          version: '1.0.1',
          tag: 'clodex@1.0.1',
          patchSha256,
          changedFiles: expectedChangedFiles,
        });
        assert.deepEqual(
          readFileSync(changedFilesPath, 'utf8').trim().split('\n'),
          expectedChangedFiles,
        );

        const outputs = parseOutputFile(githubOutput);
        assert.deepEqual(outputs, {
          directory: bundle,
          patch_sha256: patchSha256,
          release_branch: 'release/clodex-1.0.1',
        });

        const instructions = readFileSync(
          path.join(bundle, 'APPLY.md'),
          'utf8',
        );
        assert.match(instructions, new RegExp(baseSha));
        assert.match(instructions, new RegExp(patchSha256));
        assert.match(
          instructions,
          /did not create a branch, commit, push, or pull request/,
        );

        const planCheckout = path.join(root, 'plan-checkout');
        git(root, ['clone', origin, planCheckout]);
        assert.equal(git(planCheckout, ['rev-parse', 'HEAD']), baseSha);
        git(planCheckout, ['apply', '--check', patchPath]);
        assert.equal(
          git(planCheckout, [
            'status',
            '--porcelain=v1',
            '--untracked-files=all',
          ]),
          '',
        );

        const summaryPath = path.join(root, 'summary.md');
        writeFileSync(summaryPath, '');
        run(source, stepRun('prepare', 'Summary'), {
          GITHUB_STEP_SUMMARY: summaryPath,
          PATCH_SHA256: patchSha256,
          RELEASE_BRANCH: 'release/clodex-1.0.1',
          RELEASE_CHANNEL_INPUT: 'release',
          RELEASE_PRODUCT: 'clodex',
          RELEASE_SOURCE_SHA: baseSha,
          RELEASE_TAG: 'clodex@1.0.1',
          RELEASE_VERSION: '1.0.1',
        });
        assert.match(
          readFileSync(summaryPath, 'utf8'),
          /intentionally did not create a commit, push a branch, or open a pull request/,
        );

        writeFileSync(path.join(source, 'unexpected.txt'), 'not allowlisted\n');
        assert.throws(
          () =>
            run(
              source,
              stepRun('prepare', 'Validate exact generated change set'),
              { RELEASE_PRODUCT: 'clodex' },
            ),
          (error) => {
            assert.match(
              `${String(error.stdout)}${String(error.stderr)}`,
              /changed unexpected path/,
            );
            return true;
          },
        );
        rmSync(path.join(source, 'unexpected.txt'));

        assert.equal(git(source, ['rev-parse', 'HEAD']), baseSha);
        assert.equal(git(source, ['show-ref']), refsBefore);
        assert.equal(
          git(source, ['ls-remote', 'origin', 'refs/heads/main']),
          remoteMainBefore,
        );
        assert.equal(
          git(source, ['status', '--porcelain=v1', '--untracked-files=all']),
          preparedStatus,
        );
        assert.equal(git(source, ['diff', '--cached', '--name-only']), '');
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    });
  }
});

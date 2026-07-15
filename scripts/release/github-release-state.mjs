#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function fail(message) {
  throw new Error(message);
}

function extractLastHttpStatus(output) {
  const statuses = [
    ...String(output ?? '').matchAll(
      /(?:^HTTP\/[^\s]+\s+|\(HTTP\s+)(\d{3})\b/gim,
    ),
  ];
  if (statuses.length === 0) return null;
  return Number.parseInt(statuses.at(-1)[1], 10);
}

function parseReleasePages(output) {
  let pages;
  try {
    pages = JSON.parse(output ?? '');
  } catch {
    fail('GitHub release lookup returned invalid JSON');
  }
  if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page))) {
    fail('GitHub release lookup returned an invalid paginated response');
  }
  return pages.flat();
}

function classifyReleaseDocument(release) {
  if (release.draft === true && release.published_at === null) return 'draft';
  if (
    release.draft === false &&
    typeof release.published_at === 'string' &&
    release.published_at.length > 0
  ) {
    return 'published';
  }
  fail('GitHub release lookup returned an inconsistent publication state');
}

export function classifyGitHubReleaseProbe({
  error,
  status,
  stderr,
  stdout,
  tag,
}) {
  const httpStatus = extractLastHttpStatus(`${stdout ?? ''}\n${stderr ?? ''}`);

  if (error) {
    fail(
      `GitHub release lookup failed before receiving an HTTP response: ${error.message}`,
    );
  }

  if (status !== 0) {
    if (httpStatus !== null) {
      fail(`GitHub release lookup failed with HTTP ${httpStatus}`);
    }
    fail(
      `GitHub release lookup failed before receiving an HTTP status (gh exit ${status ?? 'unknown'})`,
    );
  }

  const releases = parseReleasePages(stdout);
  for (const release of releases) {
    if (
      !release ||
      typeof release !== 'object' ||
      typeof release.tag_name !== 'string'
    ) {
      fail('GitHub release lookup returned invalid release metadata');
    }
  }
  const matches = releases.filter((release) => release.tag_name === tag);
  if (matches.length === 0) return 'absent';
  if (matches.length !== 1) {
    fail(
      `GitHub release lookup found ${matches.length} records for the exact tag`,
    );
  }
  return classifyReleaseDocument(matches[0]);
}

export function queryGitHubReleaseState({
  repository,
  runGh = spawnSync,
  tag,
}) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository ?? '')) {
    fail('repository must be provided as owner/name');
  }
  if (typeof tag !== 'string' || tag.length === 0 || /[\r\n]/.test(tag)) {
    fail('tag must be a non-empty single-line value');
  }

  const endpoint = `repos/${repository}/releases?per_page=100`;
  const result = runGh(
    'gh',
    ['api', '--paginate', '--slurp', '--method', 'GET', endpoint],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  return classifyGitHubReleaseProbe({ ...result, tag });
}

function parseArguments(values) {
  const options = {
    repository: process.env.GITHUB_REPOSITORY,
    tag: undefined,
  };

  for (const value of values) {
    if (value.startsWith('--repository=')) {
      options.repository = value.slice('--repository='.length);
    } else if (value.startsWith('--tag=')) {
      options.tag = value.slice('--tag='.length);
    } else {
      fail(`Unknown argument: ${value}`);
    }
  }

  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  console.log(queryGitHubReleaseState(options));
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  try {
    main();
  } catch (error) {
    console.error(
      `[github-release-state] ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
}

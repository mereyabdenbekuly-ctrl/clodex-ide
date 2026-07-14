#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function fail(message) {
  throw new Error(message);
}

function extractLastHttpStatus(output) {
  const statuses = [
    ...String(output ?? '').matchAll(/^HTTP\/[^\s]+\s+(\d{3})\b/gim),
  ];
  if (statuses.length === 0) return null;
  return Number.parseInt(statuses.at(-1)[1], 10);
}

export function classifyGitHubReleaseProbe({ error, status, stderr, stdout }) {
  const httpStatus = extractLastHttpStatus(`${stdout ?? ''}\n${stderr ?? ''}`);

  if (error) {
    fail(
      `GitHub release lookup failed before receiving an HTTP response: ${error.message}`,
    );
  }

  if (status === 0 && httpStatus === 200) return 'exists';
  if (httpStatus === 404) return 'absent';

  if (httpStatus !== null) {
    fail(`GitHub release lookup failed with HTTP ${httpStatus}`);
  }

  fail(
    `GitHub release lookup failed before receiving an HTTP status (gh exit ${status ?? 'unknown'})`,
  );
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

  const endpoint = `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
  const result = runGh(
    'gh',
    ['api', '--include', '--method', 'GET', endpoint],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  return classifyGitHubReleaseProbe(result);
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

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  buildNpmCliInvocation,
  resolveNpmCliPath,
} from './npm-cli-invocation.mjs';

test('Windows invokes npm through node and the official npm CLI instead of npm.cmd', () => {
  const nodeExecutable = 'C:\\hostedtoolcache\\node\\22.23.1\\x64\\node.exe';
  const expectedCli = path.win32.join(
    path.win32.dirname(nodeExecutable),
    'node_modules/npm/bin/npm-cli.js',
  );
  assert.deepEqual(
    buildNpmCliInvocation({
      existsSyncImpl: (candidate) => candidate === expectedCli,
      nodeExecutable,
      platform: 'win32',
    }),
    {
      arguments: [expectedCli],
      command: nodeExecutable,
    },
  );
});

test('POSIX invokes the official npm CLI from the pinned Node distribution', () => {
  const nodeExecutable = '/opt/node/bin/node';
  const expectedCli = '/opt/node/lib/node_modules/npm/bin/npm-cli.js';
  assert.equal(
    resolveNpmCliPath({
      existsSyncImpl: (candidate) => candidate === expectedCli,
      nodeExecutable,
      platform: 'linux',
    }),
    expectedCli,
  );
});

test('npm invocation fails closed when the pinned Node distribution is incomplete', () => {
  assert.throws(
    () =>
      buildNpmCliInvocation({
        existsSyncImpl: () => false,
        nodeExecutable: '/opt/node/bin/node',
        platform: 'linux',
      }),
    /no npm CLI at an approved location/u,
  );
});

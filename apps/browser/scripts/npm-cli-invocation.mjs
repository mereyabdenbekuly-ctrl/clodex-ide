import { existsSync } from 'node:fs';
import path from 'node:path';

export function resolveNpmCliPath({
  existsSyncImpl = existsSync,
  nodeExecutable = process.execPath,
  platform = process.platform,
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (
    typeof nodeExecutable !== 'string' ||
    !pathApi.isAbsolute(nodeExecutable)
  ) {
    throw new Error('Node executable must be an absolute path.');
  }
  const nodeDirectory = pathApi.dirname(nodeExecutable);
  const candidates = [
    ...(platform === 'win32'
      ? [pathApi.join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js')]
      : [
          pathApi.resolve(
            nodeDirectory,
            '../lib/node_modules/npm/bin/npm-cli.js',
          ),
        ]),
    pathApi.resolve(nodeDirectory, '../node_modules/npm/bin/npm-cli.js'),
    pathApi.join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'),
  ];
  const npmCliPath = [...new Set(candidates)].find((candidate) =>
    existsSyncImpl(candidate),
  );
  if (!npmCliPath) {
    throw new Error(
      `Pinned Node distribution has no npm CLI at an approved location: ${candidates.join(', ')}`,
    );
  }
  return npmCliPath;
}

export function buildNpmCliInvocation(options = {}) {
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  return {
    arguments: [resolveNpmCliPath({ ...options, nodeExecutable })],
    command: nodeExecutable,
  };
}

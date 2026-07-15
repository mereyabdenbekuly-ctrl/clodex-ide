import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createCliHostPaths } from './cli-host-paths.js';

const SESSION_ROOT = path.resolve('clodex-cli-path-session');

describe('createCliHostPaths', () => {
  it('normalizes a relative session root and keeps every static path beneath it', () => {
    const root = path.resolve('relative-cli-session');
    const paths = createCliHostPaths('relative-cli-session');
    const values = [
      paths.dataDir(),
      paths.tempDir(),
      paths.agentsDir(),
      paths.agentDbPath(),
      paths.fileReadCacheDbPath(),
      paths.processedImageCacheDbPath(),
      paths.diffHistoryDir(),
      paths.diffHistoryDbPath(),
      paths.diffHistoryBlobsDir(),
      paths.userDataDir(),
      paths.plansDir(),
      paths.logsDir(),
      paths.memoryDir(),
      paths.pluginsDir(),
      paths.builtinSkillsDir(),
      paths.ripgrepBaseDir(),
    ];

    for (const value of values) {
      expect(path.isAbsolute(value)).toBe(true);
      expect(path.relative(root, value)).not.toMatch(/^\.\.(?:[/\\]|$)/);
    }
  });

  it('constructs agent and attachment paths for safe single segments', () => {
    const paths = createCliHostPaths(SESSION_ROOT);
    expect(paths.agentDir('agent-1')).toBe(
      path.join(SESSION_ROOT, 'data', 'clodex', 'agents', 'agent-1'),
    );
    expect(paths.agentAttachmentPath('agent-1', 'report final.txt')).toBe(
      path.join(
        SESSION_ROOT,
        'data',
        'clodex',
        'agents',
        'agent-1',
        'attachments',
        'report final.txt',
      ),
    );
  });

  it.each([
    '',
    '.',
    '..',
    path.join('..', 'escape'),
    path.join('nested', 'name'),
    '../portable-escape',
    '..\\portable-escape',
    'nested/portable-name',
    'nested\\portable-name',
    'nul\0byte',
  ])('rejects an unsafe path segment without returning an escaped path: %s', (segment) => {
    const paths = createCliHostPaths(SESSION_ROOT);
    expect(() => paths.agentDir(segment)).toThrow(/safe path segment/);
    expect(() => paths.agentAttachmentPath('agent', segment)).toThrow(
      /safe path segment/,
    );
  });

  it('rejects an empty session root', () => {
    expect(() => createCliHostPaths('   ')).toThrow(/non-empty/);
  });
});

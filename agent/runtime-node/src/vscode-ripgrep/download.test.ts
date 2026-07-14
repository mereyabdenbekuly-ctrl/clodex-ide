import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getRipgrepDownloadCacheDir,
  getRipgrepReleaseAssetUrl,
} from './download.js';

describe('ripgrep download routing', () => {
  it('uses the deterministic public release asset URL without a GitHub API lookup', () => {
    expect(
      getRipgrepReleaseAssetUrl(
        'v15.0.0',
        'ripgrep-v15.0.0-x86_64-pc-windows-msvc.zip',
      ),
    ).toBe(
      'https://github.com/microsoft/ripgrep-prebuilt/releases/download/v15.0.0/ripgrep-v15.0.0-x86_64-pc-windows-msvc.zip',
    );
  });

  it('isolates the archive cache by installation base directory', () => {
    const first = getRipgrepDownloadCacheDir(
      path.join('/tmp', 'first', 'bin', 'ripgrep'),
    );
    const second = getRipgrepDownloadCacheDir(
      path.join('/tmp', 'second', 'bin', 'ripgrep'),
    );

    expect(first).toBe(path.join('/tmp', 'first', '.cache', 'ripgrep'));
    expect(second).toBe(path.join('/tmp', 'second', '.cache', 'ripgrep'));
    expect(first).not.toBe(second);
  });
});

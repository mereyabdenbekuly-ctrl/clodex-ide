import { describe, expect, it } from 'vitest';
import {
  buildUpdateFeedURL,
  inferPrereleaseUpdateChannel,
  resolveUpdateArchitecture,
  resolveUpdateChannel,
  resolveUpdatePlatform,
} from './auto-update-config';

describe('auto-update config', () => {
  it('normalizes platform and architecture values', () => {
    expect(resolveUpdatePlatform('darwin')).toBe('macos');
    expect(resolveUpdatePlatform('win32')).toBe('win');
    expect(resolveUpdatePlatform('linux')).toBe('linux');
    expect(resolveUpdateArchitecture('arm64')).toBe('arm64');
    expect(resolveUpdateArchitecture('x64')).toBe('x64');
    expect(resolveUpdateArchitecture('ia32')).toBe('x64');
  });

  it('resolves stable, nightly, and prerelease channels', () => {
    expect(
      resolveUpdateChannel({
        releaseChannel: 'release',
        version: '1.16.0',
        preference: 'alpha',
      }),
    ).toBe('release');
    expect(
      resolveUpdateChannel({
        releaseChannel: 'nightly',
        version: '1.16.1-nightly20260711c001',
      }),
    ).toBe('nightly');
    expect(inferPrereleaseUpdateChannel('1.16.0-alpha001')).toBe('alpha');
    expect(inferPrereleaseUpdateChannel('1.16.0-beta001')).toBe('beta');
    expect(
      resolveUpdateChannel({
        releaseChannel: 'prerelease',
        version: '1.16.0-alpha001',
        preference: 'beta',
      }),
    ).toBe('beta');
  });

  it('builds a canonical encoded feed URL without duplicate slashes', () => {
    expect(
      buildUpdateFeedURL({
        origin: 'https://updates.clodex.xyz/base///',
        releaseChannel: 'release',
        version: '1.16.0',
        platform: 'darwin',
        architecture: 'arm64',
      }),
    ).toBe(
      'https://updates.clodex.xyz/base/update/clodex/release/macos/arm64/1.16.0',
    );
  });

  it('rejects missing, malformed, credentialed, and non-http origins', () => {
    const base = {
      releaseChannel: 'release' as const,
      version: '1.16.0',
      platform: 'win32',
      architecture: 'x64',
    };
    expect(buildUpdateFeedURL({ ...base, origin: undefined })).toBeNull();
    expect(buildUpdateFeedURL({ ...base, origin: 'not a URL' })).toBeNull();
    expect(
      buildUpdateFeedURL({
        ...base,
        origin: 'https://user:password@example.com',
      }),
    ).toBeNull();
    expect(
      buildUpdateFeedURL({ ...base, origin: 'file:///tmp/update-server' }),
    ).toBeNull();
  });
});

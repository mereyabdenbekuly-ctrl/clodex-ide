import { describe, expect, it, vi } from 'vitest';
import {
  assertSafeSkillDownloadUrl,
  downloadRemoteSkillPackage,
  isPublicSkillDownloadAddress,
} from './skill-download';

const publicLookup = async () => ['93.184.216.34'];

describe('remote skill downloads', () => {
  it('classifies loopback and private network addresses as unsafe', () => {
    expect(isPublicSkillDownloadAddress('127.0.0.1')).toBe(false);
    expect(isPublicSkillDownloadAddress('10.0.0.1')).toBe(false);
    expect(isPublicSkillDownloadAddress('169.254.169.254')).toBe(false);
    expect(isPublicSkillDownloadAddress('192.168.1.10')).toBe(false);
    expect(isPublicSkillDownloadAddress('::1')).toBe(false);
    expect(isPublicSkillDownloadAddress('fd00::1')).toBe(false);
    expect(isPublicSkillDownloadAddress('93.184.216.34')).toBe(true);
    expect(isPublicSkillDownloadAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('rejects credentialed URLs and hosts resolving to private addresses', async () => {
    await expect(
      assertSafeSkillDownloadUrl(
        new URL('https://user:secret@example.com/skill.skill'),
        publicLookup,
      ),
    ).rejects.toThrow('credentials');
    await expect(
      assertSafeSkillDownloadUrl(
        new URL('https://skills.example/skill.skill'),
        async () => ['127.0.0.1'],
      ),
    ).rejects.toThrow('non-public');
  });

  it('validates every redirect destination before fetching it', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/internal.skill' },
      });
    }) as unknown as typeof fetch;

    await expect(
      downloadRemoteSkillPackage('https://skills.example/start.skill', {
        fetchImpl,
        lookupHost: publicLookup,
      }),
    ).rejects.toThrow('non-public');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('enforces the size limit while streaming bodies without content-length', async () => {
    const fetchImpl = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5, 6]));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      downloadRemoteSkillPackage('https://skills.example/large.skill', {
        fetchImpl,
        lookupHost: publicLookup,
        maxBytes: 5,
      }),
    ).rejects.toThrow('size limit');
  });

  it('returns a validated package within the configured limit', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response('skill package', {
        status: 200,
        headers: { 'content-length': '13' },
      });
    }) as unknown as typeof fetch;

    const result = await downloadRemoteSkillPackage(
      'https://skills.example/example.skill',
      {
        fetchImpl,
        lookupHost: publicLookup,
        maxBytes: 32,
      },
    );

    expect(result.toString('utf-8')).toBe('skill package');
  });
});

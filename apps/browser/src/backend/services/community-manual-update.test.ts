import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMUNITY_RELEASES_API_URL,
  compareCommunityBuildVersions,
  discoverCommunityManualUpdate,
  isCommunityManualUpdateSupported,
  parseCommunityBuildVersion,
} from './community-manual-update';

const REPOSITORY = 'mereyabdenbekuly-ctrl/clodex-ide';
const API_ORIGIN = 'https://api.github.com';
const WEB_ORIGIN = 'https://github.com';
const SOURCE_COMMIT = 'a'.repeat(40);
const PUBLISHED_AT = '2026-07-26T12:00:00Z';
const CHECKSUM_NAME = 'SHA256SUMS.txt';

type DistributionMode = 'community-unsigned' | 'community-observed';

interface ReleaseFixture {
  checksumBody: string;
  checksumUrl: string;
  release: Record<string, unknown> & {
    assets: Array<Record<string, unknown>>;
  };
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function baseName(distributionMode: DistributionMode): string {
  return distributionMode === 'community-observed'
    ? 'clodex-community-observed'
    : 'clodex-community-unsigned';
}

function installerNames(
  distributionMode: DistributionMode,
  version: string,
): string[] {
  const base = baseName(distributionMode);
  return [
    `${base}-${version}-arm64.dmg`,
    `${base}-${version}-x64.dmg`,
    `${base}-${version}-x64-setup.exe`,
    `${base}_${version}_amd64.deb`,
    `${base}-${version.replace('-', '.')}-1.x86_64.rpm`,
  ].sort((left, right) => left.localeCompare(right));
}

function releaseAssetNames(
  distributionMode: DistributionMode,
  version: string,
): string[] {
  const names = [...installerNames(distributionMode, version), CHECKSUM_NAME];
  if (distributionMode === 'community-observed') {
    names.push(`${baseName(distributionMode)}-${version}-evidence.zip`);
  }
  return names.sort((left, right) => left.localeCompare(right));
}

function buildRelease(options: {
  version: string;
  distributionMode?: DistributionMode;
  draft?: boolean;
  immutable?: boolean;
  prerelease?: boolean;
}): ReleaseFixture {
  const distributionMode = options.distributionMode ?? 'community-observed';
  const tagName = `v${options.version}`;
  const nonChecksumNames = releaseAssetNames(
    distributionMode,
    options.version,
  ).filter((name) => name !== CHECKSUM_NAME);
  const digests = new Map(
    nonChecksumNames.map((name) => [name, digest(`fixture:${name}`)]),
  );
  const checksumBody = `${nonChecksumNames
    .map((name) => `${digests.get(name)}  ${name}`)
    .join('\n')}\n`;
  digests.set(CHECKSUM_NAME, digest(checksumBody));

  const assets = releaseAssetNames(distributionMode, options.version).map(
    (name, index) => ({
      id: 1_000 + index,
      name,
      state: 'uploaded',
      size: name === CHECKSUM_NAME ? checksumBody.length : 1_024 + index,
      digest: `sha256:${digests.get(name)}`,
      url: `${API_ORIGIN}/repos/${REPOSITORY}/releases/assets/${1_000 + index}`,
      browser_download_url: `${WEB_ORIGIN}/${REPOSITORY}/releases/download/${tagName}/${name}`,
    }),
  );
  const checksumUrl = String(
    assets.find((asset) => asset.name === CHECKSUM_NAME)?.browser_download_url,
  );
  return {
    checksumBody,
    checksumUrl,
    release: {
      tag_name: tagName,
      draft: options.draft ?? false,
      prerelease: options.prerelease ?? true,
      immutable: options.immutable ?? true,
      published_at: PUBLISHED_AT,
      target_commitish: SOURCE_COMMIT,
      html_url: `${WEB_ORIGIN}/${REPOSITORY}/releases/tag/${tagName}`,
      body: null,
      assets,
    },
  };
}

function setResponseUrl(response: Response, url: string): Response {
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function jsonResponse(
  payload: unknown,
  options: {
    contentLength?: string;
    contentType?: string;
    status?: number;
    url?: string;
  } = {},
): Response {
  const body = JSON.stringify(payload);
  return setResponseUrl(
    new Response(body, {
      status: options.status ?? 200,
      headers: {
        'content-type':
          options.contentType ?? 'application/json; charset=utf-8',
        ...(options.contentLength
          ? { 'content-length': options.contentLength }
          : {}),
      },
    }),
    options.url ?? COMMUNITY_RELEASES_API_URL,
  );
}

function checksumResponse(
  body: string,
  url: string,
  options: { contentType?: string; status?: number } = {},
): Response {
  return setResponseUrl(
    new Response(body, {
      status: options.status ?? 200,
      headers: {
        'content-type': options.contentType ?? 'text/plain; charset=utf-8',
      },
    }),
    url,
  );
}

function releaseFetch(
  payload: unknown,
  fixtures: ReleaseFixture[] = [],
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === COMMUNITY_RELEASES_API_URL) return jsonResponse(payload);
    const fixture = fixtures.find((candidate) => candidate.checksumUrl === url);
    if (fixture) {
      return checksumResponse(fixture.checksumBody, fixture.checksumUrl);
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
}

function observedRequest(overrides: Record<string, unknown> = {}) {
  return {
    distributionMode: 'community-observed' as const,
    currentVersion: '1.16.0-communityobserved9',
    platform: 'darwin',
    architecture: 'arm64',
    ...overrides,
  };
}

function checksumAsset(fixture: ReleaseFixture): Record<string, unknown> {
  return fixture.release.assets.find((asset) => asset.name === CHECKSUM_NAME)!;
}

function replaceChecksumBody(fixture: ReleaseFixture, body: string): void {
  fixture.checksumBody = body;
  const asset = checksumAsset(fixture);
  asset.size = body.length;
  asset.digest = `sha256:${digest(body)}`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('community build version comparison', () => {
  it('parses only canonical positive community build versions', () => {
    expect(parseCommunityBuildVersion('1.16.0-community42')).toEqual({
      distributionMode: 'community-unsigned',
      version: '1.16.0-community42',
      base: [1, 16, 0],
      buildCounter: 42,
    });
    expect(parseCommunityBuildVersion('1.16.0-communityobserved14')).toEqual({
      distributionMode: 'community-observed',
      version: '1.16.0-communityobserved14',
      base: [1, 16, 0],
      buildCounter: 14,
    });
    expect(parseCommunityBuildVersion('1.16.0-communityobserved0')).toBeNull();
    expect(
      parseCommunityBuildVersion('1.16.0-communityobserved014'),
    ).toBeNull();
    expect(parseCommunityBuildVersion('1.16.0-preview.2')).toBeNull();
    expect(
      parseCommunityBuildVersion('9007199254740992.16.0-communityobserved14'),
    ).toBeNull();
  });

  it('compares base SemVer and build counters numerically', () => {
    const build9 = parseCommunityBuildVersion('1.16.0-communityobserved9')!;
    const build10 = parseCommunityBuildVersion('1.16.0-communityobserved10')!;
    const nextBase = parseCommunityBuildVersion('1.16.1-communityobserved1')!;
    expect(compareCommunityBuildVersions(build10, build9)).toBeGreaterThan(0);
    expect(compareCommunityBuildVersions(nextBase, build10)).toBeGreaterThan(0);
  });

  it('enables only the exact published platform matrix', () => {
    for (const [platform, architecture] of [
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'x64'],
      ['win32', 'x64'],
    ] as const) {
      expect(
        isCommunityManualUpdateSupported({
          distributionMode: 'community-observed',
          currentVersion: '1.16.0-communityobserved14',
          releaseChannel: 'release',
          platform,
          architecture,
        }),
      ).toBe(true);
    }
    for (const [platform, architecture] of [
      ['linux', 'arm64'],
      ['win32', 'arm64'],
      ['darwin', 'ia32'],
    ] as const) {
      expect(
        isCommunityManualUpdateSupported({
          distributionMode: 'community-observed',
          currentVersion: '1.16.0-communityobserved14',
          releaseChannel: 'release',
          platform,
          architecture,
        }),
      ).toBe(false);
    }
    expect(
      isCommunityManualUpdateSupported({
        distributionMode: 'community-unsigned',
        currentVersion: '1.16.0-communityobserved14',
        releaseChannel: 'release',
        platform: 'darwin',
        architecture: 'arm64',
      }),
    ).toBe(false);
  });
});

describe('community manual update discovery', () => {
  it('selects the newest exact release and verifies checksum coverage', async () => {
    const build10 = buildRelease({
      version: '1.16.0-communityobserved10',
    });
    const nextBase = buildRelease({
      version: '1.16.1-communityobserved1',
    });
    const oldBase = buildRelease({
      version: '1.16.0-communityobserved99',
    });
    const fetchImpl = releaseFetch(
      [build10.release, nextBase.release, oldBase.release],
      [build10, nextBase, oldBase],
    );

    await expect(
      discoverCommunityManualUpdate({
        ...observedRequest(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      status: 'available',
      releaseName: '1.16.1-communityobserved1',
      releasePageUrl:
        `${WEB_ORIGIN}/${REPOSITORY}/releases/tag/` +
        'v1.16.1-communityobserved1',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      COMMUNITY_RELEASES_API_URL,
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: expect.objectContaining({
          'User-Agent': 'clodex-community-manual-update',
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      nextBase.checksumUrl,
      expect.objectContaining({
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: expect.objectContaining({
          'User-Agent': 'clodex-community-manual-update',
        }),
      }),
    );
  });

  it('supports the exact six-asset future community-unsigned contract', async () => {
    const candidate = buildRelease({
      distributionMode: 'community-unsigned',
      version: '1.16.0-community5',
    });
    await expect(
      discoverCommunityManualUpdate({
        distributionMode: 'community-unsigned',
        currentVersion: '1.16.0-community4',
        platform: 'darwin',
        architecture: 'arm64',
        fetchImpl: releaseFetch(
          [candidate.release],
          [candidate],
        ) as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({
      status: 'available',
      releaseName: '1.16.0-community5',
    });
    expect(candidate.release.assets).toHaveLength(6);
  });

  it('does not fully validate unrelated or non-newer releases', async () => {
    const payload = [
      {
        tag_name: 'v1.16.0-preview.2',
        body: { deliberately: 'not a GitHub release body' },
        assets: 'not-an-array',
      },
      {
        tag_name: 'release/with/slashes',
        body: 42,
      },
      {
        tag_name: 'v1.16.0-communityobserved8',
        draft: false,
        prerelease: true,
        immutable: false,
      },
    ];
    const fetchImpl = releaseFetch(payload);
    await expect(
      discoverCommunityManualUpdate({
        ...observedRequest(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ status: 'current' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'mutable release',
      mutate: (fixture: ReleaseFixture) => {
        fixture.release.immutable = false;
      },
    },
    {
      label: 'missing publication time',
      mutate: (fixture: ReleaseFixture) => {
        delete fixture.release.published_at;
      },
    },
    {
      label: 'non-canonical publication time',
      mutate: (fixture: ReleaseFixture) => {
        fixture.release.published_at = '2026-02-30T12:00:00Z';
      },
    },
    {
      label: 'branch target instead of an exact source SHA',
      mutate: (fixture: ReleaseFixture) => {
        fixture.release.target_commitish = 'main';
      },
    },
    {
      label: 'non-canonical release page',
      mutate: (fixture: ReleaseFixture) => {
        fixture.release.html_url =
          'https://github.example.com/mereyabdenbekuly-ctrl/clodex-ide/releases';
      },
    },
  ])('rejects a matching newer $label', async ({ mutate }) => {
    const candidate = buildRelease({
      version: '1.16.0-communityobserved15',
    });
    mutate(candidate);
    await expect(
      discoverCommunityManualUpdate({
        ...observedRequest(),
        fetchImpl: releaseFetch(
          [candidate.release],
          [candidate],
        ) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'response-invalid' });
  });

  it.each([
    {
      label: 'missing evidence asset',
      mutate: (fixture: ReleaseFixture) => {
        fixture.release.assets = fixture.release.assets.filter(
          (asset) => !String(asset.name).endsWith('-evidence.zip'),
        );
      },
    },
    {
      label: 'unexpected legacy filename',
      mutate: (fixture: ReleaseFixture) => {
        const asset = fixture.release.assets.find((entry) =>
          String(entry.name).endsWith('-arm64.dmg'),
        )!;
        asset.name = String(asset.name).replace(
          '-arm64.dmg',
          '-macos-arm64.dmg',
        );
      },
    },
    {
      label: 'duplicate asset',
      mutate: (fixture: ReleaseFixture) => {
        fixture.release.assets[1] = { ...fixture.release.assets[0] };
      },
    },
    {
      label: 'duplicate asset ID',
      mutate: (fixture: ReleaseFixture) => {
        const duplicateId = fixture.release.assets[0]!.id;
        fixture.release.assets[1]!.id = duplicateId;
        fixture.release.assets[1]!.url =
          `${API_ORIGIN}/repos/${REPOSITORY}/releases/assets/${duplicateId}`;
      },
    },
  ])('rejects an invalid exact asset set: $label', async ({ mutate }) => {
    const candidate = buildRelease({
      version: '1.16.0-communityobserved15',
    });
    mutate(candidate);
    await expect(
      discoverCommunityManualUpdate({
        ...observedRequest(),
        fetchImpl: releaseFetch(
          [candidate.release],
          [candidate],
        ) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'response-invalid' });
  });

  it.each([
    {
      label: 'non-positive ID',
      mutate: (asset: Record<string, unknown>) => {
        asset.id = 0;
      },
    },
    {
      label: 'non-canonical API URL',
      mutate: (asset: Record<string, unknown>) => {
        asset.url = `${API_ORIGIN}/repos/${REPOSITORY}/releases/assets/999999`;
      },
    },
    {
      label: 'missing GitHub digest',
      mutate: (asset: Record<string, unknown>) => {
        delete asset.digest;
      },
    },
    {
      label: 'oversized asset',
      mutate: (asset: Record<string, unknown>) => {
        asset.size = 2 * 1024 ** 3;
      },
    },
    {
      label: 'non-canonical download URL',
      mutate: (asset: Record<string, unknown>) => {
        asset.browser_download_url = `${String(asset.browser_download_url)}?x=1`;
      },
    },
  ])('rejects invalid asset metadata: $label', async ({ mutate }) => {
    const candidate = buildRelease({
      version: '1.16.0-communityobserved15',
    });
    mutate(candidate.release.assets[0]!);
    await expect(
      discoverCommunityManualUpdate({
        ...observedRequest(),
        fetchImpl: releaseFetch(
          [candidate.release],
          [candidate],
        ) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'response-invalid' });
  });

  it('rejects checksum bytes that do not match the GitHub digest', async () => {
    const candidate = buildRelease({
      version: '1.16.0-communityobserved15',
    });
    candidate.checksumBody += 'tampered';
    await expect(
      discoverCommunityManualUpdate({
        ...observedRequest(),
        fetchImpl: releaseFetch(
          [candidate.release],
          [candidate],
        ) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'response-invalid' });
  });

  it.each([
    {
      label: 'missing covered asset',
      mutate: (fixture: ReleaseFixture) => {
        const lines = fixture.checksumBody.trimEnd().split('\n');
        replaceChecksumBody(fixture, `${lines.slice(1).join('\n')}\n`);
      },
    },
    {
      label: 'checksum digest mismatch',
      mutate: (fixture: ReleaseFixture) => {
        const lines = fixture.checksumBody.trimEnd().split('\n');
        lines[0] = `${'f'.repeat(64)}${lines[0]!.slice(64)}`;
        replaceChecksumBody(fixture, `${lines.join('\n')}\n`);
      },
    },
    {
      label: 'non-canonical ordering',
      mutate: (fixture: ReleaseFixture) => {
        const lines = fixture.checksumBody.trimEnd().split('\n').reverse();
        replaceChecksumBody(fixture, `${lines.join('\n')}\n`);
      },
    },
  ])('rejects invalid checksum coverage: $label', async ({ mutate }) => {
    const candidate = buildRelease({
      version: '1.16.0-communityobserved15',
    });
    mutate(candidate);
    await expect(
      discoverCommunityManualUpdate({
        ...observedRequest(),
        fetchImpl: releaseFetch(
          [candidate.release],
          [candidate],
        ) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'response-invalid' });
  });

  it('allows exactly one allowlisted checksum redirect', async () => {
    const candidate = buildRelease({
      version: '1.16.0-communityobserved15',
    });
    const redirectUrl =
      'https://release-assets.githubusercontent.com/github-production-release-asset/1/checksums?token=bounded';
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === COMMUNITY_RELEASES_API_URL) {
          return jsonResponse([candidate.release]);
        }
        if (url === candidate.checksumUrl) {
          return setResponseUrl(
            new Response(null, {
              status: 302,
              headers: { location: redirectUrl },
            }),
            candidate.checksumUrl,
          );
        }
        if (url === redirectUrl) {
          expect(init?.redirect).toBe('error');
          return checksumResponse(candidate.checksumBody, redirectUrl);
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      },
    );

    await expect(
      discoverCommunityManualUpdate({
        ...observedRequest(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ status: 'available' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects a checksum redirect to a non-allowlisted origin', async () => {
    const candidate = buildRelease({
      version: '1.16.0-communityobserved15',
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === COMMUNITY_RELEASES_API_URL) {
        return jsonResponse([candidate.release]);
      }
      return setResponseUrl(
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/checksums' },
        }),
        candidate.checksumUrl,
      );
    });
    await expect(
      discoverCommunityManualUpdate({
        ...observedRequest(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'response-invalid' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: 'non-canonical API response URL',
      response: () =>
        jsonResponse([], {
          url: 'https://api.github.example.com/repos/clodex/releases',
        }),
      code: 'response-invalid',
    },
    {
      label: 'non-JSON content type',
      response: () => jsonResponse([], { contentType: 'text/html' }),
      code: 'response-invalid',
    },
    {
      label: 'HTTP failure',
      response: () => jsonResponse([], { status: 403 }),
      code: 'request-failed',
    },
    {
      label: 'oversized declared response',
      response: () => jsonResponse([], { contentLength: '2097153' }),
      code: 'response-too-large',
    },
  ])('rejects and cancels $label', async ({ response, code }) => {
    let cancelled = false;
    const original = response();
    const body = original.body;
    const wrapped = setResponseUrl(
      new Response(
        new ReadableStream({
          async pull(controller) {
            if (!body) {
              controller.close();
              return;
            }
            const reader = body.getReader();
            const value = await reader.read();
            if (value.done) controller.close();
            else controller.enqueue(value.value);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: original.status, headers: original.headers },
      ),
      original.url,
    );
    await expect(
      discoverCommunityManualUpdate({
        ...observedRequest(),
        fetchImpl: vi.fn(async () => wrapped) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code });
    expect(cancelled).toBe(true);
  });

  it('bounds and cancels streamed response bytes without content-length', async () => {
    let cancelled = false;
    const response = setResponseUrl(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('0123456789'));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
      COMMUNITY_RELEASES_API_URL,
    );
    await expect(
      discoverCommunityManualUpdate({
        ...observedRequest(),
        maxResponseBytes: 8,
        fetchImpl: vi.fn(async () => response) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'response-too-large' });
    expect(cancelled).toBe(true);
  });

  it('aborts a stalled release request at the configured timeout', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    ) as unknown as typeof fetch;
    const check = discoverCommunityManualUpdate({
      ...observedRequest(),
      timeoutMs: 25,
      fetchImpl,
    });
    const expectation = expect(check).rejects.toMatchObject({
      code: 'request-timeout',
    });
    await vi.advanceTimersByTimeAsync(25);
    await expectation;
  });
});

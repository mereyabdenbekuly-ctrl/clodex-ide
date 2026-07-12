import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './index.js';

describe('createApiClient', () => {
  it('builds authenticated GET requests with encoded query parameters', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ results: [], searchFilterApplied: false }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const client = createApiClient('https://clodex.xyz/api/', {
      headers: { Authorization: 'Bearer test-token' },
      fetcher,
    });

    const result = await client.v1.context7.search.get({
      query: { libraryName: 'React Router', query: 'data loading' },
    });

    expect(result.error).toBeNull();
    const [url, init] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      'https://clodex.xyz/api/v1/context7/search?libraryName=React+Router&query=data+loading',
    );
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer test-token',
    );
  });

  it('posts JSON upload metadata', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          uploadUrl: 'https://upload.example',
          uploadFields: { key: 'asset' },
          readUrl: 'https://cdn.example/asset',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = createApiClient('https://clodex.xyz/api', { fetcher });

    const result = await client.v1.assets.upload.post({
      filename: 'image.png',
      mediaType: 'image/png',
      contentLength: 42,
    });

    expect(result.error).toBeNull();
    const [, init] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      filename: 'image.png',
      mediaType: 'image/png',
      contentLength: 42,
    });
  });

  it('returns a bounded error object for non-success responses', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = createApiClient('https://clodex.xyz/api', { fetcher });

    const result = await client.v1.inspiration.get();

    expect(result.data).toBeNull();
    expect(result.error).toEqual({
      status: 401,
      body: { message: 'Unauthorized' },
    });
  });
});

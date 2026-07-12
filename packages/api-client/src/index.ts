export interface CreateApiClientOptions {
  headers?: HeadersInit | (() => HeadersInit);
  fetcher?: typeof globalThis.fetch;
}

export interface ApiClientError {
  status: number;
  body: unknown;
}

export type ApiResult<T> =
  | { data: T; error: null; response: Response }
  | { data: null; error: ApiClientError; response: Response };

export interface ContextLibraryResult {
  id: string;
  description: string;
  state: 'error' | 'finalized' | 'initial' | 'processing' | 'delete';
  title: string;
  branch: string;
  lastUpdateDate: string;
  totalTokens: number;
  totalSnippets: number;
  stars: number;
  trustScore: number;
  benchmarkScore: number;
  versions: string[];
  score: number;
  vip: boolean;
  verified: boolean;
}

export interface InspirationResponse {
  websites: Array<{
    tags: Array<{
      name: string;
      id: string;
      created_at: string | Date;
      updated_at: string | Date;
    }>;
    id: string;
    url: string;
    created_at: string | Date;
    updated_at: string | Date;
    screenshot_url: string | null;
    screen_video_url: string | null;
  }>;
  total: number;
  seed: string;
}

export interface AssetUploadRequest {
  filename: string;
  mediaType: string;
  contentLength: number;
}

export interface AssetUploadResponse {
  uploadUrl: string;
  uploadFields: Record<string, string>;
  readUrl: string;
}

type QueryValue = string | number | boolean | null | undefined;

function appendQuery(url: URL, query: Record<string, QueryValue>): void {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  if (response.headers.get('content-type')?.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

export function createApiClient(
  baseUrl: string,
  options: CreateApiClientOptions = {},
) {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

  const request = async <T>(
    path: string,
    init: RequestInit & { query?: Record<string, QueryValue> } = {},
  ): Promise<ApiResult<T>> => {
    const url = new URL(`${normalizedBaseUrl}${path}`);
    if (init.query) appendQuery(url, init.query);

    const headers = new Headers(
      typeof options.headers === 'function'
        ? options.headers()
        : options.headers,
    );
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));

    const response = await fetcher(url, { ...init, headers });
    const payload = await parseResponse(response);
    if (response.ok) {
      return { data: payload as T, error: null, response };
    }
    return {
      data: null,
      error: { status: response.status, body: payload },
      response,
    };
  };

  return {
    v1: {
      assets: {
        upload: {
          post: (body: AssetUploadRequest) =>
            request<AssetUploadResponse>('/v1/assets/upload', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
        },
      },
      context7: {
        search: {
          get: ({ query }: { query: { query: string; libraryName: string } }) =>
            request<{
              results: ContextLibraryResult[];
              searchFilterApplied: boolean;
            }>('/v1/context7/search', { query }),
        },
        docs: {
          get: ({
            query,
          }: {
            query: {
              type?: 'json' | 'txt';
              query: string;
              libraryId: string;
            };
          }) => request<unknown>('/v1/context7/docs', { query }),
        },
      },
      inspiration: {
        get: ({
          query = {},
        }: {
          query?: {
            limit?: string;
            offset?: string;
            tagIds?: string;
            seed?: string;
          };
        } = {}) => request<InspirationResponse>('/v1/inspiration', { query }),
      },
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

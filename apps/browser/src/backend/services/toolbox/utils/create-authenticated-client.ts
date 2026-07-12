import { createApiClient, type ApiClient } from '@clodex/api-client';
import { API_URL } from '@/services/auth/server-interop';

export function createAuthenticatedClient(accessToken: string): ApiClient {
  try {
    return createApiClient(API_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      fetcher: fetch,
    });
  } catch (error) {
    console.error(
      '[createAuthenticatedClient]: Error creating authenticated client',
      error,
    );
    throw error;
  }
}

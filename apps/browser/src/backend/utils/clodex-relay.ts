const DEFAULT_CLODEX_LLM_RELAY_URL = 'https://clodex.xyz/v1';

/**
 * Resolve the trusted managed-model relay endpoint.
 *
 * Keep this independent from persisted provider profiles: the reserved
 * Clodex account credential must never be redirected by user-editable state.
 */
export function getClodexLlmRelayUrl(): string {
  return (
    process.env.CLODEX_LLM_RELAY_URL ||
    process.env.LLM_PROXY_URL ||
    DEFAULT_CLODEX_LLM_RELAY_URL
  );
}

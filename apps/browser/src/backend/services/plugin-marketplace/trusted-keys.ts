/**
 * Public Ed25519 keys accepted for the bundled official marketplace index.
 *
 * Private signing material is intentionally kept outside the repository.
 * Add a new key before rotating an old one so already-packaged clients can
 * verify an overlap index during the rollout window.
 */
export const OFFICIAL_PLUGIN_MARKETPLACE_KEYS: Readonly<
  Record<string, string>
> = {
  'clodex-official-2026-01': [
    '-----BEGIN PUBLIC KEY-----',
    'MCowBQYDK2VwAyEAmtXDsSMwk5v2GM/4QzVB38heq2oSkyWO2spmWg2PS5w=',
    '-----END PUBLIC KEY-----',
  ].join('\n'),
};

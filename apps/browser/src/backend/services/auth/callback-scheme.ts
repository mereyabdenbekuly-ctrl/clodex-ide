type AuthCallbackScheme =
  | 'clodex-ide'
  | 'clodex'
  | 'clodex-prerelease'
  | 'clodex-nightly'
  | 'clodex-dev';

function getDefaultAuthCallbackScheme(): AuthCallbackScheme {
  if (process.env.CLODEX_AUTH_CALLBACK_SCHEME) {
    return process.env.CLODEX_AUTH_CALLBACK_SCHEME as AuthCallbackScheme;
  }

  switch (__APP_RELEASE_CHANNEL__) {
    case 'release':
      return 'clodex-ide';
    case 'prerelease':
      return 'clodex-ide';
    case 'nightly':
      return 'clodex-ide';
    case 'dev':
      return 'clodex-ide';
    default:
      throw new Error(
        `Unexpected app release channel for auth callback scheme: ${String(__APP_RELEASE_CHANNEL__)}`,
      );
  }
}

export const AUTH_CALLBACK_SCHEME = getDefaultAuthCallbackScheme();

export const AUTH_CALLBACK_PROTOCOL = `${AUTH_CALLBACK_SCHEME}:`;

// All valid clodex callback protocols. The URIHandlerService registers
// both the stable `clodex` scheme and the build's own scheme, so the app
// may receive callbacks on either protocol — e.g. a dev build sends
// `callback_scheme=clodex-dev` to the console, but the console's
// allowlist may fall back to `clodex://`, which the OS still routes to
// this app. handleAuthCallbackUrl must accept any of these.
const ALL_CALLBACK_SCHEMES: readonly AuthCallbackScheme[] = [
  'clodex-ide',
  'clodex',
  'clodex-prerelease',
  'clodex-nightly',
  'clodex-dev',
];

export const ALL_CALLBACK_PROTOCOLS = new Set(
  ALL_CALLBACK_SCHEMES.map((s) => `${s}:`),
);

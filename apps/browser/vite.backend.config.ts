import path from 'node:path';
import { defineConfig } from 'vite';
import * as buildConstants from './build-constants';

const backendPostHogApiKey = buildConstants.__APP_TELEMETRY_ENABLED__
  ? process.env.POSTHOG_API_KEY?.trim()
  : undefined;
const backendClodexApiUrl =
  process.env.CLODEX_API_URL ?? process.env.API_URL ?? 'https://clodex.xyz/api';

if (
  buildConstants.__APP_DISTRIBUTION_MODE__ === 'community-observed' &&
  !/^phc_[A-Za-z0-9_-]{20,}$/u.test(backendPostHogApiKey ?? '')
) {
  throw new Error(
    'community-observed backend build requires a non-empty PostHog project API key',
  );
}

// https://vitejs.dev/config
export default defineConfig({
  build: {
    target: 'esnext',
    sourcemap: 'hidden',
    lib: {
      formats: ['es'],
      entry: 'src/backend/index.ts',
      name: 'main',
      fileName: 'main',
    },
    rollupOptions: {
      external: [
        '@libsql/client',
        'sharp',
        'node-pty',
        '@xterm/headless',
        'web-tree-sitter',
        '@vscode/tree-sitter-wasm',
      ],
      output: {
        // The ESM main bundle includes CJS dependencies (e.g.
        // `proxy-from-env`, pulled in via `@clodex/agent-runtime-node` ->
        // `axios`) that call `require(...)` at load time. In an ES module
        // `require` is undefined, so esbuild's dynamic-require shim throws
        // ("Dynamic require of \"url\" is not supported"). Provide a real
        // `require` via `createRequire` so those calls resolve Node builtins.
        banner:
          "import { createRequire as __clodexCreateRequire } from 'node:module'; var require = __clodexCreateRequire(import.meta.url);",
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/backend'),
      '@shared': path.resolve(__dirname, './src/shared'),
    },
    conditions: ['node'],
    mainFields: ['module', 'main'],
  },
  define: {
    'process.env': JSON.stringify({
      BUILD_MODE: process.env.BUILD_MODE ?? 'production',
      NODE_ENV: process.env.NODE_ENV ?? 'production',
      POSTHOG_API_KEY: backendPostHogApiKey,
      POSTHOG_HOST:
        buildConstants.__APP_DISTRIBUTION_MODE__ === 'community-observed'
          ? 'https://eu.i.posthog.com'
          : (process.env.POSTHOG_HOST ?? 'https://eu.i.posthog.com'),
      CLODEX_CONSOLE_URL:
        process.env.CLODEX_CONSOLE_URL ??
        process.env.CLODEX_ORIGIN ??
        'https://clodex.xyz',
      API_URL: backendClodexApiUrl,
      LLM_PROXY_URL:
        process.env.LLM_PROXY_URL ??
        process.env.CLODEX_LLM_RELAY_URL ??
        'https://clodex.xyz/v1',
      CLODEX_ORIGIN: process.env.CLODEX_ORIGIN ?? 'https://clodex.xyz',
      CLODEX_LOGIN_URL:
        process.env.CLODEX_LOGIN_URL ?? 'https://clodex.xyz/login',
      CLODEX_API_URL: backendClodexApiUrl,
      CLODEX_LLM_RELAY_URL:
        process.env.CLODEX_LLM_RELAY_URL ?? 'https://clodex.xyz/v1',
      CLODEX_MCP_GATEWAY_URL:
        process.env.CLODEX_MCP_GATEWAY_URL ??
        'https://clodex.xyz/tools-gateway/mcp',
      CLODEX_AUTH_CALLBACK_SCHEME:
        process.env.CLODEX_AUTH_CALLBACK_SCHEME ?? 'clodex-ide',
      CLODEX_IDE_CLIENT_ID:
        buildConstants.__APP_DISTRIBUTION_MODE__ === 'community-observed'
          ? 'clodex-community-observed'
          : (process.env.CLODEX_IDE_CLIENT_ID ?? 'clodex-ide'),
      CLODEX_AUTH_ENABLED:
        buildConstants.__APP_DISTRIBUTION_MODE__ === 'community-observed'
          ? 'true'
          : buildConstants.__APP_AUTH_ENABLED__
            ? (process.env.CLODEX_AUTH_ENABLED ?? 'true')
            : 'false',
      CLODEX_DISABLE_ISOLATED_AGENT_RUNTIME:
        process.env.CLODEX_DISABLE_ISOLATED_AGENT_RUNTIME,
      UPDATE_SERVER_ORIGIN: buildConstants.__APP_AUTO_UPDATE_ENABLED__
        ? process.env.UPDATE_SERVER_ORIGIN
        : undefined,
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
    }),
    ...Object.fromEntries(
      Object.entries(buildConstants).map(([key, value]) => [
        key,
        JSON.stringify(value),
      ]),
    ),
  },
});

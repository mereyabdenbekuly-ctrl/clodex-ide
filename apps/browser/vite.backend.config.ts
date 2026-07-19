import path from 'node:path';
import { defineConfig } from 'vite';
import * as buildConstants from './build-constants';
import { resolveBackendBuildEnvironment } from './community-free-build-policy.mjs';

const backendBuildEnvironment = resolveBackendBuildEnvironment({
  authEnabled: buildConstants.__APP_AUTH_ENABLED__,
  autoUpdateEnabled: buildConstants.__APP_AUTO_UPDATE_ENABLED__,
  distributionMode: buildConstants.__APP_DISTRIBUTION_MODE__,
  environment: process.env,
  managedServicesEnabled: buildConstants.__APP_MANAGED_SERVICES_ENABLED__,
  telemetryEnabled: buildConstants.__APP_TELEMETRY_ENABLED__,
});
const backendPostHogApiKey = backendBuildEnvironment.POSTHOG_API_KEY;
const disabledManagedMcpService = path.resolve(
  __dirname,
  './src/backend/services/toolbox/services/clodex-mcp/community-disabled.ts',
);

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
    alias: [
      ...(!buildConstants.__APP_MANAGED_SERVICES_ENABLED__
        ? [
            {
              find: /^\.\/services\/clodex-mcp$/u,
              replacement: disabledManagedMcpService,
            },
          ]
        : []),
      { find: '@', replacement: path.resolve(__dirname, './src/backend') },
      {
        find: '@shared',
        replacement: path.resolve(__dirname, './src/shared'),
      },
    ],
    conditions: ['node'],
    mainFields: ['module', 'main'],
  },
  define: {
    'process.env': JSON.stringify(backendBuildEnvironment),
    ...Object.fromEntries(
      Object.entries(buildConstants).map(([key, value]) => [
        key,
        JSON.stringify(value),
      ]),
    ),
  },
});

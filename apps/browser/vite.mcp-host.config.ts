import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  ssr: {
    // The packaged app intentionally ships only a small native dependency
    // allowlist. Bundle the MCP SDK and its pure-JS runtime dependencies into
    // the isolated host so the packaged worker never depends on pruned modules.
    noExternal: true,
  },
  build: {
    ssr: true,
    target: 'esnext',
    sourcemap: 'hidden',
    lib: {
      formats: ['cjs'],
      entry: 'src/backend/mcp-host/host.ts',
      fileName: 'mcp-host',
    },
    rollupOptions: {
      output: {
        entryFileNames: 'mcp-host.cjs',
      },
    },
    emptyOutDir: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/backend'),
      '@shared': path.resolve(__dirname, './src/shared'),
    },
    conditions: ['node'],
    mainFields: ['module', 'main'],
  },
});

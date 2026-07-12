import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: true,
    target: 'esnext',
    sourcemap: 'hidden',
    lib: {
      formats: ['es'],
      entry: 'scripts/agent-host-step-executor-smoke.ts',
      fileName: 'agent-host-smoke',
    },
    rollupOptions: {
      external: ['electron'],
      output: {
        entryFileNames: 'agent-host-smoke.mjs',
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

import path from 'node:path';
import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    target: 'esnext',
    sourcemap: 'hidden',
    lib: {
      formats: ['cjs'],
      entry: 'src/backend/services/sandbox/sandbox-worker.ts',
      fileName: 'sandbox-worker',
    },
    // Don't clear the output directory — other build entries (main.js) live here too
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

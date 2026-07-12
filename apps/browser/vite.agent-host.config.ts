import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: true,
    target: 'esnext',
    sourcemap: 'hidden',
    lib: {
      formats: ['cjs'],
      entry: 'src/backend/agent-host/host.ts',
      fileName: 'agent-host',
    },
    rollupOptions: {
      output: {
        entryFileNames: 'agent-host.cjs',
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

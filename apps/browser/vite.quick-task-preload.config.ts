import { defineConfig } from 'vite';
import * as buildConstants from './build-constants';

export default defineConfig({
  build: {
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        dir: '.vite/build/quick-task-preload',
      },
    },
  },
  define: {
    ...Object.fromEntries(
      Object.entries(buildConstants).map(([key, value]) => [
        key,
        JSON.stringify(value),
      ]),
    ),
  },
});

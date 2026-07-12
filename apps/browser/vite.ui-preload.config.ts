import { defineConfig } from 'vite';
import * as buildConstants from './build-constants';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        dir: '.vite/build/ui-preload',
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

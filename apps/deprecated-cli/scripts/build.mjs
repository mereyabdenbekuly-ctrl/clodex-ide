import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.mjs',
  format: 'esm',
  platform: 'node',
  target: 'node18',
  bundle: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});

console.log('Built dist/index.mjs');

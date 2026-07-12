#!/usr/bin/env node

import esbuild from 'esbuild';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

rmSync(resolve(__dirname, 'dist'), { recursive: true, force: true });
mkdirSync(resolve(__dirname, 'dist'), { recursive: true });

console.log('Building @clodex/mcp-runtime...');
await esbuild.build({
  entryPoints: {
    index: 'src/index.ts',
    config: 'src/config.ts',
    policy: 'src/policy.ts',
    protocol: 'src/protocol.ts',
  },
  bundle: true,
  outdir: 'dist',
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: true,
  external: ['zod'],
});

console.log('Generating TypeScript declarations...');
execSync('tsc --emitDeclarationOnly --outDir dist', { stdio: 'inherit' });

console.log('Build complete.');

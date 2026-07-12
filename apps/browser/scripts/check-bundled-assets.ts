#!/usr/bin/env tsx

import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  assertBundledAssetsSafe,
  formatBytes,
} from '../src/backend/utils/bundled-assets';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const browserRoot = path.resolve(scriptDirectory, '..');

const { values } = parseArgs({
  options: {
    root: {
      type: 'string',
    },
  },
});

const bundledRoot = values.root
  ? path.resolve(values.root)
  : path.join(browserRoot, 'bundled');

try {
  const report = assertBundledAssetsSafe(bundledRoot);
  console.log(
    `[bundled-assets] OK: ${report.fileCount.toLocaleString('en-US')} files, ${formatBytes(report.totalBytes)}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

import path from 'node:path';
import type { Plugin } from 'vite';
import { writeLicenseUiJson } from '../scripts/release-attribution.mjs';

function generateLicensesJson(appRoot: string, outPath: string): void {
  const repositoryDirectory = path.resolve(appRoot, '../..');
  const releaseChannel = process.env.RELEASE_CHANNEL ?? 'dev';
  const result = writeLicenseUiJson({
    appDirectory: appRoot,
    outputPath: outPath,
    releaseChannel,
    repositoryDirectory,
  });
  console.log(
    `[license-plugin] Generated ${result.entries.length} verified/open-source inventory entries with ${result.blockers.length} blocker(s) → ${path.relative(appRoot, outPath)}`,
  );
}

export function licensePlugin(): Plugin {
  let appRoot: string;
  let outPath: string;

  return {
    name: 'clodex-license-plugin',

    configResolved(config) {
      appRoot = path.resolve(config.root, '../..');
      outPath = path.resolve(appRoot, 'src/pages/generated/licenses.json');
    },

    buildStart() {
      generateLicensesJson(appRoot, outPath);
    },

    configureServer() {
      generateLicensesJson(appRoot, outPath);
    },
  };
}

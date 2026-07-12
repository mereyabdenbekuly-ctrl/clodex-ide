import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, '../../..');
const versionFile = path.join(repositoryDirectory, '.node-version');
const expectedVersion = readFileSync(versionFile, 'utf8').trim();
const actualVersion = process.version.replace(/^v/, '');

if (actualVersion !== expectedVersion) {
  console.error(
    [
      `[packaging-runtime] Expected Node ${expectedVersion}, got ${actualVersion}.`,
      'Electron packaging uses native maker dependencies that must run under the pinned Node ABI.',
      'Activate the version from .node-version/.nvmrc, reinstall dependencies if needed, and retry.',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(
  `[packaging-runtime] Node ${actualVersion} (ABI ${process.versions.modules}) matches the pinned packaging runtime.`,
);

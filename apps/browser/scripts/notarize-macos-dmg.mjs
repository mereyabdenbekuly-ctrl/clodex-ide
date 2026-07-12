import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const browserDirectory = path.resolve(scriptDirectory, '..');

const channelBaseNames = {
  dev: 'clodex-dev',
  nightly: 'clodex-nightly',
  prerelease: 'clodex-prerelease',
  release: 'clodex',
};

function readOption(values, name, fallback) {
  const prefix = `--${name}=`;
  return (
    values.find((value) => value.startsWith(prefix))?.slice(prefix.length) ??
    fallback
  );
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: browserDirectory,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ''} failed with exit ${result.status}`,
    );
  }
}

if (process.platform !== 'darwin') {
  throw new Error('DMG notarization must run on macOS');
}

const values = process.argv.slice(2).filter((value) => value !== '--');
if (values.includes('--help')) {
  console.log(`
Notarize and staple a Clodex macOS DMG.

Usage:
  node scripts/notarize-macos-dmg.mjs [options]

Options:
  --channel=<dev|nightly|prerelease|release>
  --arch=<arm64|x64>
  --version=<semver>
  --dmg=<absolute-or-browser-relative-path>
`);
  process.exit(0);
}

const packageJson = JSON.parse(
  readFileSync(path.join(browserDirectory, 'package.json'), 'utf8'),
);
const channel = readOption(
  values,
  'channel',
  process.env.RELEASE_CHANNEL ?? 'release',
);
const arch = readOption(values, 'arch', process.arch);
const version = readOption(
  values,
  'version',
  process.env.APP_VERSION_OVERRIDE ?? packageJson.version,
);

if (!(channel in channelBaseNames)) {
  throw new Error(`Unsupported release channel: ${channel}`);
}
if (!['arm64', 'x64'].includes(arch)) {
  throw new Error(`Unsupported macOS architecture: ${arch}`);
}

const requiredEnvironment = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'];
const missingEnvironment = requiredEnvironment.filter(
  (name) => !process.env[name]?.trim(),
);
if (missingEnvironment.length > 0) {
  throw new Error(
    `Missing notarization environment: ${missingEnvironment.join(', ')}`,
  );
}

const baseName = channelBaseNames[channel];
const explicitDmg = readOption(values, 'dmg', undefined);
const dmgPath = explicitDmg
  ? path.resolve(browserDirectory, explicitDmg)
  : path.join(
      browserDirectory,
      'out',
      channel,
      'make',
      `${baseName}-${version}-${arch}.dmg`,
    );
if (!existsSync(dmgPath)) {
  throw new Error(`DMG not found: ${dmgPath}`);
}

console.log(`[dmg-notarization] Submitting ${dmgPath}`);
run('/usr/bin/xcrun', [
  'notarytool',
  'submit',
  dmgPath,
  '--apple-id',
  process.env.APPLE_ID,
  '--password',
  process.env.APPLE_PASSWORD,
  '--team-id',
  process.env.APPLE_TEAM_ID,
  '--wait',
]);

console.log('[dmg-notarization] Stapling ticket');
run('/usr/bin/xcrun', ['stapler', 'staple', dmgPath]);
run('/usr/bin/xcrun', ['stapler', 'validate', dmgPath]);
console.log('[dmg-notarization] DMG notarization and stapling passed');

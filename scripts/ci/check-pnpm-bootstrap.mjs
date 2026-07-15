import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ignoredLockfileScanDirectories = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

function hasEntries(value) {
  return Boolean(
    value && typeof value === 'object' && Object.keys(value).length,
  );
}

function findNestedPnpmLockfiles(
  directory,
  relativeDirectory = '',
  results = [],
) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    const absolutePath = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (ignoredLockfileScanDirectories.has(entry.name)) continue;
      findNestedPnpmLockfiles(absolutePath, relativePath, results);
      continue;
    }

    if (
      entry.isFile() &&
      entry.name === 'pnpm-lock.yaml' &&
      relativePath !== 'pnpm-lock.yaml'
    ) {
      results.push(relativePath);
    }
  }
  return results;
}

export function checkPnpmBootstrap(rootDirectory) {
  const errors = [];

  // This repository is a single pnpm workspace and the root lockfile is the
  // only dependency graph CI and release tooling install. A nested workspace
  // lockfile can silently retain vulnerable versions that `pnpm audit` at the
  // root never sees, so reject those stale alternate graphs before setup.
  for (const nestedLockfile of findNestedPnpmLockfiles(rootDirectory)) {
    errors.push(
      `${nestedLockfile}: nested workspace lockfiles are not allowed; use the root pnpm-lock.yaml`,
    );
  }

  for (const filename of ['.pnpmfile.cjs', '.pnpmfile.js']) {
    if (existsSync(join(rootDirectory, filename))) {
      errors.push(`${filename}: pnpm manifest-rewrite hooks are not allowed`);
    }
  }

  const manifestPath = join(rootDirectory, 'package.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const [label, value] of [
      ['configDependencies', manifest.configDependencies],
      ['pnpm.configDependencies', manifest.pnpm?.configDependencies],
    ]) {
      if (hasEntries(value)) {
        errors.push(
          `package.json:${label} is not allowed before policy checks`,
        );
      }
    }
    for (const [label, value] of [
      ['pnpmfile', manifest.pnpmfile],
      ['pnpm.pnpmfile', manifest.pnpm?.pnpmfile],
    ]) {
      if (value) {
        errors.push(
          `package.json:${label} is not allowed before policy checks`,
        );
      }
    }
  }

  const workspacePath = join(rootDirectory, 'pnpm-workspace.yaml');
  if (existsSync(workspacePath)) {
    const workspace = readFileSync(workspacePath, 'utf8');
    if (
      /(?:^|[{,\n])\s*["']?(?:configDependencies|pnpmfile)["']?\s*:/u.test(
        workspace,
      )
    ) {
      errors.push(
        'pnpm-workspace.yaml: manifest-rewrite hook configuration is not allowed before policy checks',
      );
    }
  }

  const npmrcPath = join(rootDirectory, '.npmrc');
  if (existsSync(npmrcPath)) {
    for (const [index, line] of readFileSync(npmrcPath, 'utf8')
      .split(/\r?\n/u)
      .entries()) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
        continue;
      }
      const separator = trimmed.indexOf('=');
      const rawKey = (
        separator === -1 ? trimmed : trimmed.slice(0, separator)
      ).trim();
      const unquotedKey =
        rawKey.length >= 2 &&
        ((rawKey.startsWith('"') && rawKey.endsWith('"')) ||
          (rawKey.startsWith("'") && rawKey.endsWith("'")))
          ? rawKey.slice(1, -1).trim()
          : rawKey;
      const key = unquotedKey.toLowerCase().replace(/[-_.\s]/gu, '');
      if (
        key === 'pnpmfile' ||
        key === 'globalpnpmfile' ||
        key.startsWith('configdependencies')
      ) {
        errors.push(
          `.npmrc:${index + 1}: manifest-rewrite hook configuration is not allowed before policy checks`,
        );
      }
    }
  }
  return errors;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const errors = checkPnpmBootstrap(root);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log('pnpm bootstrap policy passed.');
  }
}

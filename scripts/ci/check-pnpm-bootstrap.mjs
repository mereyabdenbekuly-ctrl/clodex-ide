import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function hasEntries(value) {
  return Boolean(
    value && typeof value === 'object' && Object.keys(value).length,
  );
}

export function checkPnpmBootstrap(rootDirectory) {
  const errors = [];
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

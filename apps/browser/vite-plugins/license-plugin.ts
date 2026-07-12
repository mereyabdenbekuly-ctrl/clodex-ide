import {
  readFileSync,
  existsSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  repository: string;
  publisher: string;
  licenseText: string;
}

// Packages that are never bundled into the shipped app (build tools, types, etc.)
const buildOnlyPatterns = [
  /^@types\//,
  /^@clodex\//,
  /^@electron-forge\//,
  /^@electron\//,
  /^@storybook\//,
  /^@vueless\//,
  /^@typescript-eslint\//,
  /^@tanstack\/router-plugin$/,
  /^@tanstack\/react-router-devtools$/,
  /^@vitejs\//,
  /^@tailwindcss\/(postcss|vite)$/,
  /^@posthog\/cli$/,
  /^typescript$/,
  /^concurrently$/,
  /^cross-env$/,
  /^dotenv-cli$/,
  /^electron$/,
  /^electron-devtools-installer$/,
  /^react-devtools-electron$/,
  /^storybook$/,
  /^drizzle-kit$/,
  /^postcss$/,
  /^vite$/,
  /^tailwindcss$/,
  /^tailwind-scrollbar$/,
  /^license-checker-rseidelsohn$/,
];

const noAttributionRequired = new Set([
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'MIT-0',
]);

function isBuildOnly(name: string): boolean {
  return buildOnlyPatterns.some((p) => p.test(name));
}

function requiresAttribution(license: string): boolean {
  if (noAttributionRequired.has(license)) return false;
  const orMatch = license.match(/^\((.+)\)$/);
  if (orMatch) {
    const parts = orMatch[1].split(/\s+OR\s+/);
    if (parts.every((p) => noAttributionRequired.has(p.trim()))) return false;
  }
  return true;
}

function findAllNodeModulesDirs(startDir: string): string[] {
  const dirs: string[] = [];
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules');
    if (existsSync(candidate)) dirs.push(candidate);
    dir = path.dirname(dir);
  }
  return dirs;
}

function readPackageJson(
  nmDirs: string[],
  pkgName: string,
): Record<string, unknown> | null {
  for (const nmDir of nmDirs) {
    const pkgPath = path.join(nmDir, pkgName, 'package.json');
    try {
      return JSON.parse(readFileSync(pkgPath, 'utf-8'));
    } catch {
      // Not found in this node_modules, try next
    }
  }
  return null;
}

const LICENSE_FILE_PATTERNS = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'license',
  'license.md',
  'license.txt',
];

function readLicenseText(nmDirs: string[], pkgName: string): string {
  for (const nmDir of nmDirs) {
    const pkgDir = path.join(nmDir, pkgName);
    try {
      const files = readdirSync(pkgDir);
      for (const pattern of LICENSE_FILE_PATTERNS) {
        const match = files.find(
          (f) => f.toLowerCase() === pattern.toLowerCase(),
        );
        if (match) {
          return readFileSync(path.join(pkgDir, match), 'utf-8');
        }
      }
    } catch {
      // Not found in this node_modules, try next
    }
  }
  return '';
}

function walkDependencyTree(
  nmDirs: string[],
  rootPkgNames: string[],
): Map<string, LicenseEntry> {
  const visited = new Set<string>();
  const result = new Map<string, LicenseEntry>();
  const queue = [...rootPkgNames];

  while (queue.length > 0) {
    const pkgName = queue.pop()!;
    if (visited.has(pkgName)) continue;
    visited.add(pkgName);

    if (isBuildOnly(pkgName)) continue;

    const pkgJson = readPackageJson(nmDirs, pkgName);
    if (!pkgJson) continue;

    const version = (pkgJson.version as string) || '';
    const licenseRaw =
      (pkgJson.license as string) ||
      (Array.isArray(pkgJson.licenses)
        ? (pkgJson.licenses as Array<{ type?: string }>)
            .map((l) => l.type || '')
            .join(', ')
        : 'Unknown');

    if (!requiresAttribution(licenseRaw)) continue;

    const repoField = pkgJson.repository as
      | string
      | { url?: string }
      | undefined;
    let repository = '';
    if (typeof repoField === 'string') {
      repository = repoField;
    } else if (repoField?.url) {
      repository = repoField.url;
    }
    repository = repository
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/\.git$/, '');

    const authorField = pkgJson.author as
      | string
      | { name?: string }
      | undefined;
    let publisher = '';
    if (typeof authorField === 'string') {
      publisher = authorField.replace(/<[^>]+>/, '').trim();
    } else if (authorField?.name) {
      publisher = authorField.name;
    }

    const licenseText = readLicenseText(nmDirs, pkgName);

    result.set(pkgName, {
      name: pkgName,
      version,
      license: licenseRaw,
      repository,
      publisher,
      licenseText,
    });

    // Queue transitive runtime dependencies (not devDependencies)
    const deps = pkgJson.dependencies as Record<string, string> | undefined;
    if (deps) {
      for (const dep of Object.keys(deps)) {
        if (!visited.has(dep)) queue.push(dep);
      }
    }
  }

  return result;
}

function generateLicensesJson(appRoot: string, outPath: string): void {
  const pkgJsonPath = path.join(appRoot, 'package.json');
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));

  // Collect all declared deps (both deps and devDeps, since Electron puts
  // bundled runtime packages in devDependencies because Vite handles bundling)
  const allDeclaredDeps = new Set<string>([
    ...Object.keys(pkgJson.dependencies || {}),
    ...Object.keys(pkgJson.devDependencies || {}),
  ]);

  const nmDirs = findAllNodeModulesDirs(appRoot);
  if (nmDirs.length === 0) {
    console.warn('[license-plugin] Could not find node_modules');
    return;
  }

  const rootDeps = [...allDeclaredDeps].filter((d) => !isBuildOnly(d));
  const licenseMap = walkDependencyTree(nmDirs, rootDeps);

  const entries = [...licenseMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(entries, null, 2), 'utf-8');
  console.log(
    `[license-plugin] Generated ${entries.length} license entries → ${path.relative(appRoot, outPath)}`,
  );
}

export function licensePlugin(): Plugin {
  let appRoot: string;
  let outPath: string;

  return {
    name: 'clodex-license-plugin',

    configResolved(config) {
      // Resolve appRoot from the pages vite config root (src/pages) up to apps/browser
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

import path from 'node:path';

const OPENABLE_PROTOCOLS = new Set([
  'http:',
  'https:',
  'clodex-ide:',
  'clodex:',
  'clodex-prerelease:',
  'clodex-nightly:',
  'clodex-dev:',
]);

const SKILL_PACKAGE_EXTENSIONS = new Set(['.skill', '.clodex-skill']);

export function isOpenableUrl(url: string): boolean {
  try {
    return OPENABLE_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function extractUrlsFromArgs(argv: string[]): string[] {
  const urls: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('-')) continue;
    if (isOpenableUrl(arg)) urls.push(arg);
  }
  return urls;
}

export function isSkillPackagePath(filePath: string): boolean {
  if (!filePath || filePath.startsWith('-') || isOpenableUrl(filePath)) {
    return false;
  }
  return (
    path.basename(filePath).toLowerCase() === 'skill.md' ||
    SKILL_PACKAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
  );
}

export function createSkillInstallUrl(filePath: string): string {
  const url = new URL('clodex://skill/install');
  url.searchParams.set('path', path.resolve(filePath));
  return url.toString();
}

export function extractSkillPackagePaths(argv: string[]): string[] {
  return argv
    .filter(isSkillPackagePath)
    .map((filePath) => path.resolve(filePath));
}

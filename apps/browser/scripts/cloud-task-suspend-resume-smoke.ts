import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cloudTaskSuspendResumeSmokeChecks,
  createCloudTaskSuspendResumeSmokeEvidence,
  type CloudTaskSuspendResumeSmokeCheck,
} from '../src/shared/cloud-task-suspend-resume-smoke';

const argumentsMap = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.replace(/^--/, '').split('=');
    return [key, value.join('=')];
  }),
);
const checks = Object.fromEntries(
  cloudTaskSuspendResumeSmokeChecks.map((check) => [
    check,
    argumentsMap.get(toKebabCase(check)) === 'passed',
  ]),
) as Record<CloudTaskSuspendResumeSmokeCheck, boolean>;
const evidence = createCloudTaskSuspendResumeSmokeEvidence({
  platform: process.platform,
  arch: process.arch,
  appVersion: process.env.npm_package_version ?? 'unknown',
  checks,
});
const output =
  argumentsMap.get('output') ??
  path.resolve(
    process.cwd(),
    '../../.release-evidence/cloud-tasks',
    `${process.platform}-${process.arch}.json`,
  );
await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
const temporary = `${output}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
});
await rename(temporary, output);
console.log(`Cloud task smoke evidence written: ${output}`);

function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

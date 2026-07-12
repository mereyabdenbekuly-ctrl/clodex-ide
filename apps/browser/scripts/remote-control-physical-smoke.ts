import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRemoteControlPhysicalSmokeReport,
  remoteControlPhysicalSmokeCheckIdSchema,
  type RemoteControlPhysicalSmokeCheckId,
} from '../src/shared/remote-control-physical-smoke';
import type { RemoteControlNativeAttestationProvider } from '../src/shared/remote-control-protocol';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');

const checkFlags: Record<RemoteControlPhysicalSmokeCheckId, string> = {
  qrPairing: '--qr-pairing-passed',
  encryptedSession: '--encrypted-session-passed',
  backgroundResume: '--background-resume-passed',
  guardianApproval: '--guardian-approval-passed',
  networkHandoff: '--network-handoff-passed',
  revoke: '--revoke-passed',
  hardwareAttestation: '--hardware-attestation-passed',
  privacyAudit: '--privacy-audit-passed',
};

interface CliOptions {
  platform?: 'ios' | 'android';
  deviceModel?: string;
  osVersion?: string;
  appBuild?: string;
  attestationProvider?: RemoteControlNativeAttestationProvider;
  outputPath?: string;
  checks: Record<RemoteControlPhysicalSmokeCheckId, boolean>;
  help: boolean;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
  } else {
    await collectPhysicalSmokeEvidence(options);
  }
} catch (error) {
  console.error(
    'REMOTE_CONTROL_PHYSICAL_SMOKE collected=false exit=1',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}

async function collectPhysicalSmokeEvidence(
  options: CliOptions,
): Promise<void> {
  const platform = requiredOption(options.platform, '--platform');
  const deviceModel = requiredOption(options.deviceModel, '--device-model');
  const osVersion = requiredOption(options.osVersion, '--os-version');
  const appBuild = requiredOption(options.appBuild, '--app-build');
  const attestationProvider = requiredOption(
    options.attestationProvider,
    '--attestation-provider',
  );
  const startedAt = Date.now();
  const report = createRemoteControlPhysicalSmokeReport({
    platform,
    deviceModel,
    osVersion,
    appBuild,
    attestationProvider,
    startedAt,
    checks: options.checks,
  });
  const outputPath = path.resolve(
    options.outputPath ??
      path.join(
        repositoryRoot,
        '.release-evidence',
        `remote-control-physical-${platform}.json`,
      ),
  );
  await writeJsonAtomically(outputPath, report);
  console.log(
    [
      'REMOTE_CONTROL_PHYSICAL_SMOKE',
      'collected=true',
      `platform=${platform}`,
      `provider=${attestationProvider}`,
      'trust=hardware-backed',
      `output=${outputPath}`,
      'exit=0',
    ].join(' '),
  );
}

function parseArguments(args: string[]): CliOptions {
  const checks = Object.fromEntries(
    remoteControlPhysicalSmokeCheckIdSchema.options.map((check) => [
      check,
      false,
    ]),
  ) as Record<RemoteControlPhysicalSmokeCheckId, boolean>;
  const options: CliOptions = { checks, help: false };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const check = remoteControlPhysicalSmokeCheckIdSchema.options.find(
      (candidate) => checkFlags[candidate] === argument,
    );
    if (check) {
      options.checks[check] = true;
      continue;
    }
    switch (argument) {
      case '--':
        break;
      case '--platform': {
        const value = readArgumentValue(args, ++index, '--platform');
        if (value !== 'ios' && value !== 'android') {
          throw new Error('--platform must be ios or android');
        }
        options.platform = value;
        break;
      }
      case '--device-model':
        options.deviceModel = readArgumentValue(
          args,
          ++index,
          '--device-model',
        );
        break;
      case '--os-version':
        options.osVersion = readArgumentValue(args, ++index, '--os-version');
        break;
      case '--app-build':
        options.appBuild = readArgumentValue(args, ++index, '--app-build');
        break;
      case '--attestation-provider': {
        const value = readArgumentValue(
          args,
          ++index,
          '--attestation-provider',
        );
        if (
          value !== 'apple-app-attest' &&
          value !== 'android-play-integrity'
        ) {
          throw new Error(
            '--attestation-provider must be apple-app-attest or android-play-integrity',
          );
        }
        options.attestationProvider = value;
        break;
      }
      case '--output':
        options.outputPath = readArgumentValue(args, ++index, '--output');
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument ${argument}`);
    }
  }
  return options;
}

async function writeJsonAtomically(
  outputPath: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await fs.chmod(temporaryPath, 0o600).catch(() => undefined);
    try {
      await fs.rename(temporaryPath, outputPath);
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        (error.code !== 'EEXIST' && error.code !== 'EPERM')
      ) {
        throw error;
      }
      await fs.rm(outputPath, { force: true });
      await fs.rename(temporaryPath, outputPath);
    }
    await fs.chmod(outputPath, 0o600).catch(() => undefined);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function readArgumentValue(
  args: string[],
  index: number,
  argument: string,
): string {
  const value = args[index];
  if (!value) throw new Error(`${argument} requires a value`);
  return value;
}

function requiredOption<T>(value: T | undefined, argument: string): T {
  if (value === undefined || value === '') {
    throw new Error(`${argument} is required`);
  }
  return value;
}

function printUsage(): void {
  console.log(`Usage:
  pnpm smoke:remote-control-physical -- \\
    --platform ios|android \\
    --device-model <model> \\
    --os-version <version> \\
    --app-build <build> \\
    --attestation-provider apple-app-attest|android-play-integrity \\
    --qr-pairing-passed \\
    --encrypted-session-passed \\
    --background-resume-passed \\
    --guardian-approval-passed \\
    --network-handoff-passed \\
    --revoke-passed \\
    --hardware-attestation-passed \\
    --privacy-audit-passed \\
    [--output <owner-only-json-path>]

The collector accepts no raw assertion, token, quote, key, device identifier,
command payload, IP address, or pairing code. It writes no passed artifact
unless every physical/device-only check is explicitly confirmed.`);
}

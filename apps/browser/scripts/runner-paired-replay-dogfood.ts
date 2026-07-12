import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readRunnerPairedReplayDogfoodConfig } from '../src/backend/services/runner-routing/dogfood-config';

const execFileAsync = promisify(execFile);

interface ProbeResult {
  available: boolean;
  configured: boolean;
  reachable: boolean;
  reason: string | null;
}

async function main(): Promise<void> {
  const requireProvider = process.argv.includes('--require-provider');
  const probeSsh = process.argv.includes('--probe-ssh');
  const local = await probeLocalReplay();
  const docker = await probeDocker();
  const ssh = await probeSshRunner(probeSsh);
  const readyProviders = [
    local.reachable ? 'local-read-only' : null,
    local.nodeReady ? 'local-node-build-test' : null,
    local.directNodeToolReady ? 'local-direct-node-tool' : null,
    local.cargoReady ? 'local-cargo-build-test' : null,
    local.goReady ? 'local-go-test' : null,
    docker.reachable ? 'docker' : null,
    ssh.reachable ? 'ssh' : null,
  ].filter((value): value is string => value !== null);
  const report = {
    schemaVersion: 1,
    checkedAt: Date.now(),
    tuning: readRunnerPairedReplayDogfoodConfig(),
    providers: { local, docker, ssh },
    readyProviders,
    ready: readyProviders.length > 0,
    nextAction:
      readyProviders.length > 0
        ? 'Enable runner-abstraction, runner-shadow-routing, and runner-paired-replay. Local replay is a disposable target for divergent local recommendations; SSH/Docker still provide the actual-provider side of route-quality counterfactuals.'
        : 'Run inside a Git worktree, install dependencies for local build/test replay, or configure Docker/SSH.',
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (requireProvider && !report.ready) process.exitCode = 1;
}

async function probeLocalReplay(): Promise<
  ProbeResult & {
    buildTestReady: boolean;
    nodeReady: boolean;
    directNodeToolReady: boolean;
    cargoReady: boolean;
    goReady: boolean;
    repositoryRoot: boolean;
  }
> {
  try {
    const result = await execFileAsync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { timeout: 5_000, encoding: 'utf8' },
    );
    const repositoryRoot = result.stdout.trim();
    if (!repositoryRoot) {
      return {
        available: true,
        configured: false,
        reachable: false,
        buildTestReady: false,
        nodeReady: false,
        directNodeToolReady: false,
        cargoReady: false,
        goReady: false,
        repositoryRoot: false,
        reason: 'Current directory is not inside a Git repository.',
      };
    }
    const [nodeReady, cargoReady, goReady] = await Promise.all([
      pathExists(path.join(repositoryRoot, 'node_modules')),
      probeCargoCache(),
      probeGoModuleCache(),
    ]);
    const directNodeToolReady = nodeReady;
    const buildTestReady = nodeReady || cargoReady || goReady;
    return {
      available: true,
      configured: true,
      reachable: true,
      buildTestReady,
      nodeReady,
      directNodeToolReady,
      cargoReady,
      goReady,
      repositoryRoot: true,
      reason: buildTestReady
        ? null
        : 'Read-only local replay is ready; install Node dependencies or populate Cargo/Go caches to enable dependency-isolated build/test replay.',
    };
  } catch (error) {
    return {
      available: false,
      configured: false,
      reachable: false,
      buildTestReady: false,
      nodeReady: false,
      directNodeToolReady: false,
      cargoReady: false,
      goReady: false,
      repositoryRoot: false,
      reason: sanitizeProbeError(error),
    };
  }
}

async function probeCargoCache(): Promise<boolean> {
  try {
    await execFileAsync('cargo', ['--version'], { timeout: 5_000 });
    const cargoHome = path.resolve(
      process.env.CARGO_HOME?.trim() ||
        path.join(process.env.HOME?.trim() || '', '.cargo'),
    );
    return (
      (await pathExists(path.join(cargoHome, 'registry'))) ||
      (await pathExists(path.join(cargoHome, 'git')))
    );
  } catch {
    return false;
  }
}

async function probeGoModuleCache(): Promise<boolean> {
  try {
    const result = await execFileAsync('go', ['env', 'GOMODCACHE'], {
      timeout: 5_000,
      encoding: 'utf8',
    });
    const moduleCache = result.stdout.trim();
    return Boolean(moduleCache) && (await pathExists(moduleCache));
  } catch {
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function probeDocker(): Promise<ProbeResult> {
  const configured = Boolean(process.env.CLODEX_DOCKER_RUNNER_IMAGE?.trim());
  try {
    await execFileAsync(
      'docker',
      ['version', '--format', '{{.Server.Version}}'],
      {
        timeout: 10_000,
      },
    );
    return {
      available: true,
      configured,
      reachable: configured,
      reason: configured
        ? null
        : 'Docker is reachable but CLODEX_DOCKER_RUNNER_IMAGE is not configured.',
    };
  } catch (error) {
    return {
      available: false,
      configured,
      reachable: false,
      reason: sanitizeProbeError(error),
    };
  }
}

async function probeSshRunner(probe: boolean): Promise<ProbeResult> {
  const target = process.env.CLODEX_RUNNER_DOGFOOD_SSH_TARGET?.trim();
  try {
    await execFileAsync('ssh', ['-V'], { timeout: 5_000 });
  } catch (error) {
    return {
      available: false,
      configured: Boolean(target),
      reachable: false,
      reason: sanitizeProbeError(error),
    };
  }
  if (!target) {
    return {
      available: true,
      configured: false,
      reachable: false,
      reason: 'CLODEX_RUNNER_DOGFOOD_SSH_TARGET is not configured.',
    };
  }
  if (!probe) {
    return {
      available: true,
      configured: true,
      reachable: false,
      reason:
        'SSH target configured; pass --probe-ssh for a BatchMode connectivity probe.',
    };
  }
  try {
    await execFileAsync(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=5',
        '-o',
        'StrictHostKeyChecking=yes',
        target,
        'true',
      ],
      { timeout: 10_000 },
    );
    return {
      available: true,
      configured: true,
      reachable: true,
      reason: null,
    };
  } catch (error) {
    return {
      available: true,
      configured: true,
      reachable: false,
      reason: sanitizeProbeError(error),
    };
  }
}

function sanitizeProbeError(error: unknown): string {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : 'probe-failed';
  return `Physical provider probe failed (${code}).`;
}

void main();

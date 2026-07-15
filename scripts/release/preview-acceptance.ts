import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  LoadedTechnicalPreviewReleasePlan,
  TechnicalPreviewReleasePlan,
} from './release-plan.mjs';

export const PREVIEW_ACCEPTANCE_SCHEMA_VERSION = 2;
export const PINNED_NODE_VERSION = '22.23.1';
export const PINNED_PNPM_VERSION = '10.30.3';
const CANONICAL_RELEASE_REPOSITORY = 'mereyabdenbekuly-ctrl/clodex-ide';

export type AcceptanceCheckKind = 'automated' | 'manual';
export type AcceptanceCheckStatus = 'blocked' | 'fail' | 'not-run' | 'pass';
export type PreviewAcceptanceStatus =
  | 'canary-running'
  | 'hold'
  | 'ready-as-rollback-baseline'
  | 'ready-for-canary'
  | 'ready-for-stable'
  | 'rollback-required';

export interface AcceptanceCheckDefinition {
  category:
    | 'artifact'
    | 'canary'
    | 'product'
    | 'rollback'
    | 'security'
    | 'source'
    | 'toolchain';
  description: string;
  id: AcceptanceCheckId;
  kind: AcceptanceCheckKind;
  required: boolean;
}

export const AUTOMATED_CHECK_IDS = [
  'source.commit-bound',
  'source.clean-tree',
  'publication.github-release',
  'toolchain.node',
  'toolchain.pnpm',
  'artifact.validation-manifest',
  'artifact.packaged-smoke',
  'artifact.clean-profile-launch',
  'artifact.app-icon',
  'security.distribution-trust',
  'product.quick-task-green',
  'product.task-creation-contract',
  'product.browser-contract',
  'product.mcp-contract',
  'product.guardian-egress-contract',
  'product.session-recovery-contract',
] as const;

export const MANUAL_CHECK_IDS = [
  'manual.dock-or-tray-icon',
  'manual.task-creation',
  'manual.terminal',
  'manual.browser',
  'manual.mcp',
  'manual.guardian-egress-prompt',
  'manual.restart-session-recovery',
] as const;

export type AutomatedCheckId = (typeof AUTOMATED_CHECK_IDS)[number];
export type ManualCheckId = (typeof MANUAL_CHECK_IDS)[number];
export type AcceptanceCheckId = AutomatedCheckId | ManualCheckId;

export const PREVIEW_ACCEPTANCE_MATRIX: readonly AcceptanceCheckDefinition[] = [
  {
    category: 'source',
    description: 'Evidence is bound to the exact public release commit.',
    id: 'source.commit-bound',
    kind: 'automated',
    required: true,
  },
  {
    category: 'source',
    description: 'The release worktree contains no tracked or untracked delta.',
    id: 'source.clean-tree',
    kind: 'automated',
    required: true,
  },
  {
    category: 'artifact',
    description:
      'GitHub identifies the exact tag as a real protected draft pre-release.',
    id: 'publication.github-release',
    kind: 'automated',
    required: true,
  },
  {
    category: 'toolchain',
    description: `Node.js is pinned to ${PINNED_NODE_VERSION}.`,
    id: 'toolchain.node',
    kind: 'automated',
    required: true,
  },
  {
    category: 'toolchain',
    description: `pnpm is pinned to ${PINNED_PNPM_VERSION}.`,
    id: 'toolchain.pnpm',
    kind: 'automated',
    required: true,
  },
  {
    category: 'artifact',
    description:
      'The macOS release validator emitted a schema-v2 passed manifest.',
    id: 'artifact.validation-manifest',
    kind: 'automated',
    required: true,
  },
  {
    category: 'artifact',
    description:
      'The packaged application passed its isolated-profile smoke test.',
    id: 'artifact.packaged-smoke',
    kind: 'automated',
    required: true,
  },
  {
    category: 'artifact',
    description:
      'A clean-profile UI launch reached startup-complete and window-shown.',
    id: 'artifact.clean-profile-launch',
    kind: 'automated',
    required: true,
  },
  {
    category: 'artifact',
    description:
      'The packaged application declares a non-empty bundled macOS icon.',
    id: 'artifact.app-icon',
    kind: 'automated',
    required: true,
  },
  {
    category: 'security',
    description:
      'Developer ID, Gatekeeper, and stapled notarization checks passed.',
    id: 'security.distribution-trust',
    kind: 'automated',
    required: true,
  },
  {
    category: 'product',
    description:
      'The Quick Task visual regression uses the Clodex green palette.',
    id: 'product.quick-task-green',
    kind: 'automated',
    required: true,
  },
  {
    category: 'product',
    description: 'Quick Task creation contracts passed.',
    id: 'product.task-creation-contract',
    kind: 'automated',
    required: true,
  },
  {
    category: 'product',
    description: 'Controlled-browser execution contracts passed.',
    id: 'product.browser-contract',
    kind: 'automated',
    required: true,
  },
  {
    category: 'product',
    description: 'MCP runtime and bridge contracts passed.',
    id: 'product.mcp-contract',
    kind: 'automated',
    required: true,
  },
  {
    category: 'security',
    description: 'Guardian and egress policy contracts passed.',
    id: 'product.guardian-egress-contract',
    kind: 'automated',
    required: true,
  },
  {
    category: 'product',
    description: 'Restart, continuity, and recovery contracts passed.',
    id: 'product.session-recovery-contract',
    kind: 'automated',
    required: true,
  },
  {
    category: 'product',
    description:
      'The installed Dock or tray surface shows the current Clodex badge.',
    id: 'manual.dock-or-tray-icon',
    kind: 'manual',
    required: true,
  },
  {
    category: 'product',
    description:
      'A user can create and open a Quick Task from the packaged app.',
    id: 'manual.task-creation',
    kind: 'manual',
    required: true,
  },
  {
    category: 'product',
    description:
      'A terminal opens, executes a harmless command, and closes cleanly.',
    id: 'manual.terminal',
    kind: 'manual',
    required: true,
  },
  {
    category: 'product',
    description:
      'The controlled browser opens and completes a local navigation.',
    id: 'manual.browser',
    kind: 'manual',
    required: true,
  },
  {
    category: 'product',
    description:
      'A non-secret local MCP server connects and exposes one safe tool.',
    id: 'manual.mcp',
    kind: 'manual',
    required: true,
  },
  {
    category: 'security',
    description:
      'A guarded egress action shows the expected user decision prompt.',
    id: 'manual.guardian-egress-prompt',
    kind: 'manual',
    required: true,
  },
  {
    category: 'product',
    description: 'A task survives restart without losing its accepted state.',
    id: 'manual.restart-session-recovery',
    kind: 'manual',
    required: true,
  },
];

export interface AcceptanceCheckReceipt {
  durationMs?: number;
  id: AcceptanceCheckId;
  reasonCode: string;
  status: AcceptanceCheckStatus;
}

export interface ManualCheckInput {
  reasonCode?: string;
  status: AcceptanceCheckStatus;
}

export interface CanaryMetrics {
  authAttempts: number;
  authFailures: number;
  crashLoops: number;
  crashes: number;
  dataLossIncidents: number;
  distributionClosedAt: string | null;
  egressMissingPrompts: number;
  egressPromptAttempts: number;
  egressUnexpectedAllows: number;
  endedAt: string | null;
  guardianBypassIncidents: number;
  launchAttempts: number;
  launchFailures: number;
  recoveryAttempts: number;
  recoveryFailures: number;
  signatureTrustFailures: number;
  startedAt: string;
  uniqueInstallations: number;
}

export interface PreviewAcceptanceInput {
  canary: CanaryMetrics | null;
  manifest: {
    path: string;
    sha256: string;
    sourceCommit: string;
  };
  manualChecks: Record<ManualCheckId, ManualCheckInput>;
  publication: {
    githubReleaseId: number | null;
    githubReleaseState: 'draft' | 'not-recorded';
    tag: string;
    targetCommit: string;
  };
  rollback: {
    operatorReviewed: boolean;
    readOnlyVerificationPassed: boolean;
  };
  schemaVersion: 2;
}

export interface PreviewAcceptanceReport {
  blockers: string[];
  canary: {
    distributionClosedAt: string | null;
    endedAt: string | null;
    exitCriteria: string[];
    observedHours: number | null;
    observedInstallations: number | null;
    startedAt: string | null;
    stopReasons: string[];
    targetInstallations: 0 | 5;
    targetObservationHours: 24;
  };
  checks: AcceptanceCheckReceipt[];
  evidenceKind: 'release-acceptance';
  generatedAt: string;
  manifest: PreviewAcceptanceInput['manifest'];
  publication: PreviewAcceptanceInput['publication'];
  release: {
    channel: 'preview';
    promotionRole: TechnicalPreviewReleasePlan['promotionRole'];
    tag: string;
    version: string;
  };
  rollback: {
    commands: string[];
    note: string;
    mode: 'distribution-stop-only';
    targetTag?: string;
  };
  schemaVersion: 2;
  status: PreviewAcceptanceStatus;
}

export type PreviewAcceptanceContext = LoadedTechnicalPreviewReleasePlan;

interface AcceptanceReleaseIdentity {
  sourceCommit: string;
  version: string;
}

interface MacosValidationManifest {
  artifacts?: {
    app?: { path?: unknown };
    dmg?: { sha256?: unknown };
    zip?: { sha256?: unknown };
  };
  build?: {
    nodeVersion?: unknown;
    pnpmVersion?: unknown;
    version?: unknown;
  };
  checks?: {
    cleanProfileUiLaunch?: {
      fatalLines?: unknown;
      startupComplete?: unknown;
      windowShown?: unknown;
    } | null;
    smoke?: {
      exitCode?: unknown;
      fatalLines?: unknown;
      successMarker?: unknown;
    };
  };
  schemaVersion?: unknown;
  signature?: {
    copied?: { isAdhoc?: unknown };
    mounted?: { isAdhoc?: unknown };
    packaged?: { isAdhoc?: unknown };
    requiredMode?: unknown;
  };
  status?: unknown;
  trust?: {
    applicationGatekeeper?: { passed?: unknown };
    applicationStapler?: { passed?: unknown };
    copiedApplicationGatekeeper?: { passed?: unknown };
    copiedApplicationStapler?: { passed?: unknown };
    dmgGatekeeper?: { passed?: unknown };
    dmgStapler?: { passed?: unknown };
  };
}

export interface AutomatedCollectionOptions {
  artifactValidationPath?: string;
  context: PreviewAcceptanceContext;
  githubRepository?: string;
  packagedAppPath?: string;
  publication: PreviewAcceptanceInput['publication'];
  repositoryDirectory: string;
  runSourceChecks: boolean;
  verifiedPublicationSnapshotPath?: string;
}

export const CANARY_5_POLICY = {
  minimum: {
    authAttempts: 5,
    egressPromptAttempts: 5,
    launchAttempts: 10,
    recoveryAttempts: 5,
    uniqueInstallations: 5,
  },
  targetInstallations: 5,
  targetObservationHours: 24,
} as const;

export const CANARY_EXIT_CRITERIA = [
  'five unique installations observed',
  'at least ten successful launch attempts with zero launch failures',
  'zero crashes and zero crash loops',
  'at least five authentication attempts with zero authentication failures',
  'at least five guarded egress prompts with zero missing prompts or unexpected allows',
  'at least five restart/recovery attempts with zero recovery failures',
  'zero data-loss, Guardian-bypass, or signature/trust incidents',
  'minimum observation duration of 24 hours',
] as const;

function receipt(
  id: AcceptanceCheckId,
  status: AcceptanceCheckStatus,
  reasonCode: string,
  durationMs?: number,
): AcceptanceCheckReceipt {
  return {
    ...(durationMs === undefined ? {} : { durationMs }),
    id,
    reasonCode,
    status,
  };
}

export function sanitizeChildEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  const blockedNames = [
    'ACTIONS_CACHE_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_RESULTS_URL',
    'ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_RUNTIME_URL',
    'ANTHROPIC_API_KEY',
    'APPLE_ID',
    'APPLE_PASSWORD',
    'APPLE_SIGNING_IDENTITY',
    'CLODEX_API_KEY',
    'DEEPSEEK_API_KEY',
    'GEMINI_API_KEY',
    'GH_TOKEN',
    'GITHUB_ENV',
    'GITHUB_OUTPUT',
    'GITHUB_PATH',
    'GITHUB_STEP_SUMMARY',
    'GITHUB_TOKEN',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
  ];
  for (const name of blockedNames) delete environment[name];
  return environment;
}

function collectVerifiedPublicationSnapshotCheck(
  options: Pick<
    AutomatedCollectionOptions,
    | 'context'
    | 'githubRepository'
    | 'publication'
    | 'repositoryDirectory'
    | 'verifiedPublicationSnapshotPath'
  >,
): AcceptanceCheckReceipt {
  if (options.githubRepository !== CANONICAL_RELEASE_REPOSITORY) {
    return receipt(
      'publication.github-release',
      'blocked',
      'github-repository-not-provided',
    );
  }
  if (
    options.publication.githubReleaseId === null ||
    options.publication.githubReleaseState !== 'draft' ||
    !options.verifiedPublicationSnapshotPath
  ) {
    return receipt(
      'publication.github-release',
      'blocked',
      'verified-publication-snapshot-missing',
    );
  }

  let tagCommit: string;
  try {
    tagCommit = runGit(options.repositoryDirectory, [
      'rev-parse',
      '--verify',
      `refs/tags/${options.context.plan.tag}^{commit}`,
    ]);
  } catch {
    return receipt(
      'publication.github-release',
      'blocked',
      'release-tag-unavailable',
    );
  }
  if (tagCommit !== options.context.releaseRef) {
    return receipt(
      'publication.github-release',
      'fail',
      'release-tag-source-mismatch',
    );
  }

  let snapshot: unknown;
  try {
    const stats = lstatSync(options.verifiedPublicationSnapshotPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
      throw new Error('invalid snapshot file');
    }
    snapshot = readJsonFile(options.verifiedPublicationSnapshotPath);
  } catch {
    return receipt(
      'publication.github-release',
      'fail',
      'verified-publication-snapshot-invalid',
    );
  }
  const reportAsset =
    isObject(snapshot) && isObject(snapshot.reportAsset)
      ? snapshot.reportAsset
      : null;
  const valid =
    isObject(snapshot) &&
    snapshot.releaseId === options.publication.githubReleaseId &&
    snapshot.repository === options.githubRepository &&
    snapshot.sourceCommit === options.context.releaseRef &&
    snapshot.tag === options.context.plan.tag &&
    typeof snapshot.createdAt === 'string' &&
    Number.isFinite(Date.parse(snapshot.createdAt)) &&
    isSha256(snapshot.reportSha256) &&
    Array.isArray(snapshot.assets) &&
    snapshot.assets.length > 0 &&
    reportAsset !== null &&
    typeof reportAsset.fileName === 'string' &&
    snapshot.assets.some(
      (asset) =>
        isObject(asset) &&
        asset.fileName === reportAsset.fileName &&
        asset.releaseAssetId === reportAsset.releaseAssetId &&
        asset.sha256 === reportAsset.sha256,
    );
  return receipt(
    'publication.github-release',
    valid ? 'pass' : 'fail',
    valid
      ? 'verified-publication-snapshot-matched'
      : 'verified-publication-snapshot-mismatch',
  );
}

function runContentFreeCommand(
  id: AutomatedCheckId,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 10 * 60_000,
  blockedPatterns: ReadonlyArray<{ pattern: RegExp; reasonCode: string }> = [],
): AcceptanceCheckReceipt {
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: sanitizeChildEnvironment(),
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
  const durationMs = Math.round(performance.now() - startedAt);
  if (result.error) {
    return receipt(id, 'fail', 'command-execution-failed', durationMs);
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const environmentBlock = blockedPatterns.find(({ pattern }) =>
    pattern.test(output),
  );
  if (environmentBlock) {
    return receipt(id, 'blocked', environmentBlock.reasonCode, durationMs);
  }
  if (result.status !== 0) {
    return receipt(
      id,
      'fail',
      `command-exit-${result.status ?? 'unknown'}`,
      durationMs,
    );
  }
  return receipt(id, 'pass', 'command-passed', durationMs);
}

function runGit(repositoryDirectory: string, args: string[]): string {
  const result = spawnSync('/usr/bin/git', args, {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    env: sanitizeChildEnvironment(),
  });
  if (result.status !== 0) throw new Error('git-command-failed');
  return result.stdout.trim();
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function validatePackagedIcon(appPath: unknown): AcceptanceCheckReceipt {
  if (process.platform !== 'darwin') {
    return receipt('artifact.app-icon', 'blocked', 'macos-required');
  }
  if (typeof appPath !== 'string' || !existsSync(appPath)) {
    return receipt('artifact.app-icon', 'blocked', 'packaged-app-missing');
  }
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  if (!existsSync(plistPath)) {
    return receipt('artifact.app-icon', 'fail', 'info-plist-missing');
  }
  const iconResult = spawnSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleIconFile', plistPath],
    { encoding: 'utf8', env: sanitizeChildEnvironment() },
  );
  const iconName = iconResult.stdout.trim();
  if (iconResult.status !== 0 || !iconName) {
    return receipt('artifact.app-icon', 'fail', 'icon-plist-entry-missing');
  }
  const candidates = [
    iconName,
    iconName.endsWith('.icns') ? iconName : `${iconName}.icns`,
  ];
  const resourcesDirectory = path.join(appPath, 'Contents', 'Resources');
  const iconPath = candidates
    .map((candidate) => path.join(resourcesDirectory, candidate))
    .find((candidate) => existsSync(candidate));
  if (!iconPath || statSync(iconPath).size === 0) {
    return receipt('artifact.app-icon', 'fail', 'bundled-icon-missing');
  }
  return receipt('artifact.app-icon', 'pass', 'bundled-icon-present');
}

function readPlistValue(plistPath: string, key: string): string | null {
  const result = spawnSync(
    '/usr/libexec/PlistBuddy',
    ['-c', `Print :${key}`, plistPath],
    { encoding: 'utf8', env: sanitizeChildEnvironment() },
  );
  return result.status === 0 ? result.stdout.trim() || null : null;
}

export function collectDirectPackagedAppChecks(
  appPath: string | undefined,
): AcceptanceCheckReceipt[] {
  if (!appPath) return [];
  const icon = validatePackagedIcon(appPath);
  if (process.platform !== 'darwin') {
    return [
      receipt('artifact.packaged-smoke', 'blocked', 'macos-required'),
      icon,
    ];
  }
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  const executableName = existsSync(plistPath)
    ? readPlistValue(plistPath, 'CFBundleExecutable')
    : null;
  const executablePath = executableName
    ? path.join(appPath, 'Contents', 'MacOS', executableName)
    : null;
  if (!executablePath || !existsSync(executablePath)) {
    return [
      receipt('artifact.packaged-smoke', 'fail', 'packaged-executable-missing'),
      icon,
    ];
  }

  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), 'clodex-preview-smoke.'),
  );
  const startedAt = performance.now();
  try {
    const result = spawnSync(
      executablePath,
      [
        `--user-data-dir=${path.join(temporaryDirectory, 'profile')}`,
        '--disable-gpu',
        '--smoke-test',
      ],
      {
        cwd: path.dirname(executablePath),
        encoding: 'utf8',
        env: sanitizeChildEnvironment(),
        maxBuffer: 50 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      },
    );
    const durationMs = Math.round(performance.now() - startedAt);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (/listen EPERM|operation not permitted/iu.test(output)) {
      return [
        receipt(
          'artifact.packaged-smoke',
          'blocked',
          'runtime-permission-blocked',
          durationMs,
        ),
        icon,
      ];
    }
    if (
      process.env.CODEX_SHELL === '1' &&
      (result.status === 134 || result.signal === 'SIGABRT') &&
      output.trim().length === 0
    ) {
      return [
        receipt(
          'artifact.packaged-smoke',
          'blocked',
          'gui-registration-permission-blocked',
          durationMs,
        ),
        icon,
      ];
    }
    const fatal = [
      'uncaught exception',
      'unhandled rejection',
      'err_module_not_found',
      'module_not_found',
      'fatal error',
    ].some((pattern) => output.toLowerCase().includes(pattern));
    const passed =
      result.status === 0 &&
      output.includes(
        '[smoke-test] App ready — all modules loaded successfully.',
      ) &&
      !fatal;
    return [
      receipt(
        'artifact.packaged-smoke',
        passed ? 'pass' : 'fail',
        passed
          ? 'direct-packaged-smoke-passed'
          : 'direct-packaged-smoke-failed',
        durationMs,
      ),
      icon,
    ];
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

export function collectMacosArtifactChecks(
  manifestPath: string | undefined,
  release: AcceptanceReleaseIdentity,
): AcceptanceCheckReceipt[] {
  if (!manifestPath) {
    return [
      receipt(
        'artifact.validation-manifest',
        'blocked',
        'manifest-not-provided',
      ),
      receipt('artifact.packaged-smoke', 'blocked', 'manifest-not-provided'),
      receipt(
        'artifact.clean-profile-launch',
        'blocked',
        'manifest-not-provided',
      ),
      receipt('artifact.app-icon', 'blocked', 'manifest-not-provided'),
      receipt(
        'security.distribution-trust',
        'blocked',
        'manifest-not-provided',
      ),
    ];
  }
  if (!existsSync(manifestPath)) {
    return [
      receipt('artifact.validation-manifest', 'fail', 'manifest-missing'),
      receipt('artifact.packaged-smoke', 'blocked', 'manifest-invalid'),
      receipt('artifact.clean-profile-launch', 'blocked', 'manifest-invalid'),
      receipt('artifact.app-icon', 'blocked', 'manifest-invalid'),
      receipt('security.distribution-trust', 'blocked', 'manifest-invalid'),
    ];
  }

  let manifest: MacosValidationManifest;
  try {
    const parsed = readJsonFile(manifestPath);
    if (!isObject(parsed)) throw new Error('manifest-not-object');
    manifest = parsed as MacosValidationManifest;
  } catch {
    return [
      receipt('artifact.validation-manifest', 'fail', 'manifest-json-invalid'),
      receipt('artifact.packaged-smoke', 'blocked', 'manifest-invalid'),
      receipt('artifact.clean-profile-launch', 'blocked', 'manifest-invalid'),
      receipt('artifact.app-icon', 'blocked', 'manifest-invalid'),
      receipt('security.distribution-trust', 'blocked', 'manifest-invalid'),
    ];
  }

  const manifestValid =
    manifest.schemaVersion === 2 &&
    manifest.status === 'passed' &&
    manifest.build?.nodeVersion === PINNED_NODE_VERSION &&
    manifest.build?.pnpmVersion === PINNED_PNPM_VERSION &&
    manifest.build?.version === release.version &&
    isSha256(manifest.artifacts?.dmg?.sha256) &&
    isSha256(manifest.artifacts?.zip?.sha256);

  const smoke = manifest.checks?.smoke;
  const smokePassed =
    smoke?.exitCode === 0 &&
    smoke.successMarker === true &&
    Array.isArray(smoke.fatalLines) &&
    smoke.fatalLines.length === 0;

  const launch = manifest.checks?.cleanProfileUiLaunch;
  const launchPassed =
    launch?.startupComplete === true &&
    launch.windowShown === true &&
    Array.isArray(launch.fatalLines) &&
    launch.fatalLines.length === 0;

  const signature = manifest.signature;
  const trust = manifest.trust;
  const distributionTrustPassed =
    signature?.requiredMode === 'developer-id' &&
    signature.packaged?.isAdhoc === false &&
    signature.mounted?.isAdhoc === false &&
    signature.copied?.isAdhoc === false &&
    trust?.applicationGatekeeper?.passed === true &&
    trust.applicationStapler?.passed === true &&
    trust.copiedApplicationGatekeeper?.passed === true &&
    trust.copiedApplicationStapler?.passed === true &&
    trust.dmgGatekeeper?.passed === true &&
    trust.dmgStapler?.passed === true;

  return [
    receipt(
      'artifact.validation-manifest',
      manifestValid ? 'pass' : 'fail',
      manifestValid ? 'manifest-passed' : 'manifest-contract-mismatch',
    ),
    receipt(
      'artifact.packaged-smoke',
      smokePassed ? 'pass' : 'fail',
      smokePassed ? 'smoke-passed' : 'smoke-missing-or-failed',
    ),
    receipt(
      'artifact.clean-profile-launch',
      launchPassed ? 'pass' : 'fail',
      launchPassed
        ? 'clean-profile-launch-passed'
        : 'clean-profile-launch-missing-or-failed',
    ),
    validatePackagedIcon(manifest.artifacts?.app?.path),
    receipt(
      'security.distribution-trust',
      distributionTrustPassed ? 'pass' : 'blocked',
      distributionTrustPassed
        ? 'developer-id-and-notarization-passed'
        : 'developer-id-or-notarization-missing',
    ),
  ];
}

function collectSourceContractChecks(
  repositoryDirectory: string,
): AcceptanceCheckReceipt[] {
  const vitestGroups: Array<{
    id: AutomatedCheckId;
    paths: string[];
  }> = [
    {
      id: 'product.task-creation-contract',
      paths: [
        'src/backend/services/quick-task-window/index.test.ts',
        'src/ui/screens/main/agent-chat/chat/_components/task-goal-model.test.ts',
      ],
    },
    {
      id: 'product.browser-contract',
      paths: [
        'src/backend/agent-host/browser-agent-step-executor.test.ts',
        'src/backend/services/network-policy/controlled-browser.test.ts',
      ],
    },
    {
      id: 'product.mcp-contract',
      paths: [
        'src/backend/mcp-host/runtime-sandbox.test.ts',
        'src/backend/services/mcp/index.test.ts',
      ],
    },
    {
      id: 'product.guardian-egress-contract',
      paths: [
        'src/backend/services/guardian/index.test.ts',
        'src/backend/services/network-policy/index.test.ts',
        'src/backend/services/network-policy/control-center.test.ts',
      ],
    },
    {
      id: 'product.session-recovery-contract',
      paths: [
        'src/backend/agent-host/cloud-task-resume-store.test.ts',
        'src/backend/services/agent-runtime-recovery.test.ts',
        'src/backend/services/session-continuity/index.test.ts',
      ],
    },
  ];

  const browserDirectory = path.join(repositoryDirectory, 'apps', 'browser');
  const receipts = vitestGroups.map(({ id, paths }) =>
    runContentFreeCommand(
      id,
      'corepack',
      ['pnpm', 'exec', 'vitest', 'run', ...paths],
      browserDirectory,
    ),
  );
  receipts.push(
    runContentFreeCommand(
      'product.quick-task-green',
      'corepack',
      [
        'pnpm',
        'exec',
        'playwright',
        'test',
        '--config',
        'playwright.visual.config.ts',
        '--grep',
        'quick-task',
      ],
      browserDirectory,
      15 * 60_000,
      [
        {
          pattern: /listen EPERM/u,
          reasonCode: 'local-socket-permission-blocked',
        },
      ],
    ),
  );
  return receipts;
}

export function collectGitHubPublicationCheck(
  options: Pick<
    AutomatedCollectionOptions,
    'context' | 'githubRepository' | 'publication' | 'repositoryDirectory'
  >,
  runGh: typeof spawnSync = spawnSync,
  runGitCommand: typeof runGit = runGit,
): AcceptanceCheckReceipt {
  if (options.githubRepository !== CANONICAL_RELEASE_REPOSITORY) {
    return receipt(
      'publication.github-release',
      'blocked',
      'github-repository-not-provided',
    );
  }
  if (
    options.publication.githubReleaseId === null ||
    options.publication.githubReleaseState !== 'draft'
  ) {
    return receipt(
      'publication.github-release',
      'blocked',
      'github-release-not-recorded',
    );
  }

  let tagCommit: string;
  try {
    tagCommit = runGitCommand(options.repositoryDirectory, [
      'rev-parse',
      '--verify',
      `refs/tags/${options.context.plan.tag}^{commit}`,
    ]);
  } catch {
    return receipt(
      'publication.github-release',
      'blocked',
      'release-tag-unavailable',
    );
  }
  if (tagCommit !== options.context.releaseRef) {
    return receipt(
      'publication.github-release',
      'fail',
      'release-tag-source-mismatch',
    );
  }

  const result = runGh(
    'gh',
    [
      'api',
      '--method',
      'GET',
      `repos/${options.githubRepository}/releases/${options.publication.githubReleaseId}`,
    ],
    {
      encoding: 'utf8',
      env: sanitizeChildEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error || result.status !== 0) {
    return receipt(
      'publication.github-release',
      'blocked',
      'github-release-query-failed',
    );
  }

  let release: unknown;
  try {
    release = JSON.parse(String(result.stdout));
  } catch {
    return receipt(
      'publication.github-release',
      'fail',
      'github-release-response-invalid',
    );
  }
  const valid =
    isObject(release) &&
    release.id === options.publication.githubReleaseId &&
    release.tag_name === options.context.plan.tag &&
    release.draft === true &&
    release.prerelease === true &&
    release.published_at === null;
  return receipt(
    'publication.github-release',
    valid ? 'pass' : 'fail',
    valid
      ? 'github-draft-release-verified'
      : 'github-release-contract-mismatch',
  );
}

export function collectAutomatedAcceptance(
  options: AutomatedCollectionOptions,
): AcceptanceCheckReceipt[] {
  const receipts: AcceptanceCheckReceipt[] = [];
  let actualCommit = '';
  let status = '';
  try {
    actualCommit = runGit(options.repositoryDirectory, ['rev-parse', 'HEAD']);
    status = runGit(options.repositoryDirectory, ['status', '--porcelain']);
  } catch {
    receipts.push(receipt('source.commit-bound', 'fail', 'git-unavailable'));
    receipts.push(receipt('source.clean-tree', 'fail', 'git-unavailable'));
  }
  if (actualCommit) {
    receipts.push(
      receipt(
        'source.commit-bound',
        actualCommit === options.context.releaseRef ? 'pass' : 'fail',
        actualCommit === options.context.releaseRef
          ? 'source-commit-matched'
          : 'source-commit-mismatch',
      ),
    );
    receipts.push(
      receipt(
        'source.clean-tree',
        status.length === 0 ? 'pass' : 'fail',
        status.length === 0 ? 'worktree-clean' : 'worktree-dirty',
      ),
    );
  }

  receipts.push(
    options.verifiedPublicationSnapshotPath
      ? collectVerifiedPublicationSnapshotCheck(options)
      : collectGitHubPublicationCheck(options),
  );

  const nodeVersion = process.version.replace(/^v/u, '');
  receipts.push(
    receipt(
      'toolchain.node',
      nodeVersion === PINNED_NODE_VERSION ? 'pass' : 'fail',
      nodeVersion === PINNED_NODE_VERSION
        ? 'node-version-matched'
        : 'node-version-mismatch',
    ),
  );
  const pnpmResult = spawnSync('corepack', ['pnpm', '--version'], {
    cwd: options.repositoryDirectory,
    encoding: 'utf8',
    env: sanitizeChildEnvironment(),
  });
  const pnpmVersion = pnpmResult.stdout.trim();
  receipts.push(
    receipt(
      'toolchain.pnpm',
      pnpmResult.status === 0 && pnpmVersion === PINNED_PNPM_VERSION
        ? 'pass'
        : 'fail',
      pnpmResult.status === 0 && pnpmVersion === PINNED_PNPM_VERSION
        ? 'pnpm-version-matched'
        : 'pnpm-version-mismatch',
    ),
  );

  receipts.push(
    ...collectMacosArtifactChecks(options.artifactValidationPath, {
      sourceCommit: options.context.releaseRef,
      version: options.context.plan.version,
    }),
  );
  receipts.push(...collectDirectPackagedAppChecks(options.packagedAppPath));
  if (options.runSourceChecks) {
    receipts.push(...collectSourceContractChecks(options.repositoryDirectory));
  } else {
    for (const id of [
      'product.quick-task-green',
      'product.task-creation-contract',
      'product.browser-contract',
      'product.mcp-contract',
      'product.guardian-egress-contract',
      'product.session-recovery-contract',
    ] as const) {
      receipts.push(receipt(id, 'not-run', 'source-checks-disabled'));
    }
  }

  return receipts;
}

function hoursBetween(startedAt: string, endedAt: string): number {
  return (
    (new Date(endedAt).getTime() - new Date(startedAt).getTime()) /
    (60 * 60 * 1000)
  );
}

function resolveCanaryObservationEnd(
  metrics: CanaryMetrics,
  now: Date,
): string {
  const nowMs = now.getTime();
  const startedAtMs = new Date(metrics.startedAt).getTime();
  const endedAt = metrics.endedAt ?? now.toISOString();
  const endedAtMs = new Date(endedAt).getTime();
  const distributionClosedAtMs =
    metrics.distributionClosedAt === null
      ? null
      : new Date(metrics.distributionClosedAt).getTime();

  if (
    Number.isNaN(nowMs) ||
    startedAtMs > endedAtMs ||
    endedAtMs > nowMs ||
    (metrics.endedAt === null && metrics.distributionClosedAt !== null) ||
    (distributionClosedAtMs !== null &&
      (Number.isNaN(distributionClosedAtMs) ||
        distributionClosedAtMs < endedAtMs ||
        distributionClosedAtMs > nowMs))
  ) {
    throw new Error('acceptance-canary-window-invalid');
  }

  return endedAt;
}

export function getCanaryStopReasons(metrics: CanaryMetrics): string[] {
  const reasons: string[] = [];
  if (metrics.uniqueInstallations > CANARY_5_POLICY.targetInstallations) {
    reasons.push('canary-installation-scope-exceeded');
  }
  if (metrics.signatureTrustFailures > 0)
    reasons.push('signature-trust-failure');
  if (metrics.guardianBypassIncidents > 0) reasons.push('guardian-bypass');
  if (metrics.egressUnexpectedAllows > 0)
    reasons.push('unexpected-egress-allow');
  if (metrics.egressMissingPrompts > 0) reasons.push('missing-egress-prompt');
  if (metrics.dataLossIncidents > 0) reasons.push('data-loss');
  if (metrics.crashLoops > 0) reasons.push('crash-loop');
  if (metrics.crashes > 0) reasons.push('crash');
  if (metrics.launchFailures > 0) reasons.push('launch-failure');
  if (metrics.recoveryFailures > 0) reasons.push('recovery-failure');
  if (metrics.authFailures > 0) reasons.push('auth-failure');
  return reasons;
}

function canaryMeetsExitCriteria(
  metrics: CanaryMetrics,
  observedHours: number,
): boolean {
  return (
    observedHours >= CANARY_5_POLICY.targetObservationHours &&
    metrics.endedAt !== null &&
    metrics.distributionClosedAt !== null &&
    metrics.uniqueInstallations === CANARY_5_POLICY.targetInstallations &&
    metrics.launchAttempts >= CANARY_5_POLICY.minimum.launchAttempts &&
    metrics.launchFailures === 0 &&
    metrics.crashes === 0 &&
    metrics.crashLoops === 0 &&
    metrics.authAttempts >= CANARY_5_POLICY.minimum.authAttempts &&
    metrics.authFailures === 0 &&
    metrics.egressPromptAttempts >=
      CANARY_5_POLICY.minimum.egressPromptAttempts &&
    metrics.egressUnexpectedAllows === 0 &&
    metrics.egressMissingPrompts === 0 &&
    metrics.recoveryAttempts >= CANARY_5_POLICY.minimum.recoveryAttempts &&
    metrics.recoveryFailures === 0 &&
    metrics.dataLossIncidents === 0 &&
    metrics.guardianBypassIncidents === 0 &&
    metrics.signatureTrustFailures === 0
  );
}

function validateAcceptanceContext(context: PreviewAcceptanceContext): void {
  if (
    context.plan.schemaVersion !== 2 ||
    context.plan.releaseKind !== 'technical-preview' ||
    !['canary', 'rollback-baseline'].includes(context.plan.promotionRole) ||
    !/^[a-f0-9]{40}$/u.test(context.releaseRef) ||
    !/^[a-f0-9]{64}$/u.test(context.manifestSha256) ||
    !context.manifestPath.startsWith('.release-notes/')
  ) {
    throw new Error('acceptance-manifest-context-invalid');
  }
}

function rollbackCommands(plan: TechnicalPreviewReleasePlan): string[] {
  const commands = [
    `gh release view ${plan.tag} --json databaseId,tagName,isDraft,isPrerelease,assets`,
  ];
  if (plan.rollback.targetTag) {
    commands.push(
      `gh release view ${plan.rollback.targetTag} --json databaseId,tagName,isDraft,isPrerelease,assets`,
      `gh release download ${plan.rollback.targetTag} --pattern "*.dmg" --pattern "*.sha256" --dir "$ROLLBACK_DIR"`,
      'shasum -a 256 -c "$ROLLBACK_DIR"/*.sha256',
    );
  }
  commands.push(`gh release edit ${plan.tag} --draft`);
  return commands;
}

export function evaluatePreviewAcceptance(
  context: PreviewAcceptanceContext,
  input: PreviewAcceptanceInput,
  automatedChecks: readonly AcceptanceCheckReceipt[],
  now = new Date(),
): PreviewAcceptanceReport {
  validateAcceptanceContext(context);
  validatePreviewAcceptanceInput(input, context);
  const byId = new Map<AcceptanceCheckId, AcceptanceCheckReceipt>();
  for (const check of automatedChecks) byId.set(check.id, check);
  for (const id of MANUAL_CHECK_IDS) {
    const manual = input.manualChecks[id];
    byId.set(
      id,
      receipt(
        id,
        manual.status,
        manual.reasonCode ??
          (manual.status === 'pass' ? 'operator-passed' : 'operator-pending'),
      ),
    );
  }

  const checks = PREVIEW_ACCEPTANCE_MATRIX.map(
    (definition) =>
      byId.get(definition.id) ??
      receipt(definition.id, 'blocked', 'evidence-missing'),
  );
  const blockers = checks
    .filter((check) => check.status !== 'pass')
    .map((check) => `${check.id}:${check.reasonCode}`);

  if (!input.rollback.operatorReviewed) {
    blockers.push('rollback:operator-review-required');
  }
  if (!input.rollback.readOnlyVerificationPassed) {
    blockers.push('rollback:read-only-verification-required');
  }
  if (
    input.publication.githubReleaseId === null ||
    input.publication.githubReleaseState !== 'draft'
  ) {
    blockers.push('publication:verified-draft-release-required');
  }

  const canary = input.canary;
  const isCanaryPlan = context.plan.promotionRole === 'canary';
  if (!isCanaryPlan && canary !== null) {
    throw new Error('acceptance-baseline-canary-forbidden');
  }
  const endedAt = canary
    ? resolveCanaryObservationEnd(canary, now)
    : now.toISOString();
  const observedHours = canary
    ? Math.max(0, hoursBetween(canary.startedAt, endedAt))
    : null;
  const stopReasons = canary ? getCanaryStopReasons(canary) : [];

  let status: PreviewAcceptanceStatus;
  if (stopReasons.length > 0) {
    status = 'rollback-required';
  } else if (blockers.length > 0) {
    status = 'hold';
  } else if (!isCanaryPlan) {
    status = 'ready-as-rollback-baseline';
  } else if (!canary) {
    status = 'ready-for-canary';
  } else if (
    observedHours !== null &&
    canaryMeetsExitCriteria(canary, observedHours)
  ) {
    status = 'ready-for-stable';
  } else {
    status = 'canary-running';
  }

  return {
    blockers,
    canary: {
      distributionClosedAt: canary?.distributionClosedAt ?? null,
      endedAt: canary?.endedAt ?? null,
      exitCriteria: isCanaryPlan ? [...CANARY_EXIT_CRITERIA] : [],
      observedHours:
        observedHours === null ? null : Math.round(observedHours * 100) / 100,
      observedInstallations: canary?.uniqueInstallations ?? null,
      startedAt: canary?.startedAt ?? null,
      stopReasons,
      targetInstallations: isCanaryPlan
        ? CANARY_5_POLICY.targetInstallations
        : 0,
      targetObservationHours: CANARY_5_POLICY.targetObservationHours,
    },
    checks,
    evidenceKind: 'release-acceptance',
    generatedAt: now.toISOString(),
    manifest: {
      path: input.manifest.path,
      sha256: input.manifest.sha256,
      sourceCommit: input.manifest.sourceCommit,
    },
    publication: {
      githubReleaseId: input.publication.githubReleaseId,
      githubReleaseState: input.publication.githubReleaseState,
      tag: input.publication.tag,
      targetCommit: input.publication.targetCommit,
    },
    release: {
      channel: 'preview',
      promotionRole: context.plan.promotionRole,
      tag: context.plan.tag,
      version: context.plan.version,
    },
    rollback: {
      commands: rollbackCommands(context.plan),
      mode: 'distribution-stop-only',
      note:
        context.plan.promotionRole === 'rollback-baseline'
          ? 'This build is the rollback baseline. Keep its GitHub Release draft and stop any out-of-band distribution; there is no earlier trusted target tag.'
          : 'Stop preview.3 distribution and use only the manifest-bound preview.2 baseline. Electron updates remain forward-only for already-updated clients.',
      ...(context.plan.rollback.targetTag
        ? { targetTag: context.plan.rollback.targetTag }
        : {}),
    },
    schemaVersion: PREVIEW_ACCEPTANCE_SCHEMA_VERSION,
    status,
  };
}

export function validatePreviewAcceptanceInput(
  value: unknown,
  context: PreviewAcceptanceContext,
): asserts value is PreviewAcceptanceInput {
  validateAcceptanceContext(context);
  if (!isObject(value) || value.schemaVersion !== 2) {
    throw new Error('acceptance-schema-version-invalid');
  }
  if (
    !isObject(value.manifest) ||
    value.manifest.path !== context.manifestPath ||
    value.manifest.sha256 !== context.manifestSha256 ||
    value.manifest.sourceCommit !== context.releaseRef
  ) {
    throw new Error('acceptance-manifest-binding-invalid');
  }
  if (!isObject(value.publication)) {
    throw new Error('acceptance-publication-missing');
  }
  if (
    (value.publication.githubReleaseId !== null &&
      (!Number.isInteger(value.publication.githubReleaseId) ||
        Number(value.publication.githubReleaseId) <= 0)) ||
    !['draft', 'not-recorded'].includes(
      String(value.publication.githubReleaseState),
    ) ||
    value.publication.tag !== context.plan.tag ||
    value.publication.targetCommit !== context.releaseRef
  ) {
    throw new Error('acceptance-publication-invalid');
  }
  if (!isObject(value.manualChecks)) {
    throw new Error('acceptance-manual-checks-missing');
  }
  for (const id of MANUAL_CHECK_IDS) {
    const check = value.manualChecks[id];
    if (
      !isObject(check) ||
      !['blocked', 'fail', 'not-run', 'pass'].includes(String(check.status)) ||
      (check.reasonCode !== undefined &&
        (typeof check.reasonCode !== 'string' ||
          !/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(check.reasonCode)))
    ) {
      throw new Error(`acceptance-manual-check-invalid:${id}`);
    }
  }
  if (!isObject(value.rollback)) throw new Error('acceptance-rollback-missing');
  if (
    typeof value.rollback.operatorReviewed !== 'boolean' ||
    typeof value.rollback.readOnlyVerificationPassed !== 'boolean'
  ) {
    throw new Error('acceptance-rollback-review-invalid');
  }
  if (value.canary !== null) validateCanaryMetrics(value.canary);
}

function validateCanaryMetrics(value: unknown): asserts value is CanaryMetrics {
  if (!isObject(value)) throw new Error('acceptance-canary-invalid');
  const numericKeys: Array<keyof CanaryMetrics> = [
    'authAttempts',
    'authFailures',
    'crashLoops',
    'crashes',
    'dataLossIncidents',
    'egressMissingPrompts',
    'egressPromptAttempts',
    'egressUnexpectedAllows',
    'guardianBypassIncidents',
    'launchAttempts',
    'launchFailures',
    'recoveryAttempts',
    'recoveryFailures',
    'signatureTrustFailures',
    'uniqueInstallations',
  ];
  for (const key of numericKeys) {
    if (
      typeof value[key] !== 'number' ||
      !Number.isInteger(value[key]) ||
      value[key] < 0
    ) {
      throw new Error(`acceptance-canary-metric-invalid:${key}`);
    }
  }
  if (
    typeof value.startedAt !== 'string' ||
    Number.isNaN(new Date(value.startedAt).getTime()) ||
    (value.endedAt !== null &&
      (typeof value.endedAt !== 'string' ||
        Number.isNaN(new Date(value.endedAt).getTime()))) ||
    (typeof value.endedAt === 'string' &&
      new Date(value.endedAt).getTime() <
        new Date(value.startedAt).getTime()) ||
    (value.distributionClosedAt !== null &&
      (typeof value.distributionClosedAt !== 'string' ||
        Number.isNaN(new Date(value.distributionClosedAt).getTime()))) ||
    (value.endedAt === null && value.distributionClosedAt !== null) ||
    (typeof value.endedAt === 'string' &&
      typeof value.distributionClosedAt === 'string' &&
      new Date(value.distributionClosedAt).getTime() <
        new Date(value.endedAt).getTime())
  ) {
    throw new Error('acceptance-canary-window-invalid');
  }
}

export function createPreviewAcceptanceTemplate(
  context: PreviewAcceptanceContext,
): PreviewAcceptanceInput {
  validateAcceptanceContext(context);
  const manualChecks = Object.fromEntries(
    MANUAL_CHECK_IDS.map((id) => [
      id,
      { reasonCode: 'operator-pending', status: 'not-run' },
    ]),
  ) as Record<ManualCheckId, ManualCheckInput>;
  return {
    canary: null,
    manifest: {
      path: context.manifestPath,
      sha256: context.manifestSha256,
      sourceCommit: context.releaseRef,
    },
    manualChecks,
    publication: {
      githubReleaseId: null,
      githubReleaseState: 'not-recorded',
      tag: context.plan.tag,
      targetCommit: context.releaseRef,
    },
    rollback: {
      operatorReviewed: false,
      readOnlyVerificationPassed: false,
    },
    schemaVersion: PREVIEW_ACCEPTANCE_SCHEMA_VERSION,
  };
}

export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

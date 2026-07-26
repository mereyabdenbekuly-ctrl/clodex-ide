import { z } from 'zod';
import { isolatedAgentRuntimeDefaultEnabledChannels } from './isolated-agent-runtime-policy';
import { cloudTaskDogfoodChannels } from './cloud-task-rollout';
import { EVIDENCE_MEMORY_ROLLOUT_POLICY } from './evidence-memory-rollout';

export const featureGateIds = [
  'collaboration-presets',
  'mascot-overlay',
  'memory-notes',
  'global-dictation',
  'realtime-dictation',
  'chronicle-visual-memory',
  'codex-micro-controller',
  'browser-use-policy-engine',
  'desktop-automation-macos-preview',
  'agent-os-debug-inspector',
  'native-skill-install',
  'agent-hooks',
  'remote-control-pairing',
  'isolated-agent-runtime',
  'multi-agent-guardian',
  'guardian-model-shadow',
  'shell-capability-security',
  'egress-policy-engine',
  'egress-transparent-proxy',
  'egress-controlled-browser',
  'egress-control-center',
  'runner-abstraction',
  'ssh-runner',
  'ssh-heavyweight-cache',
  'ssh-multiplexed-protocol',
  'ssh-artifact-manifest-fast-path',
  'docker-runner',
  'runner-shadow-routing',
  'runner-paired-replay',
  'runner-automatic-routing',
  'byo-runner-sdk',
  'plugin-marketplace',
  'cloud-tasks',
  'automations',
  'artifact-bridge',
  'artifact-bridge-writes',
  'artifact-bridge-runtime-quotas',
  'artifact-bridge-lifecycle-events',
  'artifact-bridge-ephemeral-grants',
  'artifact-bridge-sensitive-egress',
  'artifact-bridge-async-operations',
  'artifact-bridge-runtime-inspector',
  'generated-app-packages',
  'generated-app-package-capabilities',
  'executable-extensions',
  'spaces',
  'session-continuity',
  'evidence-memory-shadow',
  'evidence-memory-inspector',
  'evidence-memory-prompt-injection',
  'evidence-memory-hybrid-retrieval',
  'evidence-memory-model-summaries',
  'model-fabric-usage-ledger',
  'model-fabric-shadow-routing',
  'model-fabric-active-routing',
  'model-fabric-budget-policy',
  'model-fabric-evaluation-priors',
  'model-fabric-control-plane-refresh',
  'model-fabric-inspector',
] as const;
export type FeatureGateId = (typeof featureGateIds)[number];

export type AppReleaseChannel = 'dev' | 'prerelease' | 'nightly' | 'release';

export type FeatureGateStage = 'preview' | 'experimental';
export type FeatureGateOverrides = Partial<Record<FeatureGateId, boolean>>;

export interface FeatureGateDefinition {
  id: FeatureGateId;
  name: string;
  description: string;
  stage: FeatureGateStage;
  defaultEnabled: boolean;
  /**
   * Optional channel-specific default-on allowlist.
   *
   * When present, this replaces `defaultEnabled` for channel resolution:
   * listed channels default on and every other channel defaults off. User
   * overrides still take precedence.
   */
  defaultEnabledIn?: readonly AppReleaseChannel[];
  availableIn: readonly AppReleaseChannel[];
}

export const featureGateIdSchema = z.enum(featureGateIds);

export const featureGateOverridesSchema = z
  .record(z.string(), z.boolean())
  .transform((overrides): FeatureGateOverrides => {
    return Object.fromEntries(
      Object.entries(overrides).filter(([id]) =>
        featureGateIds.includes(id as FeatureGateId),
      ),
    ) as FeatureGateOverrides;
  })
  .default({})
  .catch({});

const ALL_RELEASE_CHANNELS: readonly AppReleaseChannel[] = [
  'dev',
  'prerelease',
  'nightly',
  'release',
];
export const agenticAppRuntimeDogfoodChannels = ['prerelease'] as const;
const evidenceMemoryShadowChannels = (
  Object.entries(EVIDENCE_MEMORY_ROLLOUT_POLICY) as Array<
    [
      AppReleaseChannel,
      (typeof EVIDENCE_MEMORY_ROLLOUT_POLICY)[AppReleaseChannel],
    ]
  >
)
  .filter(([, policy]) => policy.stage !== 'hold')
  .map(([channel]) => channel);
const evidenceMemoryInjectionChannels = (
  Object.entries(EVIDENCE_MEMORY_ROLLOUT_POLICY) as Array<
    [
      AppReleaseChannel,
      (typeof EVIDENCE_MEMORY_ROLLOUT_POLICY)[AppReleaseChannel],
    ]
  >
)
  .filter(([, policy]) => policy.allocationPercent > 0)
  .map(([channel]) => channel);

export const FEATURE_GATES: Record<FeatureGateId, FeatureGateDefinition> = {
  'collaboration-presets': {
    id: 'collaboration-presets',
    name: 'Collaboration presets',
    description:
      'Adds workflow modes for planning, implementation, review, explanation, and test writing.',
    stage: 'preview',
    defaultEnabled: false,
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'mascot-overlay': {
    id: 'mascot-overlay',
    name: 'Mascot overlay',
    description:
      'Adds a draggable glass mascot that reflects agent activity and notifications.',
    stage: 'preview',
    defaultEnabled: false,
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'memory-notes': {
    id: 'memory-notes',
    name: 'Long-term memory notes',
    description:
      'Adds encrypted global, workspace, and agent notes with explicit list, read, search, and delete tools.',
    stage: 'preview',
    defaultEnabled: false,
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'global-dictation': {
    id: 'global-dictation',
    name: 'Global dictation',
    description:
      'Adds explicit push-to-talk recording and local-buffer transcription into the active chat composer.',
    stage: 'preview',
    defaultEnabled: false,
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'realtime-dictation': {
    id: 'realtime-dictation',
    name: 'Realtime dictation',
    description:
      'Adds experimental WebRTC transcript previews with automatic batch transcription fallback.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'chronicle-visual-memory': {
    id: 'chronicle-visual-memory',
    name: 'Chronicle visual memory',
    description:
      'Adds a local timeline for privacy-filtered screen, OCR, and summary artifacts that agents can reference.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'codex-micro-controller': {
    id: 'codex-micro-controller',
    name: 'Micro controller',
    description:
      'Adds a floating command deck for push-to-talk, joystick-style actions, macro slots, and skill mentions.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'browser-use-policy-engine': {
    id: 'browser-use-policy-engine',
    name: 'Browser use policy engine',
    description:
      'Adds origin-scoped approvals for browser automation, file transfers, route capture, and CDP access.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'desktop-automation-macos-preview': {
    id: 'desktop-automation-macos-preview',
    name: 'Desktop automation for macOS',
    description:
      'Adds explicit-permission, allowlisted capture and accessibility actions with a persistent indicator and global kill switch.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'agent-os-debug-inspector': {
    id: 'agent-os-debug-inspector',
    name: 'Agent OS debug inspector',
    description:
      'Adds an internal inspector for RPC, agent, process, browser, hook, and remote-control events.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'native-skill-install': {
    id: 'native-skill-install',
    name: 'Native skill install',
    description:
      'Adds a native .skill install path for drag-and-drop and URL/deep-link skill imports.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'agent-hooks': {
    id: 'agent-hooks',
    name: 'Agent hooks',
    description:
      'Adds before-turn prompt injection and helper-agent turn/approval monitoring when a trusted runner is configured.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'remote-control-pairing': {
    id: 'remote-control-pairing',
    name: 'Remote Control + Attestation',
    description:
      'Adds one-time pairing, device-bound keys, encrypted replay-protected sessions, Guardian routing, and signed environment attestation.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: cloudTaskDogfoodChannels,
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'isolated-agent-runtime': {
    id: 'isolated-agent-runtime',
    name: 'Isolated agent runtime',
    description:
      'Runs compatible agent-step orchestration in the supervised Electron utility process.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: isolatedAgentRuntimeDefaultEnabledChannels,
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'multi-agent-guardian': {
    id: 'multi-agent-guardian',
    name: 'Multi-Agent Guardian',
    description:
      'Adds a read-only risk assessor for shell, browser network, MCP, and sandbox actions without granting execution permissions.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: ['dev', 'prerelease', 'nightly'],
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'guardian-model-shadow': {
    id: 'guardian-model-shadow',
    name: 'Guardian model shadow review',
    description:
      'Runs a provider-neutral structured risk classifier in shadow mode and compares it with deterministic Guardian without changing authorization.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'shell-capability-security': {
    id: 'shell-capability-security',
    name: 'Shell capability security',
    description:
      'Binds every shell authorization to an agent, tool call, canonical action hash, short expiry, one-time consumption, and tamper-evident local audit.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'egress-policy-engine': {
    id: 'egress-policy-engine',
    name: 'Egress policy engine',
    description:
      'Adds deny-by-default destination policy decisions and a tamper-evident content-free audit foundation for controlled network runtimes.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'egress-transparent-proxy': {
    id: 'egress-transparent-proxy',
    name: 'Transparent egress proxy',
    description:
      'Routes supported managed runtimes through an authenticated local proxy with destination policy, one-shot DNS validation, and IP-pinned sockets.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'egress-controlled-browser': {
    id: 'egress-controlled-browser',
    name: 'Controlled browser egress',
    description:
      'Routes the shared Chromium browsing session through the managed egress proxy, removes implicit loopback bypass, and fails closed when the proxy is unavailable.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'egress-control-center': {
    id: 'egress-control-center',
    name: 'Egress control center',
    description:
      'Adds a local settings surface for exact shared-browser destination grants, fail-closed runtime status, and sanitized network audit export.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'runner-abstraction': {
    id: 'runner-abstraction',
    name: 'Workspace runner abstraction',
    description:
      'Routes shell execution through snapshot-bound WorkspaceExecutionProvider leases while preserving the existing local PTY implementation.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: ['dev'],
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'ssh-runner': {
    id: 'ssh-runner',
    name: 'SSH Runner v1',
    description:
      'Routes non-interactive shell commands to a user-selected saved SSH connection after revision and workspace-state verification.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'ssh-heavyweight-cache': {
    id: 'ssh-heavyweight-cache',
    name: 'SSH heavyweight workspace cache',
    description:
      'Reuses snapshot-bound remote workspaces and isolated Node, Cargo, or Go caches for allowlisted heavyweight SSH build/test commands.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'ssh-multiplexed-protocol': {
    id: 'ssh-multiplexed-protocol',
    name: 'SSH multiplexed runner protocol',
    description:
      'Keeps a dedicated SSH ControlMaster session for runner traffic and batches polling, artifact inspection, and cleanup round trips.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'ssh-artifact-manifest-fast-path': {
    id: 'ssh-artifact-manifest-fast-path',
    name: 'SSH Artifact Manifest fast path',
    description:
      'Captures bounded artifact snapshots and deltas on the runner and merges terminal reads with artifact finalization when safe.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'docker-runner': {
    id: 'docker-runner',
    name: 'Docker Runner v1',
    description:
      'Runs snapshot-bound non-interactive shell commands in a digest-pinned, resource-limited, network-disabled Docker container.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'runner-shadow-routing': {
    id: 'runner-shadow-routing',
    name: 'Runner shadow routing',
    description:
      'Predicts Local, SSH, or Docker routing and records explainable decisions without changing the selected execution provider.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: ['dev'],
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'runner-paired-replay': {
    id: 'runner-paired-replay',
    name: 'Runner paired replay',
    description:
      'Samples safe commands onto disposable SSH or network-disabled Docker snapshots to verify shadow-routing counterfactuals without fallback.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'runner-automatic-routing': {
    id: 'runner-automatic-routing',
    name: 'Guarded automatic runner routing',
    description:
      'Allows evidence-backed runner recommendations to change dispatch only for sessionless non-interactive commands with verified environment history and pre-dispatch fallback.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'byo-runner-sdk': {
    id: 'byo-runner-sdk',
    name: 'BYO Runner SDK',
    description:
      'Allows provider-neutral, manifest-declared workspace runners to register behind the same signed jobs, leases, receipts, routing policy, and audit boundary.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'plugin-marketplace': {
    id: 'plugin-marketplace',
    name: 'Plugin Marketplace',
    description:
      'Adds signed plugin catalog metadata, staged installation, integrity verification, updates, and rollback.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: ['dev', 'prerelease', 'nightly'],
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'cloud-tasks': {
    id: 'cloud-tasks',
    name: 'Cloud Tasks',
    description:
      'Adds fail-closed cloud execution with bounded snapshots, resumable artifacts, usage quotas, and dogfood-only default admission.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: ['dev', 'prerelease', 'nightly'],
    availableIn: ALL_RELEASE_CHANNELS,
  },
  automations: {
    id: 'automations',
    name: 'Scheduled Automations',
    description:
      'Adds persistent one-time, interval, and cron agent tasks with retry, missed-run, and local/cloud execution policies.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: ['dev', 'prerelease', 'nightly'],
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'artifact-bridge': {
    id: 'artifact-bridge',
    name: 'Generated App Capability Bridge',
    description:
      'Allows explicitly granted generated apps to call read-only MCP tools, ask a bounded model question, and launch an automation.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: ['dev', 'prerelease', 'nightly'],
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'artifact-bridge-writes': {
    id: 'artifact-bridge-writes',
    name: 'Generated App Safe Writes',
    description:
      'Adds prepare, trusted preview, explicit approval, and idempotent commit for scoped generated-app MCP writes.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: agenticAppRuntimeDogfoodChannels,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'artifact-bridge-runtime-quotas': {
    id: 'artifact-bridge-runtime-quotas',
    name: 'Generated App Runtime Quotas',
    description:
      'Enforces organization-controlled per-principal concurrency, model-question, and automation-launch limits for generated apps.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: agenticAppRuntimeDogfoodChannels,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'artifact-bridge-lifecycle-events': {
    id: 'artifact-bridge-lifecycle-events',
    name: 'Generated App Lifecycle Events',
    description:
      'Adds session-scoped, context-filtered capability, identity, package trust, policy, and automation lifecycle notifications for generated apps.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: agenticAppRuntimeDogfoodChannels,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'artifact-bridge-ephemeral-grants': {
    id: 'artifact-bridge-ephemeral-grants',
    name: 'Generated App Ephemeral Grants',
    description:
      'Allows capability grants bound to one active generated-app preview session and revokes them automatically on reload or close.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: agenticAppRuntimeDogfoodChannels,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'artifact-bridge-sensitive-egress': {
    id: 'artifact-bridge-sensitive-egress',
    name: 'Generated App Sensitive Egress',
    description:
      'Classifies remote and credential-sensitive MCP calls, requires separate one-time approval, and redacts secrets from generated-app results and audit errors.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: agenticAppRuntimeDogfoodChannels,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'artifact-bridge-async-operations': {
    id: 'artifact-bridge-async-operations',
    name: 'Generated App Async Operations',
    description:
      'Adds session-bound operation handles, bounded progress, cancellation, timeout, result retrieval, and lifecycle events for generated-app MCP and automation work.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: agenticAppRuntimeDogfoodChannels,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'artifact-bridge-runtime-inspector': {
    id: 'artifact-bridge-runtime-inspector',
    name: 'Generated App Runtime Inspector',
    description:
      'Adds a trusted, bounded view of generated-app preview sessions, grants, quotas, pending reviews, async operations, and redacted audit history.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: agenticAppRuntimeDogfoodChannels,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'generated-app-packages': {
    id: 'generated-app-packages',
    name: 'Signed Generated App Packages',
    description:
      'Adds identity-bound Ed25519 attestations and fail-closed trusted-publisher verification for generated app export and import.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: agenticAppRuntimeDogfoodChannels,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'generated-app-package-capabilities': {
    id: 'generated-app-package-capabilities',
    name: 'Packaged App Capabilities',
    description:
      'Allows trusted, policy-approved generated app packages to request identity-bound MCP and automation grants without inheriting an agent identity.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: agenticAppRuntimeDogfoodChannels,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'executable-extensions': {
    id: 'executable-extensions',
    name: 'Executable Extensions',
    description:
      'Allows signed plugins with an integrity-bound runtime manifest to expose local stdio MCP servers.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: ['dev', 'prerelease', 'nightly'],
    availableIn: ALL_RELEASE_CHANNELS,
  },
  spaces: {
    id: 'spaces',
    name: 'Spaces',
    description:
      'Adds persistent knowledge and work containers that combine workspaces, links, instructions, sessions, apps, and automations.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: ['dev', 'prerelease', 'nightly'],
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'session-continuity': {
    id: 'session-continuity',
    name: 'Session Teleport and Sharing',
    description:
      'Adds cloud-readiness checks, local-to-cloud continuation, and expiring read-only session share links.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: ['dev', 'prerelease', 'nightly'],
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'evidence-memory-shadow': {
    id: 'evidence-memory-shadow',
    name: 'Evidence Memory shadow ledger',
    description:
      'Records protected task evidence and automatically compares Guarded Memory with compressed history on long tasks without changing model prompts.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: evidenceMemoryShadowChannels,
    availableIn: ALL_RELEASE_CHANNELS,
  },
  'evidence-memory-inspector': {
    id: 'evidence-memory-inspector',
    name: 'Evidence Memory inspector',
    description:
      'Adds a task-scoped trusted UI for evidence statistics, claims, provenance, exclusions, export, and reset.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: ['dev'],
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'evidence-memory-prompt-injection': {
    id: 'evidence-memory-prompt-injection',
    name: 'Evidence Memory prompt injection',
    description:
      'Injects a guarded, token-bounded evidence context pack into agent prompts. Falls back to compressed memory on every failure.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: evidenceMemoryInjectionChannels,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'evidence-memory-hybrid-retrieval': {
    id: 'evidence-memory-hybrid-retrieval',
    name: 'Evidence Memory hybrid retrieval',
    description:
      'Adds privacy-preserving local embeddings and reciprocal-rank fusion to lexical evidence retrieval.',
    stage: 'experimental',
    defaultEnabled: false,
    defaultEnabledIn: ['dev'],
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'evidence-memory-model-summaries': {
    id: 'evidence-memory-model-summaries',
    name: 'Evidence Memory model summaries',
    description:
      'Uses the provider-neutral quick-model route for redacted background summaries with deterministic offline fallback.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev', 'prerelease', 'nightly'],
  },
  'model-fabric-usage-ledger': {
    id: 'model-fabric-usage-ledger',
    name: 'Model Fabric usage ledger',
    description:
      'Records content-free model execution counters, latency, route mode, and outcomes for routing and budget evaluation.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev'],
  },
  'model-fabric-shadow-routing': {
    id: 'model-fabric-shadow-routing',
    name: 'Model Fabric shadow routing',
    description:
      'Scores provider-neutral model routes and endpoint health without changing the active model selected by the compatibility router.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev'],
  },
  'model-fabric-active-routing': {
    id: 'model-fabric-active-routing',
    name: 'Model Fabric active routing',
    description:
      'Allows conservatively admitted Model Fabric routes to replace the compatibility route with a replay-safe fallback.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev'],
  },
  'model-fabric-budget-policy': {
    id: 'model-fabric-budget-policy',
    name: 'Model Fabric budget policy',
    description:
      'Applies rolling task, workspace, provider, and global budget reservations before active route admission.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev'],
  },
  'model-fabric-evaluation-priors': {
    id: 'model-fabric-evaluation-priors',
    name: 'Model Fabric evaluation priors',
    description:
      'Applies bounded content-free reliability, latency, and cost observations to provider-neutral shadow scoring.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev'],
  },
  'model-fabric-control-plane-refresh': {
    id: 'model-fabric-control-plane-refresh',
    name: 'Model Fabric control-plane refresh',
    description:
      'Hot-applies signed enterprise policy revisions with delegated signing-key rotation, revocation, durable quarantine, and bounded backoff.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev'],
  },
  'model-fabric-inspector': {
    id: 'model-fabric-inspector',
    name: 'Model Fabric inspector',
    description:
      'Shows content-free usage, route decisions, budget lifecycle events, and endpoint health in trusted settings UI.',
    stage: 'experimental',
    defaultEnabled: false,
    availableIn: ['dev'],
  },
};

export interface ResolvedFeatureGate {
  definition: FeatureGateDefinition;
  available: boolean;
  enabled: boolean;
  source: 'unavailable' | 'default' | 'override';
}

export function getFeatureGateDefault(
  id: FeatureGateId,
  releaseChannel: AppReleaseChannel,
): boolean {
  const definition = FEATURE_GATES[id];
  return (
    definition.defaultEnabledIn?.includes(releaseChannel) ??
    definition.defaultEnabled
  );
}

export function resolveFeatureGate(
  id: FeatureGateId,
  overrides: FeatureGateOverrides,
  releaseChannel: AppReleaseChannel,
): ResolvedFeatureGate {
  const definition = FEATURE_GATES[id];
  const available = definition.availableIn.includes(releaseChannel);

  if (!available) {
    return {
      definition,
      available: false,
      enabled: false,
      source: 'unavailable',
    };
  }

  const override = overrides[id];
  return {
    definition,
    available: true,
    enabled: override ?? getFeatureGateDefault(id, releaseChannel),
    source: override === undefined ? 'default' : 'override',
  };
}

export function listAvailableFeatureGates(
  releaseChannel: AppReleaseChannel,
): FeatureGateDefinition[] {
  return featureGateIds
    .map((id) => FEATURE_GATES[id])
    .filter((definition) => definition.availableIn.includes(releaseChannel));
}

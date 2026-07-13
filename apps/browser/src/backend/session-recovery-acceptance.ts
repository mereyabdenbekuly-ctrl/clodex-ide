import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  SESSION_RECOVERY_ACCEPTANCE_ARTIFACT_DIRECTORY,
  SESSION_RECOVERY_ACCEPTANCE_PROFILE_MARKER,
  SESSION_RECOVERY_ACCEPTANCE_PROFILE_MARKER_CONTENT,
  sessionRecoverySeedArtifactSchema,
  sessionRecoveryVerifyArtifactSchema,
  type SessionRecoveryAcceptancePhase,
  type SessionRecoveryPhaseArtifact,
  type SessionRecoverySeedArtifact,
} from '../shared/session-recovery-acceptance';
import { getJsonPath } from './utils/paths';

const RECOVERY_MARKER_TITLE = 'Session recovery acceptance marker v1';
const RECOVERY_MARKER_INPUT_STATE = JSON.stringify({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'session-recovery-marker-v1' }],
    },
  ],
});
const RECOVERY_MARKER_GOAL = 'Validate packaged session recovery marker v1';
const RECOVERY_MARKER_TOKEN_BUDGET = 4096;
const RECOVERY_MARKER_TIME_BUDGET_SECONDS = 600;
const PHASE_TIMEOUT_MS = 30_000;
const ARTIFACT_MODE_OWNER_ONLY = 0o600;

const tabStateSelectionSchema = z
  .object({ lastOpenAgentId: z.string().min(1) })
  .passthrough();

type AgentManagerAcceptancePort = {
  dispatchCommand(
    name:
      | 'agents.updateInputState'
      | 'agents.setTitle'
      | 'agents.setGoal'
      | 'agents.setGoalStatus',
    args: unknown[],
    callerId?: string,
  ): Promise<unknown>;
  prepareSessionCheckpoint(agentInstanceId: string): Promise<{
    agentStateFlushedAt: string;
    memoryFlushedAt: string;
    wasLive: boolean;
  }>;
};

type AgentStoreAcceptancePort = {
  get(): unknown;
  whenSettled(): Promise<void>;
};

type AgentDbAcceptancePort = {
  getStoredAgentInstanceById(agentInstanceId: string): Promise<unknown>;
};

type WindowLayoutAcceptancePort = {
  focusAgentFromExternalWindow(agentInstanceId: string): Promise<void>;
  persistTabStateNow(): void;
};

type RecoverySemanticState = {
  type: string;
  parentAgentInstanceId: string | null;
  title: string;
  titleLockedByUser: boolean;
  isWorking: boolean;
  history: unknown[];
  queuedMessages: unknown[];
  activeModelId: string;
  toolApprovalMode: string;
  pendingApprovalCount: number;
  inputState: string;
  usedTokens: number;
  goal: unknown;
  mountedWorkspaceCount: number;
};

export interface SessionRecoveryAcceptanceDependencies {
  phase: SessionRecoveryAcceptancePhase;
  explicitUserDataDirectory: string;
  userDataDirectory: string;
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  agentManager: AgentManagerAcceptancePort;
  agentStore: AgentStoreAcceptancePort;
  agentDb: AgentDbAcceptancePort;
  windowLayout: WindowLayoutAcceptancePort;
}

export function parseSessionRecoveryAcceptancePhase(
  value: string,
): SessionRecoveryAcceptancePhase {
  if (value === 'seed' || value === 'verify') return value;
  throw new Error(
    'Session recovery acceptance phase must be "seed" or "verify"',
  );
}

export async function runSessionRecoveryAcceptance(
  dependencies: SessionRecoveryAcceptanceDependencies,
): Promise<SessionRecoveryPhaseArtifact> {
  await assertIsolatedAcceptanceProfile(dependencies);
  return dependencies.phase === 'seed'
    ? await seedRecoveryState(dependencies)
    : await verifyRecoveryState(dependencies);
}

export function hashRecoverySemanticState(value: unknown): string {
  return sha256(canonicalJson(value));
}

async function seedRecoveryState(
  dependencies: SessionRecoveryAcceptanceDependencies,
): Promise<SessionRecoverySeedArtifact> {
  const artifactPath = getPhaseArtifactPath(
    dependencies.userDataDirectory,
    'seed',
  );
  await assertFileDoesNotExist(
    artifactPath,
    'Session recovery seed artifact already exists; a fresh profile is required',
  );

  const taskId = await waitForSingleTopLevelAgent(dependencies.agentStore);
  const initialState = readLiveSemanticState(dependencies.agentStore, taskId);
  if (initialState.type !== 'chat') {
    throw new Error('Session recovery acceptance requires a CHAT task');
  }
  assertContentFreeTask(initialState);

  const callerId = 'session-recovery-acceptance';
  await dependencies.agentManager.dispatchCommand(
    'agents.updateInputState',
    [taskId, RECOVERY_MARKER_INPUT_STATE],
    callerId,
  );
  await dependencies.agentManager.dispatchCommand(
    'agents.setTitle',
    [taskId, RECOVERY_MARKER_TITLE],
    callerId,
  );
  await dependencies.agentManager.dispatchCommand(
    'agents.setGoal',
    [
      taskId,
      RECOVERY_MARKER_GOAL,
      RECOVERY_MARKER_TOKEN_BUDGET,
      RECOVERY_MARKER_TIME_BUDGET_SECONDS,
    ],
    callerId,
  );
  await dependencies.agentManager.dispatchCommand(
    'agents.setGoalStatus',
    [taskId, 'blocked'],
    callerId,
  );
  await dependencies.agentStore.whenSettled();

  await dependencies.windowLayout.focusAgentFromExternalWindow(taskId);
  dependencies.windowLayout.persistTabStateNow();
  const selectedTaskId = await readPersistedLastOpenAgentId();
  if (selectedTaskId !== taskId) {
    throw new Error('Session recovery tab selection did not persist');
  }

  const checkpoint =
    await dependencies.agentManager.prepareSessionCheckpoint(taskId);
  if (
    !checkpoint.wasLive ||
    !isIsoTimestamp(checkpoint.agentStateFlushedAt) ||
    !isIsoTimestamp(checkpoint.memoryFlushedAt)
  ) {
    throw new Error('Session recovery checkpoint did not flush live state');
  }

  const liveState = readLiveSemanticState(dependencies.agentStore, taskId);
  assertDeterministicMarkerState(liveState);
  const stored = await dependencies.agentDb.getStoredAgentInstanceById(taskId);
  const storedState = readStoredSemanticState(stored);
  assertDeterministicMarkerState(storedState);
  const semanticStateDigest = hashRecoverySemanticState(liveState);
  if (hashRecoverySemanticState(storedState) !== semanticStateDigest) {
    throw new Error('Session recovery persisted seed state does not match');
  }

  const artifact = sessionRecoverySeedArtifactSchema.parse({
    schemaVersion: 1,
    phase: 'seed',
    appVersion: dependencies.appVersion,
    platform: normalizePlatform(dependencies.platform),
    arch: dependencies.arch,
    taskIdentityHash: sha256(taskId),
    semanticStateDigest,
    counts: getObservationCounts(liveState),
    checks: {
      isolatedProfile: true,
      freshProfile: true,
      targetAgentCreated: true,
      deterministicStateSeeded: true,
      persistedStateMatched: true,
      checkpointFlushed: true,
      tabStatePersisted: true,
      contentFreeAudit: true,
    },
  });
  await writePhaseArtifact(artifactPath, artifact);
  return artifact;
}

async function verifyRecoveryState(
  dependencies: SessionRecoveryAcceptanceDependencies,
): Promise<SessionRecoveryPhaseArtifact> {
  const seedArtifact = await readSeedArtifact(dependencies.userDataDirectory);
  if (
    seedArtifact.appVersion !== dependencies.appVersion ||
    seedArtifact.platform !== normalizePlatform(dependencies.platform) ||
    seedArtifact.arch !== dependencies.arch
  ) {
    throw new Error('Session recovery verify phase used a different build');
  }

  const taskId = await readPersistedLastOpenAgentId();
  if (sha256(taskId) !== seedArtifact.taskIdentityHash) {
    throw new Error('Session recovery tab state selected a different task');
  }
  await waitForAgent(dependencies.agentStore, taskId);
  await dependencies.agentStore.whenSettled();

  const liveState = readLiveSemanticState(dependencies.agentStore, taskId);
  const stored = await dependencies.agentDb.getStoredAgentInstanceById(taskId);
  const storedState = readStoredSemanticState(stored);
  assertDeterministicMarkerState(liveState);
  assertDeterministicMarkerState(storedState);
  const liveDigest = hashRecoverySemanticState(liveState);
  const storedDigest = hashRecoverySemanticState(storedState);
  if (
    liveDigest !== seedArtifact.semanticStateDigest ||
    storedDigest !== seedArtifact.semanticStateDigest
  ) {
    throw new Error('Session recovery state changed across packaged restart');
  }

  const artifact = sessionRecoveryVerifyArtifactSchema.parse({
    schemaVersion: 1,
    phase: 'verify',
    appVersion: dependencies.appVersion,
    platform: normalizePlatform(dependencies.platform),
    arch: dependencies.arch,
    taskIdentityHash: seedArtifact.taskIdentityHash,
    semanticStateDigest: seedArtifact.semanticStateDigest,
    counts: getObservationCounts(liveState),
    checks: {
      isolatedProfile: true,
      sameProfileRestart: true,
      targetAgentResumed: true,
      persistedStateMatched: true,
      liveStateMatched: true,
      noDataLoss: true,
      contentFreeAudit: true,
    },
  });
  await writePhaseArtifact(
    getPhaseArtifactPath(dependencies.userDataDirectory, 'verify'),
    artifact,
  );
  return artifact;
}

async function assertIsolatedAcceptanceProfile(
  dependencies: Pick<
    SessionRecoveryAcceptanceDependencies,
    'explicitUserDataDirectory' | 'userDataDirectory'
  >,
): Promise<void> {
  if (!dependencies.explicitUserDataDirectory.trim()) {
    throw new Error(
      'Session recovery acceptance refuses to use the default user profile',
    );
  }
  if (
    path.resolve(dependencies.explicitUserDataDirectory) !==
    path.resolve(dependencies.userDataDirectory)
  ) {
    throw new Error('Session recovery acceptance user profile mismatch');
  }
  const markerPath = path.join(
    dependencies.userDataDirectory,
    SESSION_RECOVERY_ACCEPTANCE_PROFILE_MARKER,
  );
  const marker = await readFile(markerPath, 'utf8').catch(() => null);
  if (marker !== SESSION_RECOVERY_ACCEPTANCE_PROFILE_MARKER_CONTENT) {
    throw new Error(
      'Session recovery acceptance profile safety marker is missing',
    );
  }
}

async function waitForSingleTopLevelAgent(
  store: AgentStoreAcceptancePort,
): Promise<string> {
  return await waitFor('fresh top-level agent', () => {
    const instances = readAgentInstances(store);
    const topLevelIds = Object.entries(instances)
      .filter(([, value]) => readRecord(value).parentAgentInstanceId === null)
      .map(([id]) => id);
    return topLevelIds.length === 1 ? topLevelIds[0] : null;
  });
}

async function waitForAgent(
  store: AgentStoreAcceptancePort,
  taskId: string,
): Promise<void> {
  await waitFor('persisted task resume', () =>
    readAgentInstances(store)[taskId] ? true : null,
  );
}

async function waitFor<T>(
  description: string,
  read: () => T | null,
): Promise<T> {
  const deadline = Date.now() + PHASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for session recovery ${description}`);
}

function readLiveSemanticState(
  store: AgentStoreAcceptancePort,
  taskId: string,
): RecoverySemanticState {
  const root = readRecord(store.get());
  const agents = readRecord(root.agents);
  const instances = readRecord(agents.instances);
  const envelope = readRecord(instances[taskId]);
  const state = readRecord(envelope.state);
  const toolbox = readRecord(root.toolbox);
  const toolboxEntry = readOptionalRecord(toolbox[taskId]);
  const workspace = readOptionalRecord(toolboxEntry?.workspace);
  const mounts = Array.isArray(workspace?.mounts) ? workspace.mounts : [];
  return {
    type: readString(envelope.type, 'live task type'),
    parentAgentInstanceId: readNullableString(
      envelope.parentAgentInstanceId,
      'live parent task id',
    ),
    title: readString(state.title, 'live title'),
    titleLockedByUser: state.titleLockedByUser === true,
    isWorking: readBoolean(state.isWorking, 'live working state'),
    history: readArray(state.history),
    queuedMessages: readArray(state.queuedMessages),
    activeModelId: readString(state.activeModelId, 'live model'),
    toolApprovalMode: readString(
      state.toolApprovalMode,
      'live tool approval mode',
    ),
    pendingApprovalCount: Object.keys(readRecord(state.pendingApprovals))
      .length,
    inputState: readString(state.inputState, 'live input state'),
    usedTokens: readNumber(state.usedTokens, 'live used tokens'),
    goal: state.goal ?? null,
    mountedWorkspaceCount: mounts.length,
  };
}

function readStoredSemanticState(value: unknown): RecoverySemanticState {
  const stored = readRecord(value);
  return {
    type: readString(stored.type, 'stored task type'),
    parentAgentInstanceId: readNullableString(
      stored.parentAgentInstanceId,
      'stored parent task id',
    ),
    title: readString(stored.title, 'stored title'),
    titleLockedByUser: stored.titleLockedByUser === true,
    isWorking: false,
    history: readArray(stored.history),
    queuedMessages: readArray(stored.queuedMessages),
    activeModelId: readString(stored.activeModelId, 'stored model'),
    toolApprovalMode: readString(
      stored.toolApprovalMode,
      'stored tool approval mode',
    ),
    pendingApprovalCount: 0,
    inputState: readString(stored.inputState, 'stored input state'),
    usedTokens: readNumber(stored.usedTokens, 'stored used tokens'),
    goal: stored.goal ?? null,
    mountedWorkspaceCount: Array.isArray(stored.mountedWorkspaces)
      ? stored.mountedWorkspaces.length
      : 0,
  };
}

function assertContentFreeTask(state: RecoverySemanticState): void {
  if (
    state.history.length !== 0 ||
    state.queuedMessages.length !== 0 ||
    state.mountedWorkspaceCount !== 0
  ) {
    throw new Error(
      'Session recovery acceptance refuses a task with existing content or workspaces',
    );
  }
}

function assertDeterministicMarkerState(state: RecoverySemanticState): void {
  assertContentFreeTask(state);
  const goal = readRecord(state.goal);
  if (
    state.type !== 'chat' ||
    state.parentAgentInstanceId !== null ||
    state.title !== RECOVERY_MARKER_TITLE ||
    !state.titleLockedByUser ||
    state.isWorking ||
    state.pendingApprovalCount !== 0 ||
    state.inputState !== RECOVERY_MARKER_INPUT_STATE ||
    state.usedTokens !== 0 ||
    goal.objective !== RECOVERY_MARKER_GOAL ||
    goal.status !== 'blocked' ||
    goal.tokenBudget !== RECOVERY_MARKER_TOKEN_BUDGET ||
    goal.timeBudgetSeconds !== RECOVERY_MARKER_TIME_BUDGET_SECONDS
  ) {
    throw new Error(
      'Session recovery deterministic marker state is incomplete',
    );
  }
}

function getObservationCounts(state: RecoverySemanticState) {
  return {
    history: state.history.length,
    queuedMessages: state.queuedMessages.length,
    mountedWorkspaces: state.mountedWorkspaceCount,
  };
}

async function readPersistedLastOpenAgentId(): Promise<string> {
  const raw = await readFile(getJsonPath('tab-state'), 'utf8');
  return tabStateSelectionSchema.parse(JSON.parse(raw)).lastOpenAgentId;
}

async function readSeedArtifact(
  userDataDirectory: string,
): Promise<SessionRecoverySeedArtifact> {
  const raw = await readFile(
    getPhaseArtifactPath(userDataDirectory, 'seed'),
    'utf8',
  );
  return sessionRecoverySeedArtifactSchema.parse(JSON.parse(raw));
}

function getPhaseArtifactPath(
  userDataDirectory: string,
  phase: SessionRecoveryAcceptancePhase,
): string {
  return path.join(
    userDataDirectory,
    SESSION_RECOVERY_ACCEPTANCE_ARTIFACT_DIRECTORY,
    `${phase}.json`,
  );
}

async function writePhaseArtifact(
  outputPath: string,
  artifact: SessionRecoveryPhaseArtifact,
): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, {
      encoding: 'utf8',
      mode: ARTIFACT_MODE_OWNER_ONLY,
      flag: 'wx',
    });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function assertFileDoesNotExist(
  filePath: string,
  message: string,
): Promise<void> {
  try {
    await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(message);
}

function normalizePlatform(platform: NodeJS.Platform) {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') {
    return platform;
  }
  throw new Error('Session recovery acceptance platform is unsupported');
}

function readAgentInstances(store: AgentStoreAcceptancePort) {
  const root = readRecord(store.get());
  return readRecord(readRecord(root.agents).instances);
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Session recovery state record is missing');
  }
  return value as Record<string, unknown>;
}

function readOptionalRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return readRecord(value);
}

function readArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('Session recovery state array is missing');
  }
  return value;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Session recovery ${label} is missing`);
  }
  return value;
}

function readNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return readString(value, label);
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Session recovery ${label} is missing`);
  }
  return value;
}

function readNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Session recovery ${label} is missing`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function isIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

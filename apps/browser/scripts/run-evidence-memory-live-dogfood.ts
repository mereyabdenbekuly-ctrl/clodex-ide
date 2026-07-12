import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  AgentHost,
  AgentManager,
  AgentStore,
  AgentTypeRegistry,
  ChatAgent,
  CommandRegistry,
  WorkspaceMdAgent,
  createInitialAgentSystemState,
  createUniversalToolbox,
  type AgentManagerToolboxPort,
} from '@clodex/agent-core';
import {
  EVIDENCE_MEMORY_DOGFOOD_COHORT_TASK_ID,
  evaluateEvidenceMemoryDogfoodCohort,
  resolveEvidenceMemoryIncrementalTokenBudget,
  type EvidenceMemoryEvaluationScenario,
  type EvidenceMemoryService,
} from '@clodex/agent-core/evidence-memory';
import type { BaseAgentConfig } from '@clodex/agent-core/agents';
import type { HostModels, HostPaths } from '@clodex/agent-core/host';
import { MountManager } from '@clodex/agent-core/mount-manager';
import { AgentCorePersistence } from '@clodex/agent-core/persistence';
import type { AgentMessage, AgentState } from '@clodex/agent-core/types/agent';
import { AgentTypes } from '@clodex/agent-core/types/agent';
import { modelCapabilitiesSchema } from '@clodex/agent-core/types/models';
import type { MountPermission } from '@clodex/agent-core/types/metadata';
import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { streamText } from 'ai';
import { CredentialsService } from '../src/backend/services/credentials';
import { createBrowserDataProtection } from '../src/backend/services/data-protection';
import { EvidenceMemoryDogfoodBackfill } from '../src/backend/services/evidence-memory-dogfood-backfill';
import { Logger } from '../src/backend/services/logger';
import { PreferencesService } from '../src/backend/services/preferences';

// Four stable four-turn tasks yield three replayable post-compression
// boundaries each. That guarantees 12 restart observations without relying on
// a fifth compression pass, which is intentionally allowed to time out under
// provider backpressure.
const DEFAULT_TASKS = 4;
const DEFAULT_TURNS = 4;
const DEFAULT_MODEL = 'gpt-5.4-mini';
const MAX_TASKS = 5;
const MAX_TURNS = 6;
const STEP_TIMEOUT_MS = 180_000;
const COMPRESSION_TIMEOUT_MS = 45_000;
const MAX_COMPRESSION_ATTEMPTS = 3;
const CONTROLLED_PROBE_MAX_CLAIMS = 1;
const execFileAsync = promisify(execFile);

class LiveDogfoodChatAgent extends ChatAgent {}

const liveDogfoodChatAgentConfig = {
  ...ChatAgent.config,
  defaultModelId: DEFAULT_MODEL,
  generateTitles: false,
  historyCompressionThreshold: 0,
  minUncompressedMessages: 5,
  maxOutputTokens: 512,
} satisfies BaseAgentConfig<never>;

// ChatAgent's inferred static config preserves literal values (for example,
// generateTitles: true), so a normal static override cannot express this
// test-only configuration even though BaseAgent accepts it. Define an own
// immutable config on the harness subclass without mutating production ChatAgent.
Object.defineProperty(LiveDogfoodChatAgent, 'config', {
  configurable: false,
  enumerable: true,
  value: liveDogfoodChatAgentConfig,
  writable: false,
});

type RunOptions = {
  tasks: number;
  turns: number;
  modelId: string;
  confirmed: boolean;
  resetCohort: boolean;
  cohortSeed: string | null;
};

interface ControlledDogfoodProbe {
  id: string;
  category: EvidenceMemoryEvaluationScenario['category'];
  query: string;
  expectedClaimIds: string[];
  forbiddenClaimIds: string[];
}

interface ControlledDogfoodScenario {
  messageLines: string[];
  probes: ControlledDogfoodProbe[];
}

export async function runEvidenceMemoryLiveDogfood(
  argv: readonly string[],
): Promise<number> {
  const options = parseArguments(argv);
  if (!options.confirmed) {
    throw new Error('Live model calls require --confirm-live-model-calls');
  }
  const logger = new Logger(false);
  const dataProtection = await createBrowserDataProtection(logger);
  const credentials = await CredentialsService.create(logger);
  const preferences = await PreferencesService.create(logger);
  const clodexProfile = preferences
    .get()
    .providerProfiles.find(
      (profile) => profile.enabled && profile.providerType === 'clodex',
    );
  if (!clodexProfile?.apiKeyReference) {
    await credentials.teardown();
    await preferences.teardown();
    throw new Error('An enabled Clodex provider credential is required');
  }
  const apiKey = credentials.getProviderApiKey(clodexProfile.apiKeyReference);
  if (!apiKey) {
    await credentials.teardown();
    await preferences.teardown();
    throw new Error('An enabled Clodex provider credential is required');
  }
  const relayUrl =
    clodexProfile.baseUrl ??
    process.env.CLODEX_LLM_RELAY_URL?.trim() ??
    'https://clodex.xyz/v1';
  const paths = createProfileHostPaths(app.getPath('userData'));
  const workspacePath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../..',
  );
  const repositoryRevision = await resolveRepositoryRevision(workspacePath);
  await ensureRuntimeDirectories(paths);
  const host = new AgentHost({
    paths,
    logger,
    models: createDogfoodHostModels(apiKey, relayUrl, options.modelId),
    dataProtection,
  });
  host.defineAgentProfile(AgentTypes.CHAT, { envDomainIds: [] });
  host.defineAgentProfile(AgentTypes.WORKSPACE_MD, { envDomainIds: [] });

  const store = new AgentStore(createInitialAgentSystemState());
  const mountManager = new MountManager({
    store,
    logger,
    hooks: {},
    getAgentType: () => AgentTypes.CHAT,
    workspaceMdRelativePath: host.workspaceMdRelativePath(),
  });
  const managerToolbox = createManagerToolbox({ mountManager, store });
  const universalToolbox = createUniversalToolbox({ host, mountManager });
  const agentToolbox = {
    ...universalToolbox,
    async getEvidenceMemoryRepositoryRevision() {
      return repositoryRevision;
    },
  };
  const persistence = await AgentCorePersistence.create({
    host,
    store,
    enableEvidenceMemory: true,
    enableEvidenceMemoryPromptInjection: false,
    enableEvidenceMemoryHybridRetrieval: true,
    enableEvidenceMemorySummaryMaterialization: false,
  });
  if (!persistence.evidenceMemory) {
    await persistence.teardown();
    throw new Error('Evidence Memory failed to initialize');
  }

  const registry = new AgentTypeRegistry();
  registry.register(AgentTypes.CHAT, LiveDogfoodChatAgent as never);
  registry.register(AgentTypes.WORKSPACE_MD, WorkspaceMdAgent as never);
  const manager = new AgentManager({
    host,
    commandRegistry: new CommandRegistry(),
    agentTypeRegistry: registry,
    startupPolicy: { kind: 'none' },
    state: { store },
    storage: {
      persistenceDb: persistence.agentDb,
      attachments: persistence.attachments,
      fileReadCache: persistence.fileReadCache,
    },
    tools: {
      managerToolbox,
      agentToolbox,
    },
  });

  const runId = randomUUID();
  const cohortIdSeed =
    options.cohortSeed ?? `evidence-memory-live-dogfood-v3:${runId}`;
  const cohortIdHash = hashDogfoodCohortId(cohortIdSeed);
  if (options.resetCohort) {
    await persistence.evidenceMemory.clearTask(
      EVIDENCE_MEMORY_DOGFOOD_COHORT_TASK_ID,
    );
  }
  const globalBefore =
    await persistence.evidenceMemory.getDogfoodCohortReport();
  let completedTasks = 0;
  let completedTurns = 0;
  let compressedAnnotations = 0;
  let pairedObservations = 0;
  let attemptedTasks = 0;
  let failedTaskAttempts = 0;
  const taskIds: string[] = [];

  try {
    const maximumTaskAttempts = options.tasks * 3;
    for (
      let taskIndex = 1;
      completedTasks < options.tasks && taskIndex <= maximumTaskAttempts;
      taskIndex += 1
    ) {
      attemptedTasks = taskIndex;
      const agent = await manager.createAgent(
        AgentTypes.CHAT,
        undefined,
        undefined,
        {
          activeModelId: options.modelId,
          title: `Evidence dogfood ${runId.slice(0, 8)}-${taskIndex}`,
          toolApprovalMode: 'alwaysAllow',
        },
      );
      const taskId = agent.instanceId;
      const completedScenarios: Array<{
        scenario: ControlledDogfoodScenario;
        compressedHistory: string;
      }> = [];
      try {
        await managerToolbox.handleMountWorkspace(taskId, workspacePath);
        await persistence.evidenceMemory.record({
          taskId,
          type: 'repository_revision_changed',
          repositoryRevision,
          source: 'evidence_memory_live_dogfood',
          sourceId: runId,
          ingestionKey: `dogfood-repository-revision:${repositoryRevision}`,
          payload: { workload: 'live-dogfood' },
        });
        for (let turn = 1; turn <= options.turns; turn += 1) {
          const scenario = await prepareControlledDogfoodScenario({
            evidenceMemory: persistence.evidenceMemory,
            runId,
            taskId,
            taskIndex,
            turn,
            repositoryRevision,
          });
          const beforeCompression = countCompressedHistory(
            getAgentState(store, taskId),
          );
          await manager.sendUserMessage(
            taskId,
            createDogfoodMessage(runId, taskIndex, turn, scenario),
          );
          await waitUntilIdle(store, taskId, STEP_TIMEOUT_MS);
          await ensureCompression({
            manager,
            store,
            taskId,
            previousCount: beforeCompression,
            runId,
            taskIndex,
            turn,
          });
          completedScenarios.push({
            scenario,
            compressedHistory: getLatestCompressedHistory(
              getAgentState(store, taskId),
            ),
          });
        }
        await manager.prepareSessionCheckpoint(taskId);
      } catch (error) {
        failedTaskAttempts += 1;
        logger.warn(
          `[EvidenceMemoryDogfood] Replacing failed task attempt ${taskIndex}`,
          error,
        );
        continue;
      }

      // Publish the task cohort only after every real turn and compression
      // checkpoint succeeded, so replacement attempts cannot leave partial
      // observations in the signed run.
      for (const { scenario, compressedHistory } of completedScenarios) {
        const tokenBudget =
          resolveEvidenceMemoryIncrementalTokenBudget(compressedHistory);
        for (const probe of scenario.probes) {
          const guardedStartedAt = performance.now();
          const pack = await persistence.evidenceMemory.buildContextPack({
            taskId,
            query: probe.query,
            repositoryRevision,
            // Each controlled probe has at most one expected claim. Bounding
            // retrieval to the same unit prevents unrelated lower-ranked
            // claims from multiplying token overhead across synthetic probes;
            // production multi-claim behavior remains covered by normal live
            // steps and historical replay.
            maxClaims: CONTROLLED_PROBE_MAX_CLAIMS,
            recordShadowRun: false,
          });
          const admission =
            await persistence.evidenceMemory.evaluateContextPackForDogfood({
              pack,
              repositoryRevision,
              baselineContext: compressedHistory,
              tokenBudget,
              maxClaims: CONTROLLED_PROBE_MAX_CLAIMS,
            });
          await persistence.evidenceMemory.recordLiveDogfoodComparison({
            pack,
            admission,
            expectedClaimIds: probe.expectedClaimIds,
            forbiddenClaimIds: probe.forbiddenClaimIds,
            compressedHistory,
            compressedHistoryLatencyMs: 0,
            guardedMemoryLatencyMs: Math.max(
              0,
              performance.now() - guardedStartedAt,
            ),
            categoryOverride: probe.category,
            scenarioIdSeed: probe.id,
            cohortIdSeed,
          });
          pairedObservations += 1;
        }
      }
      taskIds.push(taskId);
      completedTurns += completedScenarios.length;
      compressedAnnotations += countCompressedHistory(
        getAgentState(store, taskId),
      );
      completedTasks += 1;
    }
    if (completedTasks < options.tasks) {
      throw new Error(
        `Only ${completedTasks}/${options.tasks} dogfood tasks completed after ${maximumTaskAttempts} attempts`,
      );
    }

    await waitForEvidenceWrites();
    const backfill = new EvidenceMemoryDogfoodBackfill({
      memoryDir: paths.memoryDir(),
      protectedFiles: host.protectedFiles,
      evidenceMemory: persistence.evidenceMemory,
    });
    const backfillResult = await backfill.run({
      maxArchives: 100,
      maxObservations: 250,
      agentIds: taskIds,
      firstCompressionOnly: false,
      classifyEveryCompressionAsRestart: true,
      includeSupersessionProbes: false,
      cohortIdSeed,
      scenarioNamespace: `live-dogfood-restart-v3:${runId}`,
    });
    const allObservations =
      await persistence.evidenceMemory.listDogfoodCohortObservations();
    const runObservations = allObservations.filter(
      (observation) => observation.cohortIdHash === cohortIdHash,
    );
    const after = evaluateEvidenceMemoryDogfoodCohort(runObservations);
    const observationsOutputPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../test-results/evidence-memory-shadow-observations.jsonl',
    );
    await writeJsonlAtomically(observationsOutputPath, runObservations);
    const globalAfter =
      await persistence.evidenceMemory.getDogfoodCohortReport();
    const report = {
      format: 'clodex-evidence-memory-live-dogfood',
      version: 3,
      generatedAt: new Date().toISOString(),
      runIdHash: runId.replaceAll('-', '').slice(0, 16),
      cohortIdHash,
      cohortMode: options.cohortSeed === null ? 'ephemeral' : 'named',
      workload: {
        requestedTasks: options.tasks,
        attemptedTasks,
        failedTaskAttempts,
        completedTasks,
        turnsPerTask: options.turns,
        completedTurns,
        modelId: options.modelId,
        compressedAnnotations,
        pairedObservations,
      },
      backfill: backfillResult,
      traceObservations: {
        count: runObservations.length,
        outputPath: observationsOutputPath,
      },
      globalBefore,
      after,
      globalAfter,
    };
    const outputPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../test-results/evidence-memory-live-dogfood.json',
    );
    await writeJsonAtomically(outputPath, report);
    console.log(JSON.stringify({ ...report, outputPath }, null, 2));
    return 0;
  } finally {
    await manager.teardown().catch((error) => {
      logger.warn(
        '[EvidenceMemoryDogfood] Agent manager teardown failed',
        error,
      );
    });
    await persistence.teardown().catch((error) => {
      logger.warn('[EvidenceMemoryDogfood] Persistence teardown failed', error);
    });
    await credentials.teardown().catch(() => undefined);
    await preferences.teardown().catch(() => undefined);
  }
}

function createDogfoodHostModels(
  apiKey: string,
  baseURL: string,
  actualModelId: string,
): HostModels {
  const clodex = createOpenAICompatible({
    name: 'clodex-live-dogfood',
    apiKey,
    baseURL,
  });
  const capabilities = modelCapabilitiesSchema.parse({ toolCalling: true });
  return {
    resolveForIntent(intent) {
      return {
        primary: { modelId: intent.preferredModelId ?? intent.currentModelId },
        fallbacks: [],
        replaySafety: intent.replaySafety,
        reasons: ['evidence-memory-live-dogfood'],
      };
    },
    async getWithOptions() {
      return {
        model: clodex.chatModel(actualModelId),
        providerOptions: {} as Parameters<
          typeof streamText
        >[0]['providerOptions'],
        headers: {},
        // Accelerated long-task dogfood: the provider still uses its real
        // context window, while the agent's compression policy sees a small
        // budget so realistic short turns cross the same compaction path
        // without manufacturing multi-megabyte prompts.
        contextWindowSize: 2_048,
        providerMode: 'clodex' as const,
        stripStrictFromTools: false,
      };
    },
    async get(modelId, traceId) {
      return (await this.getWithOptions(modelId, traceId)).model;
    },
    has() {
      return true;
    },
    getCapabilities() {
      return capabilities;
    },
  };
}

function createDogfoodMessage(
  runId: string,
  taskIndex: number,
  turn: number,
  scenario: ControlledDogfoodScenario,
): AgentMessage & { role: 'user' } {
  const token = `EMDF-${runId.slice(0, 8)}-${taskIndex}-${turn}`;
  return {
    id: randomUUID(),
    role: 'user',
    parts: [
      {
        type: 'text',
        text: [
          `This is controlled Evidence Memory ${scenario.probes[0]?.category ?? 'exact_fact'} dogfood turn ${turn}.`,
          `Remember the exact token ${token}.`,
          ...scenario.messageLines,
          `Do not call tools. Respond with exactly: ACK ${token}`,
        ].join('\n'),
      },
    ],
    metadata: {
      createdAt: new Date(),
      partsMetadata: [],
    },
  };
}

async function prepareControlledDogfoodScenario(input: {
  evidenceMemory: EvidenceMemoryService;
  runId: string;
  taskId: string;
  taskIndex: number;
  turn: number;
  repositoryRevision: string;
}): Promise<ControlledDogfoodScenario> {
  const runToken = input.runId.replaceAll('-', '').slice(0, 12);
  const token = `EMDF-${runToken}-${input.taskIndex}-${input.turn}`;
  const category = dogfoodCategoryForTurn(input.turn);
  const event = await input.evidenceMemory.record({
    taskId: input.taskId,
    type: 'user_message',
    repositoryRevision: input.repositoryRevision,
    source: 'evidence_memory_live_dogfood_fixture',
    sourceId: `${input.runId}:${input.taskIndex}:${input.turn}`,
    ingestionKey: `live-dogfood-fixture:${input.runId}:${input.taskIndex}:${input.turn}`,
    payload: {
      workload: 'controlled-live-dogfood-v3',
      category,
      taskIndex: input.taskIndex,
      turn: input.turn,
    },
  });
  const scenario: ControlledDogfoodScenario = {
    messageLines: [],
    probes: [],
  };
  const claimId = (suffix: string): string =>
    `emdf-${runToken}-${input.taskIndex}-${input.turn}-${suffix}`;
  const addProbe = (probe: {
    suffix: string;
    query: string;
    expectedClaimIds?: string[];
    forbiddenClaimIds?: string[];
  }): void => {
    scenario.probes.push({
      id: `controlled-live-dogfood-v3:${input.runId}:${input.taskIndex}:${input.turn}:${category}:${probe.suffix}`,
      category,
      query: probe.query,
      expectedClaimIds: probe.expectedClaimIds ?? [],
      forbiddenClaimIds: probe.forbiddenClaimIds ?? [],
    });
  };

  if (category === 'exact_fact') {
    for (let index = 1; index <= 15; index += 1) {
      const marker = `EMDFFACT${runToken.toUpperCase()}T${input.taskIndex}R${input.turn}I${index}`;
      const text = `The canonical build marker ${marker} maps to value_${input.taskIndex}_${input.turn}_${index}.`;
      const id = claimId(`fact-${index}`);
      await input.evidenceMemory.recordClaim({
        id,
        taskId: input.taskId,
        kind: 'observed_fact',
        subject: `dogfood.${runToken}.${input.taskIndex}.exact.${index}`,
        text,
        confidence: 0.95,
        evidenceEventIds: [event.id],
        validAtRevision: input.repositoryRevision,
      });
      scenario.messageLines.push(
        text,
        `Supplemental build note EMDFDISTRACTOR${runToken.toUpperCase()}T${input.taskIndex}R${input.turn}I${index}A has no durable claim.`,
        `Supplemental build note EMDFDISTRACTOR${runToken.toUpperCase()}T${input.taskIndex}R${input.turn}I${index}B has no durable claim.`,
      );
      addProbe({
        suffix: `fact-${index}`,
        query: `${marker} value_${input.taskIndex}_${input.turn}_${index}`,
        expectedClaimIds: [id],
      });
    }
    return scenario;
  }

  if (category === 'user_constraint') {
    for (let index = 1; index <= 7; index += 1) {
      const marker = `EMDFCONSTRAINT${runToken.toUpperCase()}T${input.taskIndex}R${input.turn}I${index}`;
      const text = `Constraint marker ${marker}: flag_${input.taskIndex}_${input.turn}_${index} must remain enabled for every subsequent step.`;
      const id = claimId(`constraint-${index}`);
      await input.evidenceMemory.recordClaim({
        id,
        taskId: input.taskId,
        kind: 'user_constraint',
        subject: `dogfood.${runToken}.${input.taskIndex}.constraint.${index}`,
        text,
        confidence: 0.95,
        evidenceEventIds: [event.id],
      });
      scenario.messageLines.push(text);
      addProbe({
        suffix: `constraint-${index}`,
        query: `${marker} flag_${input.taskIndex}_${input.turn}_${index} enabled`,
        expectedClaimIds: [id],
      });
    }
    return scenario;
  }

  if (category === 'supersession') {
    for (let index = 1; index <= 4; index += 1) {
      const subject = `dogfood.${runToken}.${input.taskIndex}.routing-mode.${index}`;
      const oldId = claimId(`routing-${index}-old`);
      const newId = claimId(`routing-${index}-new`);
      const oldMarker = `EMDFLEGACY${runToken.toUpperCase()}T${input.taskIndex}R${input.turn}I${index}`;
      const currentMarker = `EMDFCURRENT${runToken.toUpperCase()}T${input.taskIndex}R${input.turn}I${index}`;
      const oldText = `Routing marker ${oldMarker} selected legacy_${input.taskIndex}_${input.turn}_${index}.`;
      const newText = `Routing marker ${currentMarker} selects current_${input.taskIndex}_${input.turn}_${index}; the prior value is obsolete.`;
      await input.evidenceMemory.recordClaim({
        id: oldId,
        taskId: input.taskId,
        kind: 'technical_decision',
        subject,
        text: oldText,
        confidence: 0.95,
        evidenceEventIds: [event.id],
        validAtRevision: input.repositoryRevision,
      });
      await input.evidenceMemory.recordClaim({
        id: newId,
        taskId: input.taskId,
        kind: 'technical_decision',
        subject,
        text: newText,
        confidence: 0.95,
        evidenceEventIds: [event.id],
        validAtRevision: input.repositoryRevision,
      });
      await input.evidenceMemory.relateClaims({
        fromClaimId: newId,
        toClaimId: oldId,
        type: 'supersedes',
        origin: 'automation',
        reason: 'controlled-dogfood-supersession',
      });
      // Only the current value enters the real compressed history. The old
      // value remains in the ledger and must never be admitted by retrieval.
      scenario.messageLines.push(newText);
      addProbe({
        suffix: `supersession-${index}`,
        query: `${currentMarker} current_${input.taskIndex}_${input.turn}_${index} ${oldMarker} routing current legacy`,
        expectedClaimIds: [newId],
        forbiddenClaimIds: [oldId],
      });
    }
    return scenario;
  }

  scenario.messageLines.push(
    `${token}: deployment targets from previous repository revisions are invalid and must be re-read from current files.`,
  );
  for (let index = 1; index <= 5; index += 1) {
    const staleId = claimId(`stale-fact-${index}`);
    const staleMarker = `EMDFSTALE${runToken.toUpperCase()}T${input.taskIndex}R${input.turn}I${index}`;
    const staleText = `Deploy marker ${staleMarker} pointed to stale_${input.taskIndex}_${input.turn}_${index} only on the previous repository revision.`;
    await input.evidenceMemory.recordClaim({
      id: staleId,
      taskId: input.taskId,
      kind: 'observed_fact',
      subject: `dogfood.${runToken}.${input.taskIndex}.deploy-target.${index}`,
      text: staleText,
      confidence: 0.95,
      evidenceEventIds: [event.id],
      validAtRevision: `stale-revision-${runToken}`,
    });
    addProbe({
      suffix: `staleness-${index}`,
      query: `${staleMarker} stale_${input.taskIndex}_${input.turn}_${index} previous repository revision`,
      forbiddenClaimIds: [staleId],
    });
  }
  return scenario;
}

function dogfoodCategoryForTurn(
  turn: number,
): ControlledDogfoodProbe['category'] {
  switch ((turn - 1) % 4) {
    case 0:
      return 'exact_fact';
    case 1:
      return 'user_constraint';
    case 2:
      return 'supersession';
    default:
      return 'staleness';
  }
}

function createProfileHostPaths(userData: string): HostPaths {
  const dataRoot = path.join(userData, 'clodex');
  const userDataRoot = path.join(dataRoot, 'user-data');
  return {
    dataDir: () => dataRoot,
    tempDir: () => path.join(app.getPath('temp'), 'clodex-dogfood'),
    agentsDir: () => path.join(dataRoot, 'agents'),
    agentDir: (agentId) => path.join(dataRoot, 'agents', agentId),
    agentAttachmentsDir: (agentId) =>
      path.join(dataRoot, 'agents', agentId, 'data-attachments'),
    agentAttachmentPath: (agentId, attachmentId) =>
      path.join(dataRoot, 'agents', agentId, 'data-attachments', attachmentId),
    agentAppsDir: (agentId) => path.join(dataRoot, 'agents', agentId, 'apps'),
    agentShellLogsDir: (agentId) =>
      path.join(dataRoot, 'agents', agentId, 'shell-logs'),
    diffHistoryDir: () => path.join(dataRoot, 'diff-history'),
    diffHistoryDbPath: () => path.join(dataRoot, 'diff-history', 'data.sqlite'),
    diffHistoryBlobsDir: () =>
      path.join(dataRoot, 'diff-history', 'data-blobs'),
    agentDbPath: () => path.join(dataRoot, 'agents', 'instances.sqlite'),
    fileReadCacheDbPath: () => path.join(dataRoot, 'file-read-cache.sqlite'),
    processedImageCacheDbPath: () =>
      path.join(dataRoot, 'processed-image-cache.sqlite'),
    userDataDir: () => userDataRoot,
    plansDir: () => path.join(userDataRoot, 'plans'),
    logsDir: () => path.join(userDataRoot, 'logs'),
    memoryDir: () => path.join(userDataRoot, 'memory'),
    pluginsDir: () => path.join(dataRoot, 'plugins'),
    builtinSkillsDir: () => path.join(dataRoot, 'builtin-skills'),
    ripgrepBaseDir: () => path.join(dataRoot, 'bin', 'ripgrep'),
  };
}

function createManagerToolbox(input: {
  mountManager: MountManager;
  store: AgentStore;
}): AgentManagerToolboxPort {
  return {
    async handleMountWorkspace(agentId, workspacePath) {
      await input.mountManager.mountWorkspace(agentId, workspacePath);
    },
    cancelQuestion() {},
    getWorkspaceSnapshotForPersistence(agentId) {
      const mounts = input.store.get().toolbox[agentId]?.workspace.mounts ?? [];
      return mounts.map((mount) => ({
        path: mount.path,
        permissions: [] as MountPermission[],
      }));
    },
    setWorkspaceMdContent() {},
    async acceptAllPendingEditsForAgent() {},
    async getEditedFilePathsForAgent() {
      return [];
    },
  };
}

function getAgentState(store: AgentStore, taskId: string): AgentState {
  const state = store.get().agents.instances[taskId]?.state;
  if (!state) throw new Error(`Dogfood task ${taskId} disappeared`);
  if (state.error) {
    throw new Error(`Dogfood task failed: ${state.error.message}`);
  }
  return state;
}

function countCompressedHistory(state: AgentState): number {
  return state.history.filter(
    (message) =>
      typeof message.metadata?.compressedHistory === 'string' &&
      message.metadata.compressedHistory.length > 0,
  ).length;
}

function getLatestCompressedHistory(state: AgentState): string {
  for (let index = state.history.length - 1; index >= 0; index -= 1) {
    const compressedHistory = state.history[index]?.metadata?.compressedHistory;
    if (typeof compressedHistory === 'string' && compressedHistory.length > 0) {
      return compressedHistory;
    }
  }
  throw new Error(
    'Compressed history checkpoint disappeared before dogfood replay',
  );
}

function hashDogfoodCohortId(cohortIdSeed: string): string {
  return createHash('sha256')
    .update(
      `evidence-memory:dogfood-cohort\0${EVIDENCE_MEMORY_DOGFOOD_COHORT_TASK_ID}\0${cohortIdSeed}`,
    )
    .digest('hex');
}

async function ensureCompression(input: {
  manager: AgentManager;
  store: AgentStore;
  taskId: string;
  previousCount: number;
  runId: string;
  taskIndex: number;
  turn: number;
}): Promise<void> {
  for (let attempt = 1; attempt <= MAX_COMPRESSION_ATTEMPTS; attempt += 1) {
    try {
      await waitForCompression(
        input.store,
        input.taskId,
        input.previousCount,
        COMPRESSION_TIMEOUT_MS,
      );
      return;
    } catch (error) {
      if (attempt >= MAX_COMPRESSION_ATTEMPTS) throw error;
      await input.manager.sendUserMessage(
        input.taskId,
        createCompressionRecoveryMessage(
          input.runId,
          input.taskIndex,
          input.turn,
          attempt,
        ),
      );
      await waitUntilIdle(input.store, input.taskId, STEP_TIMEOUT_MS);
    }
  }
}

function createCompressionRecoveryMessage(
  runId: string,
  taskIndex: number,
  turn: number,
  attempt: number,
): AgentMessage & { role: 'user' } {
  const token = `EMDF-RECOVERY-${runId.slice(0, 8)}-${taskIndex}-${turn}-${attempt}`;
  return {
    id: randomUUID(),
    role: 'user',
    parts: [
      {
        type: 'text',
        text: [
          'Compression recovery probe: preserve the exact markers and constraints from the previous user message in task memory.',
          `Respond with exactly: ACK ${token}`,
        ].join('\n'),
      },
    ],
    metadata: {
      createdAt: new Date(),
      partsMetadata: [],
    },
  };
}

async function waitUntilIdle(
  store: AgentStore,
  taskId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = getAgentState(store, taskId);
    if (!state.isWorking) {
      await store.whenSettled();
      return;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for dogfood task ${taskId}`);
}

async function waitForCompression(
  store: AgentStore,
  taskId: string,
  previousCount: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countCompressedHistory(getAgentState(store, taskId)) > previousCount) {
      await sleep(500);
      return;
    }
    await sleep(250);
  }
  throw new Error(`History compression did not complete for task ${taskId}`);
}

async function waitForEvidenceWrites(): Promise<void> {
  await sleep(1_500);
}

async function ensureRuntimeDirectories(paths: HostPaths): Promise<void> {
  const directories = [
    paths.dataDir(),
    paths.tempDir(),
    paths.agentsDir(),
    paths.diffHistoryDir(),
    paths.diffHistoryBlobsDir(),
    paths.userDataDir(),
    paths.plansDir(),
    paths.logsDir(),
    paths.memoryDir(),
    path.dirname(paths.agentDbPath()),
  ];
  await Promise.all(
    directories.map((directory) => fs.mkdir(directory, { recursive: true })),
  );
}

async function writeJsonAtomically(
  outputPath: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(temporaryPath, outputPath);
}

async function writeJsonlAtomically(
  outputPath: string,
  values: readonly unknown[],
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  const contents = `${values.map((value) => JSON.stringify(value)).join('\n')}${
    values.length > 0 ? '\n' : ''
  }`;
  await fs.writeFile(temporaryPath, contents, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(temporaryPath, outputPath);
}

function parseArguments(argv: readonly string[]): RunOptions {
  const options: RunOptions = {
    tasks: DEFAULT_TASKS,
    turns: DEFAULT_TURNS,
    modelId: DEFAULT_MODEL,
    confirmed: false,
    resetCohort: false,
    cohortSeed: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--confirm-live-model-calls') {
      options.confirmed = true;
      continue;
    }
    if (argument === '--reset-cohort') {
      options.resetCohort = true;
      continue;
    }
    if (argument === '--cohort-seed') {
      const cohortSeed = argv[++index]?.trim();
      if (!cohortSeed || cohortSeed.length > 256) {
        throw new Error('--cohort-seed requires 1-256 characters');
      }
      options.cohortSeed = cohortSeed;
      continue;
    }
    if (argument === '--tasks') {
      options.tasks = parseBoundedInteger(argv[++index], '--tasks', MAX_TASKS);
      continue;
    }
    if (argument === '--turns') {
      options.turns = parseBoundedInteger(argv[++index], '--turns', MAX_TURNS);
      continue;
    }
    if (argument === '--model') {
      const modelId = argv[++index]?.trim();
      if (!modelId) throw new Error('--model requires a model id');
      options.modelId = modelId;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function resolveRepositoryRevision(
  workspacePath: string,
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: workspacePath,
    encoding: 'utf8',
  });
  const revision = stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision)) {
    throw new Error('Unable to resolve a valid repository revision');
  }
  return revision;
}

function parseBoundedInteger(
  value: string | undefined,
  name: string,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

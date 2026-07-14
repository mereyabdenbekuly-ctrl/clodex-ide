import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  AGENTIC_APP_RUNTIME_EVALUATION_THRESHOLDS,
  agenticAppRuntimeEvaluationEvidenceSchema,
  evaluateAgenticAppRuntimeReadiness,
  type AgenticAppRuntimeEvaluationEvidence,
  type AgenticAppRuntimeEvaluationScenarioId,
} from '@shared/agentic-app-runtime-evaluation';
import {
  DEFAULT_ARTIFACT_BRIDGE_POLICY,
  type ArtifactBridgeAuditEntry,
  type ArtifactBridgeContext,
} from '@shared/artifact-bridge';
import type { GeneratedAppManifest } from '@shared/generated-app-manifest';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import type { McpRegistryService } from '../mcp';
import { fingerprintGeneratedAppPackagePublicKey } from '../generated-app-library/package-attestation';
import {
  GeneratedAppPackageTrustService,
  type GeneratedAppPackageTrustPersistence,
} from '../generated-app-library/package-trust';
import type { ArtifactBridgeAuditEvent } from './audit-ledger';
import { ArtifactBridgeService } from './index';

const AGENT_CONTEXT = {
  kind: 'agent',
  agentId: 'evaluation-agent-a',
  appId: 'dashboard',
} as const satisfies ArtifactBridgeContext;
const OTHER_AGENT_CONTEXT = {
  kind: 'agent',
  agentId: 'evaluation-agent-b',
  appId: 'dashboard',
} as const satisfies ArtifactBridgeContext;
const PACKAGE_CONTEXT = {
  kind: 'package',
  packageId: 'com.example.evaluation',
  appId: 'dashboard',
} as const satisfies ArtifactBridgeContext;
const AUTOMATION_ID = '8d581719-6d3b-46c2-826b-262fe746cdbf';
const AUTOMATION_DEFINITION = {
  id: AUTOMATION_ID,
  title: 'Evaluation automation',
  prompt: 'Run the evaluation automation',
  enabled: true,
  schedule: { kind: 'interval' as const, everyMs: 60_000 },
  missedRunPolicy: 'run-on-wake' as const,
  retryPolicy: {
    maxAttempts: 1,
    initialBackoffMs: 5_000,
    maxBackoffMs: 5_000,
  },
  executionTarget: 'local' as const,
  workspacePaths: [],
  modelId: null,
  approvalMode: 'alwaysAsk' as const,
  grant: { capabilities: [], expiresAt: null },
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
  nextRunAt: '2026-07-14T00:01:00.000Z',
  lastRunAt: null,
};

type CountMetric = { attempts: number; violations: number };
type EvaluationCounters = {
  replay: CountMetric;
  crossPrincipalIsolation: CountMetric;
  secretEgress: CountMetric;
  packageTrust: CountMetric;
  revokeLatencies: number[];
  auditContentFree: boolean;
  inspectorContentFree: boolean;
  packageRevocationFailClosed: boolean;
};

type EvaluationScenario =
  AgenticAppRuntimeEvaluationEvidence['scenarios'][number];

export async function runAgenticAppRuntimeEvaluationSuite(options?: {
  now?: () => number;
}): Promise<{
  evidence: AgenticAppRuntimeEvaluationEvidence;
  readiness: ReturnType<typeof evaluateAgenticAppRuntimeReadiness>;
}> {
  const now = options?.now ?? Date.now;
  const counters: EvaluationCounters = {
    replay: { attempts: 0, violations: 0 },
    crossPrincipalIsolation: { attempts: 0, violations: 0 },
    secretEgress: { attempts: 0, violations: 0 },
    packageTrust: { attempts: 0, violations: 0 },
    revokeLatencies: [],
    auditContentFree: false,
    inspectorContentFree: false,
    packageRevocationFailClosed: false,
  };
  const scenarios: EvaluationScenario[] = [];
  scenarios.push(
    await runScenario('session-replay', async (evaluation) => {
      await evaluateSessionReplay(evaluation, counters);
    }),
  );
  scenarios.push(
    await runScenario('one-time-commit', async (evaluation) => {
      await evaluateOneTimeCommit(evaluation, counters);
    }),
  );
  scenarios.push(
    await runScenario('cross-principal-isolation', async (evaluation) => {
      await evaluateCrossPrincipalIsolation(evaluation, counters);
    }),
  );
  scenarios.push(
    await runScenario('grant-revoke-latency', async (evaluation) => {
      await evaluateGrantRevokeLatency(evaluation, counters);
    }),
  );
  scenarios.push(
    await runScenario('credential-egress', async (evaluation) => {
      await evaluateCredentialEgress(evaluation, counters);
    }),
  );
  scenarios.push(
    await runScenario('package-trust', async (evaluation) => {
      await evaluatePackageTrust(evaluation, counters);
    }),
  );
  scenarios.push(
    await runScenario('runtime-inspector-content-free', async (evaluation) => {
      await evaluateRuntimeInspectorContent(evaluation, counters);
    }),
  );

  const latencies = [...counters.revokeLatencies].sort(
    (left, right) => left - right,
  );
  const evidence = agenticAppRuntimeEvaluationEvidenceSchema.parse({
    schemaVersion: 1,
    runId: randomUUID(),
    generatedAt: new Date(now()).toISOString(),
    source: 'deterministic-local-harness',
    scenarios,
    metrics: {
      replay: counters.replay,
      crossPrincipalIsolation: counters.crossPrincipalIsolation,
      secretEgress: counters.secretEgress,
      packageTrust: counters.packageTrust,
      grantRevokeLatency: {
        samples: latencies.length,
        p50Ms: percentile(latencies, 0.5),
        p95Ms: percentile(latencies, 0.95),
        maxMs: latencies.at(-1) ?? 0,
      },
    },
    qualityGates: {
      reportContentFree: true,
      auditContentFree: counters.auditContentFree,
      inspectorContentFree: counters.inspectorContentFree,
      packageRevocationFailClosed: counters.packageRevocationFailClosed,
    },
  });
  const encodedEvidence = JSON.stringify(evidence);
  const reportContentFree = !FORBIDDEN_REPORT_MARKERS.some((marker) =>
    encodedEvidence.includes(marker),
  );
  const finalEvidence = {
    ...evidence,
    qualityGates: {
      ...evidence.qualityGates,
      reportContentFree,
    },
  };
  return {
    evidence: finalEvidence,
    readiness: evaluateAgenticAppRuntimeReadiness(finalEvidence, {
      now: new Date(now()),
    }),
  };
}

const FORBIDDEN_REPORT_MARKERS = [
  'eval-secret-result-canary',
  'eval-secret-error-canary',
  'eval-secret-argument-canary',
  'eval-inspector-argument-canary',
  'eval-inspector-result-canary',
];

async function evaluateSessionReplay(
  evaluation: ScenarioEvaluation,
  counters: EvaluationCounters,
): Promise<void> {
  const harness = await createEvaluationHarness();
  const sessionId = randomUUID();
  try {
    evaluation.assert(
      harness.service.registerSession(AGENT_CONTEXT, sessionId),
      'session-registration-failed',
    );
    await harness.service.setGrant({
      context: AGENT_CONTEXT,
      scope: { kind: 'session', sessionId },
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });
    await harness.service.unregisterSession(AGENT_CONTEXT, sessionId);
    evaluation.assert(
      harness.service.registerSession(AGENT_CONTEXT, sessionId),
      'session-reregistration-failed',
    );
    counters.replay.attempts += 1;
    const replayAccepted = await resolves(
      harness.service.invoke(
        AGENT_CONTEXT,
        {
          id: 'session-replay-attempt',
          method: 'callMcpTool',
          params: {
            serverId: 'docs',
            toolName: 'search',
            arguments: {},
          },
        },
        sessionId,
      ),
    );
    if (replayAccepted) counters.replay.violations += 1;
    evaluation.assert(!replayAccepted, 'closed-session-replay-accepted');
  } finally {
    await harness.service.teardown();
  }
}

async function evaluateOneTimeCommit(
  evaluation: ScenarioEvaluation,
  counters: EvaluationCounters,
): Promise<void> {
  const harness = await createEvaluationHarness();
  try {
    await grantMcpRead(harness.service, harness.identity, AGENT_CONTEXT);
    const proposal = (await harness.service.invoke(AGENT_CONTEXT, {
      id: 'one-time-prepare',
      method: 'prepareSensitiveMcpCall',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'idempotent retry' },
      },
    })) as { id: string };
    const approval = await harness.service.approveSensitiveMcpCall(
      AGENT_CONTEXT,
      proposal.id,
    );
    await harness.service.invoke(AGENT_CONTEXT, {
      id: 'one-time-commit',
      method: 'commitSensitiveMcpCall',
      params: {
        proposalId: approval.proposal.id,
        commitToken: approval.commitToken,
        asOperation: false,
      },
    });
    counters.replay.attempts += 1;
    await harness.service.invoke(AGENT_CONTEXT, {
      id: 'one-time-idempotent-retry',
      method: 'commitSensitiveMcpCall',
      params: {
        proposalId: approval.proposal.id,
        commitToken: approval.commitToken,
        asOperation: false,
      },
    });
    if (harness.toolCallCount() !== 1) counters.replay.violations += 1;
    evaluation.assert(
      harness.toolCallCount() === 1,
      'commit-token-reexecuted-provider',
    );

    counters.replay.attempts += 1;
    const wrongTokenAccepted = await resolves(
      harness.service.invoke(AGENT_CONTEXT, {
        id: 'one-time-wrong-token',
        method: 'commitSensitiveMcpCall',
        params: {
          proposalId: approval.proposal.id,
          commitToken: randomUUID(),
          asOperation: false,
        },
      }),
    );
    if (wrongTokenAccepted) counters.replay.violations += 1;
    evaluation.assert(!wrongTokenAccepted, 'wrong-commit-token-accepted');
  } finally {
    await harness.service.teardown();
  }
}

async function evaluateCrossPrincipalIsolation(
  evaluation: ScenarioEvaluation,
  counters: EvaluationCounters,
): Promise<void> {
  const harness = await createEvaluationHarness();
  const firstSession = randomUUID();
  const secondSession = randomUUID();
  try {
    await harness.service.setGrant({
      context: AGENT_CONTEXT,
      identity: harness.identity,
      capabilities: ['mcp:call', 'automation:run'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [AUTOMATION_ID],
      expiresAt: null,
    });
    for (const foreignContext of [OTHER_AGENT_CONTEXT, PACKAGE_CONTEXT]) {
      counters.crossPrincipalIsolation.attempts += 1;
      const leaked = await resolves(
        harness.service.invoke(foreignContext, {
          id: `cross-principal-${foreignContext.kind}`,
          method: 'callMcpTool',
          params: {
            serverId: 'docs',
            toolName: 'search',
            arguments: {},
          },
        }),
      );
      if (leaked) counters.crossPrincipalIsolation.violations += 1;
      evaluation.assert(!leaked, 'foreign-principal-inherited-grant');
    }

    harness.service.registerSession(AGENT_CONTEXT, firstSession);
    harness.service.registerSession(AGENT_CONTEXT, secondSession);
    const operation = (await harness.service.invoke(
      AGENT_CONTEXT,
      {
        id: 'cross-session-operation',
        method: 'startAutomationOperation',
        params: { automationId: AUTOMATION_ID },
      },
      firstSession,
    )) as { id: string };
    counters.crossPrincipalIsolation.attempts += 1;
    const crossSessionRead = await resolves(
      harness.service.invoke(
        AGENT_CONTEXT,
        {
          id: 'cross-session-read',
          method: 'getOperation',
          params: { operationId: operation.id },
        },
        secondSession,
      ),
    );
    if (crossSessionRead) counters.crossPrincipalIsolation.violations += 1;
    evaluation.assert(!crossSessionRead, 'operation-leaked-across-session');
  } finally {
    await harness.service.teardown();
  }
}

async function evaluateGrantRevokeLatency(
  evaluation: ScenarioEvaluation,
  counters: EvaluationCounters,
): Promise<void> {
  const harness = await createEvaluationHarness();
  try {
    const sampleCount =
      AGENTIC_APP_RUNTIME_EVALUATION_THRESHOLDS.minimumRevokeLatencySamples;
    for (let index = 0; index < sampleCount; index += 1) {
      await grantMcpRead(harness.service, harness.identity, AGENT_CONTEXT);
      const startedAt = performance.now();
      await harness.service.revokeGrant(AGENT_CONTEXT);
      const accepted = await resolves(
        harness.service.invoke(AGENT_CONTEXT, {
          id: `revoke-latency-${index}`,
          method: 'callMcpTool',
          params: {
            serverId: 'docs',
            toolName: 'search',
            arguments: {},
          },
        }),
      );
      counters.revokeLatencies.push(performance.now() - startedAt);
      evaluation.assert(!accepted, 'revoked-grant-remained-usable');
    }
    evaluation.assert(
      counters.revokeLatencies.length === sampleCount,
      'revoke-latency-sample-count-mismatch',
    );
  } finally {
    await harness.service.teardown();
  }
}

async function evaluateCredentialEgress(
  evaluation: ScenarioEvaluation,
  counters: EvaluationCounters,
): Promise<void> {
  const harness = await createEvaluationHarness();
  const resultCanary = 'eval-secret-result-canary';
  const errorCanary = 'eval-secret-error-canary';
  const argumentCanary = 'eval-secret-argument-canary';
  try {
    await grantMcpRead(harness.service, harness.identity, AGENT_CONTEXT);
    harness.setToolHandler(async () => ({
      content: [{ type: 'text', text: 'safe' }],
      access_token: resultCanary,
    }));
    const proposal = (await harness.service.invoke(AGENT_CONTEXT, {
      id: 'egress-result-prepare',
      method: 'prepareSensitiveMcpCall',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'result redaction' },
      },
    })) as { id: string };
    const approval = await harness.service.approveSensitiveMcpCall(
      AGENT_CONTEXT,
      proposal.id,
    );
    const result = await harness.service.invoke(AGENT_CONTEXT, {
      id: 'egress-result-commit',
      method: 'commitSensitiveMcpCall',
      params: {
        proposalId: approval.proposal.id,
        commitToken: approval.commitToken,
        asOperation: false,
      },
    });
    recordSecretProbe(counters, JSON.stringify(result).includes(resultCanary));
    evaluation.assert(
      !JSON.stringify(result).includes(resultCanary),
      'secret-result-reached-generated-code',
    );

    const callsBeforeRawArgument = harness.toolCallCount();
    const rawArgumentAccepted = await resolves(
      harness.service.invoke(AGENT_CONTEXT, {
        id: 'egress-raw-argument',
        method: 'prepareSensitiveMcpCall',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: { authorization: `Bearer ${argumentCanary}` },
        },
      }),
    );
    recordSecretProbe(counters, rawArgumentAccepted);
    evaluation.assert(!rawArgumentAccepted, 'raw-secret-argument-accepted');
    evaluation.assert(
      harness.toolCallCount() === callsBeforeRawArgument,
      'raw-secret-argument-reached-provider',
    );

    harness.setToolHandler(async () => {
      throw new Error(`upstream token=${errorCanary}`);
    });
    const errorProposal = (await harness.service.invoke(AGENT_CONTEXT, {
      id: 'egress-error-prepare',
      method: 'prepareSensitiveMcpCall',
      params: {
        serverId: 'docs',
        toolName: 'search',
        arguments: { query: 'error redaction' },
      },
    })) as { id: string };
    const errorApproval = await harness.service.approveSensitiveMcpCall(
      AGENT_CONTEXT,
      errorProposal.id,
    );
    const exposedError = await rejectionMessage(
      harness.service.invoke(AGENT_CONTEXT, {
        id: 'egress-error-commit',
        method: 'commitSensitiveMcpCall',
        params: {
          proposalId: errorApproval.proposal.id,
          commitToken: errorApproval.commitToken,
          asOperation: false,
        },
      }),
    );
    recordSecretProbe(counters, exposedError.includes(errorCanary));
    evaluation.assert(
      !exposedError.includes(errorCanary),
      'secret-provider-error-reached-generated-code',
    );

    const auditEncoded = JSON.stringify(await harness.auditEntries());
    const auditLeak = [resultCanary, errorCanary, argumentCanary].some(
      (canary) => auditEncoded.includes(canary),
    );
    recordSecretProbe(counters, auditLeak);
    counters.auditContentFree = !auditLeak;
    evaluation.assert(!auditLeak, 'secret-reached-audit-ledger');
  } finally {
    await harness.service.teardown();
  }
}

async function evaluatePackageTrust(
  evaluation: ScenarioEvaluation,
  counters: EvaluationCounters,
): Promise<void> {
  let store: unknown = { version: 1, entries: [] };
  const persistence: GeneratedAppPackageTrustPersistence = {
    load: async () => structuredClone(store),
    save: async (next) => {
      store = structuredClone(next);
    },
  };
  const trust = new GeneratedAppPackageTrustService(persistence);
  const first = createPublisherIdentity('team-evaluation', 'release');
  const substituted = createPublisherIdentity('team-evaluation', 'release');
  await trust.trust(first);

  counters.packageTrust.attempts += 1;
  const substitutionAccepted = await resolves(
    trust.assertCompatible(substituted),
  );
  if (substitutionAccepted) counters.packageTrust.violations += 1;
  evaluation.assert(!substitutionAccepted, 'publisher-key-substitution');

  await trust.revoke(first.publisherId, first.keyId, 'evaluation');
  counters.packageTrust.attempts += 1;
  const retrustAccepted = await resolves(trust.trust(first));
  if (retrustAccepted) counters.packageTrust.violations += 1;
  evaluation.assert(!retrustAccepted, 'revoked-publisher-silently-retrusted');

  const denied = createPublisherIdentity('team-denied', 'release');
  await trust.setPolicy({
    mode: 'allowlist',
    allowedPublisherIds: ['team-allowed'],
    allowedPublicKeyFingerprints: [],
  });
  counters.packageTrust.attempts += 1;
  const policyBypass = await resolves(trust.trust(denied));
  if (policyBypass) counters.packageTrust.violations += 1;
  evaluation.assert(!policyBypass, 'publisher-allowlist-bypassed');

  const trustedPackages = new Set<string>();
  const harness = await createEvaluationHarness({ trustedPackages });
  try {
    counters.packageTrust.attempts += 1;
    const untrustedGrantAccepted = await resolves(
      harness.service.setGrant({
        context: PACKAGE_CONTEXT,
        identity: harness.identity,
        capabilities: ['mcp:call'],
        mcpTools: [{ serverId: 'docs', toolName: 'search' }],
        mcpWriteTools: [],
        automationIds: [],
        expiresAt: null,
      }),
    );
    if (untrustedGrantAccepted) counters.packageTrust.violations += 1;
    evaluation.assert(
      !untrustedGrantAccepted,
      'untrusted-package-received-grant',
    );

    trustedPackages.add(PACKAGE_CONTEXT.packageId);
    await harness.service.setGrant({
      context: PACKAGE_CONTEXT,
      identity: harness.identity,
      capabilities: ['mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });
    trustedPackages.delete(PACKAGE_CONTEXT.packageId);
    counters.packageTrust.attempts += 1;
    const revokedPackageStillWorked = await resolves(
      harness.service.invoke(PACKAGE_CONTEXT, {
        id: 'revoked-package-attempt',
        method: 'callMcpTool',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: {},
        },
      }),
    );
    if (revokedPackageStillWorked) counters.packageTrust.violations += 1;
    counters.packageRevocationFailClosed = !revokedPackageStillWorked;
    evaluation.assert(
      !revokedPackageStillWorked,
      'revoked-package-remained-capable',
    );
  } finally {
    await harness.service.teardown();
  }
}

async function evaluateRuntimeInspectorContent(
  evaluation: ScenarioEvaluation,
  counters: EvaluationCounters,
): Promise<void> {
  const argumentCanary = 'eval-inspector-argument-canary';
  const resultCanary = 'eval-inspector-result-canary';
  const harness = await createEvaluationHarness();
  const sessionId = randomUUID();
  try {
    harness.service.registerSession(AGENT_CONTEXT, sessionId);
    await harness.service.setGrant({
      context: AGENT_CONTEXT,
      identity: harness.identity,
      capabilities: ['mcp:call', 'mcp:write'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [{ serverId: 'docs', toolName: 'update' }],
      automationIds: [],
      expiresAt: null,
    });
    await harness.service.invoke(
      AGENT_CONTEXT,
      {
        id: 'inspector-content-write',
        method: 'prepareMcpWrite',
        params: {
          serverId: 'docs',
          toolName: 'update',
          arguments: { note: argumentCanary },
        },
      },
      sessionId,
    );
    harness.setToolHandler(async () => ({
      content: [{ type: 'text', text: resultCanary }],
    }));
    const proposal = (await harness.service.invoke(
      AGENT_CONTEXT,
      {
        id: 'inspector-content-sensitive',
        method: 'prepareSensitiveMcpCall',
        params: {
          serverId: 'docs',
          toolName: 'search',
          arguments: { query: argumentCanary },
        },
      },
      sessionId,
    )) as { id: string };
    const approval = await harness.service.approveSensitiveMcpCall(
      AGENT_CONTEXT,
      proposal.id,
      sessionId,
    );
    await harness.service.invoke(
      AGENT_CONTEXT,
      {
        id: 'inspector-content-commit',
        method: 'commitSensitiveMcpCall',
        params: {
          proposalId: approval.proposal.id,
          commitToken: approval.commitToken,
          asOperation: false,
        },
      },
      sessionId,
    );
    const inspector = await harness.service.getRuntimeInspector(AGENT_CONTEXT);
    const encoded = JSON.stringify(inspector);
    const leaked =
      encoded.includes(argumentCanary) || encoded.includes(resultCanary);
    recordSecretProbe(counters, leaked);
    counters.inspectorContentFree = !leaked;
    evaluation.assert(!leaked, 'runtime-inspector-exposed-content');
    evaluation.assert(
      !encoded.includes(approval.commitToken),
      'runtime-inspector-exposed-commit-token',
    );
  } finally {
    await harness.service.teardown();
  }
}

type ScenarioEvaluation = {
  assert(condition: boolean, failureCode: string): void;
};

async function runScenario(
  id: AgenticAppRuntimeEvaluationScenarioId,
  operation: (evaluation: ScenarioEvaluation) => Promise<void>,
): Promise<EvaluationScenario> {
  const startedAt = performance.now();
  let assertionCount = 0;
  try {
    await operation({
      assert(condition, failureCode) {
        assertionCount += 1;
        if (!condition) throw new EvaluationFailure(failureCode);
      },
    });
    return {
      id,
      passed: true,
      durationMs: performance.now() - startedAt,
      assertionCount,
      failureCode: null,
    };
  } catch (error) {
    return {
      id,
      passed: false,
      durationMs: performance.now() - startedAt,
      assertionCount,
      failureCode:
        error instanceof EvaluationFailure
          ? error.code
          : 'unexpected-evaluation-error',
    };
  }
}

class EvaluationFailure extends Error {
  public constructor(public readonly code: string) {
    super(code);
  }
}

async function createEvaluationHarness(options?: {
  trustedPackages?: Set<string>;
}) {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const karton = {
    registerServerProcedureHandler: (
      name: string,
      handler: (...args: unknown[]) => Promise<unknown>,
    ) => handlers.set(name, handler),
    removeServerProcedureHandler: (name: string) => handlers.delete(name),
  } as unknown as KartonService;
  let toolCalls = 0;
  let toolHandler: () => Promise<unknown> = async () => ({
    content: [{ type: 'text', text: 'ok' }],
  });
  const mcpServer = {
    id: 'docs',
    displayName: 'Docs',
    enabled: true,
    source: { kind: 'builtin', builtinId: 'docs' },
    transport: {
      type: 'streamable-http',
      url: 'https://example.com',
    },
    policy: { default: 'allow-read-only', tools: {} },
  } as const;
  const mcpTools = [
    {
      name: 'search',
      description: 'Search docs',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: 'update',
      description: 'Update docs',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
  ];
  const mcpRegistry = {
    snapshot: () => ({
      schemaVersion: 1,
      servers: {
        docs: structuredClone(mcpServer),
      },
    }),
    listTools: async () => structuredClone(mcpTools),
    getToolDispatchSnapshot: (_serverId: string, toolName: string) => {
      const descriptor = mcpTools.find((tool) => tool.name === toolName);
      if (!descriptor) throw new Error('MCP tool is unavailable');
      return {
        server: structuredClone(mcpServer),
        runtime: {
          restartCount: 0,
          catalogRevision: 1,
          configurationRevision: 1,
        },
        descriptor: structuredClone(descriptor),
      };
    },
    callTool: async (
      _serverId: string,
      _toolName: string,
      _arguments: Record<string, unknown>,
      callOptions?: { beforeDispatch?: () => void },
    ) => {
      callOptions?.beforeDispatch?.();
      toolCalls += 1;
      return await toolHandler();
    },
  } as unknown as McpRegistryService;
  const identity = {
    manifestSchemaVersion: 1 as const,
    appVersion: '1.0.0',
    manifestHash: 'a'.repeat(64),
    executableHash: 'b'.repeat(64),
    assetHash: 'c'.repeat(64),
  };
  const manifest: GeneratedAppManifest = {
    schemaVersion: 1,
    id: 'dashboard',
    name: 'Evaluation dashboard',
    version: '1.0.0',
    entrypoint: 'index.html',
    capabilities: [
      {
        type: 'mcp:call',
        reason: 'Evaluation read',
        tools: [{ serverId: 'docs', toolName: 'search' }],
      },
      {
        type: 'mcp:write',
        reason: 'Evaluation write',
        tools: [{ serverId: 'docs', toolName: 'update' }],
      },
      {
        type: 'automation:run',
        reason: 'Evaluation automation',
        automationIds: [AUTOMATION_ID],
      },
    ],
  };
  const auditEvents: ArtifactBridgeAuditEvent[] = [];
  const auditReader = {
    listRecent: async (
      limit: number,
      context?: ArtifactBridgeContext,
    ): Promise<ArtifactBridgeAuditEntry[]> =>
      auditEvents
        .map((event, index) => toAuditEntry(event, index + 1))
        .filter(
          (entry) =>
            !context || contextKey(entry.context) === contextKey(context),
        )
        .slice(-limit)
        .reverse(),
  };
  const service = await ArtifactBridgeService.create({
    logger: {
      warn: () => undefined,
    } as unknown as Logger,
    karton,
    mcpRegistry,
    persistence: {
      load: async () => ({ version: 5, grants: {} }),
      save: async () => undefined,
    },
    isFeatureEnabled: () => true,
    arePackageCapabilitiesEnabled: () => true,
    areRuntimeQuotasEnabled: () => true,
    areLifecycleEventsEnabled: () => true,
    areEphemeralGrantsEnabled: () => true,
    isSensitiveEgressEnabled: () => true,
    areAsyncOperationsEnabled: () => true,
    isRuntimeInspectorEnabled: () => true,
    areWritesEnabled: () => true,
    getPolicy: () => DEFAULT_ARTIFACT_BRIDGE_POLICY,
    askAgent: async () => 'unused',
    resolveAutomationDefinition: () => structuredClone(AUTOMATION_DEFINITION),
    runAutomation: async (_automationId, automationOptions) => {
      automationOptions?.beforeDispatch?.({
        automation: structuredClone(AUTOMATION_DEFINITION),
        prompt: AUTOMATION_DEFINITION.prompt,
        attempt: 1,
      });
      return { ok: true };
    },
    resolveApp: async (context) => {
      if (
        context.kind === 'package' &&
        !options?.trustedPackages?.has(context.packageId)
      ) {
        return null;
      }
      return { identity, manifest };
    },
    auditRecorder: {
      record: async (event) => {
        auditEvents.push(structuredClone(event));
      },
    },
    auditReader,
  });
  return {
    service,
    identity,
    toolCallCount: () => toolCalls,
    setToolHandler: (handler: () => Promise<unknown>) => {
      toolHandler = handler;
    },
    auditEntries: () => auditReader.listRecent(100),
  };
}

async function grantMcpRead(
  service: ArtifactBridgeService,
  identity: {
    manifestSchemaVersion: 1;
    appVersion: string;
    manifestHash: string;
    executableHash: string;
    assetHash: string;
  },
  context: ArtifactBridgeContext,
): Promise<void> {
  await service.setGrant({
    context,
    identity,
    capabilities: ['mcp:call'],
    mcpTools: [{ serverId: 'docs', toolName: 'search' }],
    mcpWriteTools: [],
    automationIds: [],
    expiresAt: null,
  });
}

function createPublisherIdentity(publisherId: string, keyId: string) {
  const keys = generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({
    type: 'spki',
    format: 'pem',
  }) as string;
  return {
    publisherId,
    keyId,
    publicKeyPem,
    publicKeyFingerprint: fingerprintGeneratedAppPackagePublicKey(publicKeyPem),
  };
}

function recordSecretProbe(
  counters: EvaluationCounters,
  violation: boolean,
): void {
  counters.secretEgress.attempts += 1;
  if (violation) counters.secretEgress.violations += 1;
}

async function resolves(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return true;
  } catch {
    return false;
  }
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const index = Math.max(
    0,
    Math.min(values.length - 1, Math.ceil(values.length * percentileValue) - 1),
  );
  return values[index] ?? 0;
}

function toAuditEntry(
  event: ArtifactBridgeAuditEvent,
  sequence: number,
): ArtifactBridgeAuditEntry {
  return {
    sequence,
    timestamp: new Date(0).toISOString(),
    action: event.action,
    outcome: event.outcome,
    context: event.context,
    requestId: event.requestId ?? null,
    method: event.method ?? null,
    resource: event.resource ?? null,
    error: event.error ?? null,
  };
}

function contextKey(context: ArtifactBridgeContext): string {
  return context.kind === 'agent'
    ? `agent:${context.agentId}:${context.appId}:${context.pluginId ?? ''}`
    : `package:${context.packageId}:${context.appId}`;
}

#!/usr/bin/env node
import './agents-map.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  AgentHost,
  AgentManager,
  AgentStore,
  AgentTypeRegistry,
  CommandRegistry,
  WorkspaceMdAgent,
  createUniversalToolbox,
  createInitialAgentSystemState,
} from '@clodex/agent-core';
import {
  AGENTS_MD_DOMAIN_ID,
  ENABLED_SKILLS_DOMAIN_ID,
  FILE_DIFFS_DOMAIN_ID,
  LOGS_DOMAIN_ID,
  MEMORY_DOMAIN_ID,
  PLANS_DOMAIN_ID,
  WORKSPACE_DOMAIN_ID,
  WORKSPACE_MD_DOMAIN_ID,
  createAgentsMdDomainAdapter,
  createEnabledSkillsDomainAdapter,
  createFileDiffsDomainAdapter,
  createLogsDomainAdapter,
  createMemoryDomainAdapter,
  createPlansDomainAdapter,
  createWorkspaceDomainAdapter,
  createWorkspaceMdDomainAdapter,
} from '@clodex/agent-core/env/adapters';
import type { Logger } from '@clodex/agent-core/host';
import type { BaseAgentToolboxView } from '@clodex/agent-core/agents';
import { AgentCorePersistence } from '@clodex/agent-core/persistence';
import { MountManager } from '@clodex/agent-core/mount-manager';
import { AgentTypes } from '@clodex/agent-core/types/agent';
import type { AgentMessage, AgentState } from '@clodex/agent-core/types/agent';
import { CliUsageError, formatCliHelp, parseCliArgs } from './cli-args.js';
import { createCliHostModels } from './cli-host-models.js';
import { createCliHostPaths } from './cli-host-paths.js';
import { lastAssistantText } from './cli-state.js';
import { createCliToolboxPort } from './cli-toolbox-port.js';
import {
  ShellService,
  createShellSession,
  executeShellCommand,
} from '@clodex/agent-shell';
import {
  SHELLS_DOMAIN_ID,
  createShellsDomainAdapter,
} from '@clodex/agent-shell/env';
import { CliChatAgent } from './cli-chat-agent.js';

function ensureRuntimeDirs(host: AgentHost): void {
  const roots = [
    host.paths.dataDir(),
    host.paths.tempDir(),
    host.paths.agentsDir(),
    host.paths.diffHistoryDir(),
    host.paths.diffHistoryBlobsDir(),
    host.paths.userDataDir(),
    host.paths.plansDir(),
    host.paths.logsDir(),
    host.paths.memoryDir(),
    host.paths.pluginsDir(),
    host.paths.builtinSkillsDir(),
    host.paths.ripgrepBaseDir(),
    path.dirname(host.paths.agentDbPath()),
    path.dirname(host.paths.fileReadCacheDbPath()),
    path.dirname(host.paths.processedImageCacheDbPath()),
    path.dirname(host.paths.diffHistoryDbPath()),
  ];

  for (const dir of roots) {
    mkdirSync(dir, { recursive: true });
  }
}

async function waitUntilIdle(
  store: AgentStore,
  instanceId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inst = store.get().agents.instances[instanceId];
    if (!inst?.state.isWorking) {
      await store.whenSettled();
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for agent to finish`);
}

async function main() {
  const invocation = parseCliArgs(process.argv.slice(2), {
    environmentModelId: process.env.CLODEX_CLI_MODEL,
  });
  if (invocation.kind === 'help') {
    process.stderr.write(`${formatCliHelp()}\n`);
    return;
  }
  const { cwd, modelId, prompt } = invocation;

  const sessionId = randomUUID();
  const sessionRoot = path.join(tmpdir(), 'clodex-cli', sessionId);
  mkdirSync(sessionRoot, { recursive: true });

  const paths = createCliHostPaths(sessionRoot);

  const logger: Logger = {
    debug: (...a: unknown[]) => console.error('[debug]', ...a),
    info: (...a: unknown[]) => console.error('[info]', ...a),
    warn: (...a: unknown[]) => console.error('[warn]', ...a),
    error: (...a: unknown[]) => console.error('[error]', ...a),
  };

  const hostModels = createCliHostModels(modelId);

  const host = new AgentHost({
    paths,
    models: hostModels,
    logger,
  });
  ensureRuntimeDirs(host);

  // Shell runtime (shared with the browser via @clodex/agent-shell).
  // No stream sink (headless = no live preview) and no smart-approval —
  // the CLI runs in `alwaysAllow`.
  const shellService = await ShellService.create(
    logger,
    (agentInstanceId: string) =>
      path.join(host.paths.agentsDir(), agentInstanceId, 'shells'),
  );

  const store = new AgentStore(createInitialAgentSystemState());
  const workspaceMdRelativePath = host.workspaceMdRelativePath();
  const mountManager = new MountManager({
    store,
    logger,
    hooks: {},
    getAgentType: () => 'cli-chat',
    workspaceMdRelativePath,
  });

  const toolboxPort = createCliToolboxPort({ mountManager, store });
  const universalToolbox = createUniversalToolbox({ host, mountManager });
  // Extend the universal toolbox so the two shell tools resolve via
  // `getTool`. Casts bridge the `ai` `Tool` shape divergence between the
  // CLI compile site and the package's nested `ai` types.
  const agentRuntimeToolbox: BaseAgentToolboxView = {
    ...universalToolbox,
    async getTool(name: string, id: string) {
      // Hide the shell tools when no usable shell was detected (mirrors the
      // browser's ToolboxService.getTool); ChatAgent.getTools filters nulls.
      const shellAvailable = shellService.isAvailable();
      if (name === 'createShellSession') {
        if (!shellAvailable) return null;
        return createShellSession(shellService, id, () =>
          universalToolbox.getMountedPathsForAgent(id),
        ) as unknown as Awaited<ReturnType<typeof universalToolbox.getTool>>;
      }
      if (name === 'executeShellCommand') {
        if (!shellAvailable) return null;
        return executeShellCommand(
          shellService,
          id,
          () => 'alwaysAllow',
          () => universalToolbox.getMountedPathsForAgent(id),
        ) as unknown as Awaited<ReturnType<typeof universalToolbox.getTool>>;
      }
      return universalToolbox.getTool(name, id);
    },
  };

  const persistence = await AgentCorePersistence.create({ host, store });

  const registry = new CommandRegistry();
  const agentTypeRegistry = new AgentTypeRegistry();
  agentTypeRegistry.register(AgentTypes.CHAT, CliChatAgent);
  agentTypeRegistry.register(AgentTypes.WORKSPACE_MD, WorkspaceMdAgent);

  const manager = new AgentManager({
    host,
    commandRegistry: registry,
    agentTypeRegistry,
    startupPolicy: { kind: 'none' },
    state: { store },
    storage: {
      persistenceDb: persistence.agentDb,
      attachments: persistence.attachments,
      fileReadCache: persistence.fileReadCache,
    },
    tools: {
      managerToolbox: toolboxPort,
      agentToolbox: agentRuntimeToolbox,
    },
  });

  manager.registerEnvAdapter(
    createWorkspaceDomainAdapter({ host, mountManager }),
  );
  manager.registerEnvAdapter(
    createAgentsMdDomainAdapter({
      host,
      mountManager,
      workspaceMdRelativePath,
    }),
  );
  manager.registerEnvAdapter(
    createWorkspaceMdDomainAdapter({
      mountManager,
      workspaceMdRelativePath,
    }),
  );
  manager.registerEnvAdapter(createEnabledSkillsDomainAdapter({ host }));
  manager.registerEnvAdapter(createMemoryDomainAdapter());
  manager.registerEnvAdapter(createPlansDomainAdapter({ host, store }));
  manager.registerEnvAdapter(createLogsDomainAdapter({ host, store }));
  manager.registerEnvAdapter(createFileDiffsDomainAdapter({ store }));
  manager.registerEnvAdapter(
    createShellsDomainAdapter({
      getSnapshot: (id) => shellService.getShellSnapshot(id),
      getShellInfo: () => {
        const info = shellService.getShellInfo();
        return info
          ? { platform: process.platform, type: info.type, path: info.path }
          : null;
      },
    }),
  );

  // Opt the chat agent into the env domains registered above. Without a
  // profile, `BaseAgent` resolves an empty allow-list and the model would
  // receive no <workspace> mounts, no shell prompt section, and no
  // <shell-sessions> state — which the shell tools depend on for the
  // mount-prefix cwd. Listed explicitly, one per registered adapter.
  host.defineAgentProfile(AgentTypes.CHAT, {
    envDomainIds: [
      WORKSPACE_DOMAIN_ID,
      AGENTS_MD_DOMAIN_ID,
      WORKSPACE_MD_DOMAIN_ID,
      ENABLED_SKILLS_DOMAIN_ID,
      MEMORY_DOMAIN_ID,
      PLANS_DOMAIN_ID,
      LOGS_DOMAIN_ID,
      FILE_DIFFS_DOMAIN_ID,
      SHELLS_DOMAIN_ID,
    ],
  });
  // WORKSPACE_MD child agent only needs the workspace snapshot to resolve
  // mount prefixes (mirrors the browser host profile).
  host.defineAgentProfile(AgentTypes.WORKSPACE_MD, {
    envDomainIds: [WORKSPACE_DOMAIN_ID],
  });

  const agent = await manager.createAgent(
    AgentTypes.CHAT,
    undefined,
    undefined,
    { activeModelId: modelId },
    undefined,
    undefined,
  );

  const instanceId = agent.instanceId;

  await toolboxPort.handleMountWorkspace(instanceId, cwd, []);
  await manager.setToolApprovalMode(instanceId, 'alwaysAllow');

  const message: AgentMessage & { role: 'user' } = {
    id: randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: prompt }],
    metadata: {
      createdAt: new Date(),
      partsMetadata: [],
    },
  };

  let finalState: AgentState | undefined;
  try {
    await manager.sendUserMessage(instanceId, message);
    await waitUntilIdle(store, instanceId, 600_000);
    finalState = store.get().agents.instances[instanceId]?.state;
  } finally {
    try {
      await manager.teardown();
    } finally {
      // Always kill PTYs, even if the run threw or timed out.
      await shellService.teardown();
    }
  }

  if (finalState?.error) {
    throw new Error(`Agent error: ${String(finalState.error)}`);
  }

  const text = finalState ? lastAssistantText(finalState.history) : '';
  process.stdout.write(text ? `${text}\n` : '(no assistant text)\n');
}

main().catch((err) => {
  if (err instanceof CliUsageError) {
    process.stderr.write(`${err.message}\n\n${formatCliHelp()}\n`);
    process.exitCode = 1;
    return;
  }
  console.error(err);
  process.exitCode = 1;
});

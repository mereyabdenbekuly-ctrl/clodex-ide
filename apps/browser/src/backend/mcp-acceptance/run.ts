import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { McpServerSettingsInput } from '@shared/mcp-settings';
import type { McpSettingsSnapshot } from '@shared/mcp-settings';
import type { McpToolSettings } from '@shared/mcp-settings';
import type { KartonService } from '../services/karton';
import { CredentialsService } from '../services/credentials';
import { Logger } from '../services/logger';
import { McpRegistryService } from '../services/mcp';
import { McpSettingsService } from '../services/mcp/settings';
import { createRegistryMcpTools } from '../services/mcp/tools';
import { getDataRoot } from '../utils/paths';
import {
  type McpPackagedAcceptanceRuntime,
  runMcpPackagedAcceptanceWorkflow,
} from './workflow';

const ACCEPTANCE_SERVER_ID = 'packaged-acceptance';
const ACCEPTANCE_TOOL_NAME = 'health_check';

type ProcedureHandler = (
  callerId: string,
  ...args: unknown[]
) => unknown | Promise<unknown>;

type ExecutableTool = {
  needsApproval?:
    | boolean
    | ((
        args: Record<string, unknown>,
        options: { toolCallId: string },
      ) => boolean | Promise<boolean>);
  execute?: (
    args: Record<string, unknown>,
    options: {
      toolCallId: string;
      messages: never[];
      abortSignal: AbortSignal;
    },
  ) => unknown | Promise<unknown>;
};

export interface RunPackagedMcpAcceptanceOptions {
  fixturePath: string;
  nodeExecutable: string;
}

export async function runPackagedMcpAcceptance(
  options: RunPackagedMcpAcceptanceOptions,
) {
  return await runMcpPackagedAcceptanceWorkflow(
    async () => await ProductionMcpAcceptanceRuntime.create(options),
  );
}

class ProductionMcpAcceptanceRuntime implements McpPackagedAcceptanceRuntime {
  private serverConfigured = false;

  private constructor(
    private readonly procedures: AcceptanceProcedureHarness,
    private readonly credentials: CredentialsService,
    private readonly registry: McpRegistryService,
    private readonly settings: McpSettingsService,
    private readonly input: McpServerSettingsInput,
  ) {}

  public static async create(
    options: RunPackagedMcpAcceptanceOptions,
  ): Promise<ProductionMcpAcceptanceRuntime> {
    await assertLocalExecutable(options.nodeExecutable);
    await assertLocalFixture(options.fixturePath);
    await fs.mkdir(getDataRoot(), { recursive: true });

    const logger = new Logger(false);
    const credentials = await CredentialsService.create(logger);
    const registry = await McpRegistryService.create({
      logger,
      credentialsService: credentials,
    });
    const procedures = new AcceptanceProcedureHarness();
    let settings: McpSettingsService;
    try {
      settings = await McpSettingsService.create({
        logger,
        karton: procedures.karton,
        registry,
        credentials,
      });
    } catch (error) {
      await registry.teardown().catch(() => undefined);
      await credentials.teardown().catch(() => undefined);
      throw error;
    }

    return new ProductionMcpAcceptanceRuntime(
      procedures,
      credentials,
      registry,
      settings,
      {
        id: ACCEPTANCE_SERVER_ID,
        displayName: 'Packaged acceptance fixture',
        enabled: false,
        transport: {
          type: 'stdio',
          command: path.resolve(options.nodeExecutable),
          args: [path.resolve(options.fixturePath)],
          env: {},
        },
        policy: {
          default: 'deny',
          tools: { [ACCEPTANCE_TOOL_NAME]: 'allow' },
        },
      },
    );
  }

  public async connect(): Promise<void> {
    await this.procedures.call('mcp.upsert', this.input);
    this.serverConfigured = true;
    const snapshot = await this.procedures.call<McpSettingsSnapshot>(
      'mcp.setEnabled',
      ACCEPTANCE_SERVER_ID,
      true,
    );
    const server = snapshot.servers.find(
      (candidate) => candidate.id === ACCEPTANCE_SERVER_ID,
    );
    if (server?.runtime.status !== 'connected') {
      throw new Error('MCP acceptance server did not connect');
    }
  }

  public async discoverTools(): Promise<number> {
    const tools = await this.procedures.call<McpToolSettings[]>(
      'mcp.listTools',
      ACCEPTANCE_SERVER_ID,
    );
    const tool = tools[0];
    if (
      tools.length !== 1 ||
      tool?.name !== ACCEPTANCE_TOOL_NAME ||
      !tool.readOnly ||
      tool.destructive ||
      tool.effectiveDecision !== 'allow' ||
      tool.effectiveReason !== 'explicit-allow'
    ) {
      throw new Error('MCP acceptance tool discovery was unexpected');
    }
    return tools.length;
  }

  public async invokeSafeTool(): Promise<void> {
    const tools = await createRegistryMcpTools({
      registry: this.registry,
      agentInstanceId: 'mcp-packaged-acceptance',
    });
    const registered = Object.values(tools) as ExecutableTool[];
    const tool = registered[0];
    if (registered.length !== 1 || !tool?.execute) {
      throw new Error('MCP acceptance tool was not registered');
    }

    const needsApproval =
      typeof tool.needsApproval === 'function'
        ? await tool.needsApproval(
            {},
            { toolCallId: 'mcp-packaged-acceptance-call' },
          )
        : (tool.needsApproval ?? false);
    if (needsApproval) {
      throw new Error('MCP acceptance tool unexpectedly required approval');
    }

    const result = await tool.execute(
      {},
      {
        toolCallId: 'mcp-packaged-acceptance-call',
        messages: [],
        abortSignal: new AbortController().signal,
      },
    );
    if (!isExpectedHealthCheckResult(result)) {
      throw new Error('MCP acceptance tool returned an unexpected result');
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.serverConfigured) return;
    const snapshot = await this.procedures.call<McpSettingsSnapshot>(
      'mcp.disconnect',
      ACCEPTANCE_SERVER_ID,
    );
    const server = snapshot.servers.find(
      (candidate) => candidate.id === ACCEPTANCE_SERVER_ID,
    );
    if (server?.runtime.status !== 'disconnected') {
      throw new Error('MCP acceptance server did not disconnect');
    }
  }

  public async teardown(): Promise<void> {
    let failed = false;
    if (this.serverConfigured) {
      await this.procedures
        .call('mcp.remove', ACCEPTANCE_SERVER_ID)
        .catch(() => {
          failed = true;
        });
      this.serverConfigured = false;
    }
    await this.settings.teardown().catch(() => {
      failed = true;
    });
    await this.registry.teardown().catch(() => {
      failed = true;
    });
    await this.credentials.teardown().catch(() => {
      failed = true;
    });
    if (failed) throw new Error('MCP acceptance teardown failed');
  }
}

class AcceptanceProcedureHarness {
  private readonly handlers = new Map<string, ProcedureHandler>();

  public readonly karton = {
    registerServerProcedureHandler: (
      name: string,
      handler: ProcedureHandler,
    ) => {
      this.handlers.set(name, handler);
    },
    removeServerProcedureHandler: (name: string) => {
      this.handlers.delete(name);
    },
  } as unknown as KartonService;

  public async call<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Missing MCP settings procedure: ${name}`);
    return (await handler('mcp-packaged-acceptance', ...args)) as T;
  }
}

async function assertLocalExecutable(executablePath: string): Promise<void> {
  if (!path.isAbsolute(executablePath)) {
    throw new Error('MCP acceptance executable must be absolute');
  }
  await fs.access(executablePath, constants.X_OK);
}

async function assertLocalFixture(fixturePath: string): Promise<void> {
  if (!path.isAbsolute(fixturePath)) {
    throw new Error('MCP acceptance fixture must be absolute');
  }
  const stat = await fs.stat(fixturePath);
  if (!stat.isFile()) throw new Error('MCP acceptance fixture must be a file');
}

function isExpectedHealthCheckResult(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.result)) return false;
  const cappedEnvelope = value.result;
  if (
    cappedEnvelope.serverId !== ACCEPTANCE_SERVER_ID ||
    cappedEnvelope.tool !== ACCEPTANCE_TOOL_NAME ||
    !isRecord(cappedEnvelope.result)
  ) {
    return false;
  }
  const content = cappedEnvelope.result.content;
  if (!Array.isArray(content) || content.length !== 1) return false;
  const item = content[0];
  return isRecord(item) && item.type === 'text' && item.text === 'ok';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

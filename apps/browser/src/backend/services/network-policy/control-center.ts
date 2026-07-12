import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { dialog } from 'electron';
import type { FeatureGateId } from '@shared/feature-gates';
import {
  NETWORK_EGRESS_CONTROL_LIMITS,
  networkEgressGrantInputSchema,
  networkEgressSnapshotInputSchema,
  persistentNetworkEgressGrantSchema,
  toNetworkPolicyDestinationGrant,
  type NetworkEgressAuditExportResult,
  type NetworkEgressControlSnapshot,
  type NetworkEgressGrant,
  type NetworkEgressGrantInput,
  type PersistentNetworkEgressGrant,
} from '@shared/network-egress-control';
import {
  networkPolicyDestinationGrantSchema,
  type NetworkPolicy,
  type NetworkPolicyDestinationGrant,
} from '@shared/network-policy';
import { DisposableService } from '../disposable';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import type { PreferencesService } from '../preferences';
import { hashNetworkPolicy, normalizeNetworkPolicyDestinationGrant } from '.';
import {
  readNetworkPolicyAuditLedger,
  readNetworkPolicyAuditTail,
} from './audit-ledger';

const PROCEDURE_NAMES = [
  'networkEgressControl.getSnapshot',
  'networkEgressControl.addGrant',
  'networkEgressControl.revokeGrant',
  'networkEgressControl.exportAudit',
] as const;

export interface NetworkEgressRuntimeStatus {
  policyEngineEnabled: boolean;
  policyEngineAvailable: boolean;
  proxyRequired: boolean;
  proxyAvailable: boolean;
  controlledBrowserEnabled: boolean;
  controlledBrowserActive: boolean;
}

interface AuditExportPayload {
  format: 'clodex-network-egress-audit';
  version: 1;
  exportedAt: number;
  records: Awaited<ReturnType<typeof readNetworkPolicyAuditLedger>>;
}

interface SaveAuditResult {
  canceled: boolean;
  filePath?: string;
}

export interface NetworkEgressControlCenterOptions {
  logger: Logger;
  karton: KartonService;
  preferences: Pick<PreferencesService, 'get' | 'update'>;
  auditPath: string;
  isFeatureEnabled: (feature: FeatureGateId) => boolean;
  getRuntimeStatus: () => NetworkEgressRuntimeStatus;
  getBrowserPolicy: () => NetworkPolicy | null;
  applyBrowserGrants: (
    grants: readonly NetworkPolicyDestinationGrant[],
  ) => Promise<void>;
  saveAudit?: (payload: AuditExportPayload) => Promise<SaveAuditResult>;
  now?: () => number;
}

export class NetworkEgressControlCenterService extends DisposableService {
  private readonly sessionGrants = new Map<string, NetworkEgressGrant>();
  private mutationQueue = Promise.resolve();

  private constructor(
    private readonly options: NetworkEgressControlCenterOptions,
  ) {
    super();
  }

  public static async create(
    options: NetworkEgressControlCenterOptions,
  ): Promise<NetworkEgressControlCenterService> {
    const service = new NetworkEgressControlCenterService(options);
    service.registerProcedures();
    try {
      await service.enqueueMutation(async () => {
        const changed = await service.pruneExpiredGrants();
        if (changed) await service.applyCurrentPolicy();
      });
      return service;
    } catch (error) {
      service.teardown();
      throw error;
    }
  }

  private registerProcedures(): void {
    const { karton } = this.options;
    karton.registerServerProcedureHandler(
      'networkEgressControl.getSnapshot',
      async (_clientId, input) => await this.getSnapshot(input),
    );
    karton.registerServerProcedureHandler(
      'networkEgressControl.addGrant',
      async (_clientId, input: NetworkEgressGrantInput) =>
        await this.enqueueMutation(async () => {
          await this.addGrant(input);
          return await this.getSnapshot();
        }),
    );
    karton.registerServerProcedureHandler(
      'networkEgressControl.revokeGrant',
      async (_clientId, grantId: string) =>
        await this.enqueueMutation(async () => {
          await this.revokeGrant(grantId);
          return await this.getSnapshot();
        }),
    );
    karton.registerServerProcedureHandler(
      'networkEgressControl.exportAudit',
      async () => await this.exportAudit(),
    );
  }

  private async getSnapshot(
    rawInput?: unknown,
  ): Promise<NetworkEgressControlSnapshot> {
    this.assertEnabled();
    const input = networkEgressSnapshotInputSchema.parse(rawInput);
    const now = this.now();
    const grants = this.listActiveGrants(now);
    const runtime = this.options.getRuntimeStatus();
    const policy = this.options.getBrowserPolicy();
    let audit: NetworkEgressControlSnapshot['audit'];
    try {
      const tail = await readNetworkPolicyAuditTail(
        this.options.auditPath,
        input?.auditLimit ?? NETWORK_EGRESS_CONTROL_LIMITS.defaultAuditLimit,
      );
      audit = {
        status: 'verified',
        truncated: tail.truncated,
        records: tail.records.map((record) => ({
          sequence: record.sequence,
          createdAt: record.createdAt,
          principalKind: record.principalKind,
          destinationHostHash: record.destinationHostHash,
          destinationPort: record.destinationPort,
          protocol: record.protocol,
          decision: record.decision,
          reason: record.reason,
          policyHash: record.policyHash,
          eventHash: record.eventHash,
        })),
      };
    } catch (error) {
      this.options.logger.warn(
        `[NetworkEgressControl] Audit tail unavailable: ${describeError(error)}`,
      );
      audit = { status: 'unavailable', records: [], truncated: false };
    }

    return {
      featureEnabled: true,
      policyEngine: {
        status: componentStatus(
          runtime.policyEngineEnabled,
          runtime.policyEngineAvailable,
        ),
      },
      proxy: {
        status: componentStatus(runtime.proxyRequired, runtime.proxyAvailable),
      },
      browser: {
        status: runtime.controlledBrowserEnabled
          ? runtime.controlledBrowserActive
            ? 'active'
            : 'fail-closed'
          : 'disabled',
        failClosed:
          runtime.controlledBrowserEnabled && !runtime.controlledBrowserActive,
        sharedSessionScope: true,
        policyMode: policy?.mode ?? null,
        policyVersion: policy?.version ?? null,
        policyHash: policy ? hashNetworkPolicy(policy) : null,
        allowedHostPatterns: policy?.allowedHosts.length ?? 0,
      },
      grants,
      audit,
    };
  }

  private async addGrant(rawInput: NetworkEgressGrantInput): Promise<void> {
    this.assertEnabled();
    const input = networkEgressGrantInputSchema.parse(rawInput);
    const now = this.now();
    await this.pruneExpiredGrants(now);
    const normalized = normalizeNetworkPolicyDestinationGrant(
      networkPolicyDestinationGrantSchema.parse({
        protocol: input.protocol,
        hostname: input.hostname,
        port: input.port,
      }),
    );
    const ttlMs =
      input.ttlMs === undefined
        ? input.scope === 'session'
          ? NETWORK_EGRESS_CONTROL_LIMITS.defaultSessionTtlMs
          : null
        : input.scope === 'session' && input.ttlMs === null
          ? NETWORK_EGRESS_CONTROL_LIMITS.defaultSessionTtlMs
          : input.ttlMs;
    const grant = {
      id: randomUUID(),
      scope: input.scope,
      protocol: normalized.protocol,
      hostname: normalized.hostname,
      port: normalized.port,
      createdAt: now,
      expiresAt: ttlMs === null ? null : now + ttlMs,
    } satisfies NetworkEgressGrant;

    if (grant.scope === 'persistent') {
      const current = this.activePersistentGrants(now).filter(
        (candidate) => !sameDestination(candidate, grant),
      );
      if (
        current.length + this.sessionGrants.size >=
        NETWORK_EGRESS_CONTROL_LIMITS.maxGrants
      ) {
        throw new Error('Network egress grant limit reached');
      }
      const persistent = persistentNetworkEgressGrantSchema.parse(grant);
      await this.savePersistentGrants([...current, persistent]);
    } else {
      for (const [id, candidate] of this.sessionGrants) {
        if (sameDestination(candidate, grant)) this.sessionGrants.delete(id);
      }
      if (
        this.sessionGrants.size + this.activePersistentGrants(now).length >=
        NETWORK_EGRESS_CONTROL_LIMITS.maxGrants
      ) {
        throw new Error('Network egress grant limit reached');
      }
      this.sessionGrants.set(grant.id, grant);
    }

    await this.applyCurrentPolicy();
  }

  private async revokeGrant(grantId: string): Promise<void> {
    this.assertEnabled();
    const id = networkEgressGrantId(grantId);
    const now = this.now();
    await this.pruneExpiredGrants(now);
    if (this.sessionGrants.delete(id)) {
      await this.applyCurrentPolicy();
      return;
    }
    const current = this.activePersistentGrants(now);
    const next = current.filter((grant) => grant.id !== id);
    if (next.length === current.length) {
      throw new Error('Network egress grant not found');
    }
    await this.savePersistentGrants(next);
    await this.applyCurrentPolicy();
  }

  private async exportAudit(): Promise<NetworkEgressAuditExportResult> {
    this.assertEnabled();
    const records = await readNetworkPolicyAuditLedger(this.options.auditPath);
    const payload: AuditExportPayload = {
      format: 'clodex-network-egress-audit',
      version: 1,
      exportedAt: this.now(),
      records,
    };
    const result = await (this.options.saveAudit ?? saveNetworkEgressAudit)(
      payload,
    );
    return { ...result, count: records.length };
  }

  private async pruneExpiredGrants(now = this.now()): Promise<boolean> {
    let changed = false;
    for (const [id, grant] of this.sessionGrants) {
      if (grant.expiresAt !== null && grant.expiresAt <= now) {
        this.sessionGrants.delete(id);
        changed = true;
      }
    }
    const stored = this.options.preferences.get().networkEgress.browserGrants;
    const active = stored.filter(
      (grant) => grant.expiresAt === null || grant.expiresAt > now,
    );
    if (active.length !== stored.length) {
      await this.savePersistentGrants(active);
      changed = true;
    }
    return changed;
  }

  private listActiveGrants(now: number): NetworkEgressGrant[] {
    return [
      ...this.activePersistentGrants(now),
      ...[...this.sessionGrants.values()].filter(
        (grant) => grant.expiresAt === null || grant.expiresAt > now,
      ),
    ].sort((left, right) => right.createdAt - left.createdAt);
  }

  private activePersistentGrants(now: number): PersistentNetworkEgressGrant[] {
    return this.options.preferences
      .get()
      .networkEgress.browserGrants.filter(
        (grant) => grant.expiresAt === null || grant.expiresAt > now,
      );
  }

  private async savePersistentGrants(
    grants: readonly PersistentNetworkEgressGrant[],
  ): Promise<void> {
    await this.options.preferences.update([
      {
        op: 'replace',
        path: ['networkEgress', 'browserGrants'],
        value: grants.map((grant) => structuredClone(grant)),
      },
    ]);
  }

  private async applyCurrentPolicy(): Promise<void> {
    const grants = this.listActiveGrants(this.now()).map(
      toNetworkPolicyDestinationGrant,
    );
    await this.options.applyBrowserGrants(grants);
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private assertEnabled(): void {
    if (!this.options.isFeatureEnabled('egress-control-center')) {
      throw new Error('Network egress control center is disabled');
    }
  }

  protected onTeardown(): void {
    for (const procedureName of PROCEDURE_NAMES) {
      this.options.karton.removeServerProcedureHandler(procedureName);
    }
    this.sessionGrants.clear();
  }
}

function sameDestination(
  left: Pick<NetworkEgressGrant, 'protocol' | 'hostname' | 'port'>,
  right: Pick<NetworkEgressGrant, 'protocol' | 'hostname' | 'port'>,
): boolean {
  return (
    left.protocol === right.protocol &&
    left.hostname === right.hostname &&
    left.port === right.port
  );
}

function componentStatus(
  enabled: boolean,
  available: boolean,
): 'active' | 'disabled' | 'unavailable' {
  return enabled ? (available ? 'active' : 'unavailable') : 'disabled';
}

function networkEgressGrantId(value: string): string {
  return persistentNetworkEgressGrantSchema.shape.id.parse(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function saveNetworkEgressAudit(
  payload: AuditExportPayload,
): Promise<SaveAuditResult> {
  const date = new Date(payload.exportedAt).toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog({
    title: 'Export network egress audit',
    defaultPath: `clodex-network-egress-audit-${date}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return { canceled: false, filePath: result.filePath };
}

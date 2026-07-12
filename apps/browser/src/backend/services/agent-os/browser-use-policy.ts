import { randomUUID } from 'node:crypto';
import {
  AGENT_OS_LIMITS,
  browserUseApprovalResponseSchema,
  browserUseCapabilitySchema,
  browserUseOriginPolicySchema,
  type BrowserUseApprovalMode,
  type BrowserUseApprovalResponse,
  type BrowserUseCapability,
  type BrowserUseOriginPolicy,
} from '@shared/agent-os';
import type { AgentOsStateStore } from './state-store';
import type { DebugInspectorService } from './debug-inspector';

type PendingResolver = {
  resolve: (allowed: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export function normalizeBrowserOrigin(value: string): string {
  if (value === 'null' || value.startsWith('about:')) {
    return 'local://opaque';
  }
  const url = new URL(value);
  if (!['http:', 'https:', 'file:', 'local:'].includes(url.protocol)) {
    throw new Error(`Unsupported browser origin protocol: ${url.protocol}`);
  }
  return url.origin === 'null' ? `${url.protocol}//` : url.origin;
}

export class BrowserUsePolicyService {
  private readonly pendingResolvers = new Map<string, PendingResolver>();

  public constructor(
    private readonly store: AgentOsStateStore,
    private readonly debug: DebugInspectorService,
  ) {}

  public async setEnabled(enabled: boolean): Promise<void> {
    await this.store.update((draft) => {
      draft.browserUse.enabled = enabled;
      if (!enabled) draft.browserUse.pendingApprovals = [];
    });
    if (!enabled) this.resolveAllPending(false);
  }

  public async setOriginPolicy(
    policy: BrowserUseOriginPolicy,
  ): Promise<BrowserUseOriginPolicy> {
    const origin = normalizeBrowserOrigin(policy.origin);
    const parsed = browserUseOriginPolicySchema.parse({
      ...policy,
      origin,
      updatedAt: Date.now(),
    });
    await this.store.update((draft) => {
      draft.browserUse.policies[origin] = parsed;
    });
    return parsed;
  }

  public async removeOriginPolicy(originValue: string): Promise<void> {
    const origin = normalizeBrowserOrigin(originValue);
    await this.store.update((draft) => {
      delete draft.browserUse.policies[origin];
    });
  }

  public getDecision(
    originValue: string,
    capability: BrowserUseCapability,
  ): BrowserUseApprovalMode {
    const origin = normalizeBrowserOrigin(originValue);
    const parsedCapability = browserUseCapabilitySchema.parse(capability);
    const policy = this.store.snapshot().browserUse.policies[origin];
    if (policy) return policy[parsedCapability];
    return parsedCapability === 'fullCdpAccess' ? 'block' : 'ask';
  }

  public canRead(origin: string): BrowserUseApprovalMode {
    return this.getDecision(origin, 'read');
  }

  public canClick(origin: string): BrowserUseApprovalMode {
    return this.getDecision(origin, 'click');
  }

  public canTransferFile(origin: string): BrowserUseApprovalMode {
    return this.getDecision(origin, 'fileTransfer');
  }

  public canUseCdp(origin: string): BrowserUseApprovalMode {
    return this.getDecision(origin, 'fullCdpAccess');
  }

  public canReadHistory(origin: string): BrowserUseApprovalMode {
    return this.getDecision(origin, 'history');
  }

  public shouldCaptureRoutes(originValue: string): boolean {
    const origin = normalizeBrowserOrigin(originValue);
    return (
      this.store.snapshot().browserUse.policies[origin]?.routeCapture ?? false
    );
  }

  public async authorize(
    originValue: string,
    capability: BrowserUseCapability,
    description: string,
    options?: { forceAsk?: boolean },
  ): Promise<boolean> {
    const state = this.store.snapshot().browserUse;
    if (!state.enabled && !options?.forceAsk) return true;

    const origin = normalizeBrowserOrigin(originValue);
    const decision = this.getDecision(origin, capability);
    this.debug.record({
      channel: 'browser',
      level: decision === 'block' ? 'warn' : 'info',
      message: `Browser policy decision: ${decision}`,
      payload: { origin, capability, description },
    });
    if (decision === 'block') return false;
    if (decision === 'allow' && !options?.forceAsk) return true;

    const id = randomUUID();
    await this.store.update((draft) => {
      draft.browserUse.pendingApprovals.push({
        id,
        origin,
        capability,
        description,
        createdAt: Date.now(),
      });
    });

    return await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingResolvers.delete(id);
        void this.removePendingApproval(id);
        resolve(false);
      }, AGENT_OS_LIMITS.browserApprovalTtlMs);
      this.pendingResolvers.set(id, { resolve, timeout });
    });
  }

  public async resolveApproval(
    approvalId: string,
    response: BrowserUseApprovalResponse,
  ): Promise<void> {
    const parsedResponse = browserUseApprovalResponseSchema.parse(response);
    const approval = this.store
      .snapshot()
      .browserUse.pendingApprovals.find(
        (candidate) => candidate.id === approvalId,
      );
    if (!approval) return;

    if (
      parsedResponse === 'always-allow' ||
      parsedResponse === 'always-block'
    ) {
      const existing =
        this.store.snapshot().browserUse.policies[approval.origin] ??
        browserUseOriginPolicySchema.parse({
          origin: approval.origin,
          updatedAt: Date.now(),
        });
      await this.setOriginPolicy({
        ...existing,
        [approval.capability]:
          parsedResponse === 'always-allow' ? 'allow' : 'block',
        updatedAt: Date.now(),
      });
    }

    await this.removePendingApproval(approvalId);
    const pending = this.pendingResolvers.get(approvalId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingResolvers.delete(approvalId);
      pending.resolve(
        parsedResponse === 'allow-once' || parsedResponse === 'always-allow',
      );
    }
  }

  public teardown(): void {
    this.resolveAllPending(false);
  }

  private async removePendingApproval(id: string): Promise<void> {
    await this.store.update((draft) => {
      draft.browserUse.pendingApprovals =
        draft.browserUse.pendingApprovals.filter(
          (approval) => approval.id !== id,
        );
    });
  }

  private resolveAllPending(allowed: boolean): void {
    for (const pending of this.pendingResolvers.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(allowed);
    }
    this.pendingResolvers.clear();
  }
}

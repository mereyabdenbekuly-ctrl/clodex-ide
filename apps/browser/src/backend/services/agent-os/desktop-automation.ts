import { randomUUID } from 'node:crypto';
import { AGENT_OS_LIMITS, type AgentOsState } from '@shared/agent-os';
import {
  desktopAutomationAppSchema,
  desktopAutomationAppPolicyModeSchema,
  desktopAutomationApprovalResponseSchema,
  desktopAutomationBundleIdSchema,
  desktopAutomationInspectionSchema,
  desktopAutomationPermissionKindSchema,
  type DesktopAutomationApp,
  type DesktopAutomationAppPolicy,
  type DesktopAutomationAppPolicyMode,
  type DesktopAutomationApprovalResponse,
  type DesktopAutomationAuditEvent,
  type DesktopAutomationElement,
  type DesktopAutomationInspection,
  type DesktopAutomationOperation,
  type DesktopAutomationPermissionKind,
  type DesktopAutomationPermissions,
  type DesktopAutomationRisk,
} from '@shared/desktop-automation';
import type { AgentOsStateStore } from './state-store';
import type { DebugInspectorService } from './debug-inspector';
import type {
  DesktopAutomationAdapter,
  DesktopAutomationAdapterCapture,
  DesktopAutomationAdapterElement,
} from './desktop-automation-adapter';

type PendingResolver = {
  resolve: (allowed: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
};

interface TargetLocator {
  snapshotId: string;
  app: DesktopAutomationApp;
  index: number;
  element: DesktopAutomationElement;
}

const IRREVERSIBLE_TITLE_PATTERN =
  /(?:^|[^\p{L}\p{N}_])(?:delete|erase|remove|uninstall|purchase|buy|send|submit|empty trash|shut down|shutdown|restart|log out|logout|quit|удалить|стереть|очистить корзину|купить|отправить|подтвердить|выключить|перезагрузить|выйти)(?=$|[^\p{L}\p{N}_])/iu;

export interface DesktopAutomationServiceOptions {
  audit?: (event: DesktopAutomationAuditEvent) => void;
}

export class DesktopAutomationService {
  private readonly pendingResolvers = new Map<string, PendingResolver>();
  private readonly targets = new Map<string, TargetLocator>();
  private killSwitchLatched = false;

  public constructor(
    private readonly store: AgentOsStateStore,
    private readonly debug: DebugInspectorService,
    private readonly adapter: DesktopAutomationAdapter,
    private readonly options: DesktopAutomationServiceOptions = {},
  ) {}

  public async initialize(): Promise<void> {
    this.killSwitchLatched =
      this.store.snapshot().desktopAutomation.killSwitchEngaged;
    const permissions = await this.adapter.getPermissions();
    await this.store.update((draft) => {
      draft.desktopAutomation.supported = this.adapter.supported;
      draft.desktopAutomation.permissions = permissions;
      if (
        !this.adapter.supported ||
        !this.hasRequiredPermissions(permissions)
      ) {
        draft.desktopAutomation.enabled = false;
        draft.desktopAutomation.active = false;
        draft.desktopAutomation.sessionId = null;
        draft.desktopAutomation.currentApp = null;
        draft.desktopAutomation.pendingApprovals = [];
        draft.desktopAutomation.killSwitchRegistered = false;
      }
    });
    this.audit({
      operation: 'permission-check',
      success: this.hasRequiredPermissions(permissions),
      reason: this.adapter.supported ? undefined : 'unsupported',
    });

    if (this.store.snapshot().desktopAutomation.enabled) {
      try {
        await this.registerKillSwitchOrDisable();
      } catch {
        // A persisted preview setting must fail closed without blocking startup.
      }
    } else {
      this.adapter.unregisterKillSwitch();
    }
  }

  public async setEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.killSwitchLatched = false;
      this.resolveAllPending(false);
      this.targets.clear();
      this.adapter.unregisterKillSwitch();
      await this.store.update((draft) => {
        draft.desktopAutomation.enabled = false;
        draft.desktopAutomation.active = false;
        draft.desktopAutomation.sessionId = null;
        draft.desktopAutomation.currentApp = null;
        draft.desktopAutomation.pendingApprovals = [];
        draft.desktopAutomation.killSwitchRegistered = false;
        draft.desktopAutomation.killSwitchEngaged = false;
      });
      return;
    }

    if (!this.adapter.supported) {
      this.audit({
        operation: 'session-start',
        success: false,
        reason: 'unsupported',
      });
      throw new Error('Desktop automation preview is supported only on macOS');
    }
    const permissions = await this.refreshPermissions();
    if (!this.hasRequiredPermissions(permissions)) {
      this.audit({
        operation: 'session-start',
        success: false,
        reason: 'permission-missing',
      });
      throw new Error(
        'Screen Recording and Accessibility permissions are required',
      );
    }

    await this.store.update((draft) => {
      draft.desktopAutomation.enabled = true;
      draft.desktopAutomation.killSwitchEngaged = false;
    });
    this.killSwitchLatched = false;
    await this.registerKillSwitchOrDisable();
  }

  public async startSession(): Promise<string> {
    const state = this.store.snapshot().desktopAutomation;
    if (!state.enabled) {
      throw new Error('Desktop automation must be enabled first');
    }
    if (state.killSwitchEngaged) {
      throw new Error('Reset the desktop automation kill switch first');
    }
    if (this.killSwitchLatched) {
      throw new Error('Reset the desktop automation kill switch first');
    }
    const permissions = await this.refreshPermissions();
    if (!this.hasRequiredPermissions(permissions)) {
      throw new Error(
        'Screen Recording and Accessibility permissions are required',
      );
    }
    if (!this.store.snapshot().desktopAutomation.killSwitchRegistered) {
      await this.registerKillSwitchOrDisable();
    }

    const sessionId = randomUUID();
    await this.store.update((draft) => {
      draft.desktopAutomation.active = true;
      draft.desktopAutomation.sessionId = sessionId;
      draft.desktopAutomation.currentApp = null;
    });
    this.audit({ operation: 'session-start', success: true });
    return sessionId;
  }

  public async stopSession(): Promise<void> {
    this.resolveAllPending(false);
    this.targets.clear();
    await this.store.update((draft) => {
      draft.desktopAutomation.active = false;
      draft.desktopAutomation.sessionId = null;
      draft.desktopAutomation.currentApp = null;
      draft.desktopAutomation.pendingApprovals = [];
    });
    this.audit({ operation: 'session-stop', success: true });
  }

  public async engageKillSwitch(): Promise<void> {
    this.killSwitchLatched = true;
    this.resolveAllPending(false);
    this.targets.clear();
    await this.store.update((draft) => {
      draft.desktopAutomation.active = false;
      draft.desktopAutomation.sessionId = null;
      draft.desktopAutomation.currentApp = null;
      draft.desktopAutomation.pendingApprovals = [];
      draft.desktopAutomation.killSwitchEngaged = true;
    });
    this.audit({
      operation: 'kill-switch',
      success: true,
      reason: 'kill-switch',
    });
  }

  public async resetKillSwitch(): Promise<void> {
    this.killSwitchLatched = false;
    await this.store.update((draft) => {
      draft.desktopAutomation.killSwitchEngaged = false;
    });
  }

  public async refreshPermissions(): Promise<DesktopAutomationPermissions> {
    const permissions = await this.adapter.getPermissions();
    await this.applyPermissions(permissions);
    this.audit({
      operation: 'permission-check',
      success: this.hasRequiredPermissions(permissions),
      reason: this.adapter.supported ? undefined : 'unsupported',
    });
    return permissions;
  }

  public async requestPermission(
    permission: DesktopAutomationPermissionKind,
  ): Promise<DesktopAutomationPermissions> {
    if (!this.adapter.supported) {
      throw new Error('Desktop automation preview is supported only on macOS');
    }
    const parsedPermission =
      desktopAutomationPermissionKindSchema.parse(permission);
    const permissions = await this.adapter.requestPermission(parsedPermission);
    await this.applyPermissions(permissions);
    this.audit({
      operation: 'permission-request',
      success:
        parsedPermission === 'screen-recording'
          ? permissions.screenRecording === 'granted'
          : permissions.accessibility === 'granted',
    });
    return permissions;
  }

  public async openPermissionSettings(
    permission: DesktopAutomationPermissionKind,
  ): Promise<void> {
    await this.adapter.openPermissionSettings(
      desktopAutomationPermissionKindSchema.parse(permission),
    );
  }

  public async getFrontmostApp(): Promise<DesktopAutomationApp> {
    await this.refreshPermissions();
    this.assertSupportedAndAccessible();
    const app = await this.adapter.getFrontmostApp();
    await this.store.update((draft) => {
      draft.desktopAutomation.currentApp = app;
    });
    return app;
  }

  public async setAppPolicy(
    app: DesktopAutomationApp,
    mode: DesktopAutomationAppPolicyMode,
  ): Promise<DesktopAutomationAppPolicy> {
    const parsedApp = desktopAutomationAppSchema.parse(app);
    const parsedMode = desktopAutomationAppPolicyModeSchema.parse(mode);
    const policy: DesktopAutomationAppPolicy = {
      bundleId: parsedApp.bundleId,
      appName: parsedApp.name,
      mode: parsedMode,
      updatedAt: Date.now(),
    };
    await this.store.update((draft) => {
      draft.desktopAutomation.policies[parsedApp.bundleId] = policy;
    });
    return policy;
  }

  public async removeAppPolicy(bundleId: string): Promise<void> {
    const parsedBundleId = desktopAutomationBundleIdSchema.parse(bundleId);
    await this.store.update((draft) => {
      delete draft.desktopAutomation.policies[parsedBundleId];
    });
  }

  public async inspect(maxElements = 50): Promise<DesktopAutomationInspection> {
    const sessionId = await this.assertActive();
    const startedAt = Date.now();
    const expectedApp = await this.adapter.getFrontmostApp();
    const risk = deriveRisk(expectedApp);
    const allowed = await this.authorize({
      operation: 'inspect',
      app: expectedApp,
      risk,
      description: `Inspect accessibility controls in ${expectedApp.name}`,
    });
    if (!allowed) throw new Error('Desktop inspection was not approved');

    try {
      await this.revalidateBeforeProviderCall(expectedApp, sessionId);
      const inspected = await this.adapter.inspectFrontmostApp(maxElements);
      await this.assertSessionStillActive(sessionId);
      this.assertSameApp(expectedApp, inspected.app);
      const snapshotId = randomUUID();
      await this.updateActiveSession(sessionId, (draft) => {
        draft.desktopAutomation.currentApp = inspected.app;
      });
      this.targets.clear();
      const elements = inspected.elements.map((entry) =>
        this.registerTarget(snapshotId, inspected.app, entry),
      );
      const result = desktopAutomationInspectionSchema.parse({
        snapshotId,
        capturedAt: Date.now(),
        app: inspected.app,
        elements,
        truncated: inspected.truncated,
      });
      this.audit({
        operation: 'inspect',
        success: true,
        bundleId: inspected.app.bundleId,
        risk,
        latencyMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.targets.clear();
      this.audit({
        operation: 'inspect',
        success: false,
        bundleId: expectedApp.bundleId,
        risk,
        reason: 'provider-error',
        latencyMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  public async capture(): Promise<DesktopAutomationAdapterCapture> {
    const sessionId = await this.assertActive();
    const startedAt = Date.now();
    const expectedApp = await this.adapter.getFrontmostApp();
    const risk = deriveRisk(expectedApp);
    const allowed = await this.authorize({
      operation: 'capture',
      app: expectedApp,
      risk,
      description: `Capture the frontmost window of ${expectedApp.name}`,
    });
    if (!allowed) throw new Error('Desktop capture was not approved');

    try {
      await this.revalidateBeforeProviderCall(expectedApp, sessionId);
      const capture = await this.adapter.captureFrontmostApp();
      await this.assertSessionStillActive(sessionId);
      this.assertSameApp(expectedApp, capture.app);
      await this.updateActiveSession(sessionId, (draft) => {
        draft.desktopAutomation.currentApp = capture.app;
      });
      this.audit({
        operation: 'capture',
        success: true,
        bundleId: capture.app.bundleId,
        risk,
        latencyMs: Date.now() - startedAt,
      });
      return capture;
    } catch (error) {
      this.audit({
        operation: 'capture',
        success: false,
        bundleId: expectedApp.bundleId,
        risk,
        reason: 'provider-error',
        latencyMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  public async press(targetId: string): Promise<{
    app: DesktopAutomationApp;
    element: DesktopAutomationElement;
  }> {
    const sessionId = await this.assertActive();
    const locator = this.targets.get(targetId);
    if (!locator) {
      this.audit({
        operation: 'press',
        success: false,
        reason: 'invalid-target',
      });
      throw new Error('Desktop target is missing or stale; inspect again');
    }
    if (!locator.element.enabled) {
      throw new Error('Desktop target is disabled');
    }
    this.targets.clear();

    const startedAt = Date.now();
    const currentApp = await this.adapter.getFrontmostApp();
    this.assertSameApp(locator.app, currentApp);
    const allowed = await this.authorize({
      operation: 'press',
      app: locator.app,
      targetId,
      targetRole: locator.element.role,
      targetTitle: locator.element.title,
      risk: locator.element.risk,
      description: `Press ${describeElement(locator.element)} in ${locator.app.name}`,
    });
    if (!allowed) throw new Error('Desktop action was not approved');

    try {
      await this.revalidateBeforeProviderCall(locator.app, sessionId);
      await this.adapter.pressElement({
        app: locator.app,
        index: locator.index,
        role: locator.element.role,
        title: locator.element.title,
      });
      await this.assertSessionStillActive(sessionId);
      this.targets.clear();
      await this.updateActiveSession(sessionId, (draft) => {
        draft.desktopAutomation.lastActionAt = Date.now();
        draft.desktopAutomation.currentApp = locator.app;
      });
      this.audit({
        operation: 'press',
        success: true,
        bundleId: locator.app.bundleId,
        risk: locator.element.risk,
        elementRole: locator.element.role,
        latencyMs: Date.now() - startedAt,
      });
      return { app: locator.app, element: locator.element };
    } catch (error) {
      this.targets.clear();
      this.audit({
        operation: 'press',
        success: false,
        bundleId: locator.app.bundleId,
        risk: locator.element.risk,
        elementRole: locator.element.role,
        reason: 'provider-error',
        latencyMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  public async resolveApproval(
    approvalId: string,
    response: DesktopAutomationApprovalResponse,
  ): Promise<void> {
    const parsedResponse =
      desktopAutomationApprovalResponseSchema.parse(response);
    const approval = this.store
      .snapshot()
      .desktopAutomation.pendingApprovals.find(
        (candidate) => candidate.id === approvalId,
      );
    if (!approval) return;

    if (
      approval.risk === 'normal' &&
      (parsedResponse === 'always-allow' || parsedResponse === 'always-block')
    ) {
      await this.setAppPolicy(
        approval.app,
        parsedResponse === 'always-allow' ? 'allow' : 'block',
      );
    }

    await this.removePendingApproval(approvalId);
    const pending = this.pendingResolvers.get(approvalId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingResolvers.delete(approvalId);
      const allowed =
        parsedResponse === 'allow-once' || parsedResponse === 'always-allow';
      pending.resolve(allowed);
      this.audit({
        operation: 'policy-decision',
        success: allowed,
        bundleId: approval.app.bundleId,
        risk: approval.risk,
        decision: allowed ? 'human-allow' : 'human-block',
      });
    }
  }

  public async teardown(): Promise<void> {
    this.killSwitchLatched = true;
    this.resolveAllPending(false);
    this.targets.clear();
    this.adapter.unregisterKillSwitch();
    await this.store.update((draft) => {
      draft.desktopAutomation.active = false;
      draft.desktopAutomation.sessionId = null;
      draft.desktopAutomation.currentApp = null;
      draft.desktopAutomation.pendingApprovals = [];
      draft.desktopAutomation.killSwitchRegistered = false;
    });
  }

  private async registerKillSwitchOrDisable(): Promise<void> {
    this.adapter.unregisterKillSwitch();
    let registered = false;
    try {
      registered = this.adapter.registerKillSwitch(() => {
        void this.engageKillSwitch().catch(() => undefined);
      });
    } catch {
      this.adapter.unregisterKillSwitch();
      registered = false;
    }
    await this.store.update((draft) => {
      draft.desktopAutomation.killSwitchRegistered = registered;
      if (!registered) {
        draft.desktopAutomation.enabled = false;
        draft.desktopAutomation.active = false;
        draft.desktopAutomation.sessionId = null;
      }
    });
    if (!registered) {
      throw new Error(
        'Desktop automation cannot start without the global kill switch',
      );
    }
  }

  private async authorize(input: {
    operation: DesktopAutomationOperation;
    app: DesktopAutomationApp;
    risk: DesktopAutomationRisk;
    description: string;
    targetId?: string;
    targetRole?: DesktopAutomationElement['role'];
    targetTitle?: string;
  }): Promise<boolean> {
    const policies = this.store.snapshot().desktopAutomation.policies;
    const policy = Object.hasOwn(policies, input.app.bundleId)
      ? (policies[input.app.bundleId]?.mode ?? 'ask')
      : 'ask';
    const forcedAsk = input.risk !== 'normal';
    if (policy === 'block') {
      this.audit({
        operation: 'policy-decision',
        success: false,
        bundleId: input.app.bundleId,
        risk: input.risk,
        decision: 'block',
        reason: 'app-blocked',
      });
      return false;
    }
    if (policy === 'allow' && !forcedAsk) {
      this.audit({
        operation: 'policy-decision',
        success: true,
        bundleId: input.app.bundleId,
        risk: input.risk,
        decision: 'allow',
      });
      return true;
    }

    const id = randomUUID();
    const createdAt = Date.now();
    await this.store.update((draft) => {
      draft.desktopAutomation.pendingApprovals.push({
        id,
        operation: input.operation,
        app: input.app,
        targetId: input.targetId,
        targetRole: input.targetRole,
        targetTitle: input.targetTitle,
        risk: input.risk,
        description: input.description,
        createdAt,
        expiresAt: createdAt + AGENT_OS_LIMITS.desktopAutomationApprovalTtlMs,
      });
    });
    this.audit({
      operation: 'policy-decision',
      success: true,
      bundleId: input.app.bundleId,
      risk: input.risk,
      decision: 'ask',
    });

    return await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingResolvers.delete(id);
        void this.removePendingApproval(id);
        this.audit({
          operation: 'policy-decision',
          success: false,
          bundleId: input.app.bundleId,
          risk: input.risk,
          decision: 'human-block',
          reason: 'approval-expired',
        });
        resolve(false);
      }, AGENT_OS_LIMITS.desktopAutomationApprovalTtlMs);
      this.pendingResolvers.set(id, { resolve, timeout });
    });
  }

  private registerTarget(
    snapshotId: string,
    app: DesktopAutomationApp,
    entry: DesktopAutomationAdapterElement,
  ): DesktopAutomationElement {
    const targetId = randomUUID();
    const element: DesktopAutomationElement = {
      targetId,
      role: entry.role,
      title: entry.title,
      description: entry.description,
      enabled: entry.enabled,
      risk: deriveRisk(app, entry.title),
    };
    this.targets.set(targetId, {
      snapshotId,
      app,
      index: entry.index,
      element,
    });
    return element;
  }

  private async assertActive(): Promise<string> {
    this.assertKillSwitchNotLatched();
    const sessionId = this.requireActiveSessionId();
    const permissions = await this.refreshPermissions();
    if (!this.hasRequiredPermissions(permissions)) {
      throw new Error(
        'Screen Recording and Accessibility permissions are required',
      );
    }
    this.assertKillSwitchNotLatched();
    const revalidatedSessionId = this.requireActiveSessionId();
    if (revalidatedSessionId !== sessionId) {
      throw new Error('Desktop automation session changed during operation');
    }
    this.assertSupportedAndAccessible();
    return sessionId;
  }

  private assertKillSwitchNotLatched(): void {
    if (this.killSwitchLatched) {
      throw new Error('Desktop automation kill switch is engaged');
    }
  }

  private async revalidateBeforeProviderCall(
    expectedApp: DesktopAutomationApp,
    sessionId: string,
  ): Promise<void> {
    await this.assertSessionStillActive(sessionId);
    this.assertKillSwitchNotLatched();
    const currentApp = await this.adapter.getFrontmostApp();
    this.assertKillSwitchNotLatched();
    this.assertSameApp(expectedApp, currentApp);
  }

  private async assertSessionStillActive(sessionId: string): Promise<void> {
    const currentSessionId = await this.assertActive();
    if (currentSessionId !== sessionId) {
      throw new Error('Desktop automation session changed during operation');
    }
  }

  private requireActiveSessionId(): string {
    const state = this.store.snapshot().desktopAutomation;
    if (!state.enabled) {
      this.audit({
        operation: 'policy-decision',
        success: false,
        reason: 'feature-disabled',
      });
      throw new Error('Desktop automation preview is disabled');
    }
    if (state.killSwitchEngaged) {
      this.audit({
        operation: 'policy-decision',
        success: false,
        reason: 'kill-switch',
      });
      throw new Error('Desktop automation kill switch is engaged');
    }
    if (!state.active || !state.sessionId) {
      this.audit({
        operation: 'policy-decision',
        success: false,
        reason: 'session-inactive',
      });
      throw new Error('Desktop automation session is not active');
    }
    return state.sessionId;
  }

  private async updateActiveSession(
    sessionId: string,
    mutator: (draft: AgentOsState) => void,
  ): Promise<void> {
    await this.store.update((draft) => {
      const state = draft.desktopAutomation;
      if (
        state.enabled &&
        state.active &&
        !state.killSwitchEngaged &&
        state.sessionId === sessionId
      ) {
        mutator(draft);
      }
    });
    this.assertKillSwitchNotLatched();
    if (this.requireActiveSessionId() !== sessionId) {
      throw new Error('Desktop automation session changed during operation');
    }
  }

  private assertSupportedAndAccessible(): void {
    const state = this.store.snapshot().desktopAutomation;
    if (!this.adapter.supported || !state.supported) {
      throw new Error('Desktop automation preview is supported only on macOS');
    }
    if (state.permissions.accessibility !== 'granted') {
      throw new Error('Accessibility permission is required');
    }
  }

  private async applyPermissions(
    permissions: DesktopAutomationPermissions,
  ): Promise<void> {
    await this.store.update((draft) => {
      draft.desktopAutomation.supported = this.adapter.supported;
      draft.desktopAutomation.permissions = permissions;
      if (!this.hasRequiredPermissions(permissions)) {
        draft.desktopAutomation.active = false;
        draft.desktopAutomation.sessionId = null;
        draft.desktopAutomation.currentApp = null;
        draft.desktopAutomation.pendingApprovals = [];
      }
    });
    if (!this.hasRequiredPermissions(permissions)) {
      this.resolveAllPending(false);
      this.targets.clear();
    }
  }

  private hasRequiredPermissions(
    permissions: DesktopAutomationPermissions,
  ): boolean {
    return (
      permissions.screenRecording === 'granted' &&
      permissions.accessibility === 'granted'
    );
  }

  private assertSameApp(
    expected: DesktopAutomationApp,
    actual: DesktopAutomationApp,
  ): void {
    if (expected.bundleId !== actual.bundleId) {
      throw new Error('Frontmost application changed during desktop action');
    }
    if (
      normalizeWindowTitle(expected.windowTitle) !==
      normalizeWindowTitle(actual.windowTitle)
    ) {
      throw new Error(
        'Frontmost application window changed during desktop action',
      );
    }
  }

  private async removePendingApproval(id: string): Promise<void> {
    await this.store.update((draft) => {
      draft.desktopAutomation.pendingApprovals =
        draft.desktopAutomation.pendingApprovals.filter(
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

  private audit(event: DesktopAutomationAuditEvent): void {
    try {
      this.options.audit?.(event);
    } catch {
      // Audit transport must never change a permission decision.
    }
    this.debug.record({
      channel: 'desktop',
      level: event.success ? 'info' : 'warn',
      message: `Desktop automation: ${event.operation}`,
      payload: {
        success: event.success,
        bundleId: event.bundleId,
        risk: event.risk,
        decision: event.decision,
        reason: event.reason,
        elementRole: event.elementRole,
        latencyMs: event.latencyMs,
      },
    });
  }
}

function deriveRisk(
  app: DesktopAutomationApp,
  title = '',
): DesktopAutomationRisk {
  if (IRREVERSIBLE_TITLE_PATTERN.test(title)) return 'irreversible';
  if (app.bundleId.toLowerCase().startsWith('com.apple.')) return 'system';
  return 'normal';
}

function describeElement(element: DesktopAutomationElement): string {
  const label = element.title || element.description;
  return label ? `${element.role} “${label}”` : element.role;
}

function normalizeWindowTitle(title: string | undefined): string {
  return (title ?? '').trim().toLocaleLowerCase();
}

export function getDesktopAutomationState(
  state: AgentOsState,
): AgentOsState['desktopAutomation'] {
  return state.desktopAutomation;
}

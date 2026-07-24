import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dialog } from 'electron';
import type {
  BrowserUseApprovalResponse,
  BrowserUseCapability,
  BrowserUseOriginPolicy,
  ChroniclePrivacyMode,
  ChronicleRetention,
  CodexMicroAction,
  CodexMicroPosition,
  DebugInspectorEvent,
  HookDefinition,
  HookTrigger,
  SkillInstallPreview,
} from '@shared/agent-os';
import type {
  DesktopAutomationApp,
  DesktopAutomationAppPolicyMode,
  DesktopAutomationApprovalResponse,
  DesktopAutomationAuditEvent,
  DesktopAutomationPermissionKind,
} from '@shared/desktop-automation';
import type { ProtectedFileStorage } from '@clodex/agent-core/host';
import type {
  GuardianAssessmentObservation,
  GuardianDogfoodAssessment,
  GuardianFeedbackLabel,
  GuardianShadowAssessmentObservation,
} from '@shared/guardian';
import type { FeatureGateId } from '@shared/feature-gates';
import { getAgentOsDir, getAgentOsStatePath } from '@/utils/paths';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import { DisposableService } from '../disposable';
import { ChronicleService, type ChronicleCaptureProvider } from './chronicle';
import { AgentOsStateStore } from './state-store';
import { DebugInspectorService } from './debug-inspector';
import { MicroControllerService } from './micro-controller';
import { BrowserUsePolicyService } from './browser-use-policy';
import { SkillInstallerService } from './skill-installer';
import { downloadRemoteSkillPackage } from './skill-download';
import {
  HooksService,
  sanitizeRendererHookRunContext,
  type HookRunContext,
} from './hooks';
import {
  RemoteControlService,
  type RemoteControlAuditEvent,
  type RemoteControlGuardianChecker,
  type RemoteCommandHandler,
} from './remote-control';
import type { RemoteControlEnvironmentMetadata } from './remote-control-crypto';
import type {
  RemoteNativeAttestationPolicy,
  RemoteNativeAttestationVerifier,
} from './remote-control-native-attestation';
import {
  GuardianFeedbackService,
  type GuardianFeedbackSubmission,
} from './guardian-feedback';
import { DesktopAutomationService } from './desktop-automation';
import {
  createDesktopAutomationAdapter,
  type DesktopAutomationAdapter,
} from './desktop-automation-adapter';

const PROCEDURE_NAMES = [
  'agentOs.chronicle.setEnabled',
  'agentOs.chronicle.setSettings',
  'agentOs.chronicle.captureNow',
  'agentOs.chronicle.captureManual',
  'agentOs.chronicle.search',
  'agentOs.chronicle.getRecent',
  'agentOs.chronicle.summarizeLastWindow',
  'agentOs.chronicle.clear',
  'agentOs.micro.setEnabled',
  'agentOs.micro.setActions',
  'agentOs.micro.setPosition',
  'agentOs.micro.setExpanded',
  'agentOs.micro.setPushToTalkActive',
  'agentOs.micro.triggerAction',
  'agentOs.browserUse.setEnabled',
  'agentOs.browserUse.setOriginPolicy',
  'agentOs.browserUse.removeOriginPolicy',
  'agentOs.browserUse.getDecision',
  'agentOs.browserUse.resolveApproval',
  'agentOs.desktop.setEnabled',
  'agentOs.desktop.refreshPermissions',
  'agentOs.desktop.requestPermission',
  'agentOs.desktop.openPermissionSettings',
  'agentOs.desktop.getFrontmostApp',
  'agentOs.desktop.setAppPolicy',
  'agentOs.desktop.removeAppPolicy',
  'agentOs.desktop.startSession',
  'agentOs.desktop.stopSession',
  'agentOs.desktop.engageKillSwitch',
  'agentOs.desktop.resetKillSwitch',
  'agentOs.desktop.resolveApproval',
  'agentOs.debug.setEnabled',
  'agentOs.debug.setPaused',
  'agentOs.debug.clear',
  'agentOs.debug.exportJson',
  'agentOs.guardian.submitFeedback',
  'agentOs.guardian.clearRecent',
  'agentOs.skills.inspect',
  'agentOs.skills.pickPackage',
  'agentOs.skills.installFromPath',
  'agentOs.skills.uninstall',
  'agentOs.skills.listInstalled',
  'agentOs.hooks.create',
  'agentOs.hooks.update',
  'agentOs.hooks.delete',
  'agentOs.hooks.run',
  'agentOs.remote.setEnabled',
  'agentOs.remote.setAllowRemoteCommands',
  'agentOs.remote.startPairing',
  'agentOs.remote.cancelPairing',
  'agentOs.remote.revokeClient',
  'agentOs.remote.resolveCommandApproval',
  'agentOs.remote.generateAttestation',
] as const;

function isManagedPendingSkillDownload(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return (
    path.dirname(resolved) === path.resolve(getAgentOsDir()) &&
    /^pending-download-[0-9a-f-]{36}\.skill$/i.test(path.basename(resolved))
  );
}

export interface AgentOsServiceOptions {
  logger: Logger;
  karton: KartonService;
  captureProvider: ChronicleCaptureProvider;
  isFeatureEnabled: (feature: FeatureGateId) => boolean;
  remoteCommandHandler: RemoteCommandHandler;
  remoteControlAuditHandler?: (event: RemoteControlAuditEvent) => void;
  remoteControlEnvironment?: RemoteControlEnvironmentMetadata;
  remoteNativeAttestationVerifier?: RemoteNativeAttestationVerifier;
  remoteNativeAttestationPolicy?: RemoteNativeAttestationPolicy;
  guardianFeedbackHandler?: (submission: GuardianFeedbackSubmission) => void;
  protectedFiles?: ProtectedFileStorage;
  desktopAutomationAuditHandler?: (event: DesktopAutomationAuditEvent) => void;
  desktopAutomationAdapter?: DesktopAutomationAdapter;
}

export class AgentOsService extends DisposableService {
  public readonly chronicle: ChronicleService;
  public readonly micro: MicroControllerService;
  public readonly browserUse: BrowserUsePolicyService;
  public readonly desktopAutomation: DesktopAutomationService;
  public readonly debug: DebugInspectorService;
  public readonly guardian: GuardianFeedbackService;
  public readonly skills: SkillInstallerService;
  public readonly hooks: HooksService;
  public readonly remote: RemoteControlService;

  private unsubscribeStore: (() => void) | null = null;

  private constructor(
    private readonly options: AgentOsServiceOptions,
    private readonly store: AgentOsStateStore,
  ) {
    super();
    this.debug = new DebugInspectorService(store);
    this.guardian = new GuardianFeedbackService(
      store,
      options.guardianFeedbackHandler,
    );
    this.chronicle = new ChronicleService(
      store,
      options.captureProvider,
      options.protectedFiles,
    );
    this.micro = new MicroControllerService(store, this.debug);
    this.browserUse = new BrowserUsePolicyService(store, this.debug);
    this.desktopAutomation = new DesktopAutomationService(
      store,
      this.debug,
      options.desktopAutomationAdapter ?? createDesktopAutomationAdapter(),
      { audit: options.desktopAutomationAuditHandler },
    );
    this.skills = new SkillInstallerService(store, this.debug);
    this.hooks = new HooksService(store, this.debug, () =>
      options.isFeatureEnabled('agent-hooks'),
    );
    this.remote = new RemoteControlService(
      store,
      this.debug,
      options.remoteCommandHandler,
      {
        audit: options.remoteControlAuditHandler,
        environment: options.remoteControlEnvironment,
        nativeAttestationVerifier: options.remoteNativeAttestationVerifier,
        nativeAttestationPolicy: options.remoteNativeAttestationPolicy,
      },
    );
  }

  public static async create(
    options: AgentOsServiceOptions,
  ): Promise<AgentOsService> {
    const store = await AgentOsStateStore.create(getAgentOsStatePath());
    const service = new AgentOsService(options, store);
    const migratedChronicleArtifacts =
      await service.chronicle.migrateExistingArtifacts();
    if (migratedChronicleArtifacts > 0) {
      options.logger.info(
        `[ProtectedFiles] Migrated ${migratedChronicleArtifacts} Chronicle artifact(s)`,
      );
    }
    await service.initialize();
    return service;
  }

  public snapshot() {
    return this.store.snapshot();
  }

  public setRemoteGuardianPolicyChecker(
    checker: RemoteControlGuardianChecker | undefined,
  ): void {
    this.remote.setGuardianPolicyChecker(checker);
  }

  public recordEvent(
    event: Omit<DebugInspectorEvent, 'id' | 'createdAt'>,
  ): void {
    if (!this.options.isFeatureEnabled('agent-os-debug-inspector')) return;
    this.debug.record(event);
  }

  public async recordGuardianAssessment(
    observation: GuardianAssessmentObservation,
  ): Promise<void> {
    if (!this.options.isFeatureEnabled('multi-agent-guardian')) return;
    await this.guardian.recordAssessment(observation);
  }

  public async recordGuardianShadowAssessment(
    observation: GuardianShadowAssessmentObservation,
  ): Promise<void> {
    if (!this.options.isFeatureEnabled('guardian-model-shadow')) return;
    await this.guardian.recordShadowAssessment(observation);
  }

  public async enforceFeatureGates(): Promise<void> {
    const state = this.store.snapshot();
    const operations: Promise<void>[] = [];
    if (!this.options.isFeatureEnabled('agent-hooks')) {
      this.hooks.cancelPendingAutomaticRuns();
    }
    if (
      state.chronicle.enabled &&
      !this.options.isFeatureEnabled('chronicle-visual-memory')
    ) {
      operations.push(this.chronicle.setEnabled(false));
    }
    if (
      state.micro.enabled &&
      !this.options.isFeatureEnabled('codex-micro-controller')
    ) {
      operations.push(this.micro.setEnabled(false));
    }
    if (
      state.micro.pushToTalkActive &&
      !this.options.isFeatureEnabled('global-dictation')
    ) {
      operations.push(this.micro.setPushToTalkActive(false));
    }
    if (
      state.browserUse.enabled &&
      !this.options.isFeatureEnabled('browser-use-policy-engine')
    ) {
      operations.push(this.browserUse.setEnabled(false));
    }
    if (
      state.desktopAutomation.enabled &&
      !this.options.isFeatureEnabled('desktop-automation-macos-preview')
    ) {
      operations.push(this.desktopAutomation.setEnabled(false));
    }
    if (
      state.debugInspector.enabled &&
      !this.options.isFeatureEnabled('agent-os-debug-inspector')
    ) {
      operations.push(this.debug.setEnabled(false));
    }
    if (
      state.remoteControl.enabled &&
      !this.options.isFeatureEnabled('remote-control-pairing')
    ) {
      operations.push(this.remote.setEnabled(false));
    }
    await Promise.all(operations);
  }

  public async authorizeBrowserAction(
    origin: string,
    capability: BrowserUseCapability,
    description: string,
    options?: { forceAsk?: boolean },
  ): Promise<boolean> {
    if (
      !this.options.isFeatureEnabled('browser-use-policy-engine') &&
      !options?.forceAsk
    ) {
      return true;
    }
    return await this.browserUse.authorize(
      origin,
      capability,
      description,
      options,
    );
  }

  public async runHooks(trigger: HookTrigger, context?: HookRunContext) {
    if (!this.options.isFeatureEnabled('agent-hooks')) {
      return { promptText: '', runs: [] };
    }
    return await this.hooks.run(trigger, context);
  }

  public async handleSkillInstallUrl(
    incomingUrl: string,
  ): Promise<SkillInstallPreview | null> {
    if (!this.options.isFeatureEnabled('native-skill-install')) return null;
    const parsed = new URL(incomingUrl);
    const routePath = parsed.hostname
      ? `/${parsed.hostname}${parsed.pathname}`
      : parsed.pathname;
    if (routePath !== '/skill/install') return null;

    let sourcePath = parsed.searchParams.get('path');
    const sourceUrl = parsed.searchParams.get('url');
    if (!sourcePath && sourceUrl) {
      const buffer = await downloadRemoteSkillPackage(sourceUrl);
      sourcePath = path.join(
        getAgentOsDir(),
        `pending-download-${randomUUID()}.skill`,
      );
      try {
        await fs.writeFile(sourcePath, buffer, {
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        await fs.rm(sourcePath, { force: true }).catch(() => undefined);
        throw error;
      }
    }
    if (!sourcePath) throw new Error('Skill install URL has no path or URL');

    try {
      const preview = await this.skills.inspect(sourcePath);
      await this.setPendingSkillInstall(preview);
      return preview;
    } catch (error) {
      if (isManagedPendingSkillDownload(sourcePath)) {
        await fs.rm(sourcePath, { force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    const { karton } = this.options;
    await this.guardian.initialize();
    karton.setState((draft) => {
      draft.agentOs = this.store.snapshot();
    });
    this.unsubscribeStore = this.store.subscribe((state) => {
      karton.setState((draft) => {
        draft.agentOs = state;
      });
    });
    this.registerProcedures();
    karton.setProcedureEventSink((event) => {
      this.recordEvent({
        channel: 'rpc',
        level: event.error ? 'error' : 'debug',
        message: event.error
          ? `RPC failed: ${event.name}`
          : `RPC completed: ${event.name}`,
        payload: {
          durationMs: event.durationMs,
          callerId: event.callerId,
          error: event.error,
        },
      });
    });

    await this.enforceFeatureGates();
    await this.desktopAutomation.initialize();
    await this.remote.initialize();
    this.options.logger.debug('[AgentOsService] Initialized');
  }

  private assertFeature(feature: FeatureGateId): void {
    if (!this.options.isFeatureEnabled(feature)) {
      throw new Error(`Feature gate is disabled: ${feature}`);
    }
  }

  private async setPendingSkillInstall(
    preview: SkillInstallPreview | null,
  ): Promise<void> {
    const previousSourcePath =
      this.store.snapshot().pendingSkillInstall?.sourcePath;
    await this.store.update((draft) => {
      draft.pendingSkillInstall = preview;
    });
    if (
      previousSourcePath &&
      previousSourcePath !== preview?.sourcePath &&
      isManagedPendingSkillDownload(previousSourcePath)
    ) {
      await fs.rm(previousSourcePath, { force: true }).catch(() => undefined);
    }
  }

  private registerProcedures(): void {
    const { karton } = this.options;
    karton.registerServerProcedureHandler(
      'agentOs.chronicle.setEnabled',
      async (_clientId, enabled: boolean) => {
        if (enabled) this.assertFeature('chronicle-visual-memory');
        await this.chronicle.setEnabled(enabled);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.chronicle.setSettings',
      async (
        _clientId,
        settings: {
          retention?: ChronicleRetention;
          privacyMode?: ChroniclePrivacyMode;
        },
      ) => {
        this.assertFeature('chronicle-visual-memory');
        await this.chronicle.setSettings(settings);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.chronicle.captureNow',
      async () => {
        this.assertFeature('chronicle-visual-memory');
        return await this.chronicle.captureNow();
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.chronicle.captureManual',
      async (_clientId, text: string) => {
        this.assertFeature('chronicle-visual-memory');
        return await this.chronicle.captureManual(text);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.chronicle.search',
      async (_clientId, query: string) => {
        this.assertFeature('chronicle-visual-memory');
        return this.chronicle.search(query);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.chronicle.getRecent',
      async (_clientId, limit: number) => {
        this.assertFeature('chronicle-visual-memory');
        return this.chronicle.getRecent(limit);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.chronicle.summarizeLastWindow',
      async (_clientId, durationMs: number) => {
        this.assertFeature('chronicle-visual-memory');
        return await this.chronicle.summarizeLastWindow(durationMs);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.chronicle.clear',
      async () => {
        this.assertFeature('chronicle-visual-memory');
        await this.chronicle.clear();
      },
    );

    karton.registerServerProcedureHandler(
      'agentOs.micro.setEnabled',
      async (_clientId, enabled: boolean) => {
        if (enabled) this.assertFeature('codex-micro-controller');
        await this.micro.setEnabled(enabled);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.micro.setActions',
      async (_clientId, actions: CodexMicroAction[]) => {
        this.assertFeature('codex-micro-controller');
        await this.micro.setActions(actions);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.micro.setPosition',
      async (_clientId, position: CodexMicroPosition | null) => {
        this.assertFeature('codex-micro-controller');
        await this.micro.setPosition(position);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.micro.setExpanded',
      async (_clientId, expanded: boolean) => {
        this.assertFeature('codex-micro-controller');
        await this.micro.setExpanded(expanded);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.micro.setPushToTalkActive',
      async (_clientId, active: boolean) => {
        if (active) {
          this.assertFeature('codex-micro-controller');
          this.assertFeature('global-dictation');
        }
        await this.micro.setPushToTalkActive(active);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.micro.triggerAction',
      async (_clientId, actionId: string) => {
        this.assertFeature('codex-micro-controller');
        const action = this.store
          .snapshot()
          .micro.actions.find((candidate) => candidate.id === actionId);
        if (action?.kind === 'push-to-talk') {
          this.assertFeature('global-dictation');
        }
        return await this.micro.triggerAction(actionId);
      },
    );

    karton.registerServerProcedureHandler(
      'agentOs.browserUse.setEnabled',
      async (_clientId, enabled: boolean) => {
        if (enabled) this.assertFeature('browser-use-policy-engine');
        await this.browserUse.setEnabled(enabled);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.browserUse.setOriginPolicy',
      async (_clientId, policy: BrowserUseOriginPolicy) => {
        this.assertFeature('browser-use-policy-engine');
        return await this.browserUse.setOriginPolicy(policy);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.browserUse.removeOriginPolicy',
      async (_clientId, origin: string) => {
        this.assertFeature('browser-use-policy-engine');
        await this.browserUse.removeOriginPolicy(origin);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.browserUse.getDecision',
      async (_clientId, origin: string, capability: BrowserUseCapability) => {
        this.assertFeature('browser-use-policy-engine');
        return this.browserUse.getDecision(origin, capability);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.browserUse.resolveApproval',
      async (
        _clientId,
        approvalId: string,
        response: BrowserUseApprovalResponse,
      ) => {
        this.assertFeature('browser-use-policy-engine');
        await this.browserUse.resolveApproval(approvalId, response);
      },
    );

    karton.registerServerProcedureHandler(
      'agentOs.desktop.setEnabled',
      async (_clientId, enabled: boolean) => {
        if (enabled) {
          this.assertFeature('desktop-automation-macos-preview');
        }
        await this.desktopAutomation.setEnabled(enabled);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.desktop.refreshPermissions',
      async () => {
        this.assertFeature('desktop-automation-macos-preview');
        return await this.desktopAutomation.refreshPermissions();
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.desktop.requestPermission',
      async (_clientId, permission: DesktopAutomationPermissionKind) => {
        this.assertFeature('desktop-automation-macos-preview');
        return await this.desktopAutomation.requestPermission(permission);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.desktop.openPermissionSettings',
      async (_clientId, permission: DesktopAutomationPermissionKind) => {
        this.assertFeature('desktop-automation-macos-preview');
        await this.desktopAutomation.openPermissionSettings(permission);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.desktop.getFrontmostApp',
      async () => {
        this.assertFeature('desktop-automation-macos-preview');
        return await this.desktopAutomation.getFrontmostApp();
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.desktop.setAppPolicy',
      async (
        _clientId,
        app: DesktopAutomationApp,
        mode: DesktopAutomationAppPolicyMode,
      ) => {
        this.assertFeature('desktop-automation-macos-preview');
        return await this.desktopAutomation.setAppPolicy(app, mode);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.desktop.removeAppPolicy',
      async (_clientId, bundleId: string) => {
        this.assertFeature('desktop-automation-macos-preview');
        await this.desktopAutomation.removeAppPolicy(bundleId);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.desktop.startSession',
      async () => {
        this.assertFeature('desktop-automation-macos-preview');
        return await this.desktopAutomation.startSession();
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.desktop.stopSession',
      async () => {
        this.assertFeature('desktop-automation-macos-preview');
        await this.desktopAutomation.stopSession();
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.desktop.engageKillSwitch',
      async () => {
        this.assertFeature('desktop-automation-macos-preview');
        await this.desktopAutomation.engageKillSwitch();
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.desktop.resetKillSwitch',
      async () => {
        this.assertFeature('desktop-automation-macos-preview');
        await this.desktopAutomation.resetKillSwitch();
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.desktop.resolveApproval',
      async (
        _clientId,
        approvalId: string,
        response: DesktopAutomationApprovalResponse,
      ) => {
        this.assertFeature('desktop-automation-macos-preview');
        await this.desktopAutomation.resolveApproval(approvalId, response);
      },
    );

    karton.registerServerProcedureHandler(
      'agentOs.debug.setEnabled',
      async (_clientId, enabled: boolean) => {
        if (enabled) this.assertFeature('agent-os-debug-inspector');
        await this.debug.setEnabled(enabled);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.debug.setPaused',
      async (_clientId, paused: boolean) => {
        this.assertFeature('agent-os-debug-inspector');
        await this.debug.setPaused(paused);
      },
    );
    karton.registerServerProcedureHandler('agentOs.debug.clear', async () => {
      this.assertFeature('agent-os-debug-inspector');
      await this.debug.clear();
    });
    karton.registerServerProcedureHandler(
      'agentOs.debug.exportJson',
      async () => {
        this.assertFeature('agent-os-debug-inspector');
        return this.debug.exportJson();
      },
    );

    karton.registerServerProcedureHandler(
      'agentOs.guardian.submitFeedback',
      async (
        _clientId,
        assessmentId: string,
        feedback: GuardianFeedbackLabel,
      ): Promise<GuardianDogfoodAssessment | null> => {
        this.assertFeature('multi-agent-guardian');
        return await this.guardian.submitFeedback(assessmentId, feedback);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.guardian.clearRecent',
      async () => {
        this.assertFeature('multi-agent-guardian');
        await this.guardian.clearRecent();
      },
    );

    karton.registerServerProcedureHandler(
      'agentOs.skills.inspect',
      async (_clientId, sourcePath: string) => {
        this.assertFeature('native-skill-install');
        const preview = await this.skills.inspect(sourcePath);
        await this.setPendingSkillInstall(preview);
        return preview;
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.skills.pickPackage',
      async () => {
        this.assertFeature('native-skill-install');
        const result = await dialog.showOpenDialog({
          title: 'Install Clodex skill',
          filters: [
            {
              name: 'Clodex skills',
              extensions: ['skill', 'clodex-skill', 'md'],
            },
          ],
          properties: ['openFile'],
        });
        const sourcePath = result.filePaths[0];
        if (result.canceled || !sourcePath) return null;
        const preview = await this.skills.inspect(sourcePath);
        await this.setPendingSkillInstall(preview);
        return preview;
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.skills.installFromPath',
      async (_clientId, sourcePath: string, replaceExisting?: boolean) => {
        this.assertFeature('native-skill-install');
        const installed = await this.skills.install(
          sourcePath,
          replaceExisting,
        );
        await this.setPendingSkillInstall(null);
        if (isManagedPendingSkillDownload(sourcePath)) {
          await fs.rm(sourcePath, { force: true }).catch(() => undefined);
        }
        return installed;
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.skills.uninstall',
      async (_clientId, skillId: string) => {
        this.assertFeature('native-skill-install');
        await this.skills.uninstall(skillId);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.skills.listInstalled',
      async () => {
        this.assertFeature('native-skill-install');
        return this.skills.list();
      },
    );

    karton.registerServerProcedureHandler(
      'agentOs.hooks.create',
      async (
        _clientId,
        hook: Omit<HookDefinition, 'id' | 'createdAt' | 'updatedAt'>,
      ) => {
        this.assertFeature('agent-hooks');
        return await this.hooks.create(hook);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.hooks.update',
      async (_clientId, hookId: string, patch: Partial<HookDefinition>) => {
        this.assertFeature('agent-hooks');
        return await this.hooks.update(hookId, patch);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.hooks.delete',
      async (_clientId, hookId: string) => {
        this.assertFeature('agent-hooks');
        await this.hooks.delete(hookId);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.hooks.run',
      async (_clientId, trigger: HookTrigger, context?: HookRunContext) => {
        this.assertFeature('agent-hooks');
        // Renderer input is never authority. Ignore forged approval, trust,
        // and workspace properties; command execution requires a future
        // backend-minted one-shot grant.
        const sanitized = sanitizeRendererHookRunContext(context);
        if (!sanitized.manualHookId) {
          throw new Error(
            'Renderer hook execution requires an explicit manual hook id',
          );
        }
        return await this.hooks.run(trigger, sanitized);
      },
    );

    karton.registerServerProcedureHandler(
      'agentOs.remote.setEnabled',
      async (_clientId, enabled: boolean) => {
        if (enabled) this.assertFeature('remote-control-pairing');
        await this.remote.setEnabled(enabled);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.remote.setAllowRemoteCommands',
      async (_clientId, allowed: boolean) => {
        this.assertFeature('remote-control-pairing');
        await this.remote.setAllowRemoteCommands(allowed);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.remote.startPairing',
      async () => {
        this.assertFeature('remote-control-pairing');
        return await this.remote.startPairing();
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.remote.cancelPairing',
      async () => {
        this.assertFeature('remote-control-pairing');
        await this.remote.cancelPairing();
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.remote.revokeClient',
      async (_clientId, clientId: string) => {
        this.assertFeature('remote-control-pairing');
        await this.remote.revokeClient(clientId);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.remote.resolveCommandApproval',
      async (_clientId, approvalId: string, approved: boolean) => {
        this.assertFeature('remote-control-pairing');
        await this.remote.resolveCommandApproval(approvalId, approved);
      },
    );
    karton.registerServerProcedureHandler(
      'agentOs.remote.generateAttestation',
      async (_clientId, challenge?: string) => {
        this.assertFeature('remote-control-pairing');
        return this.remote.generateAttestation(challenge);
      },
    );
  }

  protected async onTeardown(): Promise<void> {
    this.options.karton.setProcedureEventSink(null);
    for (const name of PROCEDURE_NAMES) {
      this.options.karton.removeServerProcedureHandler(name);
    }
    this.browserUse.teardown();
    await this.desktopAutomation.teardown();
    await this.remote.teardown();
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    await this.store.flush();
    this.options.logger.debug('[AgentOsService] Torn down');
  }
}

export type { HookRunContext };

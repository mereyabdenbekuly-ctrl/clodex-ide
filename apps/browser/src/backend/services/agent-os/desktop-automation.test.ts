import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DesktopAutomationApp,
  DesktopAutomationElementRole,
  DesktopAutomationPermissionKind,
  DesktopAutomationPermissions,
} from '@shared/desktop-automation';
import { AgentOsStateStore } from './state-store';
import { DebugInspectorService } from './debug-inspector';
import { DesktopAutomationService } from './desktop-automation';
import type {
  DesktopAutomationAdapter,
  DesktopAutomationAdapterCapture,
  DesktopAutomationAdapterInspection,
} from './desktop-automation-adapter';

class FakeDesktopAutomationAdapter implements DesktopAutomationAdapter {
  public supported = true;
  public permissions: DesktopAutomationPermissions = {
    screenRecording: 'granted',
    accessibility: 'granted',
    checkedAt: Date.now(),
  };
  public app: DesktopAutomationApp = {
    name: 'Preview App',
    bundleId: 'com.example.preview',
    windowTitle: 'Preview',
  };
  public elements: DesktopAutomationAdapterInspection['elements'] = [
    {
      index: 3,
      role: 'AXButton',
      title: 'Continue',
      enabled: true,
    },
  ];
  public killSwitchCallback: (() => void) | null = null;
  public registerResult = true;
  public registerError: Error | null = null;
  public captureGate: Promise<void> | null = null;
  public pressGate: Promise<void> | null = null;
  public onCaptureStarted: (() => void) | null = null;
  public onPressStarted: (() => void) | null = null;
  public captureCalls = 0;
  public pressed: Array<{
    app: DesktopAutomationApp;
    index: number;
    role: DesktopAutomationElementRole;
    title: string;
  }> = [];

  public async getPermissions(): Promise<DesktopAutomationPermissions> {
    return structuredClone(this.permissions);
  }

  public async requestPermission(
    _permission: DesktopAutomationPermissionKind,
  ): Promise<DesktopAutomationPermissions> {
    return this.getPermissions();
  }

  public async openPermissionSettings(): Promise<void> {}

  public async getFrontmostApp(): Promise<DesktopAutomationApp> {
    return structuredClone(this.app);
  }

  public async inspectFrontmostApp(
    maxElements: number,
  ): Promise<DesktopAutomationAdapterInspection> {
    return {
      app: structuredClone(this.app),
      elements: structuredClone(this.elements.slice(0, maxElements)),
      truncated: this.elements.length > maxElements,
    };
  }

  public async captureFrontmostApp(): Promise<DesktopAutomationAdapterCapture> {
    this.captureCalls += 1;
    this.onCaptureStarted?.();
    if (this.captureGate) await this.captureGate;
    return {
      app: structuredClone(this.app),
      image: Buffer.from('png'),
    };
  }

  public async pressElement(input: {
    app: DesktopAutomationApp;
    index: number;
    role: DesktopAutomationElementRole;
    title: string;
  }): Promise<void> {
    this.onPressStarted?.();
    if (this.pressGate) await this.pressGate;
    this.pressed.push(structuredClone(input));
  }

  public registerKillSwitch(callback: () => void): boolean {
    if (this.registerError) throw this.registerError;
    this.killSwitchCallback = callback;
    return this.registerResult;
  }

  public unregisterKillSwitch(): void {
    this.killSwitchCallback = null;
  }
}

describe('DesktopAutomationService', () => {
  let root: string;
  let store: AgentOsStateStore;
  let adapter: FakeDesktopAutomationAdapter;
  let service: DesktopAutomationService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-automation-'));
    store = await AgentOsStateStore.create(path.join(root, 'state.json'));
    adapter = new FakeDesktopAutomationAdapter();
    service = new DesktopAutomationService(
      store,
      new DebugInspectorService(store),
      adapter,
    );
    await service.initialize();
  });

  afterEach(async () => {
    await service.teardown();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function enableAndStart(): Promise<void> {
    await service.setEnabled(true);
    await service.startSession();
  }

  it('requires both macOS permissions and a registered global kill switch', async () => {
    adapter.permissions.screenRecording = 'denied';
    await expect(service.setEnabled(true)).rejects.toThrow(
      'Screen Recording and Accessibility permissions are required',
    );

    adapter.permissions.screenRecording = 'granted';
    adapter.registerResult = false;
    await expect(service.setEnabled(true)).rejects.toThrow(
      'global kill switch',
    );
    expect(store.snapshot().desktopAutomation.enabled).toBe(false);
  });

  it('fails closed when global shortcut registration throws', async () => {
    adapter.registerError = new Error('shortcut unavailable');

    await expect(service.setEnabled(true)).rejects.toThrow(
      'global kill switch',
    );
    expect(store.snapshot().desktopAutomation).toMatchObject({
      enabled: false,
      active: false,
      sessionId: null,
      killSwitchRegistered: false,
    });
  });

  it('fails a persisted enabled setting closed without blocking startup', async () => {
    await store.update((draft) => {
      draft.desktopAutomation.enabled = true;
    });
    adapter.registerError = new Error('shortcut unavailable');

    await expect(service.initialize()).resolves.toBeUndefined();
    expect(store.snapshot().desktopAutomation).toMatchObject({
      enabled: false,
      active: false,
      sessionId: null,
      killSwitchRegistered: false,
    });
  });

  it('rejects unsupported platform adapters before enabling', async () => {
    adapter.supported = false;
    adapter.permissions = {
      screenRecording: 'unsupported',
      accessibility: 'unsupported',
      checkedAt: Date.now(),
    };
    await service.refreshPermissions();

    await expect(service.setEnabled(true)).rejects.toThrow(
      'supported only on macOS',
    );
    expect(store.snapshot().desktopAutomation.enabled).toBe(false);
  });

  it('keeps unknown apps behind explicit approval and can persist a normal allowlist', async () => {
    await enableAndStart();
    const inspectionPromise = service.inspect(20);

    await vi.waitFor(() => {
      expect(store.snapshot().desktopAutomation.pendingApprovals).toHaveLength(
        1,
      );
    });
    const approval = store.snapshot().desktopAutomation.pendingApprovals[0]!;
    expect(approval.operation).toBe('inspect');
    await service.resolveApproval(approval.id, 'always-allow');

    const inspection = await inspectionPromise;
    expect(inspection.app.bundleId).toBe('com.example.preview');
    expect(inspection.elements).toHaveLength(1);
    expect(
      store.snapshot().desktopAutomation.policies['com.example.preview']?.mode,
    ).toBe('allow');

    await expect(service.capture()).resolves.toMatchObject({
      app: { bundleId: 'com.example.preview' },
      image: Buffer.from('png'),
    });
    expect(store.snapshot().desktopAutomation.pendingApprovals).toHaveLength(0);
  });

  it('forces per-action approval for Apple system apps even when allowlisted', async () => {
    adapter.app = {
      name: 'System Settings',
      bundleId: 'com.apple.systempreferences',
      windowTitle: 'Privacy & Security',
    };
    await enableAndStart();
    await service.setAppPolicy(adapter.app, 'allow');

    const capturePromise = service.capture();
    await vi.waitFor(() => {
      expect(store.snapshot().desktopAutomation.pendingApprovals[0]?.risk).toBe(
        'system',
      );
    });
    const approval = store.snapshot().desktopAutomation.pendingApprovals[0]!;
    await service.resolveApproval(approval.id, 'allow-once');
    await expect(capturePromise).resolves.toMatchObject({
      app: { bundleId: 'com.apple.systempreferences' },
    });
  });

  it('does not persist always-allow for irreversible-looking controls', async () => {
    adapter.elements = [
      {
        index: 7,
        role: 'AXButton',
        title: 'Delete account',
        enabled: true,
      },
    ];
    await enableAndStart();
    await service.setAppPolicy(adapter.app, 'allow');
    const inspection = await service.inspect();
    const pressPromise = service.press(inspection.elements[0]!.targetId);

    await vi.waitFor(() => {
      expect(store.snapshot().desktopAutomation.pendingApprovals[0]?.risk).toBe(
        'irreversible',
      );
    });
    const approval = store.snapshot().desktopAutomation.pendingApprovals[0]!;
    await service.resolveApproval(approval.id, 'always-allow');
    await expect(pressPromise).resolves.toMatchObject({
      element: { title: 'Delete account' },
    });
    expect(adapter.pressed).toHaveLength(1);
    expect(
      store.snapshot().desktopAutomation.policies['com.example.preview']?.mode,
    ).toBe('allow');
  });

  it('classifies localized irreversible controls with Unicode boundaries', async () => {
    adapter.elements = [
      {
        index: 7,
        role: 'AXButton',
        title: 'Удалить аккаунт',
        enabled: true,
      },
    ];
    await enableAndStart();
    await service.setAppPolicy(adapter.app, 'allow');

    const inspection = await service.inspect();

    expect(inspection.elements[0]?.risk).toBe('irreversible');
  });

  it('engages the global kill switch immediately and fails pending work closed', async () => {
    await enableAndStart();
    const inspectionPromise = service.inspect();
    await vi.waitFor(() => {
      expect(store.snapshot().desktopAutomation.pendingApprovals).toHaveLength(
        1,
      );
    });

    const rejectedInspection =
      expect(inspectionPromise).rejects.toThrow('not approved');
    adapter.killSwitchCallback?.();
    await vi.waitFor(() => {
      expect(store.snapshot().desktopAutomation.killSwitchEngaged).toBe(true);
    });
    await rejectedInspection;
    expect(store.snapshot().desktopAutomation.active).toBe(false);
    expect(store.snapshot().desktopAutomation.pendingApprovals).toEqual([]);
  });

  it('fails a capture closed when the kill switch fires during the provider call', async () => {
    await enableAndStart();
    await service.setAppPolicy(adapter.app, 'allow');
    let releaseCapture!: () => void;
    let markCaptureStarted!: () => void;
    adapter.captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const captureStarted = new Promise<void>((resolve) => {
      markCaptureStarted = resolve;
    });
    adapter.onCaptureStarted = markCaptureStarted;

    const capturePromise = service.capture();
    await captureStarted;
    adapter.killSwitchCallback?.();
    releaseCapture();

    await expect(capturePromise).rejects.toThrow('kill switch is engaged');
    expect(store.snapshot().desktopAutomation.active).toBe(false);
  });

  it('fails in-flight capture closed when the feature gate disables the provider', async () => {
    await enableAndStart();
    await service.setAppPolicy(adapter.app, 'allow');
    let releaseCapture!: () => void;
    let markCaptureStarted!: () => void;
    adapter.captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const captureStarted = new Promise<void>((resolve) => {
      markCaptureStarted = resolve;
    });
    adapter.onCaptureStarted = markCaptureStarted;

    const capturePromise = service.capture();
    await captureStarted;
    await service.setEnabled(false);
    releaseCapture();

    await expect(capturePromise).rejects.toThrow('preview is disabled');
    expect(store.snapshot().desktopAutomation).toMatchObject({
      enabled: false,
      active: false,
      sessionId: null,
      currentApp: null,
    });
  });

  it('drops an in-flight capture if permissions are revoked', async () => {
    await enableAndStart();
    await service.setAppPolicy(adapter.app, 'allow');
    let releaseCapture!: () => void;
    let markCaptureStarted!: () => void;
    adapter.captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const captureStarted = new Promise<void>((resolve) => {
      markCaptureStarted = resolve;
    });
    adapter.onCaptureStarted = markCaptureStarted;

    const capturePromise = service.capture();
    await captureStarted;
    adapter.permissions.screenRecording = 'denied';
    releaseCapture();

    await expect(capturePromise).rejects.toThrow(
      'Screen Recording and Accessibility permissions are required',
    );
    expect(store.snapshot().desktopAutomation).toMatchObject({
      active: false,
      sessionId: null,
      currentApp: null,
    });
  });

  it('does not report a press as successful when the kill switch fires in flight', async () => {
    await enableAndStart();
    await service.setAppPolicy(adapter.app, 'allow');
    const inspection = await service.inspect();
    let releasePress!: () => void;
    let markPressStarted!: () => void;
    adapter.pressGate = new Promise<void>((resolve) => {
      releasePress = resolve;
    });
    const pressStarted = new Promise<void>((resolve) => {
      markPressStarted = resolve;
    });
    adapter.onPressStarted = markPressStarted;

    const pressPromise = service.press(inspection.elements[0]!.targetId);
    await pressStarted;
    adapter.killSwitchCallback?.();
    releasePress();

    await expect(pressPromise).rejects.toThrow('kill switch is engaged');
    expect(store.snapshot().desktopAutomation.lastActionAt).toBeNull();
    expect(store.snapshot().desktopAutomation.active).toBe(false);
  });

  it('rechecks permissions after approval and deactivates the session if revoked', async () => {
    await enableAndStart();
    const capturePromise = service.capture();
    await vi.waitFor(() => {
      expect(store.snapshot().desktopAutomation.pendingApprovals).toHaveLength(
        1,
      );
    });
    const approval = store.snapshot().desktopAutomation.pendingApprovals[0]!;
    adapter.permissions.accessibility = 'denied';
    await service.resolveApproval(approval.id, 'allow-once');

    await expect(capturePromise).rejects.toThrow(
      'Screen Recording and Accessibility permissions are required',
    );
    expect(adapter.captureCalls).toBe(0);
    expect(store.snapshot().desktopAutomation).toMatchObject({
      active: false,
      sessionId: null,
      pendingApprovals: [],
    });
  });

  it('deactivates an active session when a permission request confirms revocation', async () => {
    await enableAndStart();
    adapter.permissions.accessibility = 'denied';

    await service.requestPermission('accessibility');

    expect(store.snapshot().desktopAutomation).toMatchObject({
      active: false,
      sessionId: null,
      currentApp: null,
    });
  });

  it('revalidates the frontmost bundle before pressing a target', async () => {
    await enableAndStart();
    await service.setAppPolicy(adapter.app, 'allow');
    const inspection = await service.inspect();
    adapter.app = {
      name: 'Other App',
      bundleId: 'com.example.other',
    };

    await expect(
      service.press(inspection.elements[0]!.targetId),
    ).rejects.toThrow('Frontmost application changed');
    expect(adapter.pressed).toEqual([]);
  });

  it('revalidates the frontmost bundle again after press approval', async () => {
    await enableAndStart();
    await service.setAppPolicy(adapter.app, 'allow');
    const inspection = await service.inspect();
    await service.setAppPolicy(adapter.app, 'ask');
    const pressPromise = service.press(inspection.elements[0]!.targetId);
    await vi.waitFor(() => {
      expect(store.snapshot().desktopAutomation.pendingApprovals).toHaveLength(
        1,
      );
    });
    const approval = store.snapshot().desktopAutomation.pendingApprovals[0]!;
    adapter.app = {
      name: 'Other App',
      bundleId: 'com.example.other',
    };
    await service.resolveApproval(approval.id, 'allow-once');

    await expect(pressPromise).rejects.toThrow('Frontmost application changed');
    expect(adapter.pressed).toEqual([]);
  });

  it('revalidates the frontmost window again after press approval', async () => {
    await enableAndStart();
    await service.setAppPolicy(adapter.app, 'allow');
    const inspection = await service.inspect();
    await service.setAppPolicy(adapter.app, 'ask');
    const pressPromise = service.press(inspection.elements[0]!.targetId);
    await vi.waitFor(() => {
      expect(store.snapshot().desktopAutomation.pendingApprovals).toHaveLength(
        1,
      );
    });
    const approval = store.snapshot().desktopAutomation.pendingApprovals[0]!;
    adapter.app = {
      ...adapter.app,
      windowTitle: 'Different Window',
    };
    await service.resolveApproval(approval.id, 'allow-once');

    await expect(pressPromise).rejects.toThrow(
      'Frontmost application window changed',
    );
    expect(adapter.pressed).toEqual([]);
  });

  it('invalidates all targets as soon as one press begins', async () => {
    await enableAndStart();
    await service.setAppPolicy(adapter.app, 'allow');
    const inspection = await service.inspect();
    let releasePress!: () => void;
    let markPressStarted!: () => void;
    adapter.pressGate = new Promise<void>((resolve) => {
      releasePress = resolve;
    });
    const pressStarted = new Promise<void>((resolve) => {
      markPressStarted = resolve;
    });
    adapter.onPressStarted = markPressStarted;

    const firstPress = service.press(inspection.elements[0]!.targetId);
    await pressStarted;
    await expect(
      service.press(inspection.elements[0]!.targetId),
    ).rejects.toThrow('missing or stale');
    releasePress();

    await expect(firstPress).resolves.toMatchObject({
      element: { title: 'Continue' },
    });
    expect(adapter.pressed).toHaveLength(1);
  });

  it('keeps active desktop session details out of persisted Agent OS state', async () => {
    await enableAndStart();
    const capturePromise = service.capture();
    await vi.waitFor(() => {
      expect(store.snapshot().desktopAutomation.pendingApprovals).toHaveLength(
        1,
      );
    });

    const persisted = JSON.parse(
      await fs.readFile(path.join(root, 'state.json'), 'utf-8'),
    ) as {
      desktopAutomation: {
        active: boolean;
        sessionId: string | null;
        currentApp: DesktopAutomationApp | null;
        pendingApprovals: unknown[];
        killSwitchRegistered: boolean;
      };
    };
    expect(persisted.desktopAutomation).toMatchObject({
      active: false,
      sessionId: null,
      currentApp: null,
      pendingApprovals: [],
      killSwitchRegistered: false,
    });
    expect(store.snapshot().desktopAutomation.active).toBe(true);
    expect(store.snapshot().desktopAutomation.pendingApprovals).toHaveLength(1);

    const approval = store.snapshot().desktopAutomation.pendingApprovals[0]!;
    await service.resolveApproval(approval.id, 'block-once');
    await expect(capturePromise).rejects.toThrow('not approved');
  });

  it('rejects prototype-pollution bundle ids', async () => {
    await expect(
      service.setAppPolicy(
        {
          name: 'Invalid App',
          bundleId: '__proto__',
        },
        'allow',
      ),
    ).rejects.toThrow();
    await expect(service.removeAppPolicy('__proto__')).rejects.toThrow();
    expect(
      Object.hasOwn(store.snapshot().desktopAutomation.policies, '__proto__'),
    ).toBe(false);
  });
});

import type { BaseWindow } from 'electron';
import type { GlobalConfig } from '@shared/karton-contracts/ui/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KartonService } from './karton';
import type { Logger } from './logger';

interface MockNotificationInstance {
  options: Record<string, unknown>;
  show: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
}

const electronMocks = vi.hoisted(() => ({
  isSupported: vi.fn(),
  notifications: [] as MockNotificationInstance[],
  throwOnConstruct: false,
  throwOnShow: false,
}));

vi.mock('electron', () => {
  class MockNotification {
    readonly options: Record<string, unknown>;
    readonly show = vi.fn(() => {
      if (electronMocks.throwOnShow) {
        throw new Error('show failed');
      }
    });
    readonly close = vi.fn(() => {
      this.emit('close');
    });
    private readonly onceListeners = new Map<
      string,
      (...args: unknown[]) => void
    >();

    constructor(options: Record<string, unknown>) {
      if (electronMocks.throwOnConstruct) {
        throw new Error('construction failed');
      }
      this.options = options;
      electronMocks.notifications.push(this);
    }

    static isSupported(): boolean {
      return electronMocks.isSupported();
    }

    once(event: string, listener: (...args: unknown[]) => void): this {
      this.onceListeners.set(event, listener);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      const listener = this.onceListeners.get(event);
      if (!listener) return;
      this.onceListeners.delete(event);
      listener(...args);
    }
  }

  return {
    app: { dock: undefined },
    Notification: MockNotification,
  };
});

import { NotificationSoundsService } from './notification-sounds';

const config = {
  appColorScheme: 'system',
  notificationSoundPack: 'missing-test-pack',
  notificationSoundLoudness: 'off',
  dockBounceEnabled: true,
  blockAppSuspensionWhenAgentsActive: true,
  personalizationThemeId: 'default',
} as GlobalConfig;

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

let platformSpy: ReturnType<typeof vi.spyOn>;

async function createService(options?: {
  focused?: boolean;
  visibleAgentId?: string | null;
  soundLoudness?: GlobalConfig['notificationSoundLoudness'];
}): Promise<NotificationSoundsService> {
  const window = {
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => options?.focused ?? false),
  } as unknown as BaseWindow;
  const uiKarton = {
    state: {
      browser: {
        lastOpenAgentId: options?.visibleAgentId ?? null,
      },
    },
  } as unknown as KartonService;
  const service = await NotificationSoundsService.create(
    logger,
    uiKarton,
    '/missing/built-in-sounds',
    '/missing/imported-sounds',
    {
      ...config,
      notificationSoundLoudness:
        options?.soundLoudness ?? config.notificationSoundLoudness,
    },
  );
  service.setWindowRef(() => window);
  return service;
}

beforeEach(() => {
  vi.clearAllMocks();
  electronMocks.notifications.length = 0;
  electronMocks.throwOnConstruct = false;
  electronMocks.throwOnShow = false;
  electronMocks.isSupported.mockReturnValue(true);
  platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
});

afterEach(() => {
  platformSpy.mockRestore();
});

describe('NotificationSoundsService Windows lifecycle notifications', () => {
  it('shows generic privacy-safe copy for a completed background iteration', async () => {
    const service = await createService();

    service.notifyAgentEvent('done', 'private-agent-id');

    expect(electronMocks.notifications).toHaveLength(1);
    expect(electronMocks.notifications[0]?.options).toEqual({
      title: 'Iteration complete',
      body: 'The agent is ready for your input.',
      silent: true,
    });
    expect(
      JSON.stringify(electronMocks.notifications[0]?.options),
    ).not.toContain('private-agent-id');
    expect(electronMocks.notifications[0]?.show).toHaveBeenCalledOnce();
  });

  it('suppresses the toast when the completed agent is already visible and focused', async () => {
    const service = await createService({
      focused: true,
      visibleAgentId: 'agent-1',
    });

    service.notifyAgentEvent('done', 'agent-1');

    expect(electronMocks.isSupported).not.toHaveBeenCalled();
    expect(electronMocks.notifications).toHaveLength(0);
  });

  it.each([
    {
      event: 'question' as const,
      title: 'Agent needs attention',
      body: 'An approval or answer is required.',
    },
    {
      event: 'error' as const,
      title: 'Agent stopped with an error',
      body: 'Open CLODEx to review the failure and retry.',
    },
  ])('shows a privacy-safe $event toast even when the agent window remains focused', async ({
    event,
    title,
    body,
  }) => {
    const service = await createService({
      focused: true,
      visibleAgentId: 'agent-1',
    });

    service.notifyAgentEvent(event, 'agent-1');

    expect(electronMocks.notifications).toHaveLength(1);
    expect(electronMocks.notifications[0]?.options).toEqual({
      title,
      body,
      silent: true,
    });
    expect(
      JSON.stringify(electronMocks.notifications[0]?.options),
    ).not.toContain('agent-1');
  });

  it('uses a delivered toast for the existing done-event debounce', async () => {
    const service = await createService();

    service.notifyAgentEvent('done', 'agent-1');
    service.notifyAgentEvent('done', 'agent-2');

    expect(electronMocks.notifications).toHaveLength(1);
  });

  it('never lets a recent done toast suppress approval or error attention', async () => {
    const service = await createService();

    service.notifyAgentEvent('done', 'agent-1');
    service.notifyAgentEvent('question', 'agent-1');
    service.notifyAgentEvent('error', 'agent-1');

    expect(electronMocks.notifications).toHaveLength(3);
    expect(
      electronMocks.notifications.map(
        (notification) => notification.show.mock.calls.length,
      ),
    ).toEqual([1, 1, 1]);
    expect(
      electronMocks.notifications.map((notification) =>
        String(notification.options.title),
      ),
    ).toEqual([
      'Iteration complete',
      'Agent needs attention',
      'Agent stopped with an error',
    ]);
  });

  it('serializes done delivery while asynchronous sound loading is in flight', async () => {
    const service = await createService({ soundLoudness: 'subtle' });

    service.notifyAgentEvent('done', 'agent-1');
    service.notifyAgentEvent('done', 'agent-2');
    await Promise.resolve();
    await Promise.resolve();

    expect(electronMocks.notifications).toHaveLength(1);
  });

  it('skips unsupported notifications and keeps notification failures non-fatal', async () => {
    const unsupportedService = await createService();
    electronMocks.isSupported.mockReturnValue(false);

    expect(() =>
      unsupportedService.notifyAgentEvent('done', 'agent-1'),
    ).not.toThrow();
    expect(electronMocks.notifications).toHaveLength(0);

    electronMocks.isSupported.mockReturnValue(true);
    electronMocks.throwOnShow = true;
    const failingService = await createService();

    expect(() =>
      failingService.notifyAgentEvent('done', 'agent-2'),
    ).not.toThrow();
    expect(() =>
      failingService.notifyAgentEvent('done', 'agent-2'),
    ).not.toThrow();
    expect(electronMocks.notifications).toHaveLength(2);
  });

  it('focuses the originating agent when the user clicks the toast', async () => {
    const service = await createService();
    const focusAgent = vi.fn().mockResolvedValue(undefined);
    service.setFocusAgentHandler(focusAgent);
    service.notifyAgentEvent('done', 'agent-42');

    electronMocks.notifications[0]?.emit('click');
    await Promise.resolve();

    expect(focusAgent).toHaveBeenCalledWith('agent-42');
    expect(
      (
        service as unknown as {
          activeWindowsNotifications: Set<unknown>;
        }
      ).activeWindowsNotifications.size,
    ).toBe(0);
  });

  it('bounds retained native notification instances', async () => {
    const now = vi.spyOn(Date, 'now');
    let timestamp = 10_000;
    now.mockImplementation(() => timestamp);
    const service = await createService();

    for (let index = 0; index < 33; index++) {
      service.notifyAgentEvent('done', `agent-${index}`);
      timestamp += 10_001;
    }

    expect(electronMocks.notifications).toHaveLength(33);
    expect(electronMocks.notifications[0]?.close).toHaveBeenCalledOnce();
    expect(
      (
        service as unknown as {
          activeWindowsNotifications: Set<unknown>;
        }
      ).activeWindowsNotifications.size,
    ).toBe(32);
    now.mockRestore();
  });
});

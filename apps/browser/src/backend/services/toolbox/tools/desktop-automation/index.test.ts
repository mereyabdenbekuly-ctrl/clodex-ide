import { describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';
import type { DesktopAutomationService } from '@/services/agent-os/desktop-automation';
import { makeDesktopAutomationTools } from './index';

async function execute(tool: Tool, input: unknown): Promise<unknown> {
  if (!tool.execute) throw new Error('Tool has no execute function');
  return await tool.execute(input as never, {
    toolCallId: 'desktop-tool-call',
    messages: [],
    abortSignal: new AbortController().signal,
  });
}

function makeService(): DesktopAutomationService {
  return {
    inspect: vi.fn().mockResolvedValue({
      snapshotId: 'f90ebd36-7f41-45cc-a0ce-49296aa8452d',
      capturedAt: 1,
      app: {
        name: 'Preview App',
        bundleId: 'com.example.preview',
      },
      elements: [],
      truncated: false,
    }),
    capture: vi.fn().mockResolvedValue({
      app: {
        name: 'Preview App',
        bundleId: 'com.example.preview',
      },
      image: Buffer.from('png'),
    }),
    press: vi.fn().mockResolvedValue({
      app: {
        name: 'Preview App',
        bundleId: 'com.example.preview',
      },
      element: {
        targetId: 'd64f7db3-04c7-4b79-9079-1af81e0cbbab',
        role: 'AXButton',
        title: 'Continue',
        enabled: true,
        risk: 'normal',
      },
    }),
  } as unknown as DesktopAutomationService;
}

describe('desktop automation tools', () => {
  it('rechecks the feature gate before every operation', async () => {
    const tools = makeDesktopAutomationTools({
      service: makeService(),
      attachments: { write: vi.fn() } as never,
      agentInstanceId: 'agent-1',
      isEnabled: () => false,
    });

    await expect(
      execute(tools.inspectDesktop, { maxElements: 20 }),
    ).rejects.toThrow('feature is disabled');
  });

  it('stores captures as protected agent attachments', async () => {
    const service = makeService();
    const write = vi.fn().mockResolvedValue(undefined);
    const tools = makeDesktopAutomationTools({
      service,
      attachments: { write } as never,
      agentInstanceId: 'agent-1',
      isEnabled: () => true,
    });

    const result = (await execute(tools.captureDesktop, {
      fileName: 'front-window.png',
    })) as { attachmentPath: string };

    expect(write).toHaveBeenCalledWith(
      'agent-1',
      expect.stringMatching(/^front-wind_[a-z0-9]{8}\.png$/),
      Buffer.from('png'),
    );
    expect(result.attachmentPath).toMatch(/^att\/front-wind_[a-z0-9]{8}\.png$/);
  });

  it('uses only opaque target ids from the latest inspection', async () => {
    const service = makeService();
    const tools = makeDesktopAutomationTools({
      service,
      attachments: { write: vi.fn() } as never,
      agentInstanceId: 'agent-1',
      isEnabled: () => true,
    });
    const targetId = 'd64f7db3-04c7-4b79-9079-1af81e0cbbab';

    await execute(tools.pressDesktopElement, { targetId });

    expect(service.press).toHaveBeenCalledWith(targetId);
  });
});

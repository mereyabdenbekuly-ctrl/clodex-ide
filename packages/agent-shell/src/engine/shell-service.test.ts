import { describe, expect, it, vi } from 'vitest';
import { ShellService } from './shell-service';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  verboseMode: false,
} as any;

describe('ShellService teardown', () => {
  it('does not resolve until session log drains complete', async () => {
    const service = new ShellService(logger, () => '/tmp/shell-logs');
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const killAllAndDrain = vi.fn(async () => {
      await drainGate;
    });
    (service as any).sessionManager = {
      getSessionCount: () => 2,
      killAllAndDrain,
    };

    let finished = false;
    const teardown = service.teardown().then(() => {
      finished = true;
    });
    await Promise.resolve();

    expect(killAllAndDrain).toHaveBeenCalledOnce();
    expect(finished).toBe(false);

    releaseDrain();
    await teardown;
    expect(finished).toBe(true);
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentOsStateStore } from './state-store';
import { DebugInspectorService } from './debug-inspector';
import {
  BrowserUsePolicyService,
  normalizeBrowserOrigin,
} from './browser-use-policy';

describe('BrowserUsePolicyService', () => {
  let root: string;
  let store: AgentOsStateStore;
  let service: BrowserUsePolicyService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-os-policy-'));
    store = await AgentOsStateStore.create(path.join(root, 'state.json'));
    service = new BrowserUsePolicyService(
      store,
      new DebugInspectorService(store),
    );
  });

  afterEach(async () => {
    service.teardown();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('normalizes origins and applies safe unknown defaults', () => {
    expect(normalizeBrowserOrigin('https://example.com/a?b=1')).toBe(
      'https://example.com',
    );
    expect(service.getDecision('https://example.com', 'read')).toBe('ask');
    expect(service.getDecision('https://example.com', 'fileTransfer')).toBe(
      'ask',
    );
    expect(service.getDecision('https://example.com', 'fullCdpAccess')).toBe(
      'block',
    );
  });

  it('persists origin policies', async () => {
    await service.setOriginPolicy({
      origin: 'https://example.com/path',
      read: 'allow',
      click: 'block',
      fileTransfer: 'ask',
      fullCdpAccess: 'block',
      history: 'allow',
      routeCapture: true,
      updatedAt: 0,
    });

    const reloaded = await AgentOsStateStore.create(
      path.join(root, 'state.json'),
    );
    const persisted = new BrowserUsePolicyService(
      reloaded,
      new DebugInspectorService(reloaded),
    );

    expect(persisted.canRead('https://example.com/other')).toBe('allow');
    expect(persisted.canClick('https://example.com')).toBe('block');
    expect(persisted.shouldCaptureRoutes('https://example.com')).toBe(true);
  });

  it('supports allow-once and always-block approval responses', async () => {
    await service.setEnabled(true);
    const allowPromise = service.authorize(
      'https://example.com',
      'click',
      'Click the submit button',
    );

    await vi.waitFor(() => {
      expect(store.snapshot().browserUse.pendingApprovals).toHaveLength(1);
    });
    const allowApproval = store.snapshot().browserUse.pendingApprovals[0];
    expect(allowApproval).toBeDefined();
    await service.resolveApproval(allowApproval!.id, 'allow-once');
    await expect(allowPromise).resolves.toBe(true);
    expect(service.getDecision('https://example.com', 'click')).toBe('ask');

    const blockPromise = service.authorize(
      'https://example.com',
      'history',
      'Read recent history',
    );
    await vi.waitFor(() => {
      expect(store.snapshot().browserUse.pendingApprovals).toHaveLength(1);
    });
    const blockApproval = store.snapshot().browserUse.pendingApprovals[0];
    expect(blockApproval).toBeDefined();
    await service.resolveApproval(blockApproval!.id, 'always-block');
    await expect(blockPromise).resolves.toBe(false);
    expect(service.getDecision('https://example.com', 'history')).toBe('block');
  });

  it('fails closed and clears pending approvals when disabled', async () => {
    await service.setEnabled(true);
    const authorization = service.authorize(
      'https://example.com',
      'read',
      'Read the page',
    );
    await vi.waitFor(() => {
      expect(store.snapshot().browserUse.pendingApprovals).toHaveLength(1);
    });

    await service.setEnabled(false);

    await expect(authorization).resolves.toBe(false);
    expect(store.snapshot().browserUse.pendingApprovals).toEqual([]);
  });

  it('can force a one-time human prompt while the policy engine is disabled', async () => {
    const authorization = service.authorize(
      'https://example.com',
      'click',
      'Guardian escalated browser interaction',
      { forceAsk: true },
    );

    await vi.waitFor(() => {
      expect(store.snapshot().browserUse.pendingApprovals).toHaveLength(1);
    });
    const approval = store.snapshot().browserUse.pendingApprovals[0];
    expect(approval).toBeDefined();

    await service.resolveApproval(approval!.id, 'allow-once');

    await expect(authorization).resolves.toBe(true);
  });

  it('does not let a forced prompt override an explicit block policy', async () => {
    await service.setOriginPolicy({
      origin: 'https://example.com',
      read: 'ask',
      click: 'block',
      fileTransfer: 'ask',
      fullCdpAccess: 'block',
      history: 'ask',
      routeCapture: false,
      updatedAt: 0,
    });

    await expect(
      service.authorize(
        'https://example.com',
        'click',
        'Guardian escalated browser interaction',
        { forceAsk: true },
      ),
    ).resolves.toBe(false);
    expect(store.snapshot().browserUse.pendingApprovals).toEqual([]);
  });
});

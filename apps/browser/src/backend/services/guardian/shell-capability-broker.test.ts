import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createShellCapabilityAction } from '@clodex/agent-shell';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseAuditEvents,
  ShellCapabilityBroker,
  verifyShellCapabilityAuditChain,
} from './shell-capability-broker';

describe('ShellCapabilityBroker', () => {
  let directory: string;
  let auditPath: string;
  let now: number;

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'clodex-shell-capability-'),
    );
    auditPath = path.join(directory, 'audit.jsonl');
    now = 1_000;
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const createBroker = async () =>
    await ShellCapabilityBroker.create({
      auditPath,
      ttlMs: 500,
      now: () => now,
    });

  const action = (command = 'pnpm test') =>
    createShellCapabilityAction(
      {
        explanation: 'Run tests',
        session_id: 'session-1',
        command,
      },
      'wtest',
    );

  it('consumes a policy-approved capability exactly once', async () => {
    const broker = await createBroker();
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      action: action(),
      authorization: 'policy-approved',
    });

    await expect(
      broker.consume({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        action: action(),
      }),
    ).resolves.toBeUndefined();
    await expect(
      broker.consume({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        action: action(),
      }),
    ).rejects.toThrow('already consumed');
  });

  it('blocks a command mutation after authorization', async () => {
    const broker = await createBroker();
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      action: action('git status'),
      authorization: 'human-required',
    });

    await expect(
      broker.consume({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        action: action('git push --force origin main'),
      }),
    ).rejects.toThrow('changed after authorization');
  });

  it('binds capabilities to the requesting agent', async () => {
    const broker = await createBroker();
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      action: action(),
      authorization: 'policy-approved',
    });

    await expect(
      broker.consume({
        agentInstanceId: 'agent-2',
        toolCallId: 'tool-1',
        action: action(),
      }),
    ).rejects.toThrow('different agent');
  });

  it('rejects expired capabilities', async () => {
    const broker = await createBroker();
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      action: action(),
      authorization: 'policy-approved',
    });
    now += 501;

    await expect(
      broker.consume({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        action: action(),
      }),
    ).rejects.toThrow('expired');
  });

  it('records human authorization without persisting raw commands', async () => {
    const broker = await createBroker();
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      action: action('echo private-value'),
      authorization: 'human-required',
    });
    await broker.consume({
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      action: action('echo private-value'),
    });

    const content = await fs.readFile(auditPath, 'utf8');
    const events = parseAuditEvents(content);
    expect(events.map((event) => event.eventType)).toEqual([
      'staged',
      'human-authorized',
      'consumed',
    ]);
    expect(content).not.toContain('private-value');
    expect(() => verifyShellCapabilityAuditChain(events)).not.toThrow();
  });

  it('detects tampering in the persisted audit chain', async () => {
    const broker = await createBroker();
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      action: action(),
      authorization: 'policy-approved',
    });

    const events = parseAuditEvents(await fs.readFile(auditPath, 'utf8'));
    events[0] = {
      ...events[0]!,
      actionHash: 'tampered',
    };
    expect(() => verifyShellCapabilityAuditChain(events)).toThrow(
      'was modified',
    );
  });
});

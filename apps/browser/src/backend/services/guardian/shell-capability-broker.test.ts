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
      scopeId: 'scope-1',
      action: action(),
      authorization: 'policy-approved',
    });

    await expect(
      broker.consume({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        scopeId: 'scope-1',
        humanApprovalEvidence: false,
        action: action(),
      }),
    ).resolves.toBeUndefined();
    await expect(
      broker.consume({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        scopeId: 'scope-1',
        humanApprovalEvidence: false,
        action: action(),
      }),
    ).rejects.toThrow('already consumed');
  });

  it('blocks a command mutation after authorization', async () => {
    const broker = await createBroker();
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      scopeId: 'scope-1',
      action: action('git status'),
      authorization: 'human-required',
    });

    await expect(
      broker.consume({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        scopeId: 'scope-1',
        humanApprovalEvidence: false,
        action: action('git push --force origin main'),
      }),
    ).rejects.toThrow('changed after authorization');
  });

  it('does not expose a staged capability to another agent', async () => {
    const broker = await createBroker();
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      scopeId: 'scope-1',
      action: action(),
      authorization: 'policy-approved',
    });

    await expect(
      broker.consume({
        agentInstanceId: 'agent-2',
        toolCallId: 'tool-1',
        scopeId: 'scope-1',
        humanApprovalEvidence: false,
        action: action(),
      }),
    ).rejects.toThrow('missing');

    const events = parseAuditEvents(await fs.readFile(auditPath, 'utf8'));
    expect(events.at(-1)).toMatchObject({
      eventType: 'rejected',
      agentInstanceId: 'agent-2',
      capabilityId: null,
      reason: 'missing-capability',
    });
  });

  it('scopes reused provider tool call identifiers to each agent', async () => {
    const broker = await createBroker();
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'reused-tool-call',
      scopeId: 'scope-1',
      action: action('git status'),
      authorization: 'policy-approved',
    });
    await broker.stage({
      agentInstanceId: 'agent-2',
      toolCallId: 'reused-tool-call',
      scopeId: 'scope-1',
      action: action('pnpm test'),
      authorization: 'policy-approved',
    });

    await expect(
      broker.consume({
        agentInstanceId: 'agent-1',
        toolCallId: 'reused-tool-call',
        scopeId: 'scope-1',
        humanApprovalEvidence: false,
        action: action('git status'),
      }),
    ).resolves.toBeUndefined();
    await expect(
      broker.consume({
        agentInstanceId: 'agent-2',
        toolCallId: 'reused-tool-call',
        scopeId: 'scope-1',
        humanApprovalEvidence: false,
        action: action('pnpm test'),
      }),
    ).resolves.toBeUndefined();

    const events = parseAuditEvents(await fs.readFile(auditPath, 'utf8'));
    const stagedEvents = events.filter((event) => event.eventType === 'staged');
    expect(stagedEvents).toHaveLength(2);
    expect(new Set(stagedEvents.map((event) => event.capabilityId)).size).toBe(
      2,
    );
  });

  it('does not alias identical reused tool call identifiers across agents', async () => {
    const broker = await createBroker();
    const sharedAction = action('git status');
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'reused-tool-call',
      scopeId: 'scope-1',
      action: sharedAction,
      authorization: 'policy-approved',
    });
    await broker.stage({
      agentInstanceId: 'agent-2',
      toolCallId: 'reused-tool-call',
      scopeId: 'scope-1',
      action: sharedAction,
      authorization: 'policy-approved',
    });

    const events = parseAuditEvents(await fs.readFile(auditPath, 'utf8'));
    const stagedEvents = events.filter((event) => event.eventType === 'staged');
    expect(stagedEvents).toHaveLength(2);
    expect(new Set(stagedEvents.map((event) => event.capabilityId)).size).toBe(
      2,
    );
  });

  it('allows one agent to reuse a provider id in a later host scope', async () => {
    const broker = await createBroker();
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'reused-tool-call',
      scopeId: 'scope-initial-response',
      action: action('git status'),
      authorization: 'policy-approved',
    });
    await broker.consume({
      agentInstanceId: 'agent-1',
      toolCallId: 'reused-tool-call',
      scopeId: 'scope-initial-response',
      humanApprovalEvidence: false,
      action: action('git status'),
    });

    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'reused-tool-call',
      scopeId: 'scope-later-response',
      action: action('pnpm test'),
      authorization: 'policy-approved',
    });
    await expect(
      broker.consume({
        agentInstanceId: 'agent-1',
        toolCallId: 'reused-tool-call',
        scopeId: 'scope-later-response',
        humanApprovalEvidence: true,
        action: action('pnpm test'),
      }),
    ).resolves.toBeUndefined();

    const events = parseAuditEvents(await fs.readFile(auditPath, 'utf8'));
    const staged = events.filter((event) => event.eventType === 'staged');
    expect(staged).toHaveLength(2);
    expect(staged[0]?.capabilityId).not.toBe(staged[1]?.capabilityId);
  });

  it('keeps delayed grants isolated in distinct host scopes', async () => {
    const broker = await createBroker();
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'reused-tool-call',
      scopeId: 'scope-before-approval',
      action: action('git status'),
      authorization: 'human-required',
    });
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'reused-tool-call',
      scopeId: 'scope-later-response',
      action: action('pnpm test'),
      authorization: 'policy-approved',
    });

    await expect(
      broker.consume({
        agentInstanceId: 'agent-1',
        toolCallId: 'reused-tool-call',
        scopeId: 'scope-later-response',
        humanApprovalEvidence: true,
        action: action('pnpm test'),
      }),
    ).resolves.toBeUndefined();
    await expect(
      broker.consume({
        agentInstanceId: 'agent-1',
        toolCallId: 'reused-tool-call',
        scopeId: 'scope-before-approval',
        humanApprovalEvidence: true,
        action: action('git status'),
      }),
    ).resolves.toBeUndefined();
  });

  it('merges restaged authorization monotonically in both orderings', async () => {
    const broker = await createBroker();
    await expect(
      broker.stage({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-upgrade',
        scopeId: 'scope-1',
        action: action('git status'),
        authorization: 'policy-approved',
      }),
    ).resolves.toBe('policy-approved');
    await expect(
      broker.stage({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-upgrade',
        scopeId: 'scope-1',
        action: action('git status'),
        authorization: 'human-required',
      }),
    ).resolves.toBe('human-required');
    await expect(
      broker.stage({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-upgrade',
        scopeId: 'scope-1',
        action: action('git status'),
        authorization: 'policy-approved',
      }),
    ).resolves.toBe('human-required');

    const events = parseAuditEvents(await fs.readFile(auditPath, 'utf8'));
    expect(events.map((event) => event.eventType)).toEqual([
      'staged',
      'authorization-upgraded',
    ]);
  });

  it('reserves human-required capability consumption atomically', async () => {
    const broker = await createBroker();
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      scopeId: 'scope-1',
      action: action(),
      authorization: 'human-required',
    });

    const results = await Promise.allSettled([
      broker.consume({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        scopeId: 'scope-1',
        humanApprovalEvidence: true,
        action: action(),
      }),
      broker.consume({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        scopeId: 'scope-1',
        humanApprovalEvidence: true,
        action: action(),
      }),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);

    const events = parseAuditEvents(await fs.readFile(auditPath, 'utf8'));
    expect(
      events.filter((event) => event.eventType === 'consumed'),
    ).toHaveLength(1);
  });

  it('rejects a human-required consume without affirmative approval evidence', async () => {
    const broker = await createBroker();
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      scopeId: 'scope-1',
      action: action(),
      authorization: 'human-required',
    });

    await expect(
      broker.consume({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        scopeId: 'scope-1',
        humanApprovalEvidence: false,
        action: action(),
      }),
    ).rejects.toThrow('requires affirmative human approval');
  });

  it('rejects replacement of an open capability within the same agent', async () => {
    const broker = await createBroker();
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      scopeId: 'scope-1',
      action: action('git status'),
      authorization: 'policy-approved',
    });

    await expect(
      broker.stage({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        scopeId: 'scope-1',
        action: action('git push --force origin main'),
        authorization: 'policy-approved',
      }),
    ).rejects.toThrow('cannot be replaced after staging');

    const events = parseAuditEvents(await fs.readFile(auditPath, 'utf8'));
    expect(events.at(-1)).toMatchObject({
      eventType: 'rejected',
      reason: 'capability-restage-mismatch',
    });
  });

  it('rejects restaging a consumed capability in the same host scope', async () => {
    const broker = await createBroker();
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      scopeId: 'scope-1',
      action: action('git status'),
      authorization: 'policy-approved',
    });
    await broker.consume({
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      scopeId: 'scope-1',
      humanApprovalEvidence: false,
      action: action('git status'),
    });

    await expect(
      broker.stage({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        scopeId: 'scope-1',
        action: action('git status'),
        authorization: 'policy-approved',
      }),
    ).rejects.toThrow('cannot be replaced after staging');

    const events = parseAuditEvents(await fs.readFile(auditPath, 'utf8'));
    expect(events.at(-1)).toMatchObject({
      eventType: 'rejected',
      reason: 'capability-restage-after-consumption',
    });
  });

  it('rejects expired capabilities', async () => {
    const broker = await createBroker();
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      scopeId: 'scope-1',
      action: action(),
      authorization: 'policy-approved',
    });
    now += 501;

    await expect(
      broker.consume({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        scopeId: 'scope-1',
        humanApprovalEvidence: false,
        action: action(),
      }),
    ).rejects.toThrow('expired');
  });

  it('records human authorization without persisting raw commands', async () => {
    const broker = await createBroker();
    await broker.stage({
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      scopeId: 'scope-1',
      action: action('echo private-value'),
      authorization: 'human-required',
    });
    await broker.consume({
      agentInstanceId: 'agent-1',
      toolCallId: 'tool-1',
      scopeId: 'scope-1',
      humanApprovalEvidence: true,
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
      scopeId: 'scope-1',
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

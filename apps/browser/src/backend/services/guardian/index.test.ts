import { describe, expect, it, vi } from 'vitest';
import { guardianAssessmentRequestSchema } from '@shared/guardian';
import { decideGuardianOutcome, GuardianService } from './index';
import {
  createMcpGuardianRequest,
  createNetworkGuardianRequest,
  createRemoteControlGuardianRequest,
  createSandboxGuardianRequest,
  createShellGuardianRequest,
} from './requests';
import type { TelemetryService } from '@/services/telemetry';

function createService(enabled = true) {
  const capture = vi.fn();
  const telemetry = {
    capture,
  } as unknown as Pick<TelemetryService, 'capture'>;
  const recordAudit = vi.fn();
  const service = new GuardianService({
    isFeatureEnabled: () => enabled,
    telemetry,
    recordAudit,
  });
  return { service, capture, recordAudit };
}

describe('GuardianService', () => {
  it('applies the deterministic risk × user authorization matrix', () => {
    expect(
      decideGuardianOutcome({
        risk: 'low',
        userAuthorization: 'unknown',
        narrowlyScoped: false,
      }),
    ).toBe('approve');
    expect(
      decideGuardianOutcome({
        risk: 'medium',
        userAuthorization: 'unknown',
        narrowlyScoped: false,
      }),
    ).toBe('approve');
    expect(
      decideGuardianOutcome({
        risk: 'high',
        userAuthorization: 'low',
        narrowlyScoped: true,
      }),
    ).toBe('escalate');
    expect(
      decideGuardianOutcome({
        risk: 'high',
        userAuthorization: 'medium',
        narrowlyScoped: true,
      }),
    ).toBe('approve');
    expect(
      decideGuardianOutcome({
        risk: 'high',
        userAuthorization: 'high',
        narrowlyScoped: false,
      }),
    ).toBe('escalate');
    expect(
      decideGuardianOutcome({
        risk: 'critical',
        userAuthorization: 'high',
        narrowlyScoped: true,
      }),
    ).toBe('deny');
  });

  it('is inert while the feature gate is disabled', async () => {
    const { service, capture, recordAudit } = createService(false);

    await expect(
      service.assess(
        createShellGuardianRequest({ command: 'ls', cwdPrefix: 'w1' }),
      ),
    ).resolves.toBeNull();
    expect(capture).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('approves bounded read-only and medium-risk project actions', async () => {
    const { service, capture, recordAudit } = createService();

    await expect(
      service.assess(
        createShellGuardianRequest({
          command: 'git status --short',
          cwdPrefix: 'w1234',
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'shell',
      risk: 'low',
      decision: 'approve',
      irreversible: false,
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        assessmentId: expect.any(String),
        createdAt: expect.any(Number),
        kind: 'shell',
        decision: 'approve',
      }),
    );
    const telemetryProperties = capture.mock.calls[0]?.[1];
    expect(telemetryProperties).toMatchObject({ policy_version: 1 });
    expect(telemetryProperties).not.toHaveProperty('assessment_id');
    await expect(
      service.assess(
        createShellGuardianRequest({
          command: 'pnpm typecheck',
          cwdPrefix: 'w1234',
        }),
      ),
    ).resolves.toMatchObject({
      risk: 'high',
      decision: 'escalate',
    });
  });

  it('escalates reads of host paths and credential-like files', async () => {
    const { service } = createService();

    await expect(
      service.assess(
        createShellGuardianRequest({
          command: 'cat ~/.ssh/id_ed25519',
          cwdPrefix: 'w1234',
        }),
      ),
    ).resolves.toMatchObject({
      risk: 'high',
      decision: 'escalate',
      evidence: expect.arrayContaining(['credential-access']),
    });
  });

  it('denies unbounded irreversible host deletion', async () => {
    const { service } = createService();

    await expect(
      service.assess(
        createShellGuardianRequest({
          command: 'sudo rm -rf /',
          cwdPrefix: 'w1234',
        }),
      ),
    ).resolves.toMatchObject({
      risk: 'critical',
      decision: 'deny',
      irreversible: true,
      evidence: expect.arrayContaining([
        'destructive',
        'irreversible',
        'privileged-access',
      ]),
    });
  });

  it('forces human escalation for high-risk remote actions', async () => {
    const { service } = createService();

    await expect(
      service.assess(
        createShellGuardianRequest({
          command: 'git push --force origin main',
          cwdPrefix: 'w1234',
        }),
      ),
    ).resolves.toMatchObject({
      risk: 'high',
      decision: 'escalate',
      irreversible: true,
    });
    await expect(
      service.assess(
        createMcpGuardianRequest({
          toolName: 'ssh_exec',
          readOnly: false,
          destructive: true,
          requiresApproval: true,
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'mcp',
      decision: 'escalate',
      risk: 'high',
      irreversible: true,
    });
  });

  it('approves read-only network checks but escalates file transfer', async () => {
    const { service } = createService();

    await expect(
      service.assess(
        createNetworkGuardianRequest({
          origin: 'https://example.com',
          capability: 'read',
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'network',
      risk: 'low',
      decision: 'approve',
    });
    await expect(
      service.assess(
        createNetworkGuardianRequest({
          origin: 'https://example.com',
          capability: 'fileTransfer',
        }),
      ),
    ).resolves.toMatchObject({
      risk: 'high',
      decision: 'escalate',
      irreversible: true,
    });
  });

  it('routes remote control commands without exposing their payloads', async () => {
    const { service } = createService();

    await expect(
      service.assess(createRemoteControlGuardianRequest('openThread')),
    ).resolves.toMatchObject({
      kind: 'network',
      risk: 'low',
      decision: 'approve',
    });
    await expect(
      service.assess(createRemoteControlGuardianRequest('newAgent')),
    ).resolves.toMatchObject({
      kind: 'network',
      risk: 'medium',
      decision: 'escalate',
    });
    await expect(
      service.assess(createRemoteControlGuardianRequest('approveTool')),
    ).resolves.toMatchObject({
      kind: 'network',
      risk: 'high',
      decision: 'escalate',
      irreversible: true,
    });
    const sendMessageRequest =
      createRemoteControlGuardianRequest('sendMessage');
    expect(sendMessageRequest).not.toHaveProperty('payload');
    expect(sendMessageRequest).not.toHaveProperty('text');
  });

  it('keeps bounded sandbox code low-risk and escalates credential access', async () => {
    const { service } = createService();

    await expect(
      service.assess(createSandboxGuardianRequest('return 2 + 2;')),
    ).resolves.toMatchObject({
      kind: 'sandbox',
      risk: 'low',
      decision: 'approve',
    });
    await expect(
      service.assess(
        createSandboxGuardianRequest(
          "const credential = await API.getCredential('github-pat');",
        ),
      ),
    ).resolves.toMatchObject({
      risk: 'high',
      decision: 'escalate',
      evidence: expect.arrayContaining(['credential-access']),
    });
  });

  it('rejects raw action content from context and fails closed without auditing it', async () => {
    const { service, capture, recordAudit } = createService();
    const malformed = {
      ...createShellGuardianRequest({
        command: 'git status',
        cwdPrefix: 'w1234',
      }),
      command: 'secret raw command',
    };

    expect(guardianAssessmentRequestSchema.safeParse(malformed).success).toBe(
      false,
    );
    await expect(service.assess(malformed)).resolves.toMatchObject({
      risk: 'critical',
      decision: 'deny',
      evidence: ['unknown-context'],
    });

    expect(JSON.stringify(capture.mock.calls)).not.toContain(
      'secret raw command',
    );
    expect(JSON.stringify(recordAudit.mock.calls)).not.toContain(
      'secret raw command',
    );
  });

  it('does not let audit sink failures change the policy decision', async () => {
    const service = new GuardianService({
      isFeatureEnabled: () => true,
      telemetry: {
        capture: vi.fn(() => {
          throw new Error('telemetry unavailable');
        }),
      } as unknown as Pick<TelemetryService, 'capture'>,
      recordAudit: () => {
        throw new Error('debug inspector unavailable');
      },
    });

    await expect(
      service.assess(
        createShellGuardianRequest({
          command: 'git status',
          cwdPrefix: 'w1234',
        }),
      ),
    ).resolves.toMatchObject({
      decision: 'approve',
      risk: 'low',
    });
  });

  it('runs model classification in shadow mode without changing authorization', async () => {
    const recordShadowAudit = vi.fn();
    const service = new GuardianService({
      isFeatureEnabled: (feature) =>
        feature === 'multi-agent-guardian' ||
        feature === 'guardian-model-shadow',
      shadowClassifier: vi.fn(async () => ({
        risk: 'critical' as const,
        narrowlyScoped: false,
      })),
      recordShadowAudit,
    });

    await expect(
      service.assess(
        createShellGuardianRequest({
          command: 'git status --short',
          cwdPrefix: 'w1234',
        }),
      ),
    ).resolves.toMatchObject({ risk: 'low', decision: 'approve' });
    await vi.waitFor(() => {
      expect(recordShadowAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          deterministicRisk: 'low',
          deterministicDecision: 'approve',
          shadowRisk: 'critical',
          shadowDecision: 'deny',
          riskAgreement: false,
          decisionAgreement: false,
          success: true,
        }),
      );
    });
  });
});

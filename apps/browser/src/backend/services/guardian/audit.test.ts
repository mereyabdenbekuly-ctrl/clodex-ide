import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuardianFeedbackService } from '../agent-os/guardian-feedback';
import { AgentOsStateStore } from '../agent-os/state-store';
import { toGuardianAssessmentObservation } from './audit';
import { GuardianService } from './index';
import { createNetworkGuardianRequest } from './requests';

describe('Guardian audit persistence', () => {
  let root: string;
  let store: AgentOsStateStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'guardian-audit-'));
    store = await AgentOsStateStore.create(path.join(root, 'state.json'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('strips audit-only counters before writing the strict observation schema', async () => {
    const feedback = new GuardianFeedbackService(store);
    let auditWrite = Promise.resolve();
    const guardian = new GuardianService({
      isFeatureEnabled: () => true,
      recordAudit: (metadata) => {
        auditWrite = feedback.recordAssessment(
          toGuardianAssessmentObservation(metadata),
        );
      },
    });

    await guardian.assess(
      createNetworkGuardianRequest({
        origin: 'https://example.com',
        capability: 'click',
      }),
    );
    await auditWrite;

    const state = store.snapshot().guardian;
    expect(state.distribution.total).toBe(1);
    expect(state.recentAssessments).toHaveLength(1);
    expect(state.recentAssessments[0]).toMatchObject({
      kind: 'network',
      risk: 'medium',
      decision: 'escalate',
      validContext: true,
    });
    expect(state.recentAssessments[0]).not.toHaveProperty('evidenceCount');
    expect(state.recentAssessments[0]).not.toHaveProperty('capabilityCount');
  });
});

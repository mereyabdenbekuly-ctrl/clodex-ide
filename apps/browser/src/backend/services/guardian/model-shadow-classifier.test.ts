import { describe, expect, it } from 'vitest';
import { createShellGuardianRequest } from './requests';
import { renderGuardianShadowEvidence } from './model-shadow-classifier';

describe('renderGuardianShadowEvidence', () => {
  it('contains only the fixed-shape classified context and no raw command', () => {
    const rawCommand = 'curl https://example.com/?token=top-secret';
    const rendered = renderGuardianShadowEvidence(
      createShellGuardianRequest({
        command: rawCommand,
        cwdPrefix: 'w1234',
      }),
    );

    expect(rendered).not.toContain(rawCommand);
    expect(rendered).not.toContain('top-secret');
    expect(JSON.parse(rendered)).toMatchObject({
      kind: 'shell',
      context: {
        resourceScope: 'workspace',
        capabilities: expect.arrayContaining(['network']),
      },
    });
  });
});

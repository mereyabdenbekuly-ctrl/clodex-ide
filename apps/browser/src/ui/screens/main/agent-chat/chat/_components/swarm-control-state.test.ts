import { describe, expect, it } from 'vitest';
import { shouldDisableSwarmControls } from './swarm-control-state';

describe('swarm composer control state', () => {
  it('keeps next-turn controls selectable while the agent is working', () => {
    expect(
      shouldDisableSwarmControls({
        isAgentWorking: true,
        hasPendingQuestion: false,
      }),
    ).toBe(false);
  });

  it('disables controls while an atomic question response is pending', () => {
    expect(
      shouldDisableSwarmControls({
        isAgentWorking: false,
        hasPendingQuestion: true,
      }),
    ).toBe(true);
    expect(
      shouldDisableSwarmControls({
        isAgentWorking: true,
        hasPendingQuestion: true,
      }),
    ).toBe(true);
  });
});

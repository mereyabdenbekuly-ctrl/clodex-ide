import { describe, expect, it } from 'vitest';
import {
  clampMascotOverlayPosition,
  deriveMascotAgentSignal,
  getDefaultMascotOverlayPosition,
  rubberBandMascotOverlayPosition,
  stepMascotOverlaySpring,
  type MascotAgentSnapshot,
  type MascotOverlayMotion,
} from './mascot-overlay';

function agent(
  id: string,
  overrides: Partial<MascotAgentSnapshot> = {},
): MascotAgentSnapshot {
  return {
    id,
    isWorking: false,
    isWaitingForUser: false,
    hasError: false,
    hasUnseen: false,
    ...overrides,
  };
}

describe('mascot overlay positioning', () => {
  it('places the default mascot in the bottom-right viewport corner', () => {
    expect(
      getDefaultMascotOverlayPosition({ width: 1000, height: 700 }, 144),
    ).toEqual({ x: 840, y: 540 });
  });

  it('clamps persisted coordinates to the visible viewport', () => {
    expect(
      clampMascotOverlayPosition(
        { x: 2000, y: -100 },
        { width: 1000, height: 700 },
        144,
      ),
    ).toEqual({ x: 840, y: 16 });
  });

  it('centers along an axis when the viewport cannot preserve both margins', () => {
    expect(
      clampMascotOverlayPosition(
        { x: 200, y: 200 },
        { width: 150, height: 120 },
        144,
      ),
    ).toEqual({ x: 3, y: 0 });
  });

  it('adds resistance outside the legal drag bounds', () => {
    expect(
      rubberBandMascotOverlayPosition(
        { x: -84, y: 640 },
        { width: 1000, height: 700 },
        144,
      ),
    ).toEqual({ x: -8, y: 564 });
  });

  it('settles a spring animation on the requested target', () => {
    let motion: MascotOverlayMotion = {
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
    };
    let settled = false;

    for (let frame = 0; frame < 240; frame++) {
      const step = stepMascotOverlaySpring(
        motion,
        { x: 320, y: 180 },
        1000 / 60,
      );
      motion = step;
      settled = step.settled;
      if (settled) break;
    }

    expect(settled).toBe(true);
    expect(motion.position).toEqual({ x: 320, y: 180 });
  });
});

describe('mascot agent signal', () => {
  it('uses error, waiting, working, success, then idle priority', () => {
    expect(
      deriveMascotAgentSignal([
        agent('idle'),
        agent('success', { hasUnseen: true }),
        agent('working', { isWorking: true }),
        agent('waiting', { isWaitingForUser: true }),
        agent('error', { hasError: true }),
      ]),
    ).toEqual({ status: 'error', targetAgentId: 'error' });
  });

  it('returns the first idle agent as a focus target', () => {
    expect(
      deriveMascotAgentSignal([agent('agent-a'), agent('agent-b')]),
    ).toEqual({
      status: 'idle',
      targetAgentId: 'agent-a',
    });
  });

  it('returns an idle signal without a target when no agents exist', () => {
    expect(deriveMascotAgentSignal([])).toEqual({
      status: 'idle',
      targetAgentId: null,
    });
  });
});

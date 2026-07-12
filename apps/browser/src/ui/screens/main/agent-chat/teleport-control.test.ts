import { describe, expect, it } from 'vitest';
import { getTeleportPhaseLabel } from './teleport-control';

describe('TeleportControl', () => {
  it('uses explicit product labels for ownership states', () => {
    expect(getTeleportPhaseLabel('restoring')).toBe('Restoring');
    expect(getTeleportPhaseLabel('cloud-owned')).toBe('Cloud-owned');
    expect(getTeleportPhaseLabel('suspended')).toBe('Suspended');
  });
});

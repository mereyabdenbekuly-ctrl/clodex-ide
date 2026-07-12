import { describe, expect, it } from 'vitest';
import {
  cloudTaskDogfoodChannels,
  isCloudTaskKillSwitchActive,
} from './cloud-task-rollout';

describe('Cloud Tasks dogfood rollout', () => {
  it('limits default-on admission to non-release dogfood channels', () => {
    expect(cloudTaskDogfoodChannels).toEqual(['dev', 'prerelease', 'nightly']);
    expect(cloudTaskDogfoodChannels).not.toContain('release');
  });

  it.each([
    '1',
    'true',
    'TRUE',
    ' yes ',
  ])('recognizes the emergency kill-switch value %s', (value) => {
    expect(isCloudTaskKillSwitchActive(value)).toBe(true);
  });

  it.each([
    undefined,
    '',
    '0',
    'false',
    'no',
    'enabled',
  ])('keeps the kill switch inactive for %s', (value) => {
    expect(isCloudTaskKillSwitchActive(value)).toBe(false);
  });
});

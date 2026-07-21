import { describe, expect, it } from 'vitest';
import {
  bedrockInferencePrefix,
  buildSuggestedBedrockMapping,
  resolveEffectiveBedrockRegion,
} from './bedrock-settings';

describe('Bedrock settings helpers', () => {
  it('prefers an explicit region override in every auth mode', () => {
    expect(
      resolveEffectiveBedrockRegion({
        regionOverride: ' eu-west-1 ',
        awsAuthMode: 'profile',
        awsProfileName: 'prod',
        profiles: [{ name: 'prod', region: 'us-west-2' }],
        envRegion: 'ap-southeast-1',
      }),
    ).toBe('eu-west-1');
  });

  it('uses a named profile service region before the environment', () => {
    expect(
      resolveEffectiveBedrockRegion({
        regionOverride: '',
        awsAuthMode: 'profile',
        awsProfileName: 'prod',
        profiles: [{ name: 'prod', region: 'us-west-2' }],
        envRegion: 'eu-central-1',
      }),
    ).toBe('us-west-2');
  });

  it('never treats sso_region as the Bedrock service region', () => {
    expect(
      resolveEffectiveBedrockRegion({
        regionOverride: '',
        awsAuthMode: 'profile',
        awsProfileName: 'sso-prod',
        profiles: [{ name: 'sso-prod', ssoRegion: 'eu-west-1' }],
        envRegion: 'us-east-2',
      }),
    ).toBe('us-east-2');
    expect(
      resolveEffectiveBedrockRegion({
        regionOverride: '',
        awsAuthMode: 'profile',
        awsProfileName: 'sso-prod',
        profiles: [{ name: 'sso-prod', ssoRegion: 'eu-west-1' }],
        envRegion: undefined,
      }),
    ).toBeUndefined();
  });

  it('uses the environment for the default chain and static-key fallback', () => {
    expect(
      resolveEffectiveBedrockRegion({
        regionOverride: '',
        awsAuthMode: 'default-chain',
        awsProfileName: '',
        profiles: [],
        envRegion: 'ap-northeast-1',
      }),
    ).toBe('ap-northeast-1');
    expect(
      resolveEffectiveBedrockRegion({
        regionOverride: '',
        awsAuthMode: 'access-keys',
        awsProfileName: '',
        profiles: [],
        envRegion: undefined,
      }),
    ).toBe('us-east-1');
  });

  it('maps service regions to inference-profile families', () => {
    expect(bedrockInferencePrefix('US-WEST-2')).toBe('us.');
    expect(bedrockInferencePrefix('ca-central-1')).toBe('us.');
    expect(bedrockInferencePrefix('eu-central-1')).toBe('eu.');
    expect(bedrockInferencePrefix('ap-southeast-2')).toBe('apac.');
    expect(bedrockInferencePrefix(undefined)).toBe('us.');
  });

  it('applies the selected prefix to every suggested model mapping', () => {
    const mapping = JSON.parse(buildSuggestedBedrockMapping('eu.')) as Record<
      string,
      string
    >;
    expect(Object.values(mapping)).not.toHaveLength(0);
    expect(
      Object.values(mapping).every((value) => value.startsWith('eu.')),
    ).toBe(true);
  });
});

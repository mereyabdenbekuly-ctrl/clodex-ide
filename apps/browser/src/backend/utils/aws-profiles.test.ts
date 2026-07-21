import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBedrockRegionSync } from './aws-profiles';

const temporaryDirectories: string[] = [];

function awsFiles(
  config = '',
  credentials = '',
): {
  configFilepath: string;
  credentialsFilepath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'clodex-aws-profiles-'));
  temporaryDirectories.push(directory);
  const configFilepath = join(directory, 'config');
  const credentialsFilepath = join(directory, 'credentials');
  writeFileSync(configFilepath, config, 'utf8');
  writeFileSync(credentialsFilepath, credentials, 'utf8');
  return { configFilepath, credentialsFilepath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('resolveBedrockRegionSync', () => {
  it('uses the access-key override and otherwise preserves the us-east-1 default', () => {
    expect(
      resolveBedrockRegionSync({
        authMode: 'access-keys',
        regionOverride: '  eu-west-1  ',
        env: { AWS_REGION: 'ap-south-1' },
      }),
    ).toBe('eu-west-1');
    expect(
      resolveBedrockRegionSync({
        authMode: 'access-keys',
        regionOverride: '   ',
        env: { AWS_REGION: 'ap-south-1' },
      }),
    ).toBe('us-east-1');
  });

  it('uses the explicit profile and region override despite a conflicting AWS_PROFILE', () => {
    const paths = awsFiles(`
      [profile selected]
      region = eu-central-1

      [profile wrong]
      region = ap-northeast-1
    `);

    expect(
      resolveBedrockRegionSync({
        authMode: 'profile',
        profileName: ' selected ',
        regionOverride: 'us-west-2',
        env: {
          AWS_PROFILE: 'wrong',
          AWS_REGION: 'ca-central-1',
        },
        ...paths,
      }),
    ).toBe('us-west-2');
  });

  it('prefers the selected profile config region over credentials and environment regions', () => {
    const paths = awsFiles(
      `
        [profile selected]
        region = eu-west-3
      `,
      `
        [selected]
        region = ap-southeast-2
      `,
    );

    expect(
      resolveBedrockRegionSync({
        authMode: 'profile',
        profileName: 'selected',
        env: {
          AWS_REGION: 'us-west-1',
          AWS_DEFAULT_REGION: 'us-east-2',
        },
        ...paths,
      }),
    ).toBe('eu-west-3');
  });

  it('reads a credentials-file region with comments and whitespace without using sso_region', () => {
    const paths = awsFiles(
      `
        # SSO control-plane region is not the Bedrock service region.
        [profile team] ; selected profile
        sso_region = us-east-1
      `,
      `
        ; credentials may also declare a service region
        [team] # selected profile
          region = ap-southeast-1   # Bedrock service region
      `,
    );

    expect(
      resolveBedrockRegionSync({
        authMode: 'profile',
        profileName: 'team',
        env: {},
        ...paths,
      }),
    ).toBe('ap-southeast-1');
  });

  it('falls back from a regionless existing profile to AWS_REGION then AWS_DEFAULT_REGION', () => {
    const paths = awsFiles(
      '[profile team]\nsso_region = eu-west-1\n',
      '[team]\n',
    );

    expect(
      resolveBedrockRegionSync({
        authMode: 'profile',
        profileName: 'team',
        env: {
          AWS_REGION: '  sa-east-1 ',
          AWS_DEFAULT_REGION: 'us-east-2',
        },
        ...paths,
      }),
    ).toBe('sa-east-1');
    expect(
      resolveBedrockRegionSync({
        authMode: 'profile',
        profileName: 'team',
        env: { AWS_DEFAULT_REGION: 'us-east-2' },
        ...paths,
      }),
    ).toBe('us-east-2');
  });

  it('rejects a blank or missing selected profile even when an environment region exists', () => {
    const paths = awsFiles('[profile available]\nregion = us-west-1\n');

    expect(() =>
      resolveBedrockRegionSync({
        authMode: 'profile',
        profileName: '   ',
        regionOverride: 'eu-west-1',
        env: { AWS_REGION: 'us-east-1' },
        ...paths,
      }),
    ).toThrow(/requires a non-empty AWS profile name/u);
    expect(() =>
      resolveBedrockRegionSync({
        authMode: 'profile',
        profileName: 'missing',
        regionOverride: 'eu-west-1',
        env: { AWS_REGION: 'us-east-1' },
        ...paths,
      }),
    ).toThrow(/profile "missing" was not found/u);
  });

  it('rejects a selected profile that only declares sso_region', () => {
    const paths = awsFiles(
      '[profile team]\nsso_region = eu-north-1\n',
      '[team]\naws_access_key_id = example\n',
    );

    expect(() =>
      resolveBedrockRegionSync({
        authMode: 'profile',
        profileName: 'team',
        env: {},
        ...paths,
      }),
    ).toThrow(/has no service region/u);
  });

  it('applies default-chain override and environment precedence before profile files', () => {
    const missingDirectory = mkdtempSync(
      join(tmpdir(), 'clodex-aws-profiles-missing-'),
    );
    temporaryDirectories.push(missingDirectory);
    const missingPaths = {
      configFilepath: join(missingDirectory, 'missing-config'),
      credentialsFilepath: join(missingDirectory, 'missing-credentials'),
    };

    expect(
      resolveBedrockRegionSync({
        authMode: 'default-chain',
        regionOverride: 'eu-south-1',
        env: { AWS_REGION: 'us-west-1' },
        ...missingPaths,
      }),
    ).toBe('eu-south-1');
    expect(
      resolveBedrockRegionSync({
        authMode: 'default-chain',
        env: {
          AWS_REGION: 'us-west-1',
          AWS_DEFAULT_REGION: 'us-east-2',
          AWS_PROFILE: 'missing',
        },
        ...missingPaths,
      }),
    ).toBe('us-west-1');
  });

  it('uses AWS_PROFILE and then the default profile in default-chain mode', () => {
    const paths = awsFiles(
      `
        [default]
        region = us-east-2

        [profile deployment]
        region = ca-west-1
      `,
    );

    expect(
      resolveBedrockRegionSync({
        authMode: 'default-chain',
        env: { AWS_PROFILE: 'deployment' },
        ...paths,
      }),
    ).toBe('ca-west-1');
    expect(
      resolveBedrockRegionSync({
        authMode: 'default-chain',
        env: { AWS_PROFILE: '   ' },
        ...paths,
      }),
    ).toBe('us-east-2');
  });

  it('fails closed when default-chain has no environment or profile region', () => {
    const paths = awsFiles('[default]\nsso_region = us-west-2\n');

    expect(() =>
      resolveBedrockRegionSync({
        authMode: 'default-chain',
        env: {},
        ...paths,
      }),
    ).toThrow(/profile "default" has no service region/u);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildIsolatedAppHost,
  buildIsolatedAppOrigin,
  buildIsolatedAppUrl,
  parseAppUrlIdentity,
  parseIsolatedAppHost,
  parseIsolatedAppOrigin,
  parseIsolatedAppUrlIdentity,
  validateIsolatedAppHost,
  validateIsolatedAppOrigin,
  validateIsolatedAppUrlIdentity,
  type AppUrlIdentity,
} from './isolated-app-origin';

const AGENT_APP = {
  namespace: 'agents',
  entityId: 'agent-42',
  appId: 'dashboard',
} as const satisfies AppUrlIdentity;

const AGENT_HOST =
  'agents-n6lrxofj3pzhy26h3bgmbgsm46dzbixylufoimxfeused2m2zuga';

describe('isolated app host identity', () => {
  it('uses the stable full SHA-256 lowercase RFC 4648 base32 vector', () => {
    const host = buildIsolatedAppHost(AGENT_APP);

    expect(host).toBe(AGENT_HOST);
    expect(host).toHaveLength(59);
    expect(host).toMatch(/^agents-[a-z2-7]{52}$/);
    expect(host).not.toContain('=');
  });

  it('separates namespaces and every identity field', () => {
    const base = buildIsolatedAppHost(AGENT_APP);

    expect(
      buildIsolatedAppHost({ ...AGENT_APP, namespace: 'plugins' }),
    ).not.toBe(base);
    expect(
      buildIsolatedAppHost({ ...AGENT_APP, entityId: 'agent-43' }),
    ).not.toBe(base);
    expect(
      buildIsolatedAppHost({ ...AGENT_APP, appId: 'other-dashboard' }),
    ).not.toBe(base);
  });

  it('keeps collision-relevant tuple boundaries unambiguous', () => {
    const left = buildIsolatedAppHost({
      namespace: 'agents',
      entityId: 'a',
      appId: 'bc',
    });
    const right = buildIsolatedAppHost({
      namespace: 'agents',
      entityId: 'ab',
      appId: 'c',
    });

    expect(left).toBe(
      'agents-olyugol4xs5kx5epp5sbf5rr5c2yjao35tc5h4lq4yleyexslmfa',
    );
    expect(right).toBe(
      'agents-w2dnk7mqdyjkchiok42xfzfc5tn7y4e4toi2er6jpulncgjtzyrq',
    );
    expect(left).not.toBe(right);
  });

  it('uses UTF-8 byte lengths for decoded Unicode identity fields', () => {
    expect(
      buildIsolatedAppHost({
        namespace: 'agents',
        entityId: 'é',
        appId: '应用',
      }),
    ).toBe('agents-iqtedju2hmhxjyoqlzfa6tqwfacu6lu4vldoyr3hadutn4nozara');
  });

  it('parses and validates only canonical single-label hosts', () => {
    expect(parseIsolatedAppHost(AGENT_HOST)).toEqual({
      namespace: 'agents',
      digest: AGENT_HOST.slice('agents-'.length),
      host: AGENT_HOST,
    });
    expect(validateIsolatedAppHost(AGENT_HOST, AGENT_APP)).toBe(true);
    expect(
      validateIsolatedAppHost(AGENT_HOST, { ...AGENT_APP, appId: 'other' }),
    ).toBe(false);

    for (const malformed of [
      AGENT_HOST.toUpperCase(),
      `${AGENT_HOST}.`,
      `${AGENT_HOST}.example`,
      AGENT_HOST.slice(0, -1),
      AGENT_HOST.replace('n6l', 'n0l'),
      `${AGENT_HOST}=`,
      `${AGENT_HOST.slice(0, -1)}b`, // non-zero RFC 4648 pad bits
    ]) {
      expect(parseIsolatedAppHost(malformed), malformed).toBeNull();
    }
  });

  it('builds, parses, and validates a canonical origin', () => {
    const origin = buildIsolatedAppOrigin(AGENT_APP);

    expect(origin).toBe(`app://${AGENT_HOST}`);
    expect(parseIsolatedAppOrigin(origin)).toEqual({
      namespace: 'agents',
      digest: AGENT_HOST.slice('agents-'.length),
      host: AGENT_HOST,
      origin,
    });
    expect(validateIsolatedAppOrigin(origin, AGENT_APP)).toBe(true);
    expect(
      validateIsolatedAppOrigin(origin, { ...AGENT_APP, appId: 'x' }),
    ).toBe(false);

    for (const malformed of [
      `APP://${AGENT_HOST}`,
      `app://${AGENT_HOST}/`,
      `app://${AGENT_HOST}.`,
      `app://${AGENT_HOST}:123`,
      `app://user@${AGENT_HOST}`,
      `app://${AGENT_HOST}?query`,
    ]) {
      expect(parseIsolatedAppOrigin(malformed), malformed).toBeNull();
    }
  });
});

describe('isolated app URL identity', () => {
  it('builds encoded identity paths and parses their decoded identity', () => {
    const identity = {
      namespace: 'plugins',
      entityId: 'publisher plugin',
      appId: '数据-viewer',
    } as const satisfies AppUrlIdentity;
    const url = buildIsolatedAppUrl(identity, ['assets', 'index.html']);

    expect(url).toContain('/publisher%20plugin/%E6%95%B0%E6%8D%AE-viewer/');
    expect(parseIsolatedAppUrlIdentity(`${url}?revision=7#ready`)).toEqual(
      identity,
    );
    expect(validateIsolatedAppUrlIdentity(url, identity)).toBe(true);
  });

  it('rejects a syntactically valid isolated host whose digest mismatches the path', () => {
    const wrongHost = buildIsolatedAppHost({ ...AGENT_APP, appId: 'other' });
    const mismatched = `app://${wrongHost}/${AGENT_APP.entityId}/${AGENT_APP.appId}/index.html`;

    expect(parseAppUrlIdentity(mismatched)).toBeNull();
    expect(parseIsolatedAppUrlIdentity(mismatched)).toBeNull();
  });

  it('rejects credentials, ports, trailing dots, and noncanonical authorities', () => {
    const path = `/${AGENT_APP.entityId}/${AGENT_APP.appId}/index.html`;

    for (const malformed of [
      `app://user@${AGENT_HOST}${path}`,
      `app://user:secret@${AGENT_HOST}${path}`,
      `app://${AGENT_HOST}:123${path}`,
      `app://${AGENT_HOST}.${path}`,
      `app://${AGENT_HOST.toUpperCase()}${path}`,
      `APP://${AGENT_HOST}${path}`,
      `app://%61gents-${AGENT_HOST.slice('agents-'.length)}${path}`,
    ]) {
      expect(parseAppUrlIdentity(malformed), malformed).toBeNull();
    }
  });

  it('rejects malformed or unsafe decoded path identities', () => {
    for (const malformed of [
      `app://${AGENT_HOST}/only-one-segment`,
      `app://${AGENT_HOST}//dashboard/index.html`,
      `app://${AGENT_HOST}/agent-42//index.html`,
      `app://${AGENT_HOST}/agent%2F42/dashboard/index.html`,
      `app://${AGENT_HOST}/agent-42/%00/index.html`,
      `app://${AGENT_HOST}/%E0%A4%A/dashboard/index.html`,
    ]) {
      expect(parseAppUrlIdentity(malformed), malformed).toBeNull();
    }
  });

  it('classifies canonical legacy URLs for serve-only compatibility', () => {
    expect(
      parseAppUrlIdentity(
        'app://agents/agent%2042/legacy-dashboard/index.html?revision=1',
      ),
    ).toEqual({
      classification: 'legacy',
      identity: {
        namespace: 'agents',
        entityId: 'agent 42',
        appId: 'legacy-dashboard',
      },
      host: 'agents',
      origin: 'app://agents',
    });
    expect(
      parseIsolatedAppUrlIdentity(
        'app://agents/agent%2042/legacy-dashboard/index.html',
      ),
    ).toBeNull();
  });

  it('does not preserve legacy compatibility for malformed legacy authorities', () => {
    for (const malformed of [
      'app://AGENTS/agent/app/index.html',
      'app://agents./agent/app/index.html',
      'app://user@agents/agent/app/index.html',
      'app://agents:99/agent/app/index.html',
    ]) {
      expect(parseAppUrlIdentity(malformed), malformed).toBeNull();
    }
  });

  it('refuses to build ambiguous decoded identity or path components', () => {
    for (const entityId of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', '\ud800']) {
      expect(() =>
        buildIsolatedAppUrl({ ...AGENT_APP, entityId }, ['index.html']),
      ).toThrow();
    }
    expect(() => buildIsolatedAppUrl(AGENT_APP, ['assets/icon.png'])).toThrow();
    expect(() => buildIsolatedAppUrl(AGENT_APP, [''])).toThrow();
  });
});

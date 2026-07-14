import { describe, expect, it } from 'vitest';
import {
  buildIsolatedAppOrigin,
  buildIsolatedAppUrl,
} from '@shared/isolated-app-origin';
import { shouldBlockIsolatedAppWindowOpen } from './isolated-app-window-open-policy';

const identity = {
  namespace: 'agents' as const,
  entityId: 'agent-a',
  appId: 'dashboard',
};
const isolatedUrl = buildIsolatedAppUrl(identity, ['index.html']);
const isolatedOrigin = buildIsolatedAppOrigin(identity);

describe('isolated app window-open policy', () => {
  it.each([
    'https://example.com/collect?secret=1',
    'mailto:security@example.com',
    'vscode://file/tmp/secret.txt',
    'file:///tmp/secret.txt',
    'clodex://reveal-file/%2Ftmp%2Fsecret.txt',
  ])('blocks %s when the explicit referrer is an isolated app', (targetUrl) => {
    expect(
      shouldBlockIsolatedAppWindowOpen({
        targetUrl,
        referrerUrl: isolatedUrl,
        topLevelUrl: 'https://example.com/',
        frameUrls: [isolatedUrl],
      }),
    ).toBe(true);
  });

  it('fails closed for an empty referrer on a generated-app preview route', () => {
    expect(
      shouldBlockIsolatedAppWindowOpen({
        targetUrl: 'https://example.com/collect',
        referrerUrl: '',
        topLevelUrl: 'clodex://internal/preview/dashboard?agentId=agent-a&t=1',
      }),
    ).toBe(true);
  });

  it('uses immutable isolated frame origin when its URL is unavailable or history-mutated', () => {
    expect(
      shouldBlockIsolatedAppWindowOpen({
        targetUrl: 'mailto:security@example.com',
        referrerUrl: null,
        topLevelUrl: 'https://example.com/host',
        frameUrls: ['https://example.com/history-mutated'],
        frameOrigins: [isolatedOrigin],
      }),
    ).toBe(true);
  });

  it('fails closed when Electron cannot inspect the potential source frame tree', () => {
    expect(
      shouldBlockIsolatedAppWindowOpen({
        targetUrl: 'https://example.org/new-tab',
        referrerUrl: '',
        topLevelUrl: 'https://example.com/page',
        sourceInspectionFailed: true,
      }),
    ).toBe(true);
  });

  it('keeps normal web tabs without isolated frames unchanged', () => {
    expect(
      shouldBlockIsolatedAppWindowOpen({
        targetUrl: 'https://example.org/new-tab',
        referrerUrl: 'https://example.com/page',
        topLevelUrl: 'https://example.com/page',
        frameUrls: ['https://example.com/page'],
        frameOrigins: ['https://example.com'],
      }),
    ).toBe(false);
  });
});

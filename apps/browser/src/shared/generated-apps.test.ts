import { describe, expect, it } from 'vitest';
import {
  createGeneratedAppKey,
  createGeneratedAppPreviewUrl,
  decodeGeneratedAppKey,
} from './generated-apps';

describe('generated app identity', () => {
  it('round-trips unicode agent and app identifiers through a URL-safe key', () => {
    const key = createGeneratedAppKey('agent-α', 'дашборд');

    expect(key).toMatch(/^v1_[0-9a-f]+_[0-9a-f]+$/);
    expect(decodeGeneratedAppKey(key)).toEqual({
      agentId: 'agent-α',
      appId: 'дашборд',
    });
  });

  it('rejects malformed keys', () => {
    expect(decodeGeneratedAppKey('v1_not-hex_deadbeef')).toBeNull();
    expect(decodeGeneratedAppKey('v2_aa_bb')).toBeNull();
    expect(decodeGeneratedAppKey('v1_aa')).toBeNull();
  });

  it('builds an agent-owned preview URL', () => {
    expect(
      createGeneratedAppPreviewUrl(
        'agent/task',
        'status board',
        '2026-07-10T12:00:00.000Z',
      ),
    ).toBe(
      'clodex://internal/preview/status%20board?agentId=agent%2Ftask&t=2026-07-10T12%3A00%3A00.000Z',
    );
  });
});

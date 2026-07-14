import { describe, expect, it } from 'vitest';
import { createSandboxAppPreviewUrl } from './app-preview-url';

describe('createSandboxAppPreviewUrl', () => {
  it('binds a plugin preview to both its owning agent and plugin identity', () => {
    const url = new URL(
      createSandboxAppPreviewUrl({
        agentId: 'agent-1',
        appId: 'figma-app',
        pluginId: 'figma',
        title: 'Figma selection',
        cacheBust: 123,
      }),
    );

    expect(url.protocol).toBe('clodex:');
    expect(url.host).toBe('internal');
    expect(url.pathname).toBe('/preview/figma-app');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      agentId: 'agent-1',
      t: '123',
      pluginId: 'figma',
      title: Buffer.from('Figma selection', 'utf8').toString('base64url'),
    });
  });
});

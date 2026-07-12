import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentChatTitlebar } from './agent-chat-titlebar';

describe('AgentChatTitlebar', () => {
  it('keeps titlebar actions clickable inside the Electron drag region', () => {
    const markup = renderToStaticMarkup(
      createElement(AgentChatTitlebar, {
        agentTitle: 'Current task',
        actions: createElement('button', { type: 'button' }, 'Action'),
      }),
    );

    expect(markup).toMatch(
      /data-agent-chat-titlebar="" class="[^"]*\bapp-drag\b[^"]*\bpointer-events-none\b/,
    );
    expect(markup).toMatch(
      /data-agent-chat-titlebar-actions=""[^>]*class="[^"]*\bapp-no-drag\b[^"]*\bpointer-events-auto\b/,
    );
    expect(markup.indexOf('data-agent-chat-titlebar-actions')).toBeGreaterThan(
      markup.indexOf('data-agent-chat-titlebar'),
    );
  });

  it('renders Teleport ownership controls in the non-draggable title area', () => {
    const markup = renderToStaticMarkup(
      createElement(AgentChatTitlebar, {
        agentTitle: 'Cloud task',
        teleport: createElement(
          'button',
          { type: 'button', 'data-teleport-status': 'suspended' },
          'Suspended',
        ),
      }),
    );

    expect(markup).toContain('data-teleport-status="suspended"');
    expect(markup).toContain('Suspended');
  });
});

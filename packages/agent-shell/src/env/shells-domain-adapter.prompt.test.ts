import { describe, expect, it } from 'vitest';
import ShellsDomainPromptSection from './shells-domain-adapter.prompt.md?raw';

describe('shells domain prompt', () => {
  it('documents the split create and execute lifecycle', () => {
    expect(ShellsDomainPromptSection).toContain('createShellSession');
    expect(ShellsDomainPromptSection).toContain('executeShellCommand');
    expect(ShellsDomainPromptSection).toContain(
      '`executeShellCommand` never creates a session and never accepts `cwd`',
    );
    expect(ShellsDomainPromptSection).not.toContain(
      'Omit `session_id`, set `cwd`',
    );
    expect(ShellsDomainPromptSection).not.toMatch(
      /\{[^}\n]*"command"[^}\n]*"cwd"/,
    );
  });

  it('requires exactly one execute action mode and shows stdin without command', () => {
    expect(ShellsDomainPromptSection).toContain(
      'Choose exactly one action mode',
    );
    expect(ShellsDomainPromptSection).toContain(
      'omit `command` entirely for stdin and kill',
    );
    expect(ShellsDomainPromptSection).toContain(
      '{ "explanation": "Send Enter key", "session_id": "abc123", "stdin": "\\r" }',
    );
  });
});

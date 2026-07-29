import { describe, expect, it } from 'vitest';
import { createShellCapabilityAction } from './shell-capability';

const BASE_INPUT = {
  explanation: 'Use shell',
  session_id: 'session-1',
};

describe('createShellCapabilityAction stdin compatibility', () => {
  it.each([
    [
      'command',
      'command',
      { ...BASE_INPUT, command: 'git status', stdin: '' },
      'git status',
    ],
    ['implicit poll', 'poll', { ...BASE_INPUT, stdin: '' }, ''],
    ['explicit poll', 'poll', { ...BASE_INPUT, command: '', stdin: '' }, ''],
    ['kill', 'kill', { ...BASE_INPUT, kill: true, stdin: '' }, ''],
  ] as const)('does not replace %s mode with stdin', (_label, expectedOperation, input, expectedCommand) => {
    expect(createShellCapabilityAction(input, 'wtest')).toMatchObject({
      operation: expectedOperation,
      command: expectedCommand,
    });
  });

  it('still binds non-empty stdin to the exact delivered bytes', () => {
    expect(
      createShellCapabilityAction(
        { ...BASE_INPUT, command: '', stdin: 'y\\r' },
        'wtest',
      ),
    ).toMatchObject({
      operation: 'stdin',
      command: 'y\r',
    });
  });

  it.each([
    { ...BASE_INPUT, command: 'git status', stdin: '\r' },
    { ...BASE_INPUT, stdin: '\x03', kill: true },
    { ...BASE_INPUT, command: 'git status', kill: true },
  ])('fails closed for conflicting active modes', (input) => {
    expect(() => createShellCapabilityAction(input, 'wtest')).toThrow(
      /mutually exclusive/,
    );
  });
});

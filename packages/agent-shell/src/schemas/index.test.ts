import { describe, expect, it } from 'vitest';
import { asSchema } from 'ai';
import {
  executeShellCommandToolInputSchema,
  hasActiveShellStdin,
} from './index';

const BASE_INPUT = {
  explanation: 'Use shell',
  session_id: 'session-1',
};

describe('executeShellCommandToolInputSchema action modes', () => {
  it('tells the model to omit command for stdin and kill calls', () => {
    const description =
      executeShellCommandToolInputSchema.shape.command.description ?? '';

    expect(description).toContain('empty string to poll');
    expect(description).toContain(
      'Omit this field entirely when sending `stdin` or using `kill: true`',
    );
  });

  it('keeps the omission rule in the JSON schema advertised to providers', async () => {
    const jsonSchema = (await asSchema(executeShellCommandToolInputSchema)
      .jsonSchema) as {
      properties?: Record<string, { description?: string }>;
    };
    const commandDescription =
      jsonSchema.properties?.command?.description ?? '';
    const stdinDescription = jsonSchema.properties?.stdin?.description ?? '';

    expect(commandDescription).toContain('empty string to poll');
    expect(commandDescription).toContain(
      'Omit this field entirely when sending `stdin` or using `kill: true`',
    );
    expect(stdinDescription).toContain(
      'Omit `command` and `kill` entirely, including empty or false placeholders',
    );
  });

  it.each([
    ['command', { ...BASE_INPUT, command: 'git status' }],
    ['poll', { ...BASE_INPUT, command: '' }],
    ['stdin', { ...BASE_INPUT, stdin: '\r' }],
    ['kill', { ...BASE_INPUT, kill: true }],
  ] as const)('accepts one unambiguous %s mode', (_mode, input) => {
    expect(executeShellCommandToolInputSchema.safeParse(input).success).toBe(
      true,
    );
  });

  it.each([
    ['command', { ...BASE_INPUT, command: 'git status', stdin: '' }],
    ['implicit poll', { ...BASE_INPUT, stdin: '' }],
    ['explicit poll', { ...BASE_INPUT, command: '', stdin: '' }],
    ['kill', { ...BASE_INPUT, kill: true, stdin: '' }],
  ] as const)('treats empty stdin as inactive in %s mode', (_mode, input) => {
    expect(executeShellCommandToolInputSchema.safeParse(input).success).toBe(
      true,
    );
  });

  it('distinguishes empty placeholders from active stdin bytes', () => {
    expect(hasActiveShellStdin(undefined)).toBe(false);
    expect(hasActiveShellStdin('')).toBe(false);
    expect(hasActiveShellStdin('\r')).toBe(true);
    expect(hasActiveShellStdin('\x03')).toBe(true);
  });

  it('rejects command plus stdin instead of silently choosing an effect', () => {
    const result = executeShellCommandToolInputSchema.safeParse({
      ...BASE_INPUT,
      command: 'printf stale',
      stdin: '\r',
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected ambiguous input to fail');
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['stdin'],
          message: expect.stringContaining(
            'For stdin use { explanation, session_id, stdin } and omit command and kill',
          ),
        }),
      ]),
    );
  });

  it('rejects every other active-mode collision with corrective guidance', () => {
    const stdinAndKill = executeShellCommandToolInputSchema.safeParse({
      ...BASE_INPUT,
      stdin: '\x03',
      kill: true,
    });
    const commandAndKill = executeShellCommandToolInputSchema.safeParse({
      ...BASE_INPUT,
      command: 'git status',
      kill: true,
    });

    expect(stdinAndKill.success).toBe(false);
    expect(commandAndKill.success).toBe(false);
    if (stdinAndKill.success || commandAndKill.success) {
      throw new Error('Expected ambiguous inputs to fail');
    }
    expect(stdinAndKill.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['stdin'],
          message: expect.stringContaining('Choose exactly one action mode'),
        }),
      ]),
    );
    expect(commandAndKill.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['kill'],
          message: expect.stringContaining(
            'For kill use { explanation, session_id, kill: true }',
          ),
        }),
      ]),
    );
  });
});

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CliUsageError,
  DEFAULT_CLI_MODEL,
  formatCliHelp,
  parseCliArgs,
} from './cli-args.js';

const ROOT = path.resolve('/tmp/clodex-cli-args');

describe('parseCliArgs', () => {
  it('uses explicit pure defaults and joins the positional prompt', () => {
    expect(
      parseCliArgs(['create', 'hello.txt'], {
        currentWorkingDirectory: ROOT,
      }),
    ).toEqual({
      kind: 'run',
      cwd: ROOT,
      modelId: DEFAULT_CLI_MODEL,
      prompt: 'create hello.txt',
    });

    expect(
      parseCliArgs(['inspect'], {
        currentWorkingDirectory: ROOT,
        environmentModelId: '  model:env  ',
      }),
    ).toMatchObject({ modelId: 'model:env' });
  });

  it('supports separate and inline cwd/model options without process cwd drift', () => {
    expect(
      parseCliArgs(
        ['--cwd', 'workspace', '--model=model:one', 'run', 'checks'],
        { currentWorkingDirectory: ROOT },
      ),
    ).toEqual({
      kind: 'run',
      cwd: path.join(ROOT, 'workspace'),
      modelId: 'model:one',
      prompt: 'run checks',
    });

    expect(
      parseCliArgs(['--cwd=../repo', '--model', 'model:two', 'summarize'], {
        currentWorkingDirectory: ROOT,
      }),
    ).toMatchObject({
      cwd: path.resolve(ROOT, '../repo'),
      modelId: 'model:two',
    });
  });

  it('uses the option terminator for prompts that start with a dash', () => {
    expect(
      parseCliArgs(['--', '--literal', '-h'], {
        currentWorkingDirectory: ROOT,
      }),
    ).toMatchObject({ prompt: '--literal -h' });
  });

  it('returns help without requiring a prompt', () => {
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['-h'])).toEqual({ kind: 'help' });
    expect(formatCliHelp()).toContain('ANTHROPIC_API_KEY Required');
  });

  it.each([
    { argv: [] as string[], message: 'Missing prompt.' },
    { argv: ['--cwd'], message: '--cwd requires a non-empty value.' },
    { argv: ['--cwd='], message: '--cwd requires a non-empty value.' },
    {
      argv: ['--model', '--cwd=/tmp', 'prompt'],
      message: '--model requires a non-empty value.',
    },
    { argv: ['--model=   ', 'prompt'], message: '--model requires' },
    { argv: ['--unknown', 'prompt'], message: 'Unknown option' },
  ])('rejects ambiguous or incomplete input: $argv', ({ argv, message }) => {
    expect(() =>
      parseCliArgs(argv, { currentWorkingDirectory: ROOT }),
    ).toThrowError(CliUsageError);
    expect(() => parseCliArgs(argv, { currentWorkingDirectory: ROOT })).toThrow(
      message,
    );
  });
});

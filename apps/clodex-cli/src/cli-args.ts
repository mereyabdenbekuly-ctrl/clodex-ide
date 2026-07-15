import path from 'node:path';

export const DEFAULT_CLI_MODEL = 'claude-sonnet-4.6';

export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export type CliInvocation =
  | { readonly kind: 'help' }
  | {
      readonly kind: 'run';
      readonly cwd: string;
      readonly modelId: string;
      readonly prompt: string;
    };

export interface ParseCliArgsOptions {
  readonly currentWorkingDirectory?: string;
  readonly environmentModelId?: string;
}

export function parseCliArgs(
  argv: readonly string[],
  options: ParseCliArgsOptions = {},
): CliInvocation {
  const currentWorkingDirectory = path.resolve(
    options.currentWorkingDirectory ?? process.cwd(),
  );
  let cwd = currentWorkingDirectory;
  let modelId = normalizedModelId(options.environmentModelId);
  const promptParts: string[] = [];
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (positionalOnly) {
      promptParts.push(argument);
      continue;
    }
    if (argument === '--') {
      positionalOnly = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      return Object.freeze({ kind: 'help' });
    }
    if (argument === '--cwd') {
      const value = requireSeparateOptionValue(argv, index, '--cwd');
      cwd = path.resolve(currentWorkingDirectory, value);
      index += 1;
      continue;
    }
    if (argument.startsWith('--cwd=')) {
      cwd = path.resolve(
        currentWorkingDirectory,
        requireInlineOptionValue(argument, '--cwd'),
      );
      continue;
    }
    if (argument === '--model') {
      modelId = requireSeparateOptionValue(argv, index, '--model').trim();
      index += 1;
      continue;
    }
    if (argument.startsWith('--model=')) {
      modelId = requireInlineOptionValue(argument, '--model').trim();
      continue;
    }
    if (argument.startsWith('-')) {
      throw new CliUsageError(`Unknown option: ${argument}`);
    }
    promptParts.push(argument);
  }

  const prompt = promptParts.join(' ').trim();
  if (prompt.length === 0) {
    throw new CliUsageError('Missing prompt.');
  }

  return Object.freeze({ kind: 'run', cwd, modelId, prompt });
}

export function formatCliHelp(): string {
  return `clodex-cli — minimal headless agent (Anthropic)

Usage:
  clodex-cli [--cwd <dir>] [--model <id>] <prompt>

Environment:
  ANTHROPIC_API_KEY Required
  CLODEX_CLI_MODEL Optional default model id (${DEFAULT_CLI_MODEL})`;
}

function normalizedModelId(value: string | undefined): string {
  const normalized = value?.trim() ?? '';
  return normalized.length === 0 ? DEFAULT_CLI_MODEL : normalized;
}

function requireSeparateOptionValue(
  argv: readonly string[],
  optionIndex: number,
  optionName: string,
): string {
  const value = argv[optionIndex + 1];
  if (
    value === undefined ||
    value.trim().length === 0 ||
    value === '--' ||
    value === '-h' ||
    value.startsWith('--')
  ) {
    throw new CliUsageError(`${optionName} requires a non-empty value.`);
  }
  return value;
}

function requireInlineOptionValue(
  argument: string,
  optionName: string,
): string {
  const value = argument.slice(optionName.length + 1);
  if (value.trim().length === 0) {
    throw new CliUsageError(`${optionName} requires a non-empty value.`);
  }
  return value;
}

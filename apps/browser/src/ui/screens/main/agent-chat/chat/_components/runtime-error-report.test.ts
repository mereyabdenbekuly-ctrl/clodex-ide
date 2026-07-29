import { describe, expect, it } from 'vitest';
import {
  formatRuntimeErrorReport,
  MAX_RUNTIME_ERROR_DIAGNOSTICS,
  MAX_RUNTIME_ERROR_DIAGNOSTIC_CHARS,
} from './runtime-error-report';

const TESTER_DIAGNOSTIC =
  'Recoverable tool call rejection (invalid-input): Schema validation failed for "executeShellCommand". The call was not executed because command, stdin, and kill are mutually exclusive action modes. For stdin, omit command and kill; for a command or kill, omit stdin.';

describe('formatRuntimeErrorReport', () => {
  it('preserves the existing generic error report without diagnostics', () => {
    expect(
      formatRuntimeErrorReport({
        code: 500,
        message: 'Provider failed',
        stack: 'at provider:1:1',
      }),
    ).toBe(
      'Error (Code: 500): Provider failed\n\nStack trace:\nat provider:1:1',
    );
  });

  it('includes trusted rejected-call diagnostics in the copied report', () => {
    const report = formatRuntimeErrorReport({
      message:
        'Automatic tool-call recovery stopped after 2 attempts in this user turn.',
      recoveryDiagnostics: [TESTER_DIAGNOSTIC, TESTER_DIAGNOSTIC],
    });

    expect(report).toContain(
      'Error: Automatic tool-call recovery stopped after 2 attempts',
    );
    expect(report).toContain('Rejected tool calls (not executed):');
    expect(report).toContain('Rejected tool call 1:');
    expect(report).toContain('Rejected tool call 2:');
    expect(report).toContain(TESTER_DIAGNOSTIC);
  });

  it('bounds diagnostic count and size defensively', () => {
    const recoveryDiagnostics = Array.from(
      { length: MAX_RUNTIME_ERROR_DIAGNOSTICS + 3 },
      (_, index) =>
        `${index}:${'x'.repeat(MAX_RUNTIME_ERROR_DIAGNOSTIC_CHARS)}`,
    );
    const report = formatRuntimeErrorReport({
      message: 'Automatic recovery exhausted',
      recoveryDiagnostics,
    });

    expect(report).not.toContain('Rejected tool call 7:');
    expect(report).not.toContain('0:');
    expect(report).toContain('3:');
    expect(report).toContain('[diagnostic truncated]');
  });
});

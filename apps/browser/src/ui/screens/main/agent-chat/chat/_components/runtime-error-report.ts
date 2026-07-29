const DIAGNOSTIC_TRUNCATION_SUFFIX = '\n...[diagnostic truncated]';

export const MAX_RUNTIME_ERROR_DIAGNOSTICS = 6;
export const MAX_RUNTIME_ERROR_DIAGNOSTIC_CHARS = 2_000;

type RuntimeErrorReportInput = {
  readonly code?: number;
  readonly message: string;
  readonly stack?: string;
  readonly recoveryDiagnostics?: readonly string[];
};

function boundDiagnostic(value: string): string {
  if (value.length <= MAX_RUNTIME_ERROR_DIAGNOSTIC_CHARS) return value;

  const retainedChars = Math.max(
    0,
    MAX_RUNTIME_ERROR_DIAGNOSTIC_CHARS - DIAGNOSTIC_TRUNCATION_SUFFIX.length,
  );
  return `${value.slice(0, retainedChars)}${DIAGNOSTIC_TRUNCATION_SUFFIX}`;
}

/** Formats a copyable report from trusted runtime-error state only. */
export function formatRuntimeErrorReport(
  error: RuntimeErrorReportInput,
): string {
  const codeSuffix = error.code === undefined ? '' : ` (Code: ${error.code})`;
  const stackSuffix = error.stack ? `\n\nStack trace:\n${error.stack}` : '';
  const baseReport = `Error${codeSuffix}: ${error.message}${stackSuffix}`;

  const diagnostics = (error.recoveryDiagnostics ?? [])
    .slice(-MAX_RUNTIME_ERROR_DIAGNOSTICS)
    .map((diagnostic) => boundDiagnostic(diagnostic.trim()))
    .filter((diagnostic) => diagnostic.length > 0);
  if (diagnostics.length === 0) return baseReport;

  const diagnosticReport = diagnostics
    .map(
      (diagnostic, index) => `Rejected tool call ${index + 1}:\n${diagnostic}`,
    )
    .join('\n\n');

  return `${baseReport}\n\nRejected tool calls (not executed):\n\n${diagnosticReport}`;
}

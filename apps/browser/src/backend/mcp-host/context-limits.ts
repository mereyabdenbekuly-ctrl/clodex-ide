export const MAX_MCP_CONTEXT_RESULT_BYTES = 4 * 1024 * 1024;

export function assertBoundedMcpContextResult(
  value: unknown,
  label: string,
): void {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf-8') > MAX_MCP_CONTEXT_RESULT_BYTES) {
    throw new Error(
      `${label} exceeds the ${MAX_MCP_CONTEXT_RESULT_BYTES} byte limit`,
    );
  }
}

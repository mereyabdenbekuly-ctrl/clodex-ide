import { randomUUID } from 'node:crypto';
import type {
  RemoteRunnerJobSnapshot,
  RemoteRunnerJobState,
} from '@clodex/agent-shell';

const JOB_ID_PATTERN = /^job-[a-f0-9]{32}$/;
const MAX_CHUNK_BYTES = 64 * 1024;
const LONG_POLL_INTERVAL_MS = 100;
const MAX_LONG_POLL_MS = 5_000;

export function createRemoteRunnerJobId(): string {
  return `job-${randomUUID().replaceAll('-', '')}`;
}

export function buildRemoteJobStartScript(input: {
  jobId: string;
  workspacePath: string;
  cwdRelative: string;
  command: string;
  timeoutMs: number;
  waitMs?: number;
}): string {
  assertJobId(input.jobId);
  assertSafeRelativePath(input.cwdRelative);
  const job = `/tmp/clodex-runner-jobs/${input.jobId}`;
  const cwd = input.cwdRelative
    ? `${input.workspacePath}/${input.cwdRelative}`
    : input.workspacePath;
  const timeoutSeconds = Math.max(1, Math.ceil(input.timeoutMs / 1_000));
  const waitMs = normalizeWaitMs(input.waitMs);
  const commandScript = [
    '#!/bin/sh',
    'set -u',
    `cd -- ${shellQuote(cwd)}`,
    `exec sh -c ${shellQuote(input.command)}`,
    '',
  ].join('\n');
  const wrapperScript = [
    '#!/bin/sh',
    'set +e',
    remoteNowMsFunction(),
    'command_started_at_ms="$(clodex_now_ms)"',
    `printf '%s\\n' "$command_started_at_ms" > ${shellQuote(`${job}/command-started-at-ms.tmp`)}`,
    `mv ${shellQuote(`${job}/command-started-at-ms.tmp`)} ${shellQuote(`${job}/command-started-at-ms`)}`,
    `sh ${shellQuote(`${job}/command.sh`)}`,
    'code=$?',
    'command_finished_at_ms="$(clodex_now_ms)"',
    `if mkdir ${shellQuote(`${job}/finalized`)} 2>/dev/null; then`,
    `  printf '%s\\n' "$code" > ${shellQuote(`${job}/exit-code.tmp`)}`,
    `  mv ${shellQuote(`${job}/exit-code.tmp`)} ${shellQuote(`${job}/exit-code`)}`,
    `  printf '%s\\n' "$command_finished_at_ms" > ${shellQuote(`${job}/command-finished-at-ms.tmp`)}`,
    `  mv ${shellQuote(`${job}/command-finished-at-ms.tmp`)} ${shellQuote(`${job}/command-finished-at-ms`)}`,
    `  if [ "$code" -eq 0 ]; then state=completed; else state=failed; fi`,
    `  printf '%s\\n' "$state" > ${shellQuote(`${job}/state.tmp`)}`,
    `  mv ${shellQuote(`${job}/state.tmp`)} ${shellQuote(`${job}/state`)}`,
    'fi',
    '',
  ].join('\n');
  return [
    'set -eu',
    remoteNowMsFunction(),
    'command -v setsid >/dev/null 2>&1',
    'command -v base64 >/dev/null 2>&1',
    `job=${shellQuote(job)}`,
    'mkdir -p /tmp/clodex-runner-jobs',
    'test ! -e "$job"',
    'mkdir -m 700 "$job"',
    `printf '%s' ${shellQuote(commandScript)} > "$job/command.sh"`,
    `printf '%s' ${shellQuote(wrapperScript)} > "$job/wrapper.sh"`,
    'chmod 700 "$job/command.sh" "$job/wrapper.sh"',
    'printf \'running\\n\' > "$job/state"',
    'setsid sh "$job/wrapper.sh" >"$job/stdout" 2>"$job/stderr" < /dev/null &',
    'pid=$!',
    'printf \'%s\\n\' "$pid" > "$job/pid"',
    `( sleep ${timeoutSeconds}; if [ "$(cat "$job/state" 2>/dev/null || true)" = running ]; then kill -TERM "-$pid" 2>/dev/null || true; sleep 2; kill -KILL "-$pid" 2>/dev/null || true; if mkdir "$job/finalized" 2>/dev/null; then command_finished_at_ms="$(clodex_now_ms)"; printf '124\\n' > "$job/exit-code.tmp"; mv "$job/exit-code.tmp" "$job/exit-code"; printf '%s\\n' "$command_finished_at_ms" > "$job/command-finished-at-ms.tmp"; mv "$job/command-finished-at-ms.tmp" "$job/command-finished-at-ms"; printf 'timed-out\\n' > "$job/state.tmp"; mv "$job/state.tmp" "$job/state"; fi; fi ) >/dev/null 2>&1 &`,
    ...(waitMs > 0
      ? buildRemoteJobSnapshotLines({
          jobId: input.jobId,
          stdoutOffset: 0,
          stderrOffset: 0,
          waitMs,
        })
      : [`printf 'CLODEX_JOB_ID=%s\\n' ${shellQuote(input.jobId)}`]),
  ].join('\n');
}

export function buildRemoteJobReadScript(input: {
  jobId: string;
  stdoutOffset: number;
  stderrOffset: number;
  waitMs?: number;
}): string {
  assertJobId(input.jobId);
  assertOffset(input.stdoutOffset);
  assertOffset(input.stderrOffset);
  const job = `/tmp/clodex-runner-jobs/${input.jobId}`;
  return [
    'set -eu',
    remoteNowMsFunction(),
    `job=${shellQuote(job)}`,
    ...buildRemoteJobSnapshotLines(input),
  ].join('\n');
}

export function buildRemoteJobCancelScript(jobId: string): string {
  assertJobId(jobId);
  const job = `/tmp/clodex-runner-jobs/${jobId}`;
  return [
    'set -eu',
    remoteNowMsFunction(),
    `job=${shellQuote(job)}`,
    'test -d "$job"',
    'state="$(cat "$job/state" 2>/dev/null || printf running)"',
    'if [ "$state" = running ]; then pid="$(cat "$job/pid")"; kill -TERM "-$pid" 2>/dev/null || true; sleep 1; kill -KILL "-$pid" 2>/dev/null || true; if mkdir "$job/finalized" 2>/dev/null; then command_finished_at_ms="$(clodex_now_ms)"; printf \'130\\n\' > "$job/exit-code.tmp"; mv "$job/exit-code.tmp" "$job/exit-code"; printf \'%s\\n\' "$command_finished_at_ms" > "$job/command-finished-at-ms.tmp"; mv "$job/command-finished-at-ms.tmp" "$job/command-finished-at-ms"; printf \'cancelled\\n\' > "$job/state.tmp"; mv "$job/state.tmp" "$job/state"; fi; fi',
  ].join('\n');
}

export function buildRemoteJobCancelAndReadScript(input: {
  jobId: string;
  stdoutOffset: number;
  stderrOffset: number;
}): string {
  return [
    buildRemoteJobCancelScript(input.jobId),
    buildRemoteJobReadScript(input),
  ].join('\n');
}

export function buildRemoteJobCleanupScript(jobIds: readonly string[]): string {
  for (const jobId of jobIds) assertJobId(jobId);
  if (jobIds.length === 0) return 'true';
  return jobIds
    .map((jobId) => {
      const job = `/tmp/clodex-runner-jobs/${jobId}`;
      return `if [ -d ${shellQuote(job)} ]; then state="$(cat ${shellQuote(`${job}/state`)} 2>/dev/null || printf running)"; pid="$(cat ${shellQuote(`${job}/pid`)} 2>/dev/null || true)"; if [ "$state" = running ] && [ -n "$pid" ]; then kill -TERM "-$pid" 2>/dev/null || true; kill -KILL "-$pid" 2>/dev/null || true; fi; rm -rf -- ${shellQuote(job)}; fi`;
    })
    .join('; ');
}

function buildRemoteJobSnapshotLines(input: {
  jobId: string;
  stdoutOffset: number;
  stderrOffset: number;
  waitMs?: number;
}): string[] {
  const waitAttempts = Math.ceil(
    normalizeWaitMs(input.waitMs) / LONG_POLL_INTERVAL_MS,
  );
  return [
    'test -d "$job"',
    `wait_attempts=${waitAttempts}`,
    'while [ "$wait_attempts" -gt 0 ]; do state="$(cat "$job/state" 2>/dev/null || printf running)"; [ "$state" != running ] && break; sleep 0.1; wait_attempts=$((wait_attempts - 1)); done',
    'state="$(cat "$job/state" 2>/dev/null || printf running)"',
    `stdout_size="$(wc -c < "$job/stdout" 2>/dev/null || printf 0)"`,
    `stderr_size="$(wc -c < "$job/stderr" 2>/dev/null || printf 0)"`,
    `stdout_offset=${input.stdoutOffset}`,
    `stderr_offset=${input.stderrOffset}`,
    `stdout_next=$((stdout_offset + ${MAX_CHUNK_BYTES})); if [ "$stdout_next" -gt "$stdout_size" ]; then stdout_next="$stdout_size"; fi`,
    `stderr_next=$((stderr_offset + ${MAX_CHUNK_BYTES})); if [ "$stderr_next" -gt "$stderr_size" ]; then stderr_next="$stderr_size"; fi`,
    'stdout_count=$((stdout_next - stdout_offset))',
    'stderr_count=$((stderr_next - stderr_offset))',
    'if [ "$stdout_count" -gt 0 ]; then stdout_data="$(dd if="$job/stdout" bs=1 skip="$stdout_offset" count="$stdout_count" 2>/dev/null | base64 | tr -d \'\\n\')"; else stdout_data=""; fi',
    'if [ "$stderr_count" -gt 0 ]; then stderr_data="$(dd if="$job/stderr" bs=1 skip="$stderr_offset" count="$stderr_count" 2>/dev/null | base64 | tr -d \'\\n\')"; else stderr_data=""; fi',
    'if [ "$stdout_next" -eq "$stdout_size" ]; then stdout_complete=1; else stdout_complete=0; fi',
    'if [ "$stderr_next" -eq "$stderr_size" ]; then stderr_complete=1; else stderr_complete=0; fi',
    'exit_code="$(cat "$job/exit-code" 2>/dev/null || true)"',
    'command_started_at_ms="$(cat "$job/command-started-at-ms" 2>/dev/null || true)"',
    'command_finished_at_ms="$(cat "$job/command-finished-at-ms" 2>/dev/null || true)"',
    'command_duration_ms=""; case "$command_started_at_ms" in ""|*[!0-9]*) ;; *) case "$command_finished_at_ms" in ""|*[!0-9]*) ;; *) if [ "$command_finished_at_ms" -ge "$command_started_at_ms" ]; then command_duration_ms=$((command_finished_at_ms - command_started_at_ms)); fi ;; esac ;; esac',
    `printf 'CLODEX_JOB_ID=%s\\n' ${shellQuote(input.jobId)}`,
    'printf \'CLODEX_JOB_STATE=%s\\n\' "$state"',
    'printf \'CLODEX_STDOUT_OFFSET=%s\\n\' "$stdout_next"',
    'printf \'CLODEX_STDERR_OFFSET=%s\\n\' "$stderr_next"',
    'printf \'CLODEX_STDOUT_BASE64=%s\\n\' "$stdout_data"',
    'printf \'CLODEX_STDERR_BASE64=%s\\n\' "$stderr_data"',
    'printf \'CLODEX_STDOUT_COMPLETE=%s\\n\' "$stdout_complete"',
    'printf \'CLODEX_STDERR_COMPLETE=%s\\n\' "$stderr_complete"',
    'printf \'CLODEX_COMMAND_DURATION_MS=%s\\n\' "$command_duration_ms"',
    'printf \'CLODEX_EXIT_CODE=%s\\n\' "$exit_code"',
  ];
}

export function parseRemoteJobSnapshot(
  stdout: string,
): RemoteRunnerJobSnapshot {
  const markers = parseMarkers(stdout);
  const jobId = markers.get('CLODEX_JOB_ID')?.trim() ?? '';
  assertJobId(jobId);
  const state = markers.get('CLODEX_JOB_STATE')?.trim();
  if (!isRemoteJobState(state)) {
    throw new Error('Remote runner returned an invalid job state');
  }
  const stdoutOffset = parseOffset(markers.get('CLODEX_STDOUT_OFFSET'));
  const stderrOffset = parseOffset(markers.get('CLODEX_STDERR_OFFSET'));
  const exitCodeValue = markers.get('CLODEX_EXIT_CODE')?.trim() ?? '';
  const exitCode = exitCodeValue ? Number(exitCodeValue) : null;
  if (
    exitCode !== null &&
    (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255)
  ) {
    throw new Error('Remote runner returned an invalid exit code');
  }
  return {
    jobId,
    state,
    stdout: decodeBase64(markers.get('CLODEX_STDOUT_BASE64')),
    stderr: decodeBase64(markers.get('CLODEX_STDERR_BASE64')),
    stdoutOffset,
    stderrOffset,
    exitCode,
    commandDurationMs: parseOptionalDuration(
      markers.get('CLODEX_COMMAND_DURATION_MS'),
    ),
    stdoutComplete: parseCompletionMarker(
      markers.get('CLODEX_STDOUT_COMPLETE'),
    ),
    stderrComplete: parseCompletionMarker(
      markers.get('CLODEX_STDERR_COMPLETE'),
    ),
  };
}

export function parseRemoteJobId(stdout: string): string {
  const jobId = parseMarkers(stdout).get('CLODEX_JOB_ID')?.trim() ?? '';
  assertJobId(jobId);
  return jobId;
}

function parseMarkers(stdout: string): Map<string, string> {
  return new Map(
    stdout
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return separator < 0
          ? null
          : ([line.slice(0, separator), line.slice(separator + 1)] as const);
      })
      .filter((entry): entry is readonly [string, string] => entry !== null),
  );
}

function decodeBase64(value: string | undefined): string {
  if (!value) return '';
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('Remote runner returned invalid base64 output');
  }
  return Buffer.from(value, 'base64').toString('utf8');
}

function parseOffset(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Remote runner returned an invalid output offset');
  }
  return parsed;
}

function parseOptionalDuration(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Remote runner returned an invalid command duration');
  }
  return parsed;
}

function parseCompletionMarker(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error('Remote runner returned an invalid output completion marker');
}

function assertOffset(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Remote runner output offset is invalid');
  }
}

function normalizeWaitMs(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Remote runner long-poll duration is invalid');
  }
  return Math.min(MAX_LONG_POLL_MS, value);
}

function assertJobId(jobId: string): void {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error('Remote runner job id is invalid');
  }
}

function assertSafeRelativePath(value: string): void {
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    containsControlCharacter(normalized) ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error('Remote runner cwd escaped its workspace');
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isRemoteJobState(
  value: string | undefined,
): value is RemoteRunnerJobState {
  return (
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'timed-out'
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function remoteNowMsFunction(): string {
  return 'clodex_now_ms() { value="$(date +%s%3N 2>/dev/null || true)"; case "$value" in ""|*[!0-9]*) printf \'%s000\\n\' "$(date +%s)" ;; *) printf \'%s\\n\' "$value" ;; esac; }';
}

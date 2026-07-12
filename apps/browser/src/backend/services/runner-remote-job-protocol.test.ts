import { describe, expect, it } from 'vitest';
import {
  buildRemoteJobCancelAndReadScript,
  buildRemoteJobCancelScript,
  buildRemoteJobReadScript,
  buildRemoteJobStartScript,
  parseRemoteJobSnapshot,
} from './runner-remote-job-protocol';

const JOB_ID = `job-${'a'.repeat(32)}`;

describe('remote runner job protocol', () => {
  it('builds process-group lifecycle scripts without interpolating raw commands', () => {
    const script = buildRemoteJobStartScript({
      jobId: JOB_ID,
      workspacePath: "/tmp/workspace's",
      cwdRelative: 'packages/app',
      command: 'printf \'%s\\n\' "hello"; sleep 1',
      timeoutMs: 12_500,
      waitMs: 1_000,
    });

    expect(script).toContain('setsid sh "$job/wrapper.sh"');
    expect(script).toContain('kill -TERM "-$pid"');
    expect(script).toContain("printf 'timed-out\\n'");
    expect(script).toContain('sleep 13');
    expect(script).toContain('command-started-at-ms');
    expect(script).toContain('wait_attempts=10');
    expect(script).toContain("'\\''");
  });

  it('reads bounded output by byte offset and parses terminal state', () => {
    const script = buildRemoteJobReadScript({
      jobId: JOB_ID,
      stdoutOffset: 128,
      stderrOffset: 64,
    });
    expect(script).toContain('skip="$stdout_offset"');
    expect(script).toContain('count="$stdout_count"');
    expect(script).toContain('base64');

    expect(
      parseRemoteJobSnapshot(
        [
          `CLODEX_JOB_ID=${JOB_ID}`,
          'CLODEX_JOB_STATE=timed-out',
          'CLODEX_STDOUT_OFFSET=134',
          'CLODEX_STDERR_OFFSET=71',
          `CLODEX_STDOUT_BASE64=${Buffer.from('hello\n').toString('base64')}`,
          `CLODEX_STDERR_BASE64=${Buffer.from('timeout').toString('base64')}`,
          'CLODEX_STDOUT_COMPLETE=1',
          'CLODEX_STDERR_COMPLETE=1',
          'CLODEX_COMMAND_DURATION_MS=1250',
          'CLODEX_EXIT_CODE=124',
          '',
        ].join('\n'),
      ),
    ).toEqual({
      jobId: JOB_ID,
      state: 'timed-out',
      stdout: 'hello\n',
      stderr: 'timeout',
      stdoutOffset: 134,
      stderrOffset: 71,
      exitCode: 124,
      commandDurationMs: 1250,
      stdoutComplete: true,
      stderrComplete: true,
    });
  });

  it('builds idempotent cancellation around the process group finalizer', () => {
    const script = buildRemoteJobCancelScript(JOB_ID);
    expect(script).toContain('kill -TERM "-$pid"');
    expect(script).toContain('kill -KILL "-$pid"');
    expect(script).toContain('mkdir "$job/finalized"');
    expect(script).toContain("printf 'cancelled\\n'");
    expect(script).toContain('command-finished-at-ms');
    expect(
      buildRemoteJobCancelAndReadScript({
        jobId: JOB_ID,
        stdoutOffset: 4,
        stderrOffset: 2,
      }),
    ).toContain('CLODEX_STDOUT_OFFSET');
  });
});

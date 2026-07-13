import { describe, expect, it, vi } from 'vitest';
import { CloudTaskExecutionLeaseRegistry } from '../../agent-host/cloud-task-execution-lease';
import {
  createCloudTaskRuntime,
  parseCloudTaskResidency,
  type CloudTaskRuntimeInput,
} from './cloud-task-runtime';

function createInput(overrides: Partial<CloudTaskRuntimeInput> = {}) {
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
  };
  const audit = vi.fn();
  const input: CloudTaskRuntimeInput = {
    logger,
    baseUrl: 'https://cloud.example.test',
    residency: undefined,
    killSwitchActive: false,
    artifactRootDirectory: '/tmp/clodex-cloud-task-runtime-test/artifacts',
    resumeRootDirectory: '/tmp/clodex-cloud-task-runtime-test/resume',
    memorySyncJournalFilePath:
      '/tmp/clodex-cloud-task-runtime-test/memory-sync-journal.json',
    getAccountAccessToken: () => undefined,
    isFeatureEnabled: () => true,
    leaseRegistry: new CloudTaskExecutionLeaseRegistry(),
    leaseHolderId: 'desktop:test',
    resolveMounts: () => [],
    isProtectedFile: () => Promise.resolve(false),
    audit,
    evidenceMemory: undefined,
    ...overrides,
  };
  return { audit, input, logger };
}

describe('parseCloudTaskResidency', () => {
  it.each([
    [undefined, 'us'],
    ['', 'us'],
    ['  ', 'us'],
    ['us', 'us'],
    [' US ', 'us'],
    ['unknown', 'us'],
    [' EU ', 'eu'],
    ['ApAc', 'apac'],
  ] as const)('normalizes %s to %s', (value, expected) => {
    expect(parseCloudTaskResidency(value)).toBe(expected);
  });
});

describe('createCloudTaskRuntime fail-closed behavior', () => {
  it('short-circuits on the emergency kill switch before URL validation', () => {
    const { input, logger } = createInput({
      baseUrl: 'http://cloud.example.test',
      killSwitchActive: true,
    });

    expect(createCloudTaskRuntime(input)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      '[CloudTasks] Emergency kill switch is active; production adapter remains fail closed',
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    '   ',
  ])('fails closed when the base URL is not configured (%s)', (baseUrl) => {
    const { input, logger } = createInput({ baseUrl });

    expect(createCloudTaskRuntime(input)).toBeNull();
    expect(logger.debug).toHaveBeenCalledWith(
      '[CloudTasks] Production control plane is not configured; adapter remains fail closed',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('catches invalid control-plane configuration and remains fail closed', () => {
    const { input, logger } = createInput({
      baseUrl: 'http://cloud.example.test',
    });

    expect(createCloudTaskRuntime(input)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      '[CloudTasks] Invalid production control-plane configuration; adapter remains fail closed: cloud task base URL must use authenticated HTTPS',
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });
});

describe('createCloudTaskRuntime configuration', () => {
  it('uses normalized residency and preserves the audit callback', () => {
    const { audit, input, logger } = createInput({ residency: ' EU ' });

    const runtime = createCloudTaskRuntime(input);

    expect(runtime).not.toBeNull();
    if (!runtime) {
      throw new Error('Expected the cloud task runtime to be configured');
    }
    expect(runtime.residency).toBe('eu');
    expect(runtime.audit).toBe(audit);
    expect(logger.debug).toHaveBeenCalledWith(
      '[CloudTasks] Production control plane configured for eu residency',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

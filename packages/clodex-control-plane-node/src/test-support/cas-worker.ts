import { setTimeout as sleep } from 'node:timers/promises';
import { parseCanonicalJson } from '@clodex/contracts';
import type { ControlPlaneStorageMutation } from '@clodex/control-plane';
import { PosixControlPlaneStore } from '../posix-control-plane-store.js';

interface WorkerInput {
  readonly baseDirectory: string;
  readonly mutation: ControlPlaneStorageMutation;
  readonly holdAfterLockMs: number;
}

async function main(): Promise<void> {
  const encoded = process.env.CLODEX_CONTROL_PLANE_NODE_WORKER_INPUT;
  if (encoded === undefined) throw new Error('Worker input is missing');
  const input = parseCanonicalJson(encoded) as unknown as WorkerInput;
  const store = new PosixControlPlaneStore({
    baseDirectory: input.baseDirectory,
    lockAcquisitionTimeoutMs: 5_000,
    lockRetryDelayMs: 2,
    async faultInjector(point) {
      if (point === 'after-lock-acquired' && input.holdAfterLockMs > 0) {
        await sleep(input.holdAfterLockMs);
      }
    },
  });
  const result = await store.compareAndSwap(input.mutation);
  process.stdout.write(JSON.stringify(result));
}

await main();

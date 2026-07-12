import {
  P256RunnerSigningAuthority,
  type RunnerSigningAuthority,
} from '@clodex/agent-shell';
import { z } from 'zod';
import type { Logger } from '@/services/logger';
import { readPersistedData, writePersistedData } from '@/utils/persisted-data';

const STORAGE_NAME = 'docker-runner-signing-identity' as const;
const STORAGE_OPTIONS = {
  encrypt: true,
  requireEncryption: true,
} as const;

const storedDockerRunnerIdentitySchema = z
  .object({
    version: z.literal(1),
    privateKeyPem: z.string().min(1),
    publicKey: z.string().min(16),
  })
  .strict()
  .nullable();

export async function createDockerRunnerAuthority(
  logger: Logger,
): Promise<RunnerSigningAuthority> {
  let stored = await readPersistedData(
    STORAGE_NAME,
    storedDockerRunnerIdentitySchema,
    null,
    STORAGE_OPTIONS,
  );
  if (stored === null) {
    const generated = P256RunnerSigningAuthority.generate();
    stored = {
      version: 1,
      privateKeyPem: generated.privateKeyPem,
      publicKey: generated.publicKey,
    };
    await writePersistedData(
      STORAGE_NAME,
      storedDockerRunnerIdentitySchema,
      stored,
      STORAGE_OPTIONS,
    );
    logger.debug('[DockerRunner] Generated protected P-256 receipt identity');
  }
  const authority = new P256RunnerSigningAuthority(stored);
  logger.debug(`[DockerRunner] Receipt identity ready (${authority.keyId})`);
  return authority;
}

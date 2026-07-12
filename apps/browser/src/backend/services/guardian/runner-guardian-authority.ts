import {
  P256RunnerSigningAuthority,
  type RunnerSigningAuthority,
} from '@clodex/agent-shell';
import { z } from 'zod';
import type { Logger } from '@/services/logger';
import { readPersistedData, writePersistedData } from '@/utils/persisted-data';

const STORAGE_NAME = 'runner-signing-identity' as const;
const STORAGE_OPTIONS = {
  encrypt: true,
  requireEncryption: true,
} as const;

const storedRunnerIdentitySchema = z
  .object({
    version: z.literal(1),
    privateKeyPem: z.string().min(1),
    publicKey: z.string().min(16),
  })
  .strict()
  .nullable();

export async function createRunnerGuardianAuthority(
  logger: Logger,
): Promise<RunnerSigningAuthority> {
  let stored = await readPersistedData(
    STORAGE_NAME,
    storedRunnerIdentitySchema,
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
      storedRunnerIdentitySchema,
      stored,
      STORAGE_OPTIONS,
    );
    logger.debug('[RunnerGuardian] Generated protected P-256 signing identity');
  }
  const authority = new P256RunnerSigningAuthority(stored);
  logger.debug(`[RunnerGuardian] Signing identity ready (${authority.keyId})`);
  return authority;
}

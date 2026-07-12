import {
  P256RunnerSigningAuthority,
  type RunnerSigningAuthority,
} from '@clodex/agent-shell';
import { z } from 'zod';
import type { Logger } from '@/services/logger';
import { readPersistedData, writePersistedData } from '@/utils/persisted-data';

const STORAGE_NAME = 'ssh-runner-signing-identity' as const;
const STORAGE_OPTIONS = {
  encrypt: true,
  requireEncryption: true,
} as const;

const storedSshRunnerIdentitySchema = z
  .object({
    version: z.literal(1),
    privateKeyPem: z.string().min(1),
    publicKey: z.string().min(16),
  })
  .strict()
  .nullable();

/**
 * Receipt identity for the local SSH runner proxy. This is intentionally
 * separate from the Guardian job-signing key. Remote hardware attestation is
 * out of scope for SSH Runner v1.
 */
export async function createSshRunnerAuthority(
  logger: Logger,
): Promise<RunnerSigningAuthority> {
  let stored = await readPersistedData(
    STORAGE_NAME,
    storedSshRunnerIdentitySchema,
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
      storedSshRunnerIdentitySchema,
      stored,
      STORAGE_OPTIONS,
    );
    logger.debug('[SshRunner] Generated protected P-256 receipt identity');
  }
  const authority = new P256RunnerSigningAuthority(stored);
  logger.debug(`[SshRunner] Receipt identity ready (${authority.keyId})`);
  return authority;
}

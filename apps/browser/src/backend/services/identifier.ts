/**
 * Identifier service
 *
 * Returns a unique identifier of the machine.
 */

import type { Logger } from './logger';
import { DisposableService } from './disposable';
import { z } from 'zod';
import { readPersistedData, writePersistedData } from '@/utils/persisted-data';

const identitySchema = z.object({
  machineId: z.string().uuid(),
});

export class IdentifierService extends DisposableService {
  private readonly logger: Logger;
  private machineId: string | null = null;

  private constructor(logger: Logger) {
    super();
    this.logger = logger;
  }

  private async initialize(): Promise<void> {
    const data = await readPersistedData(
      'identity',
      identitySchema,
      null as unknown as z.infer<typeof identitySchema>,
    );

    if (data?.machineId) {
      this.machineId = data.machineId;
    } else {
      this.logger.debug(
        '[IdentifierService] No identifier file found. Creating a new one...',
      );
      this.machineId = crypto.randomUUID();
      await writePersistedData('identity', identitySchema, {
        machineId: this.machineId,
      });
    }
  }

  public static async create(logger: Logger): Promise<IdentifierService> {
    const instance = new IdentifierService(logger);
    await instance.initialize();
    return instance;
  }

  public getMachineId(): string {
    if (!this.machineId) {
      this.logger.error(
        "[IdentifierService] Machine ID not found. This shouldn't happen.",
      );
      throw new Error("Machine ID not found. This shouldn't happen.");
    }
    return this.machineId;
  }

  protected onTeardown(): void {
    this.machineId = null;
    this.logger.debug('[IdentifierService] Teardown complete');
  }
}

export const P1_PROTECTED_MIGRATION_ORDER = [
  'attachments',
  'chronicle',
  'shell-logs',
  'memory',
  'diff-history-blobs',
  'caches',
  'titles/search',
] as const;

export type P1ProtectedMigrationStage =
  (typeof P1_PROTECTED_MIGRATION_ORDER)[number];

export class P1ProtectedMigrationOrder {
  private nextIndex = 0;

  public async run<T>(
    stage: P1ProtectedMigrationStage,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.mark(stage);
    return operation();
  }

  public mark(stage: P1ProtectedMigrationStage): void {
    const expected = P1_PROTECTED_MIGRATION_ORDER[this.nextIndex];
    if (stage !== expected) {
      throw new Error(
        `Protected migration order violation: expected ${expected ?? 'completion'}, received ${stage}`,
      );
    }
    this.nextIndex++;
  }

  public assertComplete(): void {
    if (this.nextIndex !== P1_PROTECTED_MIGRATION_ORDER.length) {
      throw new Error(
        `Protected migration sequence is incomplete: expected ${P1_PROTECTED_MIGRATION_ORDER[this.nextIndex]}`,
      );
    }
  }
}

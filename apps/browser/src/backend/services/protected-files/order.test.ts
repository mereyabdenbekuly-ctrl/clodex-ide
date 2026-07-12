import { describe, expect, it } from 'vitest';
import {
  P1_PROTECTED_MIGRATION_ORDER,
  P1ProtectedMigrationOrder,
} from './order';

describe('P1 protected migration order', () => {
  it('accepts only the immutable complete sequence', () => {
    const order = new P1ProtectedMigrationOrder();
    for (const stage of P1_PROTECTED_MIGRATION_ORDER) order.mark(stage);
    expect(() => order.assertComplete()).not.toThrow();
  });

  it('rejects skipped, reordered, and incomplete stages', () => {
    const reordered = new P1ProtectedMigrationOrder();
    expect(() => reordered.mark('chronicle')).toThrow('expected attachments');

    const incomplete = new P1ProtectedMigrationOrder();
    incomplete.mark('attachments');
    expect(() => incomplete.assertComplete()).toThrow('expected chronicle');
  });
});

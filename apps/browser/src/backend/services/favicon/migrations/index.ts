import type { MigrationScript } from '@clodex/agent-core/migrate-database';

const registry: MigrationScript[] = [];
const schemaVersion = 1;

export { registry, schemaVersion };

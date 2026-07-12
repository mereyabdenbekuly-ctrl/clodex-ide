import type { MigrationScript } from '../../../migrate-database';
import { up as v002Up } from './v002-add-claims';
import { up as v003Up } from './v003-add-code-fingerprints';
import { up as v004Up } from './v004-add-deterministic-ingestion-and-fts';
import { up as v005Up } from './v005-add-relation-automation-provenance';

const registry: MigrationScript[] = [
  { version: 2, name: 'add-claims', up: v002Up },
  { version: 3, name: 'add-code-fingerprints', up: v003Up },
  {
    version: 4,
    name: 'add-deterministic-ingestion-and-fts',
    up: v004Up,
  },
  {
    version: 5,
    name: 'add-relation-automation-provenance',
    up: v005Up,
  },
];
const schemaVersion = 5;

export { registry, schemaVersion };

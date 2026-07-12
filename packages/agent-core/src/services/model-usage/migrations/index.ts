import type { MigrationScript } from '../../../migrate-database';
import { up as v002Up } from './v002-add-route-decisions';
import { up as v003Up } from './v003-add-active-routing';
import { up as v004Up } from './v004-add-budget-events';
import { up as v005Up } from './v005-add-provider-quota-windows';

export const registry: MigrationScript[] = [
  { version: 2, name: 'add-route-decisions', up: v002Up },
  { version: 3, name: 'add-active-routing', up: v003Up },
  { version: 4, name: 'add-budget-events', up: v004Up },
  { version: 5, name: 'add-provider-quota-windows', up: v005Up },
];

export const schemaVersion = 5;

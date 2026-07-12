/**
 * Compatibility shim. The canonical skill types now live in
 * `@clodex/agent-core/types`. This re-export preserves the
 * `@shared/skills` import path used throughout `apps/browser`.
 */
export type {
  SkillSource,
  SkillDefinition,
  SkillDefinitionUI,
} from '@clodex/agent-core/types';
export { toSkillDefinitionUI } from '@clodex/agent-core/types';

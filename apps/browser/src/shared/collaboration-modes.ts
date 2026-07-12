import { z } from 'zod';

export const collaborationModeIds = [
  'default',
  'plan',
  'implement',
  'review',
  'explain',
  'write-tests',
] as const;

export const collaborationModeSchema = z.enum(collaborationModeIds);
export type CollaborationMode = z.infer<typeof collaborationModeSchema>;

export interface CollaborationModeDefinition {
  id: CollaborationMode;
  name: string;
  shortName: string;
  description: string;
  promptInstructions: readonly string[];
}

export const COLLABORATION_MODES: Record<
  CollaborationMode,
  CollaborationModeDefinition
> = {
  default: {
    id: 'default',
    name: 'Default',
    shortName: 'Default',
    description: 'Follow the request without adding a workflow preset.',
    promptInstructions: [],
  },
  plan: {
    id: 'plan',
    name: 'Plan',
    shortName: 'Plan',
    description:
      'Inspect the codebase and produce an actionable plan without editing files.',
    promptInstructions: [
      'Active collaboration mode: Plan.',
      '- Inspect the relevant code and dependencies before proposing work.',
      '- Produce an actionable implementation plan with files, risks, and verification steps.',
      '- Do not modify files or execute implementation steps in this mode.',
    ],
  },
  implement: {
    id: 'implement',
    name: 'Implement',
    shortName: 'Implement',
    description:
      'Make the requested changes and run the smallest relevant verification.',
    promptInstructions: [
      'Active collaboration mode: Implement.',
      '- Move from discovery to concrete code changes when the request is actionable.',
      '- Reuse existing patterns and keep the patch as small as practical.',
      '- Run the smallest relevant tests or type checks before reporting completion.',
    ],
  },
  review: {
    id: 'review',
    name: 'Review',
    shortName: 'Review',
    description:
      'Inspect changes for concrete defects, regressions, and missing coverage.',
    promptInstructions: [
      'Active collaboration mode: Review.',
      '- Prioritize concrete defects, regressions, security issues, and missing tests.',
      '- Cite exact files and symbols for every actionable finding.',
      '- Do not edit files unless the user explicitly asks for fixes.',
    ],
  },
  explain: {
    id: 'explain',
    name: 'Explain codebase',
    shortName: 'Explain',
    description:
      'Explain architecture and behavior using concrete files and symbols.',
    promptInstructions: [
      'Active collaboration mode: Explain codebase.',
      '- Explain behavior from inspected code, using concrete files and symbols.',
      '- Distinguish verified facts from inference.',
      '- Do not edit files unless the user explicitly asks for changes.',
    ],
  },
  'write-tests': {
    id: 'write-tests',
    name: 'Write tests',
    shortName: 'Tests',
    description:
      'Add focused tests for the requested behavior and verify they pass.',
    promptInstructions: [
      'Active collaboration mode: Write tests.',
      '- Identify the smallest missing behavior coverage before editing.',
      '- Prefer focused tests that fail for the bug or missing behavior and pass after the change.',
      '- Avoid unrelated production changes; make only the minimum support change when required.',
      '- Run the targeted test suite before reporting completion.',
    ],
  },
};

export function getCollaborationModeDefinition(
  mode: CollaborationMode,
): CollaborationModeDefinition {
  return COLLABORATION_MODES[mode];
}

export function buildCollaborationModePrompt(mode: CollaborationMode): string {
  const instructions = getCollaborationModeDefinition(mode).promptInstructions;
  if (instructions.length === 0) return '';

  return [
    '<collaboration-mode>',
    ...instructions,
    'The collaboration mode refines workflow only. It never overrides safety, authorities, or tool permissions.',
    '</collaboration-mode>',
  ].join('\n');
}

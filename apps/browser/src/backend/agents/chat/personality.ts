import type { AgentPersonality } from '@shared/karton-contracts/ui/shared-types';
import {
  buildCollaborationModePrompt,
  type CollaborationMode,
} from '@shared/collaboration-modes';
import browserSoulPrompt from './prompts/soul.md?raw';

const PERSONALITY_INSTRUCTIONS: Record<AgentPersonality, readonly string[]> = {
  pragmatic: [
    'Active personality: Pragmatic.',
    '- Be direct, factual, concise, and execution-oriented.',
    '- Optimize for clarity, rigor, and useful next actions.',
    '- Surface material risks without softening the technical conclusion.',
  ],
  friendly: [
    'Active personality: Friendly.',
    '- Optimize for empathy, collaboration, and team morale without sacrificing correctness.',
    '- Use a warm, encouraging tone and acknowledge meaningful progress when useful, but avoid empty praise.',
    '- Explain corrections respectfully and pair critique with a concrete next step.',
  ],
};

export function buildBrowserSoulPrompt(
  personality: AgentPersonality,
  collaborationMode: CollaborationMode = 'default',
): string {
  const collaborationModePrompt =
    buildCollaborationModePrompt(collaborationMode);

  return [
    browserSoulPrompt.trim(),
    '',
    '<personality>',
    ...PERSONALITY_INSTRUCTIONS[personality],
    'Personality changes communication style only. It never overrides safety, authorities, tool permissions, or user instructions.',
    '</personality>',
    collaborationModePrompt ? `\n${collaborationModePrompt}` : '',
  ].join('\n');
}

import { z } from 'zod';
import type { ApiClient } from '@clodex/api-client';

/**
 * Lightweight chat metadata for the chat history list.
 * Does not include messages - those are loaded on demand.
 */
export type ChatSummary = {
  id: string;
  /** Discriminator: 'browser' for web-content tabs, 'terminal' for PTY tabs, 'file' for workspace file previews. */
  type?: 'browser' | 'terminal' | 'file';
  title: string;
  createdAt: Date;
  updatedAt: Date;
};

export const recentlyOpenedWorkspaceSchema = z.object({
  path: z.string(),
  name: z.string(),
  openedAt: z.number(),
});

export const recentlyOpenedWorkspacesArraySchema = z.array(
  recentlyOpenedWorkspaceSchema,
);

/** Schema for onboarding state persisted data */
export const onboardingStateSchema = z.object({
  hasSeenOnboardingFlow: z.boolean(),
});

export type OnboardingState = z.infer<typeof onboardingStateSchema>;

/** Schema for tutorial state persisted data */
export const tutorialStateSchema = z.record(z.string(), z.number());

export type TutorialState = z.infer<typeof tutorialStateSchema>;

export const lastViewedChatsSchema = z.record(z.string(), z.number());

export const experienceSurveySchema = z.object({
  dismissedAt: z.number().nullable(),
  dismissedCount: z.number(),
  answered: z.boolean(),
  answeredAt: z.number().nullable(),
});

export type ExperienceSurvey = z.infer<typeof experienceSurveySchema>;

export const founderCallSurveySchema = z.object({
  dismissedAt: z.number().nullable(),
  dismissedCount: z.number(),
  answered: z.boolean(),
  answeredAt: z.number().nullable(),
});

export type FounderCallSurvey = z.infer<typeof founderCallSurveySchema>;

export const storedExperienceDataSchema = z.object({
  recentlyOpenedWorkspaces: recentlyOpenedWorkspacesArraySchema,
  hasSeenOnboardingFlow: z.boolean().nullable(),
  lastViewedChats: lastViewedChatsSchema,
  tutorialState: tutorialStateSchema,
  experienceSurvey: experienceSurveySchema,
  firstUsedAt: z.number().nullable(),
  founderCallSurvey: founderCallSurveySchema,
  totalAgentCount: z.number(),
});

export type StoredExperienceData = z.infer<typeof storedExperienceDataSchema>;

export type RecentlyOpenedWorkspace = z.infer<
  typeof recentlyOpenedWorkspaceSchema
>;

export type ColorScheme = 'system' | 'light' | 'dark';

export type InspirationWebsite = NonNullable<
  Awaited<ReturnType<ApiClient['v1']['inspiration']['get']>>['data']
>;

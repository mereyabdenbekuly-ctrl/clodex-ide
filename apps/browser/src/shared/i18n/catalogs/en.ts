import { commonAuthEn } from './common-auth.en';
import { onboardingEn } from './onboarding.en';
import { taskEn } from './task.en';

export const enCatalog = {
  common: {
    ...commonAuthEn,
    language: {
      system: 'System',
      english: 'English',
      russianBeta: 'Русский (beta)',
    },
    itemCount_one: '{{count}} item',
    itemCount_few: '{{count}} items',
    itemCount_many: '{{count}} items',
    itemCount_other: '{{count}} items',
  },
  settings: {
    telemetry: {
      title: 'Telemetry',
      standardDescription:
        'Control what usage data is collected to help improve CLODEx.',
      anonymousLabel: 'Help improve CLODEx by sharing anonymized events.',
      fullLabel: 'Share identifiable chat and usage data with CLODEx.',
      observedDescription:
        'Control the anonymous product statistics choice made during first-run setup.',
      observedLabel: 'Send anonymous product usage metrics.',
      observedPrivacyNote:
        'Uses a pseudonymous installation ID. Never includes prompts, messages, source code, tool arguments, commands, file paths, URLs, API keys, credentials, error text, or session recordings.',
      saveError: 'Could not save the telemetry setting. Please try again.',
    },
    personalization: {
      eyebrow: 'Experience',
      title: 'Personalization',
      description:
        'Tune the visual language, interface scale, notifications, and agent communication style.',
      language: {
        sectionTitle: 'Language',
        sectionDescription: 'Choose the language used by the CLODEx interface.',
        title: 'Interface language',
        description:
          'Russian is an opt-in beta. English remains the fallback for untranslated text.',
        saveError: 'Failed to save interface language',
      },
    },
  },
  onboarding: onboardingEn,
  task: taskEn,
} as const;

export type CatalogShape<T> = T extends string
  ? string
  : { readonly [Key in keyof T]: CatalogShape<T[Key]> };

export type AppCatalog = CatalogShape<typeof enCatalog>;

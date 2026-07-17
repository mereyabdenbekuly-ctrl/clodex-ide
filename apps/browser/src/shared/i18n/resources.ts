import { enCatalog, type AppCatalog } from './catalogs/en';
import { ruCatalog } from './catalogs/ru';

export const I18N_NAMESPACES = [
  'common',
  'settings',
  'onboarding',
  'task',
] as const;
export const DEFAULT_I18N_NAMESPACE = 'common' as const;

export const I18N_RESOURCES = {
  en: enCatalog,
  ru: ruCatalog,
} as const satisfies Record<'en' | 'ru', AppCatalog>;

export type AppI18nResources = (typeof I18N_RESOURCES)['en'];

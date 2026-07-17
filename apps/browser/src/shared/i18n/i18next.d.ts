import 'i18next';
import type { AppI18nResources, DEFAULT_I18N_NAMESPACE } from './resources';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof DEFAULT_I18N_NAMESPACE;
    resources: AppI18nResources;
    returnNull: false;
  }
}

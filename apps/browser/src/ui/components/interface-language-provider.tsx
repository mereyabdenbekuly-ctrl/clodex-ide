import {
  appI18n,
  readSystemLocales,
  resolveInterfaceLocale,
  syncHtmlLanguage,
} from '@shared/i18n';
import { useKartonState } from '@ui/hooks/use-karton';
import { type ReactNode, useEffect, useState } from 'react';
import { I18nextProvider } from 'react-i18next';

export function InterfaceLanguageProvider({
  children,
}: {
  children?: ReactNode;
}) {
  const interfaceLanguage = useKartonState(
    (state) => state.preferences.general.interfaceLanguage,
  );
  const [systemLocales, setSystemLocales] = useState(readSystemLocales);
  const locale = resolveInterfaceLocale(interfaceLanguage, systemLocales);

  useEffect(() => {
    if (interfaceLanguage !== 'system') return;

    const handleLanguageChange = () => setSystemLocales(readSystemLocales());
    handleLanguageChange();
    window.addEventListener('languagechange', handleLanguageChange);
    return () =>
      window.removeEventListener('languagechange', handleLanguageChange);
  }, [interfaceLanguage]);

  useEffect(() => {
    syncHtmlLanguage(locale);
    if (appI18n.resolvedLanguage !== locale) {
      void appI18n.changeLanguage(locale);
    }
  }, [locale]);

  return <I18nextProvider i18n={appI18n}>{children}</I18nextProvider>;
}

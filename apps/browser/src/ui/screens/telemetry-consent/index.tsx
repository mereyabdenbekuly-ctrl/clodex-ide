import { useEffect, useRef, useState } from 'react';
import { BarChart3Icon, ShieldCheckIcon } from 'lucide-react';
import { Button } from '@clodex/stage-ui/components/button';
import { Select } from '@clodex/stage-ui/components/select';
import { Logo } from '@ui/components/ui/logo';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { useTranslation } from 'react-i18next';
import {
  createCommunityObservedTelemetryConsentPatches,
  type CommunityObservedTelemetryChoice,
} from './model';
import { COMMUNITY_OBSERVED_TELEMETRY_CONSENT_UI_ASSERTION } from '@shared/community-observed-telemetry-consent';
import { isInterfaceLanguage, type InterfaceLanguage } from '@shared/i18n';

type ConsentChoice = CommunityObservedTelemetryChoice;

export function TelemetryConsentScreen() {
  const { t } = useTranslation('onboarding');
  const { t: tCommon } = useTranslation('common');
  const preferences = useKartonState((state) => state.preferences);
  const updatePreferences = useKartonProcedure(
    (procedures) => procedures.preferences.update,
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const savingRef = useRef(false);
  const [pendingChoice, setPendingChoice] = useState<ConsentChoice | null>(
    null,
  );
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const languageItems: Array<{ value: InterfaceLanguage; label: string }> = [
    { value: 'system', label: tCommon('language.system') },
    { value: 'en', label: tCommon('language.english') },
    { value: 'ru', label: tCommon('language.russianBeta') },
  ];

  const changeLanguage = async (value: unknown) => {
    if (
      !isInterfaceLanguage(value) ||
      value === preferences.general.interfaceLanguage
    ) {
      return;
    }
    try {
      await updatePreferences([
        {
          op: 'replace',
          path: ['general', 'interfaceLanguage'],
          value,
        },
      ]);
    } catch {
      setSaveError(true);
    }
  };

  const saveChoice = async (choice: ConsentChoice) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setPendingChoice(choice);
    setSaveError(false);

    try {
      await updatePreferences(
        createCommunityObservedTelemetryConsentPatches(choice),
      );
    } catch {
      savingRef.current = false;
      setSaveError(true);
      setPendingChoice(null);
    }
  };

  return (
    <div className="app-drag fixed inset-0 flex min-h-0 flex-col bg-background">
      <div className="h-10 shrink-0" aria-hidden="true" />
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-5 py-8 sm:px-8">
        <section
          aria-labelledby="telemetry-consent-title"
          aria-describedby="telemetry-consent-description"
          aria-busy={pendingChoice !== null}
          data-community-observed-consent-contract={
            COMMUNITY_OBSERVED_TELEMETRY_CONSENT_UI_ASSERTION
          }
          className="app-no-drag w-full max-w-2xl overflow-hidden rounded-3xl border border-clodex-green-400/20 bg-token-bg-primary shadow-2xl shadow-black/30"
        >
          <div className="border-token-border-light border-b bg-clodex-green-400/5 px-6 py-6 sm:px-8 sm:py-8">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex size-11 items-center justify-center rounded-2xl border border-clodex-green-400/25 bg-clodex-green-400/10 text-clodex-green-400">
                  <BarChart3Icon className="size-5" aria-hidden="true" />
                </span>
                <Logo className="size-9" />
              </div>
              <Select
                value={preferences.general.interfaceLanguage}
                onValueChange={(value) => void changeLanguage(value)}
                items={languageItems}
                triggerVariant="secondary"
                size="xs"
                triggerClassName="w-auto min-w-32 rounded-lg"
                side="bottom"
                align="end"
              />
            </div>
            <h1
              id="telemetry-consent-title"
              ref={headingRef}
              tabIndex={-1}
              className="font-semibold text-2xl text-token-text-primary outline-none sm:text-3xl"
            >
              {t('telemetryConsent.title')}
            </h1>
            <p
              id="telemetry-consent-description"
              className="mt-3 max-w-xl text-sm text-token-text-secondary leading-6"
            >
              {t('telemetryConsent.description')}
            </p>
          </div>

          <div className="grid gap-4 px-6 py-6 sm:grid-cols-2 sm:px-8">
            <div className="rounded-2xl border border-token-border-light bg-token-bg-secondary/55 p-4">
              <div className="flex items-center gap-2 text-token-text-primary">
                <BarChart3Icon
                  className="size-4 text-clodex-green-400"
                  aria-hidden="true"
                />
                <h2 className="font-medium text-sm">
                  {t('telemetryConsent.sharedTitle')}
                </h2>
              </div>
              <p className="mt-2 text-token-text-secondary text-xs leading-5">
                {t('telemetryConsent.sharedDescription')}
              </p>
            </div>

            <div className="rounded-2xl border border-token-border-light bg-token-bg-secondary/55 p-4">
              <div className="flex items-center gap-2 text-token-text-primary">
                <ShieldCheckIcon
                  className="size-4 text-clodex-green-400"
                  aria-hidden="true"
                />
                <h2 className="font-medium text-sm">
                  {t('telemetryConsent.privateTitle')}
                </h2>
              </div>
              <p className="mt-2 text-token-text-secondary text-xs leading-5">
                {t('telemetryConsent.privateDescription')}
              </p>
            </div>
          </div>

          <div className="px-6 pb-6 sm:px-8 sm:pb-8">
            <p className="rounded-xl border border-clodex-green-400/15 bg-clodex-green-400/5 px-4 py-3 text-token-text-secondary text-xs leading-5">
              {t('telemetryConsent.safeguards')}
            </p>

            <div className="mt-6 flex flex-col gap-3 sm:flex-row-reverse">
              <Button
                type="button"
                variant="primary"
                size="lg"
                className="w-full rounded-xl sm:flex-1"
                disabled={pendingChoice !== null}
                onClick={() => void saveChoice('allow')}
              >
                {t('telemetryConsent.allow')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="w-full rounded-xl sm:flex-1"
                disabled={pendingChoice !== null}
                onClick={() => void saveChoice('decline')}
              >
                {t('telemetryConsent.decline')}
              </Button>
            </div>

            <p className="mt-4 text-center text-token-text-tertiary text-xs">
              {t('telemetryConsent.settingsNote')}
            </p>
            <p
              role="alert"
              aria-live="assertive"
              className="mt-2 min-h-5 text-center text-error-foreground text-xs"
            >
              {saveError ? t('telemetryConsent.saveError') : ''}
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}

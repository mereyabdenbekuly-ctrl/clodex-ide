import { cn } from '@clodex/stage-ui/lib/utils';
import type { SocialAuthProvider } from '@shared/karton-contracts/ui/shared-types';
import clodexLogoUrl from '@ui/assets/clodex-logo.png';
import {
  ArrowUpRightIcon,
  Loader2Icon,
  LogInIcon,
  SendIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './sign-in-options-panel.css';

export type SignInMethod = SocialAuthProvider | 'email' | 'telegram';

type TrackingPrefix = 'onboarding-auth' | 'account-auth' | 'chat-auth';
type TrackEvent = (
  eventName: string,
  properties?: Record<string, unknown>,
) => void | Promise<void>;

type AuthAction = 'login' | 'telegram';

const CLODEX_HOME_URL = (
  import.meta.env.VITE_CLODEX_ORIGIN || 'https://clodex.xyz'
).replace(/\/+$/, '');
const CLODEX_REGISTER_URL = `${CLODEX_HOME_URL}/sign-up`;
// Fail closed until the production desktop handoff binds every authorization
// response to the initiating app instance with state + PKCE S256. Keep this
// renderer guard in addition to the backend guard so the UI never advertises
// the legacy callback as secure or opens it accidentally.
const SECURE_BROWSER_HANDOFF_AVAILABLE = false;

// This component is shared by both Electron renderer hosts: the main UI
// preload exposes `window.electron`, while internal pages expose
// `window.clodexPagesApi`. Keep host-bound services injected through props
// and avoid importing Karton/telemetry hooks here.
export type SignInOptionsPanelProps = {
  title?: string;
  description?: string;
  variant?: 'centered' | 'section';
  sendOtp: (
    email: string,
    turnstileToken?: string,
  ) => Promise<{ error?: string }>;
  verifyOtp: (email: string, code: string) => Promise<{ error?: string }>;
  signInSocial: (provider: SocialAuthProvider) => Promise<{ error?: string }>;
  signInEmail: () => Promise<{ error?: string }>;
  signInTelegram: () => Promise<{ error?: string }>;
  onUseApiKeys: () => void;
  onUseSubscription: () => void;
  trackingPrefix: TrackingPrefix;
  track: TrackEvent;
  openExternalUrl?: (url: string) => void | Promise<void>;
  onAuthenticated?: (method: SignInMethod) => void;
  className?: string;
};

export function SignInOptionsPanel({
  title,
  description,
  variant = 'centered',
  signInEmail,
  signInTelegram,
  trackingPrefix,
  track,
  openExternalUrl,
  onAuthenticated,
  className,
}: SignInOptionsPanelProps) {
  const { t, i18n } = useTranslation('common');
  const [activeAction, setActiveAction] = useState<AuthAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const panelTitle = title ?? t('auth.signIn.defaultTitle');
  const panelDescription = description ?? t('auth.signIn.defaultDescription');
  const browserHandoffDisabledMessage = t(
    'auth.signIn.browserHandoffDisabledMessage',
  );
  const isCentered = variant === 'centered';
  const isLoading = activeAction !== null;

  const openUrl = useCallback(
    (url: string) => {
      if (openExternalUrl) {
        void openExternalUrl(url);
        return;
      }

      window.open(url, '_blank', 'noopener,noreferrer');
    },
    [openExternalUrl],
  );

  const handleClodexHandoff = useCallback(
    async (action: AuthAction) => {
      if (isLoading) return;

      if (action === 'login' && !SECURE_BROWSER_HANDOFF_AVAILABLE) {
        setError(null);
        return;
      }

      setError(null);
      setActiveAction(action);
      void track(`${trackingPrefix}-clodex-login-requested`, { action });

      try {
        // Credentials are intentionally never collected in the renderer.
        // The injected action opens CLODEx.xyz in the system browser and waits
        // for the registered desktop callback.
        const result =
          action === 'telegram' ? await signInTelegram() : await signInEmail();
        if (result?.error) {
          void track(`${trackingPrefix}-method-failed`, {
            auth_method: 'clodex',
            provider: action,
            error_kind: 'backend-error',
          });
          setError(result.error);
          return;
        }

        void track(`${trackingPrefix}-clodex-login-verified`, { action });
        onAuthenticated?.(action === 'telegram' ? 'telegram' : 'email');
      } catch {
        void track(`${trackingPrefix}-method-failed`, {
          auth_method: 'clodex',
          provider: action,
          error_kind: 'network-error',
        });
        setError(t('auth.signIn.genericFailure'));
      } finally {
        setActiveAction(null);
      }
    },
    [
      isLoading,
      onAuthenticated,
      signInEmail,
      signInTelegram,
      track,
      trackingPrefix,
      t,
    ],
  );

  const loginPanel = (
    <section
      className="clodex-login-panel"
      aria-label={t('auth.signIn.panelAriaLabel')}
    >
      <span className="clodex-login-panel-accent" aria-hidden="true" />

      <div className="clodex-login-panel-content">
        <div className="clodex-login-panel-intro">
          <div className="clodex-login-eyebrow">
            <span aria-hidden="true" />
            {t('auth.signIn.eyebrow')}
          </div>
          <h2>{panelTitle}</h2>
          <p className="clodex-login-description">{panelDescription}</p>
          <p className="clodex-login-switch">
            {t('auth.signIn.noAccount')}{' '}
            <button type="button" onClick={() => openUrl(CLODEX_REGISTER_URL)}>
              {t('auth.signIn.register')}
            </button>
          </p>
        </div>

        <div className="clodex-login-browser-handoff">
          <ShieldCheckIcon aria-hidden="true" />
          <div>
            <strong>{t('auth.signIn.secureHandoffTitle')}</strong>
            <span>{t('auth.signIn.secureHandoffDescription')}</span>
          </div>
        </div>

        <form
          className="clodex-login-form"
          aria-busy={isLoading}
          onSubmit={(event) => {
            event.preventDefault();
            void handleClodexHandoff('login');
          }}
        >
          <div className="clodex-login-divider">
            <span>{t('auth.signIn.chooseMethod')}</span>
          </div>

          <button
            type="button"
            className="clodex-login-provider-button"
            disabled={isLoading}
            onClick={() => void handleClodexHandoff('telegram')}
          >
            {activeAction === 'telegram' ? (
              <Loader2Icon className="clodex-login-spinner" />
            ) : (
              <SendIcon aria-hidden="true" />
            )}
            {t('auth.signIn.continueWithTelegram')}
          </button>

          <button
            type="submit"
            className="clodex-login-submit"
            disabled={isLoading || !SECURE_BROWSER_HANDOFF_AVAILABLE}
            aria-describedby="clodex-browser-handoff-status"
          >
            {activeAction === 'login' ? (
              <Loader2Icon className="clodex-login-spinner" />
            ) : (
              <LogInIcon aria-hidden="true" />
            )}
            {t('auth.signIn.browserHandoffDisabledButton')}
          </button>

          {!SECURE_BROWSER_HANDOFF_AVAILABLE && (
            <p
              id="clodex-browser-handoff-status"
              role="status"
              className="clodex-login-error"
            >
              {browserHandoffDisabledMessage}
            </p>
          )}

          {error && (
            <p
              role="alert"
              aria-live="assertive"
              aria-atomic="true"
              className="clodex-login-error"
            >
              {error}
            </p>
          )}
        </form>

        <p className="clodex-login-terms">{t('auth.signIn.terms')}</p>
      </div>
    </section>
  );

  if (!isCentered) {
    return (
      <div
        lang={i18n.resolvedLanguage ?? 'en'}
        className={cn('clodex-login-section app-no-drag', className)}
      >
        {loginPanel}
        <SecurityNote label={t('auth.signIn.unsafeCallbackBlocked')} />
      </div>
    );
  }

  return (
    <div
      lang={i18n.resolvedLanguage ?? 'en'}
      className={cn('clodex-login-shell app-no-drag', className)}
    >
      <div className="clodex-login-grid" aria-hidden="true" />
      <div className="clodex-login-glow" aria-hidden="true" />

      <header className="clodex-login-header">
        <img
          className="clodex-login-logo"
          src={clodexLogoUrl}
          alt="CLODEx"
          draggable={false}
        />
        <button
          type="button"
          className="clodex-login-home-link"
          onClick={() => openUrl(CLODEX_HOME_URL)}
        >
          <span>{t('auth.signIn.homeLink')}</span>
          <ArrowUpRightIcon aria-hidden="true" />
        </button>
      </header>

      <main className="clodex-login-layout">
        <section
          className="clodex-login-story"
          aria-label={t('auth.signIn.storyAriaLabel')}
        >
          <div className="clodex-login-story-copy">
            <div className="clodex-login-story-eyebrow">
              <span aria-hidden="true" />
              {t('auth.signIn.storyEyebrow')}
            </div>
            <h1>
              <span>{t('auth.signIn.headline.account')}</span>
              <span>{t('auth.signIn.headline.models')}</span>
              <span>{t('auth.signIn.headline.control')}</span>
            </h1>
            <p>{t('auth.signIn.storyDescription')}</p>
            <ul className="clodex-login-benefits">
              <li>
                <span aria-hidden="true">✓</span>
                {t('auth.signIn.benefits.systemBrowser')}
              </li>
              <li>
                <span aria-hidden="true">!</span>
                {t('auth.signIn.benefits.callbackClosed')}
              </li>
              <li>
                <span aria-hidden="true">✓</span>
                {t('auth.signIn.benefits.passwordNotHandled')}
              </li>
            </ul>
          </div>

          <div className="clodex-login-status-card">
            <div className="clodex-login-status-heading">
              <span>
                <i aria-hidden="true" />
                {t('auth.signIn.status.browserHandoff')}
              </span>
              <strong>clodex.xyz/login</strong>
            </div>
            <div className="clodex-login-status-tags">
              <span>{t('auth.signIn.status.systemBrowser')}</span>
              <span>{t('auth.signIn.status.ideCallback')}</span>
              <span>{t('auth.signIn.status.accountAccess')}</span>
            </div>
          </div>
        </section>

        <section className="clodex-login-form-region">
          {loginPanel}
          <SecurityNote label={t('auth.signIn.unsafeCallbackBlocked')} />
        </section>
      </main>
    </div>
  );
}

function SecurityNote({ label }: { label: string }) {
  return (
    <p className="clodex-login-security-note">
      <ShieldCheckIcon aria-hidden="true" />
      {label}
    </p>
  );
}

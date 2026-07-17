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
const BROWSER_HANDOFF_DISABLED_MESSAGE =
  'Вход через CLODEx.xyz временно отключён: серверный desktop-flow ещё не подтверждает state + PKCE. Используйте Telegram или локальные API-ключи.';

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
  title = 'С возвращением',
  description = 'Войдите в аккаунт CLODEx, чтобы управлять доступом к моделям и API.',
  variant = 'centered',
  signInEmail,
  signInTelegram,
  trackingPrefix,
  track,
  openExternalUrl,
  onAuthenticated,
  className,
}: SignInOptionsPanelProps) {
  const [activeAction, setActiveAction] = useState<AuthAction | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        setError(BROWSER_HANDOFF_DISABLED_MESSAGE);
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
        setError('Не удалось завершить вход через CLODEx. Попробуйте ещё раз.');
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
    ],
  );

  const loginPanel = (
    <section className="clodex-login-panel" aria-label="Вход в CLODEx">
      <span className="clodex-login-panel-accent" aria-hidden="true" />

      <div className="clodex-login-panel-content">
        <div className="clodex-login-panel-intro">
          <div className="clodex-login-eyebrow">
            <span aria-hidden="true" />
            Доступ к аккаунту
          </div>
          <h2>{title}</h2>
          <p className="clodex-login-description">{description}</p>
          <p className="clodex-login-switch">
            Нет аккаунта?{' '}
            <button type="button" onClick={() => openUrl(CLODEX_REGISTER_URL)}>
              Зарегистрироваться
            </button>
          </p>
        </div>

        <div className="clodex-login-browser-handoff">
          <ShieldCheckIcon aria-hidden="true" />
          <div>
            <strong>Защищённый desktop-вход готовится</strong>
            <span>
              Legacy callback отключён до обязательной проверки state и PKCE
              S256.
            </span>
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
            <span>Выберите способ входа</span>
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
            Продолжить с Telegram
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
            Вход через CLODEx.xyz временно отключён
          </button>

          {!SECURE_BROWSER_HANDOFF_AVAILABLE && (
            <p
              id="clodex-browser-handoff-status"
              role="status"
              className="clodex-login-error"
            >
              {BROWSER_HANDOFF_DISABLED_MESSAGE}
            </p>
          )}

          {error && error !== BROWSER_HANDOFF_DISABLED_MESSAGE && (
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

        <p className="clodex-login-terms">
          Продолжая, вы соглашаетесь с применимыми условиями использования и
          политикой конфиденциальности CLODEx.xyz.
        </p>
      </div>
    </section>
  );

  if (!isCentered) {
    return (
      <div
        lang="ru"
        className={cn('clodex-login-section app-no-drag', className)}
      >
        {loginPanel}
        <SecurityNote />
      </div>
    );
  }

  return (
    <div lang="ru" className={cn('clodex-login-shell app-no-drag', className)}>
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
          <span>На CLODEx.xyz</span>
          <ArrowUpRightIcon aria-hidden="true" />
        </button>
      </header>

      <main className="clodex-login-layout">
        <section className="clodex-login-story" aria-label="О CLODEx">
          <div className="clodex-login-story-copy">
            <div className="clodex-login-story-eyebrow">
              <span aria-hidden="true" />
              CLODEx для AI-продуктов
            </div>
            <h1>
              <span>Один аккаунт.</span>
              <span>Лучшие модели.</span>
              <span>Полный контроль.</span>
            </h1>
            <p>
              Подключайте coding agents и AI-продукты через единый вход CLODEx.
            </p>
            <ul className="clodex-login-benefits">
              <li>
                <span aria-hidden="true">✓</span>
                Системный браузер без передачи пароля renderer-процессу
              </li>
              <li>
                <span aria-hidden="true">!</span>
                Desktop callback закрыт до внедрения state + PKCE S256
              </li>
              <li>
                <span aria-hidden="true">✓</span>
                Пароль не обрабатывается renderer-процессом
              </li>
            </ul>
          </div>

          <div className="clodex-login-status-card">
            <div className="clodex-login-status-heading">
              <span>
                <i aria-hidden="true" />
                Browser handoff
              </span>
              <strong>clodex.xyz/login</strong>
            </div>
            <div className="clodex-login-status-tags">
              <span>System browser</span>
              <span>IDE callback</span>
              <span>Account access</span>
            </div>
          </div>
        </section>

        <section className="clodex-login-form-region">
          {loginPanel}
          <SecurityNote />
        </section>
      </main>
    </div>
  );
}

function SecurityNote() {
  return (
    <p className="clodex-login-security-note">
      <ShieldCheckIcon aria-hidden="true" />
      Небезопасный callback заблокирован fail-closed
    </p>
  );
}

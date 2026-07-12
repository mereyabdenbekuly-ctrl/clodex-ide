import { Button } from '@clodex/stage-ui/components/button';
import { cn } from '@clodex/stage-ui/lib/utils';
import type { SocialAuthProvider } from '@shared/karton-contracts/ui/shared-types';
import {
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
  LogInIcon,
  SendIcon,
} from 'lucide-react';
import { useCallback, useState } from 'react';

export type SignInMethod = SocialAuthProvider | 'email' | 'telegram';

type TrackingPrefix = 'onboarding-auth' | 'account-auth' | 'chat-auth';
type TrackEvent = (
  eventName: string,
  properties?: Record<string, unknown>,
) => void | Promise<void>;

type AuthAction = 'login' | 'telegram';

const CLODEX_REGISTER_URL = 'https://clodex.xyz/sign-up';
const CLODEX_FORGOT_PASSWORD_URL = 'https://clodex.xyz/forgot-password';

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
  variant = 'centered',
  signInEmail,
  signInTelegram,
  trackingPrefix,
  track,
  openExternalUrl,
  onAuthenticated,
  className,
}: SignInOptionsPanelProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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

      setError(null);
      setActiveAction(action);
      void track(`${trackingPrefix}-clodex-login-requested`, { action });

      try {
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
        setError('Не удалось завершить вход через Clodex.');
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

  return (
    <div
      className={cn(
        'relative flex w-full flex-col',
        isCentered
          ? 'min-h-[min(650px,calc(100vh-7rem))] items-center justify-center px-6 text-left'
          : 'items-center',
        className,
      )}
    >
      {isCentered && (
        <div className="pointer-events-none absolute top-1 left-0 select-none font-semibold text-[11px] text-foreground/80 tracking-[0.22em]">
          CLODEX<span className="text-[#22e36f]">_</span>
        </div>
      )}

      <form
        className="app-no-drag flex w-full max-w-[37.25rem] flex-col gap-7"
        onSubmit={(event) => {
          event.preventDefault();
          void handleClodexHandoff('login');
        }}
      >
        <div className="flex flex-col gap-2">
          <h2 className="font-semibold text-2xl text-foreground tracking-normal">
            LOGIN
          </h2>
          <p className="text-base text-muted-foreground">
            У вас нет аккаунта?{' '}
            <button
              type="button"
              className="font-medium underline underline-offset-4 transition-colors hover:text-foreground"
              onClick={() => openUrl(CLODEX_REGISTER_URL)}
            >
              Регистрация
            </button>
            .
          </p>
        </div>

        <div className="flex items-center gap-3 font-medium text-muted-foreground text-sm">
          <span className="h-px flex-1 bg-border-subtle" />
          <span className="whitespace-nowrap">ИЛИ ПРОДОЛЖИТЬ С</span>
          <span className="h-px flex-1 bg-border-subtle" />
        </div>

        <Button
          type="button"
          variant="secondary"
          size="md"
          className="h-12 w-full rounded-[18px] border-white/10! bg-[#252525]! px-4 text-base text-foreground! shadow-none hover:bg-[#2d2d2d]!"
          disabled={isLoading}
          onClick={() => void handleClodexHandoff('telegram')}
        >
          {activeAction === 'telegram' ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <SendIcon className="size-4" />
          )}
          Продолжить с Telegram
        </Button>

        <div className="flex flex-col gap-2">
          <label
            htmlFor="clodex-login-username"
            className="font-semibold text-base text-foreground"
          >
            Имя пользователя или Email
          </label>
          <input
            id="clodex-login-username"
            className="h-11 w-full rounded-[18px] border border-white/10 bg-[#242424] px-4 text-base text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-white/30"
            placeholder="Введите ваше имя пользователя или адрес электронной почты"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={isLoading}
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-4">
            <label
              htmlFor="clodex-login-password"
              className="font-semibold text-base text-foreground"
            >
              Пароль
            </label>
            <button
              type="button"
              className="shrink-0 font-medium text-muted-foreground text-sm transition-colors hover:text-foreground"
              onClick={() => openUrl(CLODEX_FORGOT_PASSWORD_URL)}
            >
              Забыли пароль?
            </button>
          </div>
          <div className="relative">
            <input
              id="clodex-login-password"
              className="h-11 w-full rounded-[18px] border border-white/10 bg-[#242424] px-4 pr-12 text-base text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-white/30"
              placeholder="Введите пароль"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isLoading}
            />
            <button
              type="button"
              aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
              className="absolute inset-y-0 right-3 flex items-center text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setShowPassword((value) => !value)}
              disabled={isLoading}
            >
              {showPassword ? (
                <EyeIcon className="size-5" />
              ) : (
                <EyeOffIcon className="size-5" />
              )}
            </button>
          </div>
        </div>

        <Button
          type="submit"
          variant="primary"
          size="md"
          className="mt-2 h-12 w-full rounded-[18px] border-white/90! bg-white! text-base text-black! shadow-none hover:bg-white/90!"
          disabled={isLoading}
        >
          {activeAction === 'login' ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <LogInIcon className="size-4" />
          )}
          LOGIN
        </Button>

        {error && (
          <p
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
            className="text-error-foreground text-sm"
          >
            {error}
          </p>
        )}
      </form>
    </div>
  );
}

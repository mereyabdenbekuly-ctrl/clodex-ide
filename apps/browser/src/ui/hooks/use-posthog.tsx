import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { PostHogProvider as PostHogProviderOriginal } from 'posthog-js/react';
import posthog from 'posthog-js';
import { containsResizeObserverLoopError } from '@ui/utils/resize-observer';
import { createRendererPostHogController } from '@ui/telemetry/posthog-privacy';
import { useKartonState } from './use-karton';

const rendererPostHogController = createRendererPostHogController({
  client: posthog,
  metadata: {
    product: 'clodex-browser',
    app_name: __APP_NAME__,
    app_version: __APP_VERSION__,
    app_release_channel: __APP_RELEASE_CHANNEL__,
    app_platform: __APP_PLATFORM__,
    app_arch: __APP_ARCH__,
  },
  beforeSend: (event) => {
    if (!event || containsResizeObserverLoopError(event)) return null;
    return event;
  },
  debug: import.meta.env.NODE_ENV === 'development',
});

interface PostHogProviderProps {
  children: ReactNode;
}

/**
 * Custom PostHog provider wrapper that integrates with karton state.
 * This must be used inside KartonProvider to have access to karton state.
 */
export function PostHogProvider({ children }: PostHogProviderProps) {
  const internalData = useKartonState((s) => s.internalData);
  const userAccount = useKartonState((s) => s.userAccount);
  const telemetryLevel = useKartonState(
    (s) => s.preferences.privacy.telemetryLevel,
  );

  useEffect(() => {
    rendererPostHogController.sync({
      rendererEnabled: __APP_RENDERER_TELEMETRY_ENABLED__,
      telemetryLevel,
      disabledInDevelopment:
        import.meta.env.NODE_ENV === 'development' &&
        import.meta.env.VITE_DISABLE_TELEMETRY === 'true',
      apiKey: internalData.posthog?.apiKey,
      apiHost: internalData.posthog?.host,
      userId: userAccount?.user?.id,
    });
  }, [
    telemetryLevel,
    internalData.posthog?.apiKey,
    internalData.posthog?.host,
    userAccount?.user?.id,
  ]);

  return (
    <PostHogProviderOriginal client={posthog}>
      {children}
    </PostHogProviderOriginal>
  );
}

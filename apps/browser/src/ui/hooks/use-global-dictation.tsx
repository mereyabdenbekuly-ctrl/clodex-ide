import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import type { DictationState } from '@shared/dictation';
import type { DictationSessionDiagnostics } from '@shared/dictation-diagnostics';
import {
  getDictationMicroCommand,
  shouldMicroIndicateDictationActive,
} from '@shared/dictation-micro';
import type { DictationRuntimeSupport } from '@shared/dictation-runtime';
import { resolveFeatureGate } from '@shared/feature-gates';
import { HotkeyActions } from '@shared/hotkeys';
import { requestChatInputInsertText } from '@ui/screens/main/agent-chat/chat/_lib/chat-input-events';
import { useDictation } from './use-dictation';
import { useHotKeyListener } from './use-hotkey-listener';
import {
  useKartonConnected,
  useKartonProcedure,
  useKartonReconnectState,
  useKartonState,
} from './use-karton';
import { useOpenAgent } from './use-open-chat';

export interface GlobalDictationContextValue {
  enabled: boolean;
  visible: boolean;
  available: boolean;
  state: DictationState;
  runtimeSupport: DictationRuntimeSupport;
  lastSessionDiagnostics: DictationSessionDiagnostics | null;
  toggle: () => void;
  cancel: () => void;
}

const GlobalDictationContext =
  createContext<GlobalDictationContextValue | null>(null);

export function GlobalDictationProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const [openAgent] = useOpenAgent();
  const isConnected = useKartonConnected();
  const reconnectState = useKartonReconnectState();
  const appScreenMode = useKartonState((state) => state.appScreen.mode);
  const featureGateEnabled = useKartonState(
    (state) =>
      resolveFeatureGate(
        'global-dictation',
        state.preferences.featureGates.overrides,
        state.appInfo.releaseChannel,
      ).enabled,
  );
  const realtimeFeatureGateEnabled = useKartonState(
    (state) =>
      resolveFeatureGate(
        'realtime-dictation',
        state.preferences.featureGates.overrides,
        state.appInfo.releaseChannel,
      ).enabled,
  );
  const microControllerAvailable = useKartonState(
    (state) =>
      state.agentOs.micro.enabled &&
      resolveFeatureGate(
        'codex-micro-controller',
        state.preferences.featureGates.overrides,
        state.appInfo.releaseChannel,
      ).enabled,
  );
  const microPushToTalkActive = useKartonState(
    (state) => state.agentOs.micro.pushToTalkActive,
  );
  const activeModelId = useKartonState((state) =>
    openAgent
      ? (state.agents.instances[openAgent]?.state.activeModelId ?? undefined)
      : undefined,
  );
  const allowUserInput = useKartonState((state) =>
    openAgent
      ? (state.agents.instances[openAgent]?.allowUserInput ?? false)
      : false,
  );
  const setPushToTalkActiveProcedure = useKartonProcedure(
    (procedures) => procedures.agentOs.micro.setPushToTalkActive,
  );
  const setPushToTalkActiveRef = useRef(setPushToTalkActiveProcedure);
  setPushToTalkActiveRef.current = setPushToTalkActiveProcedure;

  const visible =
    active &&
    featureGateEnabled &&
    appScreenMode !== 'settings' &&
    openAgent !== null &&
    allowUserInput;
  const available = visible && isConnected && !reconnectState.isReconnecting;

  const insertTranscript = useCallback((transcript: string) => {
    requestChatInputInsertText(transcript);
  }, []);
  const dictation = useDictation({
    enabled: available,
    realtimeEnabled: featureGateEnabled && realtimeFeatureGateEnabled,
    preferredModelId: activeModelId,
    sessionKey: openAgent ?? undefined,
    onTranscript: insertTranscript,
  });
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;

  const previousOpenAgentRef = useRef(openAgent);
  useEffect(() => {
    if (previousOpenAgentRef.current === openAgent) return;
    previousOpenAgentRef.current = openAgent;
    dictationRef.current.cancel();
  }, [openAgent]);

  const stableToggle = useCallback(() => {
    dictationRef.current.toggle();
  }, []);
  const stableCancel = useCallback(() => {
    dictationRef.current.cancel();
  }, []);

  useHotKeyListener(stableToggle, HotkeyActions.TOGGLE_DICTATION, available);

  const previousMicroPushToTalkRef = useRef<boolean | null>(null);
  const microStartRequestedRef = useRef(false);
  const microStopRequestedRef = useRef(false);

  useEffect(() => {
    const previous = previousMicroPushToTalkRef.current;
    previousMicroPushToTalkRef.current = microPushToTalkActive;
    if (previous === null) {
      microStartRequestedRef.current = false;
      microStopRequestedRef.current = false;
      if (microPushToTalkActive) {
        void setPushToTalkActiveRef.current(false).catch(() => undefined);
      }
      return;
    }

    const current = dictationRef.current;
    const bridgeAvailable = microControllerAvailable && available;
    const command = getDictationMicroCommand({
      previousMicroActive: previous,
      microActive: microPushToTalkActive,
      bridgeAvailable,
      dictationStatus: current.state.status,
    });

    if (!bridgeAvailable) {
      microStartRequestedRef.current = false;
      microStopRequestedRef.current = false;
      if (command === 'reset-micro') {
        void setPushToTalkActiveRef.current(false).catch(() => undefined);
      }
      return;
    }
    if (command === 'start') {
      microStartRequestedRef.current = true;
      microStopRequestedRef.current = false;
      void current.start().finally(() => {
        microStartRequestedRef.current = false;
      });
      return;
    }
    if (command === 'cancel') {
      microStartRequestedRef.current = false;
      microStopRequestedRef.current = true;
      current.cancel();
    } else if (command === 'stop') {
      microStartRequestedRef.current = false;
      microStopRequestedRef.current = true;
      current.stop();
    }
  }, [available, microControllerAvailable, microPushToTalkActive]);

  useEffect(() => {
    if (!microControllerAvailable || !available) return;

    const shouldBeActive = shouldMicroIndicateDictationActive(
      dictation.state.status,
    );
    if (shouldBeActive && microStopRequestedRef.current) return;
    if (!shouldBeActive && microStartRequestedRef.current) return;

    if (!shouldBeActive) {
      microStartRequestedRef.current = false;
      microStopRequestedRef.current = false;
    }
    if (microPushToTalkActive === shouldBeActive) return;

    void setPushToTalkActiveRef.current(shouldBeActive).catch(() => undefined);
  }, [
    available,
    dictation.state.status,
    microControllerAvailable,
    microPushToTalkActive,
  ]);

  const value = useMemo<GlobalDictationContextValue>(
    () => ({
      enabled: featureGateEnabled,
      visible,
      available,
      state: dictation.state,
      runtimeSupport: dictation.runtimeSupport,
      lastSessionDiagnostics: dictation.lastSessionDiagnostics,
      toggle: stableToggle,
      cancel: stableCancel,
    }),
    [
      available,
      active,
      dictation.lastSessionDiagnostics,
      dictation.runtimeSupport,
      dictation.state,
      featureGateEnabled,
      stableCancel,
      stableToggle,
      visible,
    ],
  );

  return (
    <GlobalDictationContext.Provider value={value}>
      {children}
    </GlobalDictationContext.Provider>
  );
}

export function useGlobalDictation(): GlobalDictationContextValue {
  const context = useContext(GlobalDictationContext);
  if (!context) {
    throw new Error(
      'useGlobalDictation must be used within GlobalDictationProvider',
    );
  }
  return context;
}

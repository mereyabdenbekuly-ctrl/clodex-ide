import { useCallback, useEffect, type RefObject } from 'react';
import { useKartonProcedure, useKartonState } from '@pages/hooks/use-karton';
import {
  artifactBridgeEnvelopeSchema,
  type ArtifactBridgeResponse,
} from '@shared/artifact-bridge';

export function useIframeAppBridge({
  iframeRef,
  agentId,
  appId,
  pluginId,
  iframeLoaded,
}: {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  agentId?: string;
  appId: string;
  pluginId?: string;
  iframeLoaded: boolean;
}) {
  const forwardAppMessage = useKartonProcedure((p) => p.forwardAppMessage);
  const clearPendingAppMessage = useKartonProcedure(
    (p) => p.clearPendingAppMessage,
  );
  const invokeArtifactBridge = useKartonProcedure(
    (p) => p.artifactBridge.invoke,
  );

  const pendingAppMessage = useKartonState((s) => {
    if (!agentId) return null;
    return s.pendingAppMessagesByAgentInstanceId[agentId] ?? null;
  });

  useEffect(() => {
    if (!pendingAppMessage || !agentId || !iframeLoaded) return;
    if (
      pendingAppMessage.appId !== appId ||
      pendingAppMessage.pluginId !== pluginId
    )
      return;

    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;

    iframe.contentWindow.postMessage(pendingAppMessage.data, '*');
    void clearPendingAppMessage(agentId);
  }, [
    pendingAppMessage,
    agentId,
    appId,
    pluginId,
    iframeRef,
    iframeLoaded,
    clearPendingAppMessage,
  ]);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;
      if (event.source !== iframe.contentWindow) return;

      const bridgeEnvelope = artifactBridgeEnvelopeSchema.safeParse(event.data);
      if (bridgeEnvelope.success) {
        const request = bridgeEnvelope.data.request;
        if (!agentId) {
          iframe.contentWindow.postMessage(
            {
              __clodexArtifactBridge: 1,
              type: 'response',
              id: request.id,
              ok: false,
              error: 'Capability bridge requires an agent-owned app.',
            } satisfies ArtifactBridgeResponse,
            '*',
          );
          return;
        }
        void invokeArtifactBridge({ agentId, appId, pluginId }, request).then(
          (result) => {
            iframe.contentWindow?.postMessage(
              {
                __clodexArtifactBridge: 1,
                type: 'response',
                id: request.id,
                ok: true,
                result,
              } satisfies ArtifactBridgeResponse,
              '*',
            );
          },
          (error) => {
            iframe.contentWindow?.postMessage(
              {
                __clodexArtifactBridge: 1,
                type: 'response',
                id: request.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              } satisfies ArtifactBridgeResponse,
              '*',
            );
          },
        );
        return;
      }

      if (!agentId) return;
      void forwardAppMessage(agentId, appId, pluginId, event.data);
    },
    [
      agentId,
      appId,
      pluginId,
      iframeRef,
      forwardAppMessage,
      invokeArtifactBridge,
    ],
  );

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);
}

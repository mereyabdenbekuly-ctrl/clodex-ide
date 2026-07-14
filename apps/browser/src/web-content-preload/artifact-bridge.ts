import { contextBridge, ipcRenderer } from 'electron';
import {
  ARTIFACT_BRIDGE_FRAME_CONNECT_CHANNEL,
  artifactBridgeHelloSchema,
  type ArtifactBridgeRequest,
} from '@shared/artifact-bridge';
import { parseAppUrlIdentity } from '@shared/isolated-app-origin';
import {
  ArtifactBridgePortClient,
  type ArtifactBridgeRequestMethod,
  type ArtifactBridgeRequestParams,
} from './artifact-bridge-port-client';

export interface ClodexArtifactBridgeApi {
  request<M extends ArtifactBridgeRequestMethod>(
    method: M,
    params: ArtifactBridgeRequestParams<M>,
  ): Promise<unknown>;
}

/**
 * Installs the generated-app bridge only in an isolated app:// subframe.
 * The MessagePort and backend session binding remain in the isolated preload
 * world and are never transferred to generated app JavaScript.
 */
export function initializeArtifactBridgePreload(): void {
  if (process.isMainFrame) return;

  const parsedUrl = parseAppUrlIdentity(window.location.href);
  if (
    parsedUrl?.classification !== 'isolated' ||
    window.location.origin !== parsedUrl.origin
  ) {
    return;
  }
  const contentRevisions = new URL(window.location.href).searchParams.getAll(
    'clodexRev',
  );
  const contentRevision = contentRevisions[0];
  if (
    contentRevisions.length !== 1 ||
    !contentRevision ||
    !/^[a-f0-9]{64}$/.test(contentRevision)
  ) {
    return;
  }

  const channel = new MessageChannel();
  const client = new ArtifactBridgePortClient(channel.port1);
  const hello = artifactBridgeHelloSchema.parse({
    __clodexArtifactBridge: 2,
    type: 'hello',
    contentRevision,
  });

  const api: ClodexArtifactBridgeApi = Object.freeze({
    request: async <M extends ArtifactBridgeRequest['method']>(
      method: M,
      params: ArtifactBridgeRequestParams<M>,
    ) => await client.request(method, params),
  });

  try {
    contextBridge.exposeInMainWorld('clodexArtifactBridge', api);
    ipcRenderer.postMessage(ARTIFACT_BRIDGE_FRAME_CONNECT_CHANNEL, hello, [
      channel.port2,
    ]);
  } catch (error) {
    client.dispose(
      error instanceof Error
        ? error
        : new Error('Artifact Bridge preload initialization failed'),
    );
    return;
  }

  window.addEventListener(
    'pagehide',
    () => client.dispose(new Error('Artifact Bridge document navigated')),
    { once: true },
  );
}

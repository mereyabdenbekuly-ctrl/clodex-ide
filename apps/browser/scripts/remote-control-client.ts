import {
  createRemoteBrowserKeyPair,
  createRemoteBrowserNonce,
  createRemoteBrowserUuid,
  decryptRemoteBrowserMessage,
  deriveRemoteBrowserSessionKey,
  encryptRemoteBrowserMessage,
  getRemoteBrowserPublicKeyFingerprint,
  signRemoteBrowserPayload,
  verifyRemoteBrowserPayload,
  type RemoteBrowserKeyPair,
} from '../src/shared/remote-control-browser-crypto';
import { REMOTE_SIGNATURE_CONTEXTS } from '../src/shared/remote-control-canonical';
import type {
  RemoteControlCommand,
  RemoteControlEnvironmentAttestation,
  RemoteControlPairingRequest,
  RemoteControlPairingResponse,
  RemoteControlResponseEnvelope,
  RemoteControlSecureEnvelope,
  RemoteControlSessionHello,
  RemoteControlSessionHelloAck,
} from '../src/shared/remote-control-protocol';

const PROTOCOL_VERSION = 2 as const;
const DEVICE_DATABASE = 'clodex-remote-control';
const DEVICE_STORE = 'devices';
const ACTIVE_DEVICE_KEY = 'active';

interface StoredRemoteDevice extends RemoteBrowserKeyPair {
  deviceId: string;
  clientId: string;
  serverPublicKey: string;
}

interface BrowserRemoteSession {
  id: string;
  key: Uint8Array;
  expiresAt: number;
}

function requiredElement<ElementType extends Element>(
  selector: string,
): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Remote control UI is missing ${selector}`);
  return element;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const statusNode = requiredElement<HTMLElement>('#status');
const pairingForm = requiredElement<HTMLFormElement>('#pair');
const codeInput = requiredElement<HTMLInputElement>('#code');
const labelInput = requiredElement<HTMLInputElement>('#label');
const commandsSection = requiredElement<HTMLElement>('#commands');
const pairingHash = new URLSearchParams(location.hash.slice(1));
const pinnedServerKey = pairingHash.get('serverKey') ?? '';

codeInput.value = pairingHash.get('code') ?? '';
labelInput.value = navigator.platform || 'Mobile device';

let socket: WebSocket | null = null;
let session: BrowserRemoteSession | null = null;
let sendSequence = 0;
let receiveSequence = 0;
let socketFailure: string | null = null;

function setStatus(message: string): void {
  statusNode.textContent = message;
}

async function openDeviceDatabase(): Promise<IDBDatabase> {
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DEVICE_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DEVICE_STORE)) {
        request.result.createObjectStore(DEVICE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Unable to open device storage'));
  });
}

async function saveDevice(device: StoredRemoteDevice): Promise<void> {
  const database = await openDeviceDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(DEVICE_STORE, 'readwrite');
      transaction.objectStore(DEVICE_STORE).put(device, ACTIVE_DEVICE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(
          transaction.error ?? new Error('Unable to persist remote device'),
        );
    });
  } finally {
    database.close();
  }
}

async function loadDevice(): Promise<StoredRemoteDevice | null> {
  const database = await openDeviceDatabase();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = database
        .transaction(DEVICE_STORE)
        .objectStore(DEVICE_STORE)
        .get(ACTIVE_DEVICE_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('Unable to load remote device'));
    });
    if (
      !isRecord(value) ||
      typeof value.deviceId !== 'string' ||
      typeof value.clientId !== 'string' ||
      typeof value.privateKey !== 'string' ||
      typeof value.publicKey !== 'string' ||
      typeof value.serverPublicKey !== 'string'
    ) {
      return null;
    }
    return value as unknown as StoredRemoteDevice;
  } finally {
    database.close();
  }
}

function verifyAttestation(
  attestation: RemoteControlEnvironmentAttestation,
  challenge: string,
  serverPublicKey: string,
): boolean {
  const now = Date.now();
  return (
    attestation.publicKey === serverPublicKey &&
    attestation.payload.protocolVersion === PROTOCOL_VERSION &&
    attestation.payload.challenge === challenge &&
    attestation.payload.issuedAt <= now + 30_000 &&
    attestation.payload.expiresAt >= now &&
    attestation.payload.signingKeyFingerprint ===
      getRemoteBrowserPublicKeyFingerprint(serverPublicKey) &&
    verifyRemoteBrowserPayload(
      serverPublicKey,
      REMOTE_SIGNATURE_CONTEXTS.environmentAttestation,
      attestation.payload,
      attestation.signature,
    )
  );
}

async function parseJsonResponse<ResponseType>(
  response: Response,
): Promise<ResponseType> {
  const body = (await response.json()) as unknown;
  if (!isRecord(body)) throw new Error('Desktop returned an invalid response');
  if (!response.ok) {
    throw new Error(
      typeof body.error === 'string' ? body.error : 'Pairing failed',
    );
  }
  return body as ResponseType;
}

async function pairDevice(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  try {
    setStatus('Creating a software-held device signing key…');
    const keyPair = createRemoteBrowserKeyPair();
    const unsignedRequest = {
      protocolVersion: PROTOCOL_VERSION,
      code: codeInput.value.trim(),
      deviceId: createRemoteBrowserUuid(),
      label: labelInput.value.trim() || 'Mobile device',
      platform: 'web' as const,
      nonce: createRemoteBrowserNonce(),
      signingPublicKey: keyPair.publicKey,
    };
    const request: RemoteControlPairingRequest = {
      ...unsignedRequest,
      proof: signRemoteBrowserPayload(
        keyPair.privateKey,
        REMOTE_SIGNATURE_CONTEXTS.pairingRequest,
        unsignedRequest,
      ),
    };
    const response = await fetch('/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const body =
      await parseJsonResponse<RemoteControlPairingResponse>(response);
    if (
      body.protocolVersion !== PROTOCOL_VERSION ||
      (pinnedServerKey && body.serverPublicKey !== pinnedServerKey)
    ) {
      throw new Error('Desktop identity mismatch');
    }
    const { signature, ...responsePayload } = body;
    if (
      !verifyRemoteBrowserPayload(
        body.serverPublicKey,
        REMOTE_SIGNATURE_CONTEXTS.pairingResponse,
        responsePayload,
        signature,
      )
    ) {
      throw new Error('Invalid desktop signature');
    }
    if (
      !verifyAttestation(body.attestation, request.nonce, body.serverPublicKey)
    ) {
      throw new Error('Invalid environment attestation');
    }
    const device: StoredRemoteDevice = {
      ...keyPair,
      deviceId: request.deviceId,
      clientId: body.clientId,
      serverPublicKey: body.serverPublicKey,
    };
    await saveDevice(device);
    connectDevice(device);
  } catch (error) {
    setStatus(errorMessage(error));
  }
}

function sendSecureCommand(
  command: RemoteControlCommand,
  payload: Record<string, unknown> = {},
): void {
  if (!socket || !session) throw new Error('Remote session is not connected');
  if (session.expiresAt <= Date.now()) {
    socket.close();
    throw new Error('Remote session has expired');
  }
  const sequence = sendSequence + 1;
  const message = {
    type: 'command' as const,
    id: createRemoteBrowserUuid(),
    command,
    payload,
  };
  const ciphertext = encryptRemoteBrowserMessage(
    session.key,
    session.id,
    'client-to-server',
    sequence,
    JSON.stringify(message),
  );
  socket.send(
    JSON.stringify({
      type: 'secure',
      sessionId: session.id,
      sequence,
      ciphertext,
    } satisfies RemoteControlSecureEnvelope),
  );
  sendSequence = sequence;
}

function receiveSecureResponse(
  message: RemoteControlSecureEnvelope,
): RemoteControlResponseEnvelope {
  if (!session) throw new Error('Remote session is not connected');
  if (
    message.sessionId !== session.id ||
    message.sequence !== receiveSequence + 1
  ) {
    throw new Error('Replay or out-of-order response');
  }
  const plaintext = decryptRemoteBrowserMessage(
    session.key,
    session.id,
    'server-to-client',
    message.sequence,
    message.ciphertext,
  );
  receiveSequence = message.sequence;
  const response = JSON.parse(plaintext) as unknown;
  if (
    !isRecord(response) ||
    (response.type !== 'result' && response.type !== 'error') ||
    typeof response.replyTo !== 'string'
  ) {
    throw new Error('Desktop returned an invalid secure response');
  }
  return response as unknown as RemoteControlResponseEnvelope;
}

function handleHelloAck(
  device: StoredRemoteDevice,
  hello: RemoteControlSessionHello,
  ephemeralPrivateKey: string,
  message: RemoteControlSessionHelloAck,
): void {
  const { signature, ...ackPayload } = message;
  if (
    message.protocolVersion !== PROTOCOL_VERSION ||
    message.clientId !== device.clientId ||
    message.clientNonce !== hello.nonce ||
    message.expiresAt <= Date.now()
  ) {
    throw new Error('Session binding mismatch');
  }
  if (
    !verifyRemoteBrowserPayload(
      device.serverPublicKey,
      REMOTE_SIGNATURE_CONTEXTS.sessionHelloAck,
      ackPayload,
      signature,
    )
  ) {
    throw new Error('Invalid session signature');
  }
  if (
    !verifyAttestation(message.attestation, hello.nonce, device.serverPublicKey)
  ) {
    throw new Error('Invalid session attestation');
  }
  session = {
    id: message.sessionId,
    key: deriveRemoteBrowserSessionKey({
      privateKey: ephemeralPrivateKey,
      peerPublicKey: message.ephemeralPublicKey,
      clientNonce: hello.nonce,
      serverNonce: message.serverNonce,
      sessionId: message.sessionId,
    }),
    expiresAt: message.expiresAt,
  };
  sendSequence = 0;
  receiveSequence = 0;
  socketFailure = null;
  setStatus('Paired, attested, and connected.');
  pairingForm.style.display = 'none';
  commandsSection.style.display = 'block';
}

function connectDevice(device: StoredRemoteDevice): void {
  if (pinnedServerKey && device.serverPublicKey !== pinnedServerKey) {
    setStatus('Saved device belongs to a different desktop. Pair again.');
    return;
  }
  setStatus('Authenticating encrypted session…');
  const ephemeral = createRemoteBrowserKeyPair();
  const unsignedHello = {
    type: 'hello' as const,
    protocolVersion: PROTOCOL_VERSION,
    clientId: device.clientId,
    timestamp: Date.now(),
    nonce: createRemoteBrowserNonce(),
    ephemeralPublicKey: ephemeral.publicKey,
  };
  const hello: RemoteControlSessionHello = {
    ...unsignedHello,
    signature: signRemoteBrowserPayload(
      device.privateKey,
      REMOTE_SIGNATURE_CONTEXTS.sessionHello,
      unsignedHello,
    ),
  };
  const websocketProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socketFailure = null;
  socket = new WebSocket(`${websocketProtocol}//${location.host}/ws`);
  socket.onopen = () => socket?.send(JSON.stringify(hello));
  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(String(event.data)) as unknown;
      if (!isRecord(message) || typeof message.type !== 'string') {
        throw new Error('Desktop returned an invalid WebSocket message');
      }
      if (message.type === 'hello-ack') {
        handleHelloAck(
          device,
          hello,
          ephemeral.privateKey,
          message as unknown as RemoteControlSessionHelloAck,
        );
      } else if (message.type === 'secure' && session) {
        const response = receiveSecureResponse(
          message as unknown as RemoteControlSecureEnvelope,
        );
        setStatus(
          response.type === 'error'
            ? response.error || 'Command failed'
            : 'Command completed.',
        );
      } else {
        throw new Error('Desktop returned an unexpected WebSocket message');
      }
    } catch (error) {
      socketFailure = errorMessage(error);
      setStatus(socketFailure);
      socket?.close();
    }
  };
  socket.onerror = () => {
    socketFailure ??= 'Unable to connect to the desktop.';
    setStatus(socketFailure);
  };
  socket.onclose = () => {
    session = null;
    socket = null;
    if (!socketFailure) setStatus('Disconnected. Reload to reconnect.');
  };
}

pairingForm.addEventListener('submit', (event) => {
  void pairDevice(event as SubmitEvent);
});

commandsSection.addEventListener('click', (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('button[data-command]')
      : null;
  const command = button?.dataset.command as RemoteControlCommand | undefined;
  if (!command || !session) return;
  try {
    setStatus('Sent. Waiting for desktop policy/approval…');
    sendSecureCommand(command);
  } catch (error) {
    setStatus(errorMessage(error));
  }
});

void loadDevice()
  .then((device) => {
    if (device) connectDevice(device);
  })
  .catch(() => {
    setStatus('Enter the one-time code shown by the desktop app.');
  });

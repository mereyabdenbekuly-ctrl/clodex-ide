import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
  webcrypto,
} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  REMOTE_SIGNATURE_CONTEXTS,
  createRemoteSignaturePayload,
  remoteControlPairingResponseSchema,
  remoteControlSecureEnvelopeSchema,
  remoteControlSessionHelloAckSchema,
  type RemoteControlCommand,
  type RemoteControlNativeAttestation,
  type RemoteControlPairingRequest,
  type RemoteControlPlatform,
} from '@shared/remote-control-protocol';
import {
  createRemoteBrowserKeyPair,
  decryptRemoteBrowserMessage,
  deriveRemoteBrowserSessionKey,
  encryptRemoteBrowserMessage,
  signRemoteBrowserPayload,
  verifyRemoteBrowserPayload,
} from '@shared/remote-control-browser-crypto';
import { GuardianService } from '@/services/guardian';

const pathMock = vi.hoisted(() => ({
  secretsPath: '',
}));

vi.mock('@/utils/paths', () => ({
  getRemoteControlSecretsPath: () => pathMock.secretsPath,
}));

import { AgentOsStateStore } from './state-store';
import { DebugInspectorService } from './debug-inspector';
import {
  RemoteControlService,
  type RemoteControlAuditEvent,
  type RemoteControlGuardianChecker,
  type RemoteControlServiceOptions,
} from './remote-control';
import {
  createRemoteNonce,
  decodeRemoteBase64Url,
  decryptRemoteMessage,
  deriveRemoteSessionCrypto,
  encodeRemoteBase64Url,
  encryptRemoteMessage,
  generateRemoteEphemeralKeyPair,
  getRemotePublicKeyFingerprint,
  verifyRemoteEnvironmentAttestation,
  verifyRemotePayload,
  type RemoteControlSessionCrypto,
} from './remote-control-crypto';
import {
  createRemoteNativeAttestationChallenge,
  type RemoteNativeAttestationVerifier,
} from './remote-control-native-attestation';

type JsonMessage = Record<string, unknown>;

interface TestDevice {
  deviceId: string;
  privateKey: KeyObject;
  publicKey: string;
}

interface TestSession {
  socket: WebSocket;
  crypto: RemoteControlSessionCrypto;
  sentSequence: number;
  receivedSequence: number;
}

function createDevice(): TestDevice {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    deviceId: randomUUID(),
    privateKey: pair.privateKey,
    publicKey: encodeRemoteBase64Url(
      pair.publicKey.export({ format: 'der', type: 'spki' }),
    ),
  };
}

function signDevicePayload(
  device: TestDevice,
  context: string,
  payload: unknown,
): string {
  return sign(
    'sha256',
    Buffer.from(createRemoteSignaturePayload(context, payload), 'utf-8'),
    { key: device.privateKey, dsaEncoding: 'ieee-p1363' },
  ).toString('base64url');
}

function forceHighSP256Signature(signature: string): string {
  const order = BigInt(
    '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
  );
  const bytes = decodeRemoteBase64Url(signature);
  const s = BigInt(`0x${bytes.subarray(32).toString('hex')}`);
  const highS = s > order / 2n ? s : order - s;
  const highSBytes = Buffer.from(highS.toString(16).padStart(64, '0'), 'hex');
  return Buffer.concat([bytes.subarray(0, 32), highSBytes]).toString(
    'base64url',
  );
}

function createPairingRequest(
  code: string,
  device: TestDevice,
  platform: RemoteControlPlatform = 'web',
): RemoteControlPairingRequest {
  const payload = {
    protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
    code,
    deviceId: device.deviceId,
    label: 'Test phone',
    platform,
    nonce: createRemoteNonce(),
    signingPublicKey: device.publicKey,
  };
  return {
    ...payload,
    proof: signDevicePayload(
      device,
      REMOTE_SIGNATURE_CONTEXTS.pairingRequest,
      payload,
    ),
  };
}

function createNativePairingRequest(
  code: string,
  device: TestDevice,
  options: {
    platform?: Extract<RemoteControlPlatform, 'ios' | 'android' | 'desktop'>;
    provider?: RemoteControlNativeAttestation['provider'];
    nonce?: string;
    challenge?: string;
    evidenceMarker?: string;
  } = {},
): RemoteControlPairingRequest {
  const platform = options.platform ?? 'ios';
  const provider = options.provider ?? 'apple-app-attest';
  const nonce = options.nonce ?? createRemoteNonce();
  const challenge =
    options.challenge ??
    createRemoteNativeAttestationChallenge({
      pairingNonce: nonce,
      deviceId: device.deviceId,
      signingKeyFingerprint: getRemotePublicKeyFingerprint(device.publicKey),
    });
  const evidenceMarker =
    options.evidenceMarker ?? randomBytes(48).toString('base64url');
  const nativeAttestation: RemoteControlNativeAttestation =
    provider === 'android-play-integrity'
      ? {
          version: 1,
          provider,
          challenge,
          integrityToken: evidenceMarker,
        }
      : {
          version: 1,
          provider,
          challenge,
          keyId: randomBytes(32).toString('base64url'),
          attestationObject: evidenceMarker,
        };
  const payload = {
    protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
    code,
    deviceId: device.deviceId,
    label: 'Native test phone',
    platform,
    nonce,
    signingPublicKey: device.publicKey,
    nativeAttestation,
  };
  return {
    ...payload,
    proof: signDevicePayload(
      device,
      REMOTE_SIGNATURE_CONTEXTS.pairingRequest,
      payload,
    ),
  };
}

async function postPair(
  baseUrl: string,
  request: RemoteControlPairingRequest,
): Promise<{ response: Response; body: JsonMessage }> {
  const response = await fetch(`${baseUrl}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  return {
    response,
    body: (await response.json()) as JsonMessage,
  };
}

function loopbackUrl(serverUrl: string, protocol: 'http' | 'ws'): string {
  const parsed = new URL(serverUrl);
  return `${protocol}://127.0.0.1:${parsed.port}`;
}

async function nextMessage(socket: WebSocket): Promise<JsonMessage> {
  return await new Promise<JsonMessage>((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      cleanup();
      try {
        resolve(JSON.parse(raw.toString()) as JsonMessage);
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('message', onMessage);
      socket.off('error', onError);
    };
    socket.on('message', onMessage);
    socket.on('error', onError);
  });
}

async function pairDeviceWithRequest(
  service: RemoteControlService,
  store: AgentOsStateStore,
  device: TestDevice,
) {
  const pairing = await service.startPairing();
  const request = createPairingRequest(pairing.code, device);
  const serverUrl = store.snapshot().remoteControl.serverUrl;
  expect(serverUrl).not.toBeNull();
  const result = await postPair(loopbackUrl(serverUrl!, 'http'), request);
  expect(result.response.status).toBe(200);
  const response = remoteControlPairingResponseSchema.parse(result.body);
  expect(
    verifyRemoteEnvironmentAttestation(response.attestation, request.nonce),
  ).toBe(true);
  return { request, response };
}

async function connectClient(
  wsUrl: string,
  device: TestDevice,
  clientId: string,
  serverPublicKey: string,
): Promise<TestSession> {
  const socket = new WebSocket(`${wsUrl}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const ephemeral = generateRemoteEphemeralKeyPair();
  const helloPayload = {
    type: 'hello' as const,
    protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
    clientId,
    timestamp: Date.now(),
    nonce: createRemoteNonce(),
    ephemeralPublicKey: ephemeral.publicKey,
  };
  const hello = {
    ...helloPayload,
    signature: signDevicePayload(
      device,
      REMOTE_SIGNATURE_CONTEXTS.sessionHello,
      helloPayload,
    ),
  };
  const ackPromise = nextMessage(socket);
  socket.send(JSON.stringify(hello));
  const ack = remoteControlSessionHelloAckSchema.parse(await ackPromise);
  const ackPayload = { ...ack };
  delete (ackPayload as Partial<typeof ack>).signature;
  expect(
    verifyRemotePayload(
      serverPublicKey,
      REMOTE_SIGNATURE_CONTEXTS.sessionHelloAck,
      ackPayload,
      ack.signature,
    ),
  ).toBe(true);
  expect(verifyRemoteEnvironmentAttestation(ack.attestation, hello.nonce)).toBe(
    true,
  );
  return {
    socket,
    crypto: deriveRemoteSessionCrypto({
      privateKey: ephemeral.privateKey,
      peerPublicKey: ack.ephemeralPublicKey,
      clientNonce: hello.nonce,
      serverNonce: ack.serverNonce,
      sessionId: ack.sessionId,
      expiresAt: ack.expiresAt,
    }),
    sentSequence: 0,
    receivedSequence: 0,
  };
}

function createEncryptedCommand(
  session: TestSession,
  command: RemoteControlCommand,
  payload: Record<string, unknown> = {},
) {
  const sequence = session.sentSequence + 1;
  const id = randomUUID();
  const envelope = {
    type: 'secure' as const,
    sessionId: session.crypto.sessionId,
    sequence,
    ciphertext: encryptRemoteMessage(
      session.crypto,
      'client-to-server',
      sequence,
      JSON.stringify({ type: 'command', id, command, payload }),
    ),
  };
  return { id, envelope };
}

async function sendCommand(
  session: TestSession,
  command: RemoteControlCommand,
  payload: Record<string, unknown> = {},
) {
  const { id, envelope } = createEncryptedCommand(session, command, payload);
  const responsePromise = nextMessage(session.socket);
  session.socket.send(JSON.stringify(envelope));
  session.sentSequence = envelope.sequence;
  const secureResponse = remoteControlSecureEnvelopeSchema.parse(
    await responsePromise,
  );
  expect(secureResponse.sequence).toBe(session.receivedSequence + 1);
  const plaintext = decryptRemoteMessage(
    session.crypto,
    'server-to-client',
    secureResponse.sequence,
    secureResponse.ciphertext,
  );
  session.receivedSequence = secureResponse.sequence;
  const response = JSON.parse(plaintext) as JsonMessage;
  expect(response.replyTo).toBe(id);
  return { response, sentEnvelope: envelope };
}

describe('RemoteControlService protocol v2', () => {
  let root: string;
  let store: AgentOsStateStore;
  let service: RemoteControlService;
  let commandHandler: ReturnType<typeof vi.fn>;
  let guardianChecker: RemoteControlGuardianChecker;
  let nativeAttestationVerifier: RemoteNativeAttestationVerifier;
  let auditEvents: RemoteControlAuditEvent[];
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-os-remote-'));
    pathMock.secretsPath = path.join(root, 'remote-control', 'clients.json');
    store = await AgentOsStateStore.create(path.join(root, 'state.json'));
    commandHandler = vi.fn(async () => ({ ok: true }));
    const guardian = new GuardianService({
      isFeatureEnabled: () => true,
    });
    guardianChecker = (request) => guardian.assess(request);
    auditEvents = [];
    nativeAttestationVerifier = vi.fn(async (input) => ({
      verified: true as const,
      challenge: input.expectedChallenge,
      issuedAt: input.now - 1_000,
      expiresAt: input.now + 60_000,
      replayId: `${input.evidence.provider}:${input.expectedChallenge}`,
    }));
    service = new RemoteControlService(
      store,
      new DebugInspectorService(store),
      commandHandler,
      {
        guardian: guardianChecker,
        audit: (event) => auditEvents.push(event),
        nativeAttestationVerifier,
        environment: {
          appVersion: '1.2.3-test',
          releaseChannel: 'dev',
          platform: 'test',
          architecture: 'test-arch',
        },
      },
    );
    await service.initialize();
    await service.setEnabled(true);
  });

  async function restartService(
    overrides: Partial<RemoteControlServiceOptions>,
  ): Promise<void> {
    await service.teardown();
    service = new RemoteControlService(
      store,
      new DebugInspectorService(store),
      commandHandler,
      {
        guardian: guardianChecker,
        audit: (event) => auditEvents.push(event),
        nativeAttestationVerifier,
        environment: {
          appVersion: '1.2.3-test',
          releaseChannel: 'dev',
          platform: 'test',
          architecture: 'test-arch',
        },
        ...overrides,
      },
    );
    await service.initialize();
    if (!store.snapshot().remoteControl.enabled) {
      await service.setEnabled(true);
    }
  }

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await service.teardown();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('expires one-time pairing codes and clears pairing state', async () => {
    const pairing = await service.startPairing();
    const device = createDevice();
    await store.update((draft) => {
      draft.remoteControl.pairingExpiresAt = Date.now() - 1;
    });
    const serverUrl = store.snapshot().remoteControl.serverUrl;
    expect(serverUrl).not.toBeNull();

    const result = await postPair(
      loopbackUrl(serverUrl!, 'http'),
      createPairingRequest(pairing.code, device),
    );

    expect(result.response.status).toBe(400);
    expect(result.body.error).toContain('invalid or expired');
    expect(store.snapshot().remoteControl).toMatchObject({
      pairingCode: null,
      pairingExpiresAt: null,
      pairingUrl: null,
      pairingQrDataUrl: null,
    });
  });

  it('stores a device public key, verifies attestation, and consumes the code', async () => {
    const device = createDevice();
    const pairing = await service.startPairing();
    const request = createPairingRequest(pairing.code, device);
    const serverUrl = store.snapshot().remoteControl.serverUrl!;
    const baseUrl = loopbackUrl(serverUrl, 'http');

    const paired = await postPair(baseUrl, request);
    expect(paired.response.status).toBe(200);
    const response = remoteControlPairingResponseSchema.parse(paired.body);
    expect(
      verifyRemoteEnvironmentAttestation(response.attestation, request.nonce),
    ).toBe(true);

    const secrets = await fs.readFile(pathMock.secretsPath, 'utf-8');
    expect(secrets).toContain(device.publicKey);
    expect(secrets).not.toContain('tokenHashes');
    expect(
      store.snapshot().remoteControl.clients[response.clientId],
    ).toMatchObject({
      deviceId: device.deviceId,
      keyFingerprint: expect.any(String),
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      trustLevel: 'software',
      attestationProvider: null,
      attestationVerdict: 'software-only',
      revoked: false,
    });

    const replay = await postPair(baseUrl, request);
    expect(replay.response.status).toBe(400);
    expect(replay.body.error).toContain('invalid or expired');
  });

  it('verifies native evidence, stores only trust metadata, and audits without raw evidence', async () => {
    const device = createDevice();
    const pairing = await service.startPairing();
    const evidenceMarker = `rawEvidence${'A'.repeat(48)}`;
    const request = createNativePairingRequest(pairing.code, device, {
      evidenceMarker,
    });
    const serverUrl = store.snapshot().remoteControl.serverUrl!;

    const paired = await postPair(loopbackUrl(serverUrl, 'http'), request);

    expect(paired.response.status).toBe(200);
    const response = remoteControlPairingResponseSchema.parse(paired.body);
    expect(
      store.snapshot().remoteControl.clients[response.clientId],
    ).toMatchObject({
      platform: 'ios',
      trustLevel: 'hardware-backed',
      attestationProvider: 'apple-app-attest',
      attestationVerdict: 'verified',
      attestationVerifiedAt: expect.any(Number),
    });
    expect(nativeAttestationVerifier).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: request.nativeAttestation?.challenge,
        signingKeyFingerprint: getRemotePublicKeyFingerprint(device.publicKey),
      }),
    );
    const persistedState = await fs.readFile(
      path.join(root, 'state.json'),
      'utf8',
    );
    const persistedSecrets = await fs.readFile(pathMock.secretsPath, 'utf8');
    expect(persistedState).not.toContain(evidenceMarker);
    expect(persistedSecrets).not.toContain(evidenceMarker);
    expect(JSON.stringify(auditEvents)).not.toContain(evidenceMarker);
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        operation: 'client-attestation',
        success: true,
        trustLevel: 'hardware-backed',
        attestationProvider: 'apple-app-attest',
        attestationReason: 'verified',
      }),
    );
  });

  it('requires hardware evidence for policy-selected native platforms', async () => {
    await restartService({
      nativeAttestationPolicy: { requiredPlatforms: ['ios'] },
    });
    const pairing = await service.startPairing();
    const result = await postPair(
      loopbackUrl(store.snapshot().remoteControl.serverUrl!, 'http'),
      createPairingRequest(pairing.code, createDevice(), 'ios'),
    );

    expect(result.response.status).toBe(400);
    expect(result.body.error).toContain('Hardware-backed attestation');
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        operation: 'client-attestation',
        success: false,
        attestationReason: 'required',
      }),
    );
  });

  it('rejects native evidence with a mismatched challenge before verification', async () => {
    const pairing = await service.startPairing();
    const request = createNativePairingRequest(pairing.code, createDevice(), {
      challenge: randomBytes(32).toString('base64url'),
    });
    const result = await postPair(
      loopbackUrl(store.snapshot().remoteControl.serverUrl!, 'http'),
      request,
    );

    expect(result.response.status).toBe(400);
    expect(result.body.error).toContain('challenge is invalid');
    expect(nativeAttestationVerifier).not.toHaveBeenCalled();
  });

  it('rejects expired provider verdicts', async () => {
    nativeAttestationVerifier = vi.fn(async (input) => ({
      verified: true as const,
      challenge: input.expectedChallenge,
      issuedAt: input.now - 120_000,
      expiresAt: input.now - 1,
      replayId: 'expired-provider-verdict',
    }));
    await restartService({ nativeAttestationVerifier });
    const pairing = await service.startPairing();
    const result = await postPair(
      loopbackUrl(store.snapshot().remoteControl.serverUrl!, 'http'),
      createNativePairingRequest(pairing.code, createDevice()),
    );

    expect(result.response.status).toBe(400);
    expect(result.body.error).toContain('expired');
  });

  it('rejects replayed hardware evidence even with a fresh pairing code', async () => {
    const device = createDevice();
    const nonce = createRemoteNonce();
    const evidenceMarker = `replayEvidence${'B'.repeat(48)}`;
    const firstPairing = await service.startPairing();
    const first = await postPair(
      loopbackUrl(store.snapshot().remoteControl.serverUrl!, 'http'),
      createNativePairingRequest(firstPairing.code, device, {
        nonce,
        evidenceMarker,
      }),
    );
    expect(first.response.status).toBe(200);

    await restartService({});
    const secondPairing = await service.startPairing();
    const replay = await postPair(
      loopbackUrl(store.snapshot().remoteControl.serverUrl!, 'http'),
      createNativePairingRequest(secondPairing.code, device, {
        nonce,
        evidenceMarker,
      }),
    );

    expect(replay.response.status).toBe(400);
    expect(replay.body.error).toContain('already used');
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        operation: 'client-attestation',
        success: false,
        attestationReason: 'replayed',
      }),
    );
  });

  it('fails closed for unsupported providers and unavailable verifiers', async () => {
    nativeAttestationVerifier = vi.fn(async () => ({
      verified: false as const,
      reason: 'unsupported-provider' as const,
    }));
    await restartService({ nativeAttestationVerifier });
    const unsupportedPairing = await service.startPairing();
    const unsupported = await postPair(
      loopbackUrl(store.snapshot().remoteControl.serverUrl!, 'http'),
      createNativePairingRequest(unsupportedPairing.code, createDevice(), {
        platform: 'desktop',
        provider: 'apple-secure-enclave',
      }),
    );
    expect(unsupported.response.status).toBe(400);
    expect(unsupported.body.error).toContain('unsupported-provider');

    await restartService({ nativeAttestationVerifier: undefined });
    const unavailablePairing = await service.startPairing();
    const unavailable = await postPair(
      loopbackUrl(store.snapshot().remoteControl.serverUrl!, 'http'),
      createNativePairingRequest(unavailablePairing.code, createDevice()),
    );
    expect(unavailable.response.status).toBe(400);
    expect(unavailable.body.error).toContain('verifier is unavailable');
  });

  it('accepts a WebCrypto P-256 proof from compatible native clients', async () => {
    const pair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const publicKey = encodeRemoteBase64Url(
      new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey)),
    );
    const payload = {
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      code: '123456',
      deviceId: randomUUID(),
      label: 'WebCrypto phone',
      platform: 'web' as const,
      nonce: createRemoteNonce(),
      signingPublicKey: publicKey,
    };
    const signature = encodeRemoteBase64Url(
      new Uint8Array(
        await webcrypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          Buffer.from(
            createRemoteSignaturePayload(
              REMOTE_SIGNATURE_CONTEXTS.pairingRequest,
              payload,
            ),
            'utf-8',
          ),
        ),
      ),
    );

    expect(
      verifyRemotePayload(
        publicKey,
        REMOTE_SIGNATURE_CONTEXTS.pairingRequest,
        payload,
        signature,
      ),
    ).toBe(true);
  });

  it('accepts the pure-JS P-256 proof used by the insecure LAN bootstrap', () => {
    const pair = createRemoteBrowserKeyPair();
    const payload = {
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      code: '123456',
      deviceId: randomUUID(),
      label: 'Pure JS phone',
      platform: 'web' as const,
      nonce: createRemoteNonce(),
      signingPublicKey: pair.publicKey,
    };
    const signature = signRemoteBrowserPayload(
      pair.privateKey,
      REMOTE_SIGNATURE_CONTEXTS.pairingRequest,
      payload,
    );

    expect(
      verifyRemotePayload(
        pair.publicKey,
        REMOTE_SIGNATURE_CONTEXTS.pairingRequest,
        payload,
        signature,
      ),
    ).toBe(true);

    const nodePair = createDevice();
    const nodeSignature = forceHighSP256Signature(
      signDevicePayload(
        nodePair,
        REMOTE_SIGNATURE_CONTEXTS.pairingResponse,
        payload,
      ),
    );
    expect(
      verifyRemoteBrowserPayload(
        nodePair.publicKey,
        REMOTE_SIGNATURE_CONTEXTS.pairingResponse,
        payload,
        nodeSignature,
      ),
    ).toBe(true);
  });

  it('interoperates with the pure-JS ECDH, HKDF and AES-GCM client', () => {
    const browserEphemeral = createRemoteBrowserKeyPair();
    const serverEphemeral = generateRemoteEphemeralKeyPair();
    const sessionId = randomUUID();
    const clientNonce = createRemoteNonce();
    const serverNonce = createRemoteNonce();
    const serverCrypto = deriveRemoteSessionCrypto({
      privateKey: serverEphemeral.privateKey,
      peerPublicKey: browserEphemeral.publicKey,
      clientNonce,
      serverNonce,
      sessionId,
      expiresAt: Date.now() + 60_000,
    });
    const browserKey = deriveRemoteBrowserSessionKey({
      privateKey: browserEphemeral.privateKey,
      peerPublicKey: serverEphemeral.publicKey,
      clientNonce,
      serverNonce,
      sessionId,
    });

    expect(Buffer.from(browserKey)).toEqual(serverCrypto.key);
    const browserCiphertext = encryptRemoteBrowserMessage(
      browserKey,
      sessionId,
      'client-to-server',
      1,
      '{"from":"browser"}',
    );
    expect(
      decryptRemoteMessage(
        serverCrypto,
        'client-to-server',
        1,
        browserCiphertext,
      ),
    ).toBe('{"from":"browser"}');

    const serverCiphertext = encryptRemoteMessage(
      serverCrypto,
      'server-to-client',
      1,
      '{"from":"desktop"}',
    );
    expect(
      decryptRemoteBrowserMessage(
        browserKey,
        sessionId,
        'server-to-client',
        1,
        serverCiphertext,
      ),
    ).toBe('{"from":"desktop"}');
  });

  it('serves a CSP-protected pure-JS client for insecure LAN origins', async () => {
    const serverUrl = store.snapshot().remoteControl.serverUrl;
    expect(serverUrl).not.toBeNull();
    const baseUrl = loopbackUrl(serverUrl!, 'http');

    const pageResponse = await fetch(baseUrl);
    const page = await pageResponse.text();
    expect(pageResponse.status).toBe(200);
    expect(pageResponse.headers.get('content-security-policy')).toContain(
      "script-src 'self'",
    );
    expect(pageResponse.headers.get('content-security-policy')).not.toContain(
      "script-src 'unsafe-inline'",
    );
    expect(page).toContain('<script src="/client.js" defer></script>');
    expect(page).not.toContain('crypto.subtle');

    const clientResponse = await fetch(`${baseUrl}/client.js`);
    const client = await clientResponse.text();
    expect(clientResponse.status).toBe(200);
    expect(clientResponse.headers.get('content-type')).toContain(
      'application/javascript',
    );
    expect(client).toContain('Paired, attested, and connected.');
    expect(client).not.toContain('crypto.subtle');
  });

  it('encrypts commands and closes the session on sequence replay', async () => {
    const device = createDevice();
    const { response } = await pairDeviceWithRequest(service, store, device);
    await service.setAllowRemoteCommands(true);
    const wsUrl = loopbackUrl(store.snapshot().remoteControl.serverUrl!, 'ws');
    const session = await connectClient(
      wsUrl,
      device,
      response.clientId,
      response.serverPublicKey,
    );
    sockets.push(session.socket);

    const completed = await sendCommand(session, 'openThread', {
      agentId: 'agent-1',
    });
    expect(completed.response).toMatchObject({
      type: 'result',
      result: { ok: true },
    });
    expect(JSON.stringify(completed.sentEnvelope)).not.toContain('openThread');
    expect(commandHandler).toHaveBeenCalledWith('openThread', {
      agentId: 'agent-1',
    });

    const replayClosed = new Promise<number>((resolve) => {
      session.socket.once('close', (code) => resolve(code));
    });
    session.socket.send(JSON.stringify(completed.sentEnvelope));
    await expect(replayClosed).resolves.toBe(4008);
  });

  it('routes risky commands through Guardian and one-time desktop approval', async () => {
    const device = createDevice();
    const { response } = await pairDeviceWithRequest(service, store, device);
    await service.setAllowRemoteCommands(true);
    const session = await connectClient(
      loopbackUrl(store.snapshot().remoteControl.serverUrl!, 'ws'),
      device,
      response.clientId,
      response.serverPublicKey,
    );
    sockets.push(session.socket);

    const pendingResult = sendCommand(session, 'newAgent');
    await vi.waitFor(() => {
      expect(store.snapshot().remoteControl.pendingApprovals).toHaveLength(1);
    });
    const approval = store.snapshot().remoteControl.pendingApprovals[0];
    expect(approval).toMatchObject({
      command: 'newAgent',
      clientId: response.clientId,
      risk: 'medium',
      irreversible: false,
    });
    await service.resolveCommandApproval(approval!.id, true);
    await expect(pendingResult).resolves.toMatchObject({
      response: { type: 'result', result: { ok: true } },
    });
    expect(store.snapshot().remoteControl.pendingApprovals).toEqual([]);

    const deniedResult = sendCommand(session, 'approveTool');
    await vi.waitFor(() => {
      expect(store.snapshot().remoteControl.pendingApprovals).toHaveLength(1);
    });
    const dangerousApproval =
      store.snapshot().remoteControl.pendingApprovals[0];
    expect(dangerousApproval?.irreversible).toBe(true);
    await service.resolveCommandApproval(dangerousApproval!.id, false);
    await expect(deniedResult).resolves.toMatchObject({
      response: {
        type: 'error',
        error: 'Remote command was not approved on the desktop',
      },
    });
    expect(commandHandler).toHaveBeenCalledTimes(1);
  });

  it('revokes device keys and closes authenticated sockets', async () => {
    const device = createDevice();
    const { response } = await pairDeviceWithRequest(service, store, device);
    const session = await connectClient(
      loopbackUrl(store.snapshot().remoteControl.serverUrl!, 'ws'),
      device,
      response.clientId,
      response.serverPublicKey,
    );
    sockets.push(session.socket);

    const closed = new Promise<number>((resolve) => {
      session.socket.once('close', (code) => resolve(code));
    });
    await service.revokeClient(response.clientId);
    await expect(closed).resolves.toBe(4004);
    expect(
      store.snapshot().remoteControl.clients[response.clientId]?.revoked,
    ).toBe(true);

    const secrets = await fs.readFile(pathMock.secretsPath, 'utf-8');
    expect(secrets).not.toContain(device.publicKey);
  });

  it('rate-limits repeated pairing guesses from one client', async () => {
    const pairing = await service.startPairing();
    const serverUrl = store.snapshot().remoteControl.serverUrl!;
    const baseUrl = loopbackUrl(serverUrl, 'http');

    for (let attempt = 0; attempt < 20; attempt++) {
      const device = createDevice();
      const request = createPairingRequest('000000', device);
      const result = await postPair(baseUrl, request);
      expect(result.response.status).toBe(400);
    }
    const limited = await postPair(
      baseUrl,
      createPairingRequest(pairing.code, createDevice()),
    );

    expect(limited.response.status).toBe(400);
    expect(limited.body.error).toContain('Too many pairing attempts');
  });

  it('rejects tampered client signatures before opening a session', async () => {
    const device = createDevice();
    const { response } = await pairDeviceWithRequest(service, store, device);
    const wsUrl = loopbackUrl(store.snapshot().remoteControl.serverUrl!, 'ws');
    const socket = new WebSocket(`${wsUrl}/ws`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const closed = new Promise<number>((resolve) => {
      socket.once('close', (code) => resolve(code));
    });
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        clientId: response.clientId,
        timestamp: Date.now(),
        nonce: randomBytes(16).toString('base64url'),
        ephemeralPublicKey: generateRemoteEphemeralKeyPair().publicKey,
        signature: randomBytes(64).toString('base64url'),
      }),
    );
    await expect(closed).resolves.toBe(4005);
    expect(commandHandler).not.toHaveBeenCalled();
  });
});

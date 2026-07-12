import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as QRCode from 'qrcode';
import { WebSocketServer, type WebSocket } from 'ws';
import { AGENT_OS_LIMITS, type RemoteControlClient } from '@shared/agent-os';
import type {
  GuardianAssessment,
  GuardianAssessmentRequest,
} from '@shared/guardian';
import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  REMOTE_SIGNATURE_CONTEXTS,
  remoteControlCommandEnvelopeSchema,
  remoteControlPairingRequestSchema,
  remoteControlSecureEnvelopeSchema,
  remoteControlSessionHelloSchema,
  type RemoteControlCommand,
  type RemoteControlEnvironmentAttestation,
  type RemoteControlNativeAttestationProvider,
  type RemoteControlPairingRequest,
  type RemoteControlPairingResponse,
  type RemoteControlResponseEnvelope,
  type RemoteControlSessionHelloAck,
  type RemoteControlTrustLevel,
} from '@shared/remote-control-protocol';
import { getRemoteControlSecretsPath } from '@/utils/paths';
import { createRemoteControlGuardianRequest } from '@/services/guardian/requests';
import type { AgentOsStateStore } from './state-store';
import type { DebugInspectorService } from './debug-inspector';
import {
  createRemoteEnvironmentAttestation,
  createRemoteNonce,
  decryptRemoteMessage,
  deriveRemoteSessionCrypto,
  encryptRemoteMessage,
  generateRemoteControlServerIdentity,
  generateRemoteEphemeralKeyPair,
  getRemotePublicKeyFingerprint,
  importRemoteP256PublicKey,
  signRemotePayload,
  verifyRemotePayload,
  type RemoteControlEnvironmentMetadata,
  type RemoteControlServerIdentity,
  type RemoteControlSessionCrypto,
} from './remote-control-crypto';
import remoteControlClientBundle from './remote-control-client.bundle.js?raw';
import {
  createRemoteNativeAttestationChallenge,
  createSoftwareRemoteClientTrust,
  isHardwareAttestationRequired,
  isProviderCompatibleWithPlatform,
  validateVerifiedRemoteNativeAttestation,
  type RemoteClientAttestationTrust,
  type RemoteNativeAttestationFailureReason,
  type RemoteNativeAttestationPolicy,
  type RemoteNativeAttestationVerifier,
} from './remote-control-native-attestation';

const MAX_PAIRING_ATTEMPTS_PER_WINDOW = 20;
const PAIRING_ATTEMPT_WINDOW_MS = 60_000;
const MAX_PAIRING_REQUEST_BYTES = 256 * 1024;
const MAX_HANDSHAKE_CLOCK_SKEW_MS = 60_000;
const MAX_COMMANDS_PER_WINDOW = 120;
const COMMAND_WINDOW_MS = 60_000;
const MAX_PENDING_APPROVALS = 20;
const REMOTE_PROTOCOL_CLOSE = {
  authTimeout: 4001,
  authenticationRequired: 4002,
  invalidClient: 4003,
  revoked: 4004,
  invalidProtocol: 4005,
  invalidSignature: 4006,
  expiredSession: 4007,
  replayDetected: 4008,
  rateLimited: 4009,
} as const;

const FALLBACK_AUTO_APPROVE_COMMANDS = new Set<RemoteControlCommand>([
  'openThread',
  'pushToTalkStop',
]);

export type RemoteCommandHandler = (
  command: RemoteControlCommand,
  payload: Record<string, unknown>,
) => Promise<unknown>;

export type RemoteControlGuardianChecker = (
  request: GuardianAssessmentRequest,
) => Promise<GuardianAssessment | null>;

export interface RemoteControlAuditEvent {
  operation:
    | 'pair'
    | 'revoke'
    | 'session'
    | 'replay-blocked'
    | 'command-assessed'
    | 'command-completed'
    | 'attestation'
    | 'client-attestation';
  success: boolean;
  protocolVersion: number;
  command?: RemoteControlCommand;
  decision?: GuardianAssessment['decision'] | 'human-approved' | 'human-denied';
  risk?: GuardianAssessment['risk'];
  irreversible?: boolean;
  latencyMs?: number;
  reason?: 'invalid' | 'expired' | 'revoked' | 'rate-limited' | 'denied';
  trustLevel?: RemoteControlTrustLevel;
  attestationProvider?: RemoteControlNativeAttestationProvider;
  attestationReason?:
    | RemoteNativeAttestationFailureReason
    | 'software-only'
    | 'verified';
}

export interface RemoteControlServiceOptions {
  guardian?: RemoteControlGuardianChecker;
  audit?: (event: RemoteControlAuditEvent) => void;
  environment?: RemoteControlEnvironmentMetadata;
  nativeAttestationVerifier?: RemoteNativeAttestationVerifier;
  nativeAttestationPolicy?: RemoteNativeAttestationPolicy;
}

interface RemoteSecrets {
  version: 2;
  identity: RemoteControlServerIdentity;
  listenPort: number | null;
  clientSigningPublicKeys: Record<string, string>;
  nativeAttestationReplayKeys: Record<string, number>;
}

interface RemoteSocketSession {
  clientId: string;
  crypto: RemoteControlSessionCrypto;
  receivedSequence: number;
  sentSequence: number;
}

interface PendingApprovalResolver {
  clientId: string;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isPrivateRemoteAddress(address?: string): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, '');
  return (
    normalized === '::1' ||
    normalized === '127.0.0.1' ||
    normalized.startsWith('10.') ||
    normalized.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  );
}

function getLanAddress(): string {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === 'IPv4') return entry.address;
    }
  }
  return '127.0.0.1';
}

async function readJsonBody(
  request: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer);
    size += buffer.length;
    if (size > MAX_PAIRING_REQUEST_BYTES) {
      throw new Error('Request body is too large');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(JSON.stringify(body));
}

function pairingPage(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clodex Remote Control</title>
  <style>
    body{font:16px system-ui;margin:0;background:#101114;color:#f7f7f8}
    main{max-width:520px;margin:0 auto;padding:32px 20px}
    input,button{font:inherit;padding:12px;border-radius:10px;border:1px solid #444}
    input{width:100%;box-sizing:border-box;background:#191b20;color:white;margin:8px 0}
    button{background:#6c5ce7;color:white;border:0;margin:4px 4px 4px 0}
    button:disabled{opacity:.5}#commands{display:none;margin-top:24px}.status{color:#a7abb5}
    code{font-size:12px;word-break:break-all}
  </style>
</head>
<body><main>
  <h1>Clodex Remote Control</h1>
  <p class="status" id="status">Enter the one-time code shown by the desktop app.</p>
  <form id="pair">
    <input id="code" inputmode="numeric" maxlength="6" placeholder="6-digit code">
    <input id="label" maxlength="80" placeholder="Device name">
    <button>Pair this device</button>
  </form>
  <section id="commands">
    <p class="status">Commands are encrypted end-to-end and replay protected.</p>
    <button data-command="pushToTalkStart">Talk</button>
    <button data-command="pushToTalkStop">Stop talking</button>
    <button data-command="newAgent">New agent</button>
  </section>
  <script src="/client.js" defer></script>
</main></body></html>`;
}

function pairingCodeMatches(expected: string, candidate: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf-8');
  const candidateBytes = Buffer.from(candidate, 'utf-8');
  return (
    expectedBytes.length === candidateBytes.length &&
    timingSafeEqual(expectedBytes, candidateBytes)
  );
}

function defaultEnvironmentMetadata(): RemoteControlEnvironmentMetadata {
  return {
    appVersion: 'development',
    releaseChannel: 'dev',
  };
}

function createNewSecrets(): RemoteSecrets {
  return {
    version: 2,
    identity: generateRemoteControlServerIdentity(),
    listenPort: null,
    clientSigningPublicKeys: {},
    nativeAttestationReplayKeys: {},
  };
}

function parseSecrets(value: unknown): RemoteSecrets | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<RemoteSecrets>;
  if (
    candidate.version !== 2 ||
    !candidate.identity ||
    typeof candidate.identity.serverId !== 'string' ||
    typeof candidate.identity.environmentId !== 'string' ||
    typeof candidate.identity.signingPrivateKeyPem !== 'string' ||
    typeof candidate.identity.signingPublicKey !== 'string' ||
    !candidate.clientSigningPublicKeys ||
    typeof candidate.clientSigningPublicKeys !== 'object'
  ) {
    return null;
  }
  try {
    importRemoteP256PublicKey(candidate.identity.signingPublicKey);
  } catch {
    return null;
  }
  return {
    version: 2,
    identity: candidate.identity,
    listenPort:
      typeof candidate.listenPort === 'number' &&
      Number.isInteger(candidate.listenPort) &&
      candidate.listenPort >= 1 &&
      candidate.listenPort <= 65_535
        ? candidate.listenPort
        : null,
    clientSigningPublicKeys: Object.fromEntries(
      Object.entries(candidate.clientSigningPublicKeys).filter(
        ([clientId, publicKey]) =>
          typeof clientId === 'string' && typeof publicKey === 'string',
      ),
    ),
    nativeAttestationReplayKeys: Object.fromEntries(
      Object.entries(candidate.nativeAttestationReplayKeys ?? {}).filter(
        ([key, expiresAt]) =>
          typeof key === 'string' &&
          typeof expiresAt === 'number' &&
          Number.isSafeInteger(expiresAt) &&
          expiresAt > 0,
      ),
    ),
  };
}

export class RemoteControlService {
  private server: http.Server | null = null;
  private websocketServer: WebSocketServer | null = null;
  private secrets: RemoteSecrets = createNewSecrets();
  private readonly authenticatedSockets = new Map<WebSocket, string>();
  private readonly pairingAttempts = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private readonly handshakeNonces = new Map<string, number>();
  private readonly commandWindows = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private readonly pendingApprovals = new Map<
    string,
    PendingApprovalResolver
  >();
  private guardianPolicyChecker: RemoteControlGuardianChecker | undefined;

  public constructor(
    private readonly store: AgentOsStateStore,
    private readonly debug: DebugInspectorService,
    private readonly commandHandler: RemoteCommandHandler,
    private readonly options: RemoteControlServiceOptions = {},
  ) {
    this.guardianPolicyChecker = options.guardian;
  }

  public setGuardianPolicyChecker(
    checker: RemoteControlGuardianChecker | undefined,
  ): void {
    this.guardianPolicyChecker = checker;
  }

  public async initialize(): Promise<void> {
    let shouldSave = false;
    try {
      const parsed = parseSecrets(
        JSON.parse(
          await fs.readFile(getRemoteControlSecretsPath(), 'utf-8'),
        ) as unknown,
      );
      if (parsed) this.secrets = parsed;
      else shouldSave = true;
    } catch {
      shouldSave = true;
    }
    for (const [key, expiresAt] of Object.entries(
      this.secrets.nativeAttestationReplayKeys,
    )) {
      if (expiresAt <= Date.now()) {
        delete this.secrets.nativeAttestationReplayKeys[key];
        shouldSave = true;
      }
    }
    if (shouldSave) await this.saveSecrets();

    const fingerprint = getRemotePublicKeyFingerprint(
      this.secrets.identity.signingPublicKey,
    );
    await this.store.update((draft) => {
      draft.remoteControl.protocolVersion = REMOTE_CONTROL_PROTOCOL_VERSION;
      draft.remoteControl.serverFingerprint = fingerprint;
      draft.remoteControl.pendingApprovals = [];
      for (const client of Object.values(draft.remoteControl.clients)) {
        if (!this.secrets.clientSigningPublicKeys[client.id]) {
          client.revoked = true;
        }
      }
    });
    if (this.store.snapshot().remoteControl.enabled) {
      try {
        await this.startServer();
      } catch (error) {
        await this.store.update((draft) => {
          draft.remoteControl.enabled = false;
          draft.remoteControl.allowRemoteCommands = false;
          draft.remoteControl.serverUrl = null;
        });
        this.debug.record({
          channel: 'remote',
          level: 'error',
          message: 'Remote control server failed to start',
          payload: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  public async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      await this.store.update((draft) => {
        draft.remoteControl.enabled = true;
      });
      try {
        await this.startServer();
      } catch (error) {
        await this.store.update((draft) => {
          draft.remoteControl.enabled = false;
          draft.remoteControl.serverUrl = null;
        });
        throw error;
      }
      return;
    }

    await this.stopServer();
    await this.store.update((draft) => {
      draft.remoteControl.enabled = false;
      draft.remoteControl.allowRemoteCommands = false;
      draft.remoteControl.serverUrl = null;
      draft.remoteControl.pairingUrl = null;
      draft.remoteControl.pairingQrDataUrl = null;
      draft.remoteControl.pairingCode = null;
      draft.remoteControl.pairingExpiresAt = null;
      draft.remoteControl.pendingApprovals = [];
    });
  }

  public async setAllowRemoteCommands(allowed: boolean): Promise<void> {
    if (!allowed) await this.resolveAllPendingApprovals(false);
    await this.store.update((draft) => {
      draft.remoteControl.allowRemoteCommands = allowed;
    });
  }

  public async startPairing(): Promise<{
    code: string;
    expiresAt: number;
    pairingUrl: string;
  }> {
    if (!this.store.snapshot().remoteControl.enabled) {
      throw new Error('Remote control must be enabled before pairing');
    }
    await this.startServer();
    const code = randomInt(100_000, 1_000_000).toString();
    const expiresAt = Date.now() + AGENT_OS_LIMITS.remotePairingTtlMs;
    const serverUrl = this.store.snapshot().remoteControl.serverUrl;
    if (!serverUrl) throw new Error('Remote control server is unavailable');
    const fragment = new URLSearchParams({
      code,
      serverKey: this.secrets.identity.signingPublicKey,
      serverId: this.secrets.identity.serverId,
    });
    const pairingUrl = `${serverUrl}/#${fragment.toString()}`;
    const pairingQrDataUrl = await QRCode.toDataURL(pairingUrl, {
      margin: 1,
      width: 240,
    });
    this.pairingAttempts.clear();
    await this.store.update((draft) => {
      draft.remoteControl.pairingCode = code;
      draft.remoteControl.pairingExpiresAt = expiresAt;
      draft.remoteControl.pairingUrl = pairingUrl;
      draft.remoteControl.pairingQrDataUrl = pairingQrDataUrl;
    });
    this.debug.record({
      channel: 'remote',
      level: 'info',
      message: 'Remote control pairing started',
      payload: { expiresAt, protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION },
    });
    return { code, expiresAt, pairingUrl };
  }

  public async cancelPairing(): Promise<void> {
    await this.store.update((draft) => {
      draft.remoteControl.pairingCode = null;
      draft.remoteControl.pairingExpiresAt = null;
      draft.remoteControl.pairingUrl = null;
      draft.remoteControl.pairingQrDataUrl = null;
    });
  }

  public async revokeClient(clientId: string): Promise<void> {
    await this.resolvePendingApprovalsForClient(clientId, false);
    await this.store.update((draft) => {
      const client = draft.remoteControl.clients[clientId];
      if (client) client.revoked = true;
    });
    delete this.secrets.clientSigningPublicKeys[clientId];
    await this.saveSecrets();
    for (const [socket, authenticatedClientId] of this.authenticatedSockets) {
      if (authenticatedClientId === clientId) {
        socket.close(REMOTE_PROTOCOL_CLOSE.revoked, 'Client revoked');
      }
    }
    this.audit({
      operation: 'revoke',
      success: true,
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
    });
    this.debug.record({
      channel: 'remote',
      level: 'warn',
      message: 'Remote control client revoked',
      payload: { clientId },
    });
  }

  public async resolveCommandApproval(
    approvalId: string,
    approved: boolean,
  ): Promise<void> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingApprovals.delete(approvalId);
    await this.removePendingApproval(approvalId);
    pending.resolve(approved);
  }

  public generateAttestation(
    challenge = createRemoteNonce(),
  ): RemoteControlEnvironmentAttestation {
    const attestation = createRemoteEnvironmentAttestation(
      this.secrets.identity,
      this.options.environment ?? defaultEnvironmentMetadata(),
      challenge,
    );
    this.audit({
      operation: 'attestation',
      success: true,
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
    });
    return attestation;
  }

  public async teardown(): Promise<void> {
    await this.stopServer();
  }

  private async startServer(): Promise<void> {
    if (this.server) return;
    const websocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: 128 * 1024,
    });
    const server = http.createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    server.on('upgrade', (request, socket, head) => {
      if (
        request.url !== '/ws' ||
        !isPrivateRemoteAddress(request.socket.remoteAddress)
      ) {
        socket.destroy();
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit('connection', websocket, request);
      });
    });
    websocketServer.on('connection', (socket) => {
      this.handleWebSocket(socket);
    });

    await this.listen(server, this.secrets.listenPort ?? 0);
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Remote control server did not expose a TCP port');
    }
    this.server = server;
    this.websocketServer = websocketServer;
    if (this.secrets.listenPort !== address.port) {
      this.secrets.listenPort = address.port;
      await this.saveSecrets();
    }
    const serverUrl = `http://${getLanAddress()}:${address.port}`;
    await this.store.update((draft) => {
      draft.remoteControl.serverUrl = serverUrl;
      draft.remoteControl.serverFingerprint = getRemotePublicKeyFingerprint(
        this.secrets.identity.signingPublicKey,
      );
      draft.remoteControl.protocolVersion = REMOTE_CONTROL_PROTOCOL_VERSION;
    });
    this.debug.record({
      channel: 'remote',
      level: 'info',
      message: 'Encrypted remote control server started',
      payload: {
        port: address.port,
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      },
    });
  }

  private async listen(server: http.Server, port: number): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      if (
        port === 0 ||
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'EADDRINUSE'
      ) {
        throw error;
      }
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '0.0.0', () => {
          server.off('error', reject);
          resolve();
        });
      });
    }
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    await this.resolveAllPendingApprovals(false);
    this.websocketServer?.clients.forEach((client) => client.close());
    this.websocketServer?.close();
    this.websocketServer = null;
    this.authenticatedSockets.clear();
    this.pairingAttempts.clear();
    this.handshakeNonces.clear();
    this.commandWindows.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleHttpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (!isPrivateRemoteAddress(request.socket.remoteAddress)) {
      sendJson(response, 403, { error: 'LAN clients only' });
      return;
    }

    try {
      const url = new URL(request.url ?? '/', 'http://clodex.local');
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy':
            "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; img-src data:",
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        });
        response.end(pairingPage());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/client.js') {
        response.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'",
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        });
        response.end(remoteControlClientBundle);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/pair') {
        const result = await this.pairClient(
          await readJsonBody(request),
          request.socket.remoteAddress ?? 'unknown',
        );
        sendJson(response, 200, result as unknown as Record<string, unknown>);
        return;
      }
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleWebSocket(socket: WebSocket): void {
    let session: RemoteSocketSession | null = null;
    let queue = Promise.resolve();
    const authTimeout = setTimeout(
      () =>
        socket.close(
          REMOTE_PROTOCOL_CLOSE.authTimeout,
          'Authentication timeout',
        ),
      10_000,
    );

    socket.on('message', (raw) => {
      queue = queue
        .then(async () => {
          const message = JSON.parse(raw.toString()) as unknown;
          if (!session) {
            const authenticated = await this.authenticateSessionHello(message);
            session = authenticated.session;
            clearTimeout(authTimeout);
            this.authenticatedSockets.set(socket, session.clientId);
            socket.send(JSON.stringify(authenticated.ack));
            return;
          }
          await this.handleSecureMessage(socket, session, message);
        })
        .catch((error) => {
          if (session) {
            void this.sendSecureResponse(socket, session, {
              type: 'error',
              replyTo: 'protocol',
              error: error instanceof Error ? error.message : String(error),
            }).catch(() => {
              socket.close(
                REMOTE_PROTOCOL_CLOSE.invalidProtocol,
                'Invalid secure message',
              );
            });
            return;
          }
          socket.close(
            REMOTE_PROTOCOL_CLOSE.invalidProtocol,
            error instanceof Error ? error.message.slice(0, 120) : 'Invalid',
          );
        });
    });
    socket.on('close', () => {
      clearTimeout(authTimeout);
      this.authenticatedSockets.delete(socket);
    });
  }

  private async authenticateSessionHello(rawMessage: unknown): Promise<{
    session: RemoteSocketSession;
    ack: RemoteControlSessionHelloAck;
  }> {
    const hello = remoteControlSessionHelloSchema.parse(rawMessage);
    const now = Date.now();
    if (Math.abs(now - hello.timestamp) > MAX_HANDSHAKE_CLOCK_SKEW_MS) {
      throw new Error('Remote session hello is expired');
    }
    const client = this.store.snapshot().remoteControl.clients[hello.clientId];
    const clientPublicKey =
      this.secrets.clientSigningPublicKeys[hello.clientId];
    if (!client || client.revoked || !clientPublicKey) {
      this.audit({
        operation: 'session',
        success: false,
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        reason: client?.revoked ? 'revoked' : 'invalid',
      });
      throw new Error('Remote client is not authorized');
    }
    this.consumeHandshakeNonce(hello.clientId, hello.nonce, hello.timestamp);
    const helloPayload = { ...hello };
    delete (helloPayload as Partial<typeof hello>).signature;
    if (
      !verifyRemotePayload(
        clientPublicKey,
        REMOTE_SIGNATURE_CONTEXTS.sessionHello,
        helloPayload,
        hello.signature,
      )
    ) {
      throw new Error('Remote client signature is invalid');
    }
    importRemoteP256PublicKey(hello.ephemeralPublicKey);

    const ephemeral = generateRemoteEphemeralKeyPair();
    const serverNonce = createRemoteNonce();
    const sessionId = randomUUID();
    const expiresAt = now + AGENT_OS_LIMITS.remoteSessionTtlMs;
    const attestation = this.generateAttestation(hello.nonce);
    const ackPayload = {
      type: 'hello-ack' as const,
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      clientId: hello.clientId,
      sessionId,
      clientNonce: hello.nonce,
      serverNonce,
      ephemeralPublicKey: ephemeral.publicKey,
      expiresAt,
      attestation,
    };
    const ack: RemoteControlSessionHelloAck = {
      ...ackPayload,
      signature: signRemotePayload(
        this.secrets.identity,
        REMOTE_SIGNATURE_CONTEXTS.sessionHelloAck,
        ackPayload,
      ),
    };
    await this.touchClient(hello.clientId);
    this.audit({
      operation: 'session',
      success: true,
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
    });
    return {
      session: {
        clientId: hello.clientId,
        crypto: deriveRemoteSessionCrypto({
          privateKey: ephemeral.privateKey,
          peerPublicKey: hello.ephemeralPublicKey,
          clientNonce: hello.nonce,
          serverNonce,
          sessionId,
          expiresAt,
        }),
        receivedSequence: 0,
        sentSequence: 0,
      },
      ack,
    };
  }

  private async handleSecureMessage(
    socket: WebSocket,
    session: RemoteSocketSession,
    rawMessage: unknown,
  ): Promise<void> {
    const envelope = remoteControlSecureEnvelopeSchema.parse(rawMessage);
    if (
      envelope.sessionId !== session.crypto.sessionId ||
      envelope.sequence !== session.receivedSequence + 1
    ) {
      this.audit({
        operation: 'replay-blocked',
        success: true,
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      });
      socket.close(
        REMOTE_PROTOCOL_CLOSE.replayDetected,
        'Replay or out-of-order message',
      );
      return;
    }
    const plaintext = decryptRemoteMessage(
      session.crypto,
      'client-to-server',
      envelope.sequence,
      envelope.ciphertext,
    );
    session.receivedSequence = envelope.sequence;
    const commandEnvelope = remoteControlCommandEnvelopeSchema.parse(
      JSON.parse(plaintext) as unknown,
    );
    this.consumeCommandBudget(session.clientId);
    const startedAt = Date.now();
    try {
      const result = await this.executeRemoteCommand(
        session.clientId,
        commandEnvelope.command,
        commandEnvelope.payload,
      );
      await this.sendSecureResponse(socket, session, {
        type: 'result',
        replyTo: commandEnvelope.id,
        result,
      });
      this.audit({
        operation: 'command-completed',
        success: true,
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        command: commandEnvelope.command,
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      await this.sendSecureResponse(socket, session, {
        type: 'error',
        replyTo: commandEnvelope.id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.audit({
        operation: 'command-completed',
        success: false,
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        command: commandEnvelope.command,
        latencyMs: Date.now() - startedAt,
        reason: 'denied',
      });
    }
  }

  private async sendSecureResponse(
    socket: WebSocket,
    session: RemoteSocketSession,
    response: RemoteControlResponseEnvelope,
  ): Promise<void> {
    const sequence = session.sentSequence + 1;
    const ciphertext = encryptRemoteMessage(
      session.crypto,
      'server-to-client',
      sequence,
      JSON.stringify(response),
    );
    session.sentSequence = sequence;
    socket.send(
      JSON.stringify({
        type: 'secure',
        sessionId: session.crypto.sessionId,
        sequence,
        ciphertext,
      }),
    );
  }

  private async pairClient(
    rawRequest: Record<string, unknown>,
    remoteAddress: string,
  ): Promise<RemoteControlPairingResponse> {
    const startedAt = Date.now();
    const request = remoteControlPairingRequestSchema.parse(rawRequest);
    const state = this.store.snapshot().remoteControl;
    if (
      state.pairingExpiresAt !== null &&
      state.pairingExpiresAt <= Date.now()
    ) {
      await this.cancelPairing();
      this.auditPairingFailure('expired', startedAt);
      throw new Error('Pairing code is invalid or expired');
    }
    this.consumePairingAttempt(remoteAddress);
    if (
      !state.pairingCode ||
      !state.pairingExpiresAt ||
      !pairingCodeMatches(state.pairingCode, request.code)
    ) {
      this.auditPairingFailure('invalid', startedAt);
      throw new Error('Pairing code is invalid or expired');
    }
    importRemoteP256PublicKey(request.signingPublicKey);
    const signingKeyFingerprint = getRemotePublicKeyFingerprint(
      request.signingPublicKey,
    );
    const proofPayload = { ...request };
    delete (proofPayload as Partial<RemoteControlPairingRequest>).proof;
    if (
      !verifyRemotePayload(
        request.signingPublicKey,
        REMOTE_SIGNATURE_CONTEXTS.pairingRequest,
        proofPayload,
        request.proof,
      )
    ) {
      this.auditPairingFailure('invalid', startedAt);
      throw new Error('Device key proof is invalid');
    }
    const clientAttestation = await this.verifyClientAttestation(
      request,
      signingKeyFingerprint,
    );

    for (const existing of Object.values(state.clients)) {
      if (existing.deviceId === request.deviceId && !existing.revoked) {
        await this.revokeClient(existing.id);
      }
    }

    const id = randomUUID();
    const client: RemoteControlClient = {
      id,
      label: request.label,
      deviceId: request.deviceId,
      platform: request.platform,
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      keyFingerprint: signingKeyFingerprint,
      attestedAt: Date.now(),
      trustLevel: clientAttestation.trustLevel,
      attestationProvider: clientAttestation.provider,
      attestationVerifiedAt: clientAttestation.verifiedAt,
      attestationVerdict: clientAttestation.verdict,
      pairedAt: Date.now(),
      lastSeenAt: null,
      revoked: false,
    };
    this.secrets.clientSigningPublicKeys[id] = request.signingPublicKey;
    try {
      await this.saveSecrets();
      await this.store.update((draft) => {
        draft.remoteControl.clients[id] = client;
        draft.remoteControl.pairingCode = null;
        draft.remoteControl.pairingExpiresAt = null;
        draft.remoteControl.pairingUrl = null;
        draft.remoteControl.pairingQrDataUrl = null;
      });
    } catch (error) {
      delete this.secrets.clientSigningPublicKeys[id];
      await this.saveSecrets().catch(() => undefined);
      throw error;
    }
    this.pairingAttempts.delete(remoteAddress);
    const serverPublicKey = this.secrets.identity.signingPublicKey;
    const responsePayload = {
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      clientId: id,
      serverPublicKey,
      serverFingerprint: getRemotePublicKeyFingerprint(serverPublicKey),
      attestation: this.generateAttestation(request.nonce),
    };
    const response: RemoteControlPairingResponse = {
      ...responsePayload,
      signature: signRemotePayload(
        this.secrets.identity,
        REMOTE_SIGNATURE_CONTEXTS.pairingResponse,
        responsePayload,
      ),
    };
    this.audit({
      operation: 'pair',
      success: true,
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      latencyMs: Date.now() - startedAt,
      trustLevel: clientAttestation.trustLevel,
      attestationProvider: clientAttestation.provider ?? undefined,
    });
    this.debug.record({
      channel: 'remote',
      level: 'info',
      message: 'Device-bound remote control client paired',
      payload: {
        clientId: id,
        platform: request.platform,
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        trustLevel: clientAttestation.trustLevel,
        attestationProvider: clientAttestation.provider,
      },
    });
    return response;
  }

  private async verifyClientAttestation(
    request: RemoteControlPairingRequest,
    signingKeyFingerprint: string,
  ): Promise<RemoteClientAttestationTrust> {
    const evidence = request.nativeAttestation;
    if (!evidence) {
      if (
        isHardwareAttestationRequired(
          request.platform,
          this.options.nativeAttestationPolicy,
        )
      ) {
        this.auditClientAttestation(false, {
          trustLevel: 'software',
          reason: 'required',
        });
        throw new Error(
          'Hardware-backed attestation is required for this platform',
        );
      }
      const trust = createSoftwareRemoteClientTrust();
      this.auditClientAttestation(true, {
        trustLevel: trust.trustLevel,
        reason: 'software-only',
      });
      return trust;
    }

    if (
      !isProviderCompatibleWithPlatform(evidence.provider, request.platform)
    ) {
      this.auditClientAttestation(false, {
        trustLevel: 'software',
        provider: evidence.provider,
        reason: 'provider-mismatch',
      });
      throw new Error(
        'Native attestation provider does not match the client platform',
      );
    }

    const expectedChallenge = createRemoteNativeAttestationChallenge({
      pairingNonce: request.nonce,
      deviceId: request.deviceId,
      signingKeyFingerprint,
      protocolVersion: request.protocolVersion,
    });
    if (evidence.challenge !== expectedChallenge) {
      this.auditClientAttestation(false, {
        trustLevel: 'software',
        provider: evidence.provider,
        reason: 'challenge-mismatch',
      });
      throw new Error('Native attestation challenge is invalid');
    }

    const verifier = this.options.nativeAttestationVerifier;
    if (!verifier) {
      this.auditClientAttestation(false, {
        trustLevel: 'software',
        provider: evidence.provider,
        reason: 'verifier-unavailable',
      });
      throw new Error('Native attestation verifier is unavailable');
    }

    const now = Date.now();
    let verification: Awaited<ReturnType<RemoteNativeAttestationVerifier>>;
    try {
      verification = await verifier({
        evidence,
        expectedChallenge,
        deviceId: request.deviceId,
        platform: request.platform,
        protocolVersion: request.protocolVersion,
        signingKeyFingerprint,
        now,
      });
    } catch {
      this.auditClientAttestation(false, {
        trustLevel: 'software',
        provider: evidence.provider,
        reason: 'verifier-unavailable',
      });
      throw new Error('Native attestation verifier is unavailable');
    }

    const validated = validateVerifiedRemoteNativeAttestation(
      {
        evidence,
        expectedChallenge,
        deviceId: request.deviceId,
        platform: request.platform,
        protocolVersion: request.protocolVersion,
        signingKeyFingerprint,
        now,
      },
      verification,
      this.options.nativeAttestationPolicy,
    );
    if (typeof validated === 'string') {
      this.auditClientAttestation(false, {
        trustLevel: 'software',
        provider: evidence.provider,
        reason: validated,
      });
      throw new Error(`Native attestation was rejected: ${validated}`);
    }

    if (
      !this.consumeNativeAttestationReplayKeys(
        validated.replayKeys,
        validated.expiresAt,
      )
    ) {
      this.auditClientAttestation(false, {
        trustLevel: 'software',
        provider: evidence.provider,
        reason: 'replayed',
      });
      throw new Error('Native attestation evidence was already used');
    }
    this.auditClientAttestation(true, {
      trustLevel: validated.trustLevel,
      provider: validated.provider,
      reason: 'verified',
    });
    return validated;
  }

  private consumeNativeAttestationReplayKeys(
    replayKeys: readonly string[],
    expiresAt: number,
  ): boolean {
    const now = Date.now();
    for (const [key, replayExpiresAt] of Object.entries(
      this.secrets.nativeAttestationReplayKeys,
    )) {
      if (replayExpiresAt <= now) {
        delete this.secrets.nativeAttestationReplayKeys[key];
      }
    }
    if (
      replayKeys.some(
        (key) => (this.secrets.nativeAttestationReplayKeys[key] ?? 0) > now,
      )
    ) {
      return false;
    }
    for (const key of replayKeys) {
      this.secrets.nativeAttestationReplayKeys[key] = expiresAt;
    }
    return true;
  }

  private auditClientAttestation(
    success: boolean,
    metadata: {
      trustLevel: RemoteControlTrustLevel;
      provider?: RemoteControlNativeAttestationProvider;
      reason:
        | RemoteNativeAttestationFailureReason
        | 'software-only'
        | 'verified';
    },
  ): void {
    this.audit({
      operation: 'client-attestation',
      success,
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      trustLevel: metadata.trustLevel,
      attestationProvider: metadata.provider,
      attestationReason: metadata.reason,
    });
  }

  private async touchClient(clientId: string): Promise<void> {
    await this.store.update((draft) => {
      const client = draft.remoteControl.clients[clientId];
      if (client) client.lastSeenAt = Date.now();
    });
  }

  private async executeRemoteCommand(
    clientId: string,
    command: RemoteControlCommand,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const state = this.store.snapshot().remoteControl;
    const client = state.clients[clientId];
    if (
      !client ||
      client.revoked ||
      this.secrets.clientSigningPublicKeys[clientId] === undefined
    ) {
      throw new Error('Remote client is no longer authorized');
    }
    if (!state.allowRemoteCommands && command !== 'pushToTalkStop') {
      throw new Error('Remote commands require desktop approval');
    }

    const request = createRemoteControlGuardianRequest(command);
    const assessment = (await this.guardianPolicyChecker?.(request)) ?? null;
    if (assessment?.decision === 'deny') {
      this.audit({
        operation: 'command-assessed',
        success: false,
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        command,
        decision: 'deny',
        risk: assessment.risk,
        irreversible: request.irreversible,
        reason: 'denied',
      });
      throw new Error('Guardian denied the remote command');
    }

    const needsHumanApproval =
      command === 'approveTool' ||
      request.irreversible ||
      assessment?.decision === 'escalate' ||
      (!assessment && !FALLBACK_AUTO_APPROVE_COMMANDS.has(command));
    if (needsHumanApproval) {
      const approved = await this.requestDesktopApproval(
        client,
        command,
        assessment,
        request,
      );
      if (!approved) {
        this.audit({
          operation: 'command-assessed',
          success: false,
          protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
          command,
          decision: 'human-denied',
          risk: assessment?.risk ?? 'high',
          irreversible: request.irreversible,
          reason: 'denied',
        });
        throw new Error('Remote command was not approved on the desktop');
      }
    }
    this.audit({
      operation: 'command-assessed',
      success: true,
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      command,
      decision: needsHumanApproval
        ? 'human-approved'
        : (assessment?.decision ?? 'approve'),
      risk: assessment?.risk ?? 'low',
      irreversible: request.irreversible,
    });
    this.debug.record({
      channel: 'remote',
      level: needsHumanApproval ? 'warn' : 'info',
      message: `Authorized remote command: ${command}`,
      payload: {
        command,
        guardianDecision: assessment?.decision ?? 'unavailable',
        guardianRisk: assessment?.risk ?? 'unknown',
        humanApproval: needsHumanApproval,
      },
    });
    return await this.commandHandler(command, payload);
  }

  private async requestDesktopApproval(
    client: RemoteControlClient,
    command: RemoteControlCommand,
    assessment: GuardianAssessment | null,
    request: GuardianAssessmentRequest,
  ): Promise<boolean> {
    if (this.pendingApprovals.size >= MAX_PENDING_APPROVALS) {
      throw new Error('Too many remote commands are awaiting approval');
    }
    const id = randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + AGENT_OS_LIMITS.remoteCommandApprovalTtlMs;
    const explanation =
      assessment?.explanation ??
      'Guardian is unavailable, so explicit desktop approval is required.';
    await this.store.update((draft) => {
      draft.remoteControl.pendingApprovals.push({
        id,
        clientId: client.id,
        clientLabel: client.label,
        command,
        risk: assessment?.risk ?? 'high',
        explanation,
        irreversible: request.irreversible,
        createdAt,
        expiresAt,
      });
    });
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(id);
        void this.removePendingApproval(id);
        resolve(false);
      }, AGENT_OS_LIMITS.remoteCommandApprovalTtlMs);
      this.pendingApprovals.set(id, { clientId: client.id, resolve, timer });
    });
  }

  private async removePendingApproval(approvalId: string): Promise<void> {
    await this.store.update((draft) => {
      draft.remoteControl.pendingApprovals =
        draft.remoteControl.pendingApprovals.filter(
          (approval) => approval.id !== approvalId,
        );
    });
  }

  private async resolvePendingApprovalsForClient(
    clientId: string,
    approved: boolean,
  ): Promise<void> {
    for (const [approvalId, pending] of this.pendingApprovals) {
      if (pending.clientId !== clientId) continue;
      clearTimeout(pending.timer);
      this.pendingApprovals.delete(approvalId);
      pending.resolve(approved);
    }
    await this.store.update((draft) => {
      draft.remoteControl.pendingApprovals =
        draft.remoteControl.pendingApprovals.filter(
          (approval) => approval.clientId !== clientId,
        );
    });
  }

  private async resolveAllPendingApprovals(approved: boolean): Promise<void> {
    for (const [approvalId, pending] of this.pendingApprovals) {
      clearTimeout(pending.timer);
      this.pendingApprovals.delete(approvalId);
      pending.resolve(approved);
    }
    if (this.store.snapshot().remoteControl.pendingApprovals.length > 0) {
      await this.store.update((draft) => {
        draft.remoteControl.pendingApprovals = [];
      });
    }
  }

  private consumePairingAttempt(remoteAddress: string): void {
    const now = Date.now();
    const existing = this.pairingAttempts.get(remoteAddress);
    const attempt =
      !existing || existing.resetAt <= now
        ? { count: 0, resetAt: now + PAIRING_ATTEMPT_WINDOW_MS }
        : existing;
    attempt.count++;
    this.pairingAttempts.set(remoteAddress, attempt);
    if (attempt.count > MAX_PAIRING_ATTEMPTS_PER_WINDOW) {
      this.audit({
        operation: 'pair',
        success: false,
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        reason: 'rate-limited',
      });
      throw new Error('Too many pairing attempts; try again later');
    }
  }

  private consumeHandshakeNonce(
    clientId: string,
    nonce: string,
    timestamp: number,
  ): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.handshakeNonces) {
      if (expiresAt <= now) this.handshakeNonces.delete(key);
    }
    const key = `${clientId}:${nonce}`;
    if (this.handshakeNonces.has(key)) {
      this.audit({
        operation: 'replay-blocked',
        success: true,
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      });
      throw new Error('Remote session hello was already used');
    }
    this.handshakeNonces.set(key, timestamp + MAX_HANDSHAKE_CLOCK_SKEW_MS);
  }

  private consumeCommandBudget(clientId: string): void {
    const now = Date.now();
    const existing = this.commandWindows.get(clientId);
    const window =
      !existing || existing.resetAt <= now
        ? { count: 0, resetAt: now + COMMAND_WINDOW_MS }
        : existing;
    window.count++;
    this.commandWindows.set(clientId, window);
    if (window.count > MAX_COMMANDS_PER_WINDOW) {
      this.audit({
        operation: 'command-completed',
        success: false,
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        reason: 'rate-limited',
      });
      throw new Error('Remote command rate limit exceeded');
    }
  }

  private auditPairingFailure(
    reason: RemoteControlAuditEvent['reason'],
    startedAt: number,
  ): void {
    this.audit({
      operation: 'pair',
      success: false,
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      reason,
      latencyMs: Date.now() - startedAt,
    });
  }

  private audit(event: RemoteControlAuditEvent): void {
    try {
      this.options.audit?.(event);
    } catch {
      // Audit transport must never change the authorization result.
    }
  }

  private async saveSecrets(): Promise<void> {
    const filePath = getRemoteControlSecretsPath();
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(this.secrets, null, 2)}\n`,
      { encoding: 'utf-8', mode: 0o600, flag: 'wx' },
    );
    await fs.rename(temporaryPath, filePath);
  }
}

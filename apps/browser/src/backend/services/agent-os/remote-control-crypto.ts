import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  REMOTE_SIGNATURE_CONTEXTS,
  createRemoteSignaturePayload,
  remoteControlEnvironmentAttestationSchema,
  type RemoteControlEnvironmentAttestation,
} from '@shared/remote-control-protocol';
import type { AppReleaseChannel } from '@shared/feature-gates';

const AES_GCM_TAG_BYTES = 16;
const CLIENT_TO_SERVER_IV_PREFIX = 0x434c4e54;
const SERVER_TO_CLIENT_IV_PREFIX = 0x53525652;

export interface RemoteControlServerIdentity {
  serverId: string;
  environmentId: string;
  signingPrivateKeyPem: string;
  signingPublicKey: string;
}

export interface RemoteControlEnvironmentMetadata {
  appVersion: string;
  releaseChannel: AppReleaseChannel;
  platform?: string;
  architecture?: string;
}

export interface RemoteControlEphemeralKeyPair {
  privateKey: KeyObject;
  publicKey: string;
}

export interface RemoteControlSessionCrypto {
  sessionId: string;
  key: Buffer;
  expiresAt: number;
}

export function encodeRemoteBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

export function decodeRemoteBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export function generateRemoteControlServerIdentity(): RemoteControlServerIdentity {
  const pair = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { format: 'der', type: 'spki' },
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  });
  return {
    serverId: randomUUID(),
    environmentId: randomUUID(),
    signingPrivateKeyPem: pair.privateKey,
    signingPublicKey: encodeRemoteBase64Url(pair.publicKey),
  };
}

export function getRemotePublicKeyFingerprint(publicKey: string): string {
  return createHash('sha256')
    .update(decodeRemoteBase64Url(publicKey))
    .digest('base64url');
}

export function importRemoteP256PublicKey(publicKey: string): KeyObject {
  const key = createPublicKey({
    key: decodeRemoteBase64Url(publicKey),
    format: 'der',
    type: 'spki',
  });
  if (
    key.asymmetricKeyType !== 'ec' ||
    key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw new Error('Remote client key must use P-256');
  }
  return key;
}

export function signRemotePayload(
  identity: Pick<RemoteControlServerIdentity, 'signingPrivateKeyPem'>,
  context: string,
  payload: unknown,
): string {
  return sign(
    'sha256',
    Buffer.from(createRemoteSignaturePayload(context, payload), 'utf-8'),
    {
      key: createPrivateKey(identity.signingPrivateKeyPem),
      dsaEncoding: 'ieee-p1363',
    },
  ).toString('base64url');
}

export function verifyRemotePayload(
  publicKey: string,
  context: string,
  payload: unknown,
  signature: string,
): boolean {
  try {
    return verify(
      'sha256',
      Buffer.from(createRemoteSignaturePayload(context, payload), 'utf-8'),
      {
        key: importRemoteP256PublicKey(publicKey),
        dsaEncoding: 'ieee-p1363',
      },
      decodeRemoteBase64Url(signature),
    );
  } catch {
    return false;
  }
}

export function createRemoteEnvironmentAttestation(
  identity: RemoteControlServerIdentity,
  metadata: RemoteControlEnvironmentMetadata,
  challenge: string,
  now = Date.now(),
): RemoteControlEnvironmentAttestation {
  const payload = {
    version: 1 as const,
    protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
    serverId: identity.serverId,
    environmentId: identity.environmentId,
    appVersion: metadata.appVersion,
    releaseChannel: metadata.releaseChannel,
    platform: metadata.platform ?? process.platform,
    architecture: metadata.architecture ?? process.arch,
    signingKeyFingerprint: getRemotePublicKeyFingerprint(
      identity.signingPublicKey,
    ),
    challenge,
    issuedAt: now,
    expiresAt: now + 5 * 60 * 1000,
  };
  return remoteControlEnvironmentAttestationSchema.parse({
    payload,
    publicKey: identity.signingPublicKey,
    signature: signRemotePayload(
      identity,
      REMOTE_SIGNATURE_CONTEXTS.environmentAttestation,
      payload,
    ),
  });
}

export function verifyRemoteEnvironmentAttestation(
  attestation: RemoteControlEnvironmentAttestation,
  expectedChallenge?: string,
  now = Date.now(),
): boolean {
  const parsed =
    remoteControlEnvironmentAttestationSchema.safeParse(attestation);
  if (!parsed.success) return false;
  if (
    expectedChallenge !== undefined &&
    parsed.data.payload.challenge !== expectedChallenge
  ) {
    return false;
  }
  if (
    parsed.data.payload.issuedAt > now + 30_000 ||
    parsed.data.payload.expiresAt < now
  ) {
    return false;
  }
  if (
    getRemotePublicKeyFingerprint(parsed.data.publicKey) !==
    parsed.data.payload.signingKeyFingerprint
  ) {
    return false;
  }
  return verifyRemotePayload(
    parsed.data.publicKey,
    REMOTE_SIGNATURE_CONTEXTS.environmentAttestation,
    parsed.data.payload,
    parsed.data.signature,
  );
}

export function generateRemoteEphemeralKeyPair(): RemoteControlEphemeralKeyPair {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: pair.privateKey,
    publicKey: encodeRemoteBase64Url(
      pair.publicKey.export({ format: 'der', type: 'spki' }),
    ),
  };
}

export function deriveRemoteSessionCrypto(input: {
  privateKey: KeyObject;
  peerPublicKey: string;
  clientNonce: string;
  serverNonce: string;
  sessionId: string;
  expiresAt: number;
}): RemoteControlSessionCrypto {
  const sharedSecret = diffieHellman({
    privateKey: input.privateKey,
    publicKey: importRemoteP256PublicKey(input.peerPublicKey),
  });
  const salt = createHash('sha256')
    .update(`${input.clientNonce}.${input.serverNonce}`)
    .digest();
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      sharedSecret,
      salt,
      Buffer.from(`clodex.remote.session.v2:${input.sessionId}`, 'utf-8'),
      32,
    ),
  );
  return {
    sessionId: input.sessionId,
    key,
    expiresAt: input.expiresAt,
  };
}

function createRemoteIv(
  direction: 'client-to-server' | 'server-to-client',
  sequence: number,
): Buffer {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error('Remote message sequence is invalid');
  }
  const iv = Buffer.alloc(12);
  iv.writeUInt32BE(
    direction === 'client-to-server'
      ? CLIENT_TO_SERVER_IV_PREFIX
      : SERVER_TO_CLIENT_IV_PREFIX,
    0,
  );
  iv.writeBigUInt64BE(BigInt(sequence), 4);
  return iv;
}

function createRemoteAad(
  sessionId: string,
  direction: 'client-to-server' | 'server-to-client',
  sequence: number,
): Buffer {
  return Buffer.from(
    `clodex.remote.secure.v2:${sessionId}:${direction}:${sequence}`,
    'utf-8',
  );
}

export function encryptRemoteMessage(
  crypto: RemoteControlSessionCrypto,
  direction: 'client-to-server' | 'server-to-client',
  sequence: number,
  plaintext: string,
): string {
  if (crypto.expiresAt <= Date.now()) {
    throw new Error('Remote control session has expired');
  }
  const cipher = createCipheriv(
    'aes-256-gcm',
    crypto.key,
    createRemoteIv(direction, sequence),
  );
  cipher.setAAD(createRemoteAad(crypto.sessionId, direction, sequence));
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return encrypted.toString('base64url');
}

export function decryptRemoteMessage(
  crypto: RemoteControlSessionCrypto,
  direction: 'client-to-server' | 'server-to-client',
  sequence: number,
  ciphertext: string,
): string {
  if (crypto.expiresAt <= Date.now()) {
    throw new Error('Remote control session has expired');
  }
  const encrypted = decodeRemoteBase64Url(ciphertext);
  if (encrypted.length <= AES_GCM_TAG_BYTES) {
    throw new Error('Remote control ciphertext is invalid');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    crypto.key,
    createRemoteIv(direction, sequence),
  );
  decipher.setAAD(createRemoteAad(crypto.sessionId, direction, sequence));
  decipher.setAuthTag(encrypted.subarray(-AES_GCM_TAG_BYTES));
  return Buffer.concat([
    decipher.update(encrypted.subarray(0, -AES_GCM_TAG_BYTES)),
    decipher.final(),
  ]).toString('utf-8');
}

export function createRemoteNonce(): string {
  return randomBytes(16).toString('base64url');
}

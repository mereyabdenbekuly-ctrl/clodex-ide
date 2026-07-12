import { z } from 'zod';

export {
  REMOTE_SIGNATURE_CONTEXTS,
  canonicalizeRemotePayload,
  createRemoteSignaturePayload,
  type CanonicalRemoteValue,
} from './remote-control-canonical';

export const REMOTE_CONTROL_PROTOCOL_VERSION = 2 as const;

export const remoteControlCommandSchema = z.enum([
  'sendMessage',
  'pushToTalkStart',
  'pushToTalkStop',
  'approveTool',
  'rejectTool',
  'stopAgent',
  'newAgent',
  'openThread',
]);
export type RemoteControlCommand = z.infer<typeof remoteControlCommandSchema>;

export const remoteControlPlatformSchema = z.enum([
  'web',
  'ios',
  'android',
  'desktop',
  'unknown',
]);
export type RemoteControlPlatform = z.infer<typeof remoteControlPlatformSchema>;

export const remoteControlNativeAttestationProviderSchema = z.enum([
  'apple-app-attest',
  'apple-secure-enclave',
  'android-play-integrity',
  'tpm',
]);
export type RemoteControlNativeAttestationProvider = z.infer<
  typeof remoteControlNativeAttestationProviderSchema
>;

export const remoteControlTrustLevelSchema = z.enum([
  'software',
  'hardware-backed',
]);
export type RemoteControlTrustLevel = z.infer<
  typeof remoteControlTrustLevelSchema
>;

export const remoteControlClientAttestationVerdictSchema = z.enum([
  'software-only',
  'verified',
]);
export type RemoteControlClientAttestationVerdict = z.infer<
  typeof remoteControlClientAttestationVerdictSchema
>;

const base64UrlSchema = z
  .string()
  .min(16)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+$/);

const opaqueNativeEvidenceSchema = z
  .string()
  .min(16)
  .max(96 * 1024)
  .regex(/^[A-Za-z0-9._~-]+$/);

const keyedNativeAttestationFields = {
  version: z.literal(1),
  challenge: base64UrlSchema.max(128),
  keyId: base64UrlSchema.max(1024),
  attestationObject: opaqueNativeEvidenceSchema,
} as const;

export const remoteControlNativeAttestationSchema = z.discriminatedUnion(
  'provider',
  [
    z
      .object({
        ...keyedNativeAttestationFields,
        provider: z.literal('apple-app-attest'),
      })
      .strict(),
    z
      .object({
        ...keyedNativeAttestationFields,
        provider: z.literal('apple-secure-enclave'),
      })
      .strict(),
    z
      .object({
        version: z.literal(1),
        provider: z.literal('android-play-integrity'),
        challenge: base64UrlSchema.max(128),
        integrityToken: opaqueNativeEvidenceSchema,
      })
      .strict(),
    z
      .object({
        ...keyedNativeAttestationFields,
        provider: z.literal('tpm'),
      })
      .strict(),
  ],
);
export type RemoteControlNativeAttestation = z.infer<
  typeof remoteControlNativeAttestationSchema
>;

export const remoteControlPairingRequestSchema = z
  .object({
    protocolVersion: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    code: z.string().regex(/^\d{6}$/),
    deviceId: z.string().uuid(),
    label: z.string().trim().min(1).max(80),
    platform: remoteControlPlatformSchema,
    nonce: base64UrlSchema.max(64),
    signingPublicKey: base64UrlSchema.max(512),
    nativeAttestation: remoteControlNativeAttestationSchema.optional(),
    proof: base64UrlSchema.max(256),
  })
  .strict();
export type RemoteControlPairingRequest = z.infer<
  typeof remoteControlPairingRequestSchema
>;

export const remoteControlEnvironmentAttestationPayloadSchema = z
  .object({
    version: z.literal(1),
    protocolVersion: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    serverId: z.string().uuid(),
    environmentId: z.string().uuid(),
    appVersion: z.string().min(1).max(80),
    releaseChannel: z.enum(['dev', 'prerelease', 'nightly', 'release']),
    platform: z.string().min(1).max(40),
    architecture: z.string().min(1).max(40),
    signingKeyFingerprint: base64UrlSchema.max(128),
    challenge: base64UrlSchema.max(256),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
export type RemoteControlEnvironmentAttestationPayload = z.infer<
  typeof remoteControlEnvironmentAttestationPayloadSchema
>;

export const remoteControlEnvironmentAttestationSchema = z
  .object({
    payload: remoteControlEnvironmentAttestationPayloadSchema,
    publicKey: base64UrlSchema.max(512),
    signature: base64UrlSchema.max(256),
  })
  .strict();
export type RemoteControlEnvironmentAttestation = z.infer<
  typeof remoteControlEnvironmentAttestationSchema
>;

export const remoteControlPairingResponseSchema = z
  .object({
    protocolVersion: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    clientId: z.string().uuid(),
    serverPublicKey: base64UrlSchema.max(512),
    serverFingerprint: base64UrlSchema.max(128),
    attestation: remoteControlEnvironmentAttestationSchema,
    signature: base64UrlSchema.max(256),
  })
  .strict();
export type RemoteControlPairingResponse = z.infer<
  typeof remoteControlPairingResponseSchema
>;

export const remoteControlSessionHelloSchema = z
  .object({
    type: z.literal('hello'),
    protocolVersion: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    clientId: z.string().uuid(),
    timestamp: z.number().int().nonnegative(),
    nonce: base64UrlSchema.max(64),
    ephemeralPublicKey: base64UrlSchema.max(512),
    signature: base64UrlSchema.max(256),
  })
  .strict();
export type RemoteControlSessionHello = z.infer<
  typeof remoteControlSessionHelloSchema
>;

export const remoteControlSessionHelloAckSchema = z
  .object({
    type: z.literal('hello-ack'),
    protocolVersion: z.literal(REMOTE_CONTROL_PROTOCOL_VERSION),
    clientId: z.string().uuid(),
    sessionId: z.string().uuid(),
    clientNonce: base64UrlSchema.max(64),
    serverNonce: base64UrlSchema.max(64),
    ephemeralPublicKey: base64UrlSchema.max(512),
    expiresAt: z.number().int().nonnegative(),
    attestation: remoteControlEnvironmentAttestationSchema,
    signature: base64UrlSchema.max(256),
  })
  .strict();
export type RemoteControlSessionHelloAck = z.infer<
  typeof remoteControlSessionHelloAckSchema
>;

export const remoteControlSecureEnvelopeSchema = z
  .object({
    type: z.literal('secure'),
    sessionId: z.string().uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    ciphertext: base64UrlSchema.max(128 * 1024),
  })
  .strict();
export type RemoteControlSecureEnvelope = z.infer<
  typeof remoteControlSecureEnvelopeSchema
>;

export const remoteControlCommandEnvelopeSchema = z
  .object({
    type: z.literal('command'),
    id: z.string().min(1).max(80),
    command: remoteControlCommandSchema,
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type RemoteControlCommandEnvelope = z.infer<
  typeof remoteControlCommandEnvelopeSchema
>;

export const remoteControlResponseEnvelopeSchema = z
  .object({
    type: z.enum(['result', 'error']),
    replyTo: z.string().min(1).max(80),
    result: z.unknown().optional(),
    error: z.string().max(500).optional(),
  })
  .strict();
export type RemoteControlResponseEnvelope = z.infer<
  typeof remoteControlResponseEnvelopeSchema
>;

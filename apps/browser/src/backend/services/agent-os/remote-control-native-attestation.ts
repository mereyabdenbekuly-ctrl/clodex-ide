import { createHash } from 'node:crypto';
import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  canonicalizeRemotePayload,
  type RemoteControlNativeAttestation,
  type RemoteControlNativeAttestationProvider,
  type RemoteControlPlatform,
  type RemoteControlTrustLevel,
} from '@shared/remote-control-protocol';

const NATIVE_ATTESTATION_CHALLENGE_CONTEXT =
  'clodex.remote.native-attestation.v1';

export type RemoteNativeAttestationFailureReason =
  | 'required'
  | 'provider-mismatch'
  | 'challenge-mismatch'
  | 'unsupported-provider'
  | 'verifier-unavailable'
  | 'invalid'
  | 'expired'
  | 'replayed';

export interface RemoteNativeAttestationPolicy {
  requiredPlatforms?: readonly Extract<
    RemoteControlPlatform,
    'ios' | 'android' | 'desktop'
  >[];
  maxEvidenceAgeMs?: number;
  clockSkewMs?: number;
}

export interface RemoteNativeAttestationVerificationInput {
  evidence: RemoteControlNativeAttestation;
  expectedChallenge: string;
  deviceId: string;
  platform: RemoteControlPlatform;
  protocolVersion: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  signingKeyFingerprint: string;
  now: number;
}

export type RemoteNativeAttestationVerificationResult =
  | {
      verified: true;
      challenge: string;
      issuedAt: number;
      expiresAt: number;
      replayId: string;
    }
  | {
      verified: false;
      reason:
        | 'challenge-mismatch'
        | 'unsupported-provider'
        | 'invalid'
        | 'expired';
    };

export type RemoteNativeAttestationVerifier = (
  input: RemoteNativeAttestationVerificationInput,
) => Promise<RemoteNativeAttestationVerificationResult>;

export interface RemoteClientAttestationTrust {
  trustLevel: RemoteControlTrustLevel;
  provider: RemoteControlNativeAttestationProvider | null;
  verifiedAt: number | null;
  verdict: 'software-only' | 'verified';
}

export interface VerifiedRemoteNativeAttestation
  extends RemoteClientAttestationTrust {
  trustLevel: 'hardware-backed';
  provider: RemoteControlNativeAttestationProvider;
  verifiedAt: number;
  verdict: 'verified';
  expiresAt: number;
  replayKeys: readonly string[];
}

export function createRemoteNativeAttestationChallenge(input: {
  pairingNonce: string;
  deviceId: string;
  signingKeyFingerprint: string;
  protocolVersion?: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
}): string {
  const payload = canonicalizeRemotePayload({
    context: NATIVE_ATTESTATION_CHALLENGE_CONTEXT,
    protocolVersion: input.protocolVersion ?? REMOTE_CONTROL_PROTOCOL_VERSION,
    pairingNonce: input.pairingNonce,
    deviceId: input.deviceId,
    signingKeyFingerprint: input.signingKeyFingerprint,
  });
  return createHash('sha256').update(payload, 'utf8').digest('base64url');
}

export function createSoftwareRemoteClientTrust(): RemoteClientAttestationTrust {
  return {
    trustLevel: 'software',
    provider: null,
    verifiedAt: null,
    verdict: 'software-only',
  };
}

export function isHardwareAttestationRequired(
  platform: RemoteControlPlatform,
  policy: RemoteNativeAttestationPolicy | undefined,
): boolean {
  return (
    (platform === 'ios' || platform === 'android' || platform === 'desktop') &&
    (policy?.requiredPlatforms?.includes(platform) ?? false)
  );
}

export function isProviderCompatibleWithPlatform(
  provider: RemoteControlNativeAttestationProvider,
  platform: RemoteControlPlatform,
): boolean {
  switch (provider) {
    case 'apple-app-attest':
      return platform === 'ios';
    case 'android-play-integrity':
      return platform === 'android';
    case 'apple-secure-enclave':
    case 'tpm':
      return platform === 'desktop';
  }
}

export function createRemoteNativeAttestationReplayKeys(
  evidence: RemoteControlNativeAttestation,
  replayId: string,
): readonly string[] {
  return [
    hashReplayMaterial(
      evidence.provider,
      'evidence',
      canonicalizeRemotePayload(evidence),
    ),
    hashReplayMaterial(evidence.provider, 'verifier', replayId),
  ];
}

export function validateVerifiedRemoteNativeAttestation(
  input: RemoteNativeAttestationVerificationInput,
  result: RemoteNativeAttestationVerificationResult,
  policy: RemoteNativeAttestationPolicy | undefined,
): VerifiedRemoteNativeAttestation | RemoteNativeAttestationFailureReason {
  if (!result.verified) return result.reason;
  if (result.challenge !== input.expectedChallenge) {
    return 'challenge-mismatch';
  }
  const clockSkewMs = policy?.clockSkewMs ?? 30_000;
  const maxEvidenceAgeMs = policy?.maxEvidenceAgeMs ?? 5 * 60_000;
  if (
    !Number.isSafeInteger(result.issuedAt) ||
    !Number.isSafeInteger(result.expiresAt) ||
    result.issuedAt < 0 ||
    result.expiresAt <= result.issuedAt ||
    result.issuedAt > input.now + clockSkewMs ||
    result.expiresAt <= input.now ||
    input.now - result.issuedAt > maxEvidenceAgeMs
  ) {
    return 'expired';
  }
  if (
    typeof result.replayId !== 'string' ||
    result.replayId.length < 1 ||
    result.replayId.length > 1024
  ) {
    return 'invalid';
  }
  return {
    trustLevel: 'hardware-backed',
    provider: input.evidence.provider,
    verifiedAt: input.now,
    verdict: 'verified',
    expiresAt: result.expiresAt,
    replayKeys: createRemoteNativeAttestationReplayKeys(
      input.evidence,
      result.replayId,
    ),
  };
}

export function createRemoteNativeAttestationVerifier(
  providers: Partial<
    Record<
      RemoteControlNativeAttestationProvider,
      RemoteNativeAttestationVerifier
    >
  >,
): RemoteNativeAttestationVerifier {
  return async (input) => {
    const verifier = providers[input.evidence.provider];
    if (!verifier) {
      return { verified: false, reason: 'unsupported-provider' };
    }
    return await verifier(input);
  };
}

function hashReplayMaterial(
  provider: RemoteControlNativeAttestationProvider,
  scope: 'evidence' | 'verifier',
  value: string,
): string {
  return createHash('sha256')
    .update(`${provider}:${scope}:`, 'utf8')
    .update(value, 'utf8')
    .digest('base64url');
}

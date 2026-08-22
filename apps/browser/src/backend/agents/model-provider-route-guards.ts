import { createHash } from 'node:crypto';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { UserPreferences } from '@shared/karton-contracts/ui/shared-types';
import type { AuthState } from '@/services/auth';
import { isPlainObject } from './model-provider-options';

export function guardRevocableModelRoute(
  model: LanguageModelV3,
  isValid: () => boolean,
): LanguageModelV3 {
  const assertValid = () => {
    if (!isValid()) {
      throw new Error('Model route was revoked before request dispatch');
    }
  };
  const doGenerate: LanguageModelV3['doGenerate'] = (options) => {
    assertValid();
    return model.doGenerate(options);
  };
  const doStream: LanguageModelV3['doStream'] = (options) => {
    assertValid();
    return model.doStream(options);
  };
  return new Proxy(model, {
    get(target, property, receiver) {
      if (property === 'doGenerate') return doGenerate;
      if (property === 'doStream') return doStream;
      return Reflect.get(target, property, receiver);
    },
  });
}

export function getPreferencesRouteAuthorityFingerprint(
  preferences: UserPreferences,
): string {
  return JSON.stringify({
    providerConfigs: preferences.providerConfigs,
    providerProfiles: preferences.providerProfiles,
    defaultProviderProfileId: preferences.defaultProviderProfileId,
    customEndpoints: preferences.customEndpoints,
    customModels: preferences.customModels,
  });
}

export function getAuthRouteAuthorityFingerprint(authState: AuthState): string {
  return JSON.stringify({
    models: authState.models ?? [],
    keys: (authState.keys ?? []).map((key) => ({
      id: key.id,
      name: key.name,
      group: key.group,
      status: key.status,
      isDefault: key.isDefault,
      modelLimitsEnabled: key.modelLimitsEnabled,
      modelLimits: key.modelLimits,
      protocols: key.protocols,
      baseUrls: key.baseUrls,
    })),
    activeKeyId: authState.activeKeyId,
    ideTokenKeyIdentity: authState.ideToken
      ? {
          keyId: authState.ideToken.keyId,
          group: authState.ideToken.group,
        }
      : undefined,
  });
}

export function isManagedCredentialRejection(error: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const { value: current, depth } = pending.shift()!;
    if (!(current instanceof Error) && !isPlainObject(current)) continue;
    if (seen.has(current)) continue;
    seen.add(current);

    const frame = current as Record<string, unknown>;
    const statusCode = frame.statusCode ?? frame.status;
    if (statusCode === 401) return true;

    const errorText = [frame.message, frame.code, frame.responseBody]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    if (
      errorText.includes('invalid api key') ||
      errorText.includes('invalid_api_key')
    ) {
      return true;
    }

    if (depth >= 3) continue;
    for (const nested of [
      frame.lastError,
      frame.cause,
      frame.responseBody,
      frame.error,
    ]) {
      if (nested instanceof Error || isPlainObject(nested)) {
        pending.push({ value: nested, depth: depth + 1 });
      }
    }
  }
  return false;
}

export function fingerprintManagedCredential(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function guardManagedModelCredential(
  model: LanguageModelV3,
  onCredentialRejected: () => void,
): LanguageModelV3 {
  const doGenerate: LanguageModelV3['doGenerate'] = async (options) => {
    try {
      return await model.doGenerate(options);
    } catch (error) {
      if (isManagedCredentialRejection(error)) onCredentialRejected();
      throw error;
    }
  };
  const doStream: LanguageModelV3['doStream'] = async (options) => {
    try {
      return await model.doStream(options);
    } catch (error) {
      if (isManagedCredentialRejection(error)) onCredentialRejected();
      throw error;
    }
  };
  return new Proxy(model, {
    get(target, property, receiver) {
      if (property === 'doGenerate') return doGenerate;
      if (property === 'doStream') return doStream;
      return Reflect.get(target, property, receiver);
    },
  });
}

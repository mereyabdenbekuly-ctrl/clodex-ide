import { shell } from 'electron';

export const CLODEX_ORIGIN = process.env.CLODEX_ORIGIN || 'https://clodex.xyz';
export const CLODEX_API_URL =
  process.env.CLODEX_API_URL || process.env.API_URL || `${CLODEX_ORIGIN}/api`;
export const CLODEX_LLM_RELAY_URL =
  process.env.CLODEX_LLM_RELAY_URL || `${CLODEX_ORIGIN}/v1`;

const IDE_CLIENT_ID = process.env.CLODEX_IDE_CLIENT_ID || 'clodex-ide';

type ClodexUser = {
  id: string;
  email?: string;
  name?: string;
  username?: string;
  displayName?: string;
  group?: string;
  quota?: number;
  usedQuota?: number;
  requestCount?: number;
  balance?: ClodexBalance;
};

export type ClodexSession = {
  accessToken: string;
  user?: ClodexUser;
  expiresAt?: string;
};

type ClodexIdeToken = {
  token: string;
  expiresAt?: string;
  keyId?: string;
  keyName?: string;
  group?: string;
};

type ClodexIdeTokenRequestRoute = {
  provider?: string;
  modelId?: string;
  group?: string;
};

type ClodexIdeKey = {
  id: string;
  name: string;
  group?: string;
  status?: string;
  isDefault?: boolean;
  modelLimitsEnabled?: boolean;
  modelLimits?: string[];
  protocols?: string[];
  baseUrls?: {
    openai?: string;
    anthropic?: string;
    google?: string;
  };
  expiresAt?: string;
};

type ClodexTelegramStart = {
  token: string;
  botName?: string;
  expiresAt?: number;
  telegramUrl: string;
};

type ClodexTelegramStatus = {
  status:
    | 'pending'
    | 'consumed'
    | 'delivered'
    | 'expired'
    | 'failed'
    | 'not_found';
  message?: string;
  user?: ClodexUser;
  created?: boolean;
  accessToken?: string;
  cookieHeader?: string;
};

type ClodexUserModel = {
  id: string;
  name?: string;
  provider?: string;
  protocols?: string[];
  enabled?: boolean;
  costTier?: 'free' | 'low' | 'medium' | 'high';
  taskRoles?: ('analysis' | 'coding' | 'review' | 'general')[];
  contextWindow?: number;
};

type ClodexBalance = {
  amount?: number;
  currency?: string;
  display?: string;
  rawQuota?: number;
  updatedAt?: string;
};
export type { ClodexBalance, ClodexIdeKey, ClodexUser, ClodexUserModel };

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function readNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function unwrapApiData(value: unknown): unknown {
  if (!isRecord(value) || !('success' in value)) return value;

  if (value.success === false) {
    const error = isRecord(value.error) ? value.error : null;
    const message =
      error && typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : typeof value.error === 'string' && value.error.length > 0
          ? value.error
          : typeof value.message === 'string' && value.message.length > 0
            ? value.message
            : 'Clodex request failed.';
    const code = error
      ? readString(error, ['code'])
      : readString(value, ['code']);
    throw new ClodexRequestError(message, 200, code);
  }

  return 'data' in value ? value.data : value;
}

function readApiError(value: unknown, fallbackStatus: number) {
  if (!isRecord(value)) {
    return {
      message: `Clodex request failed with status ${fallbackStatus}.`,
      code: undefined,
    };
  }

  const error = isRecord(value.error) ? value.error : null;
  const message =
    error && typeof error.message === 'string' && error.message.length > 0
      ? error.message
      : typeof value.error === 'string' && value.error.length > 0
        ? value.error
        : typeof value.message === 'string' && value.message.length > 0
          ? value.message
          : `Clodex request failed with status ${fallbackStatus}.`;
  const code = error
    ? readString(error, ['code'])
    : readString(value, ['code']);

  return { message, code };
}

function readSelf(value: unknown): ClodexUser | undefined {
  const data = unwrapApiData(value);

  if (isRecord(value)) {
    const rootUser = 'user' in value ? readUser(value.user) : undefined;
    const dataUser = readUser(data);
    const nestedDataUser =
      isRecord(data) && 'user' in data ? readUser(data.user) : undefined;
    const user = rootUser ?? nestedDataUser ?? dataUser;
    if (user) {
      const balance =
        readBalance(value.balance) ??
        (isRecord(data) ? readBalance(data.balance) : undefined) ??
        user.balance;
      return { ...user, balance };
    }
  }

  return readUser(data);
}

function readUser(value: unknown): ClodexUser | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value, ['id', 'userId', 'user_id', 'sub']);
  if (!id) return undefined;
  const username = readString(value, ['username', 'userName', 'user_name']);
  const displayName = readString(value, ['displayName', 'display_name']);
  const name = readString(value, ['name']) ?? displayName ?? username;
  return {
    id,
    email: readString(value, ['email']),
    name,
    username,
    displayName,
    group: readString(value, ['group', 'userGroup', 'user_group']),
    quota: readNumber(value, ['quota']),
    usedQuota: readNumber(value, ['usedQuota', 'used_quota']),
    requestCount: readNumber(value, ['requestCount', 'request_count']),
    balance: readBalance(value.balance) ?? readQuotaBalance(value),
  };
}

function readBalance(value: unknown): ClodexBalance | undefined {
  if (!isRecord(value)) return undefined;

  return {
    amount: readNumber(value, ['amount', 'balance', 'available']),
    currency: readString(value, ['currency']),
    display: readString(value, ['display', 'formatted', 'formattedBalance']),
    rawQuota: readNumber(value, ['rawQuota', 'raw_quota', 'quota']),
    updatedAt: readString(value, ['updatedAt', 'updated_at']),
  };
}

function readQuotaBalance(value: unknown): ClodexBalance | undefined {
  if (!isRecord(value)) return undefined;

  const rawQuota = readNumber(value, ['quota']);
  if (typeof rawQuota !== 'number') return undefined;

  const amount = rawQuota / 500_000;
  return {
    amount,
    currency: 'USD',
    display: `$${amount.toFixed(2)}`,
    rawQuota,
  };
}

function readSession(value: unknown): ClodexSession {
  const data = unwrapApiData(value);
  if (!isRecord(data)) {
    throw new Error('Clodex auth exchange returned an invalid response.');
  }

  const accessToken = readString(data, [
    'accessToken',
    'access_token',
    'token',
  ]);
  if (!accessToken) {
    throw new Error('Clodex auth exchange did not return an access token.');
  }

  return {
    accessToken,
    user: readSelf(data),
    expiresAt: readString(data, ['expiresAt', 'expires_at']),
  };
}

function readIdeToken(value: unknown): ClodexIdeToken {
  const data = unwrapApiData(value);
  const root = isRecord(value) ? value : {};
  if (!isRecord(data)) {
    throw new Error('Clodex IDE token endpoint returned an invalid response.');
  }

  const token =
    readString(data, [
      'ideModelToken',
      'ide_model_token',
      'accessToken',
      'access_token',
      'token',
    ]) ??
    readString(root, [
      'ideModelToken',
      'ide_model_token',
      'accessToken',
      'access_token',
      'token',
    ]);
  if (!token) {
    throw new Error('Clodex IDE token endpoint did not return a token.');
  }

  return {
    token,
    expiresAt:
      readString(data, ['expiresAt', 'expires_at']) ??
      readString(root, ['expiresAt', 'expires_at']),
    keyId:
      readString(data, ['keyId', 'key_id']) ??
      readString(root, ['keyId', 'key_id']),
    keyName:
      readString(data, ['keyName', 'key_name']) ??
      readString(root, ['keyName', 'key_name']),
    group:
      readString(data, ['group', 'groupName', 'group_name']) ??
      readString(root, ['group', 'groupName', 'group_name']),
  };
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
  return strings.length > 0 ? strings : undefined;
}

function readBaseUrls(value: unknown): ClodexIdeKey['baseUrls'] {
  if (!isRecord(value)) return undefined;
  const openai = readString(value, ['openai', 'openAI', 'openaiCompatible']);
  const anthropic = readString(value, ['anthropic', 'anthropicCompatible']);
  const google = readString(value, ['google', 'gemini', 'googleCompatible']);
  if (!openai && !anthropic && !google) return undefined;
  return { openai, anthropic, google };
}

function readIdeKey(value: unknown): ClodexIdeKey | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value, ['id', 'keyId', 'key_id']);
  if (!id) return undefined;

  return {
    id,
    name:
      readString(value, ['name', 'keyName', 'key_name', 'displayName']) ??
      `Key ${id}`,
    group: readString(value, ['group', 'groupName', 'group_name']),
    status: readString(value, ['status']),
    isDefault:
      typeof value.isDefault === 'boolean'
        ? value.isDefault
        : typeof value.is_default === 'boolean'
          ? value.is_default
          : undefined,
    modelLimitsEnabled:
      typeof value.modelLimitsEnabled === 'boolean'
        ? value.modelLimitsEnabled
        : typeof value.model_limits_enabled === 'boolean'
          ? value.model_limits_enabled
          : undefined,
    modelLimits:
      readStringArray(value.modelLimits) ?? readStringArray(value.model_limits),
    protocols: readStringArray(value.protocols),
    baseUrls: readBaseUrls(value.baseUrls ?? value.base_urls),
    expiresAt: readString(value, ['expiresAt', 'expires_at']),
  };
}

function readIdeKeys(value: unknown): ClodexIdeKey[] {
  const data = unwrapApiData(value);
  const rawKeys = isRecord(data) && Array.isArray(data.keys) ? data.keys : data;
  if (!Array.isArray(rawKeys)) return [];
  return rawKeys.flatMap((key): ClodexIdeKey[] => {
    const parsed = readIdeKey(key);
    return parsed ? [parsed] : [];
  });
}

function readUserModels(value: unknown): ClodexUserModel[] {
  const data = unwrapApiData(value);
  const rawModels =
    isRecord(data) && Array.isArray(data.models) ? data.models : data;
  if (!Array.isArray(rawModels)) return [];

  return rawModels.flatMap((model): ClodexUserModel[] => {
    if (typeof model === 'string') return [{ id: model }];
    if (!isRecord(model)) return [];
    const id = readString(model, ['id', 'model', 'modelId', 'model_id']);
    if (!id) return [];
    return [
      {
        id,
        name: readString(model, ['name', 'displayName', 'display_name']),
        provider: readString(model, ['provider', 'providerName']),
        protocols: readStringArray(model.protocols),
        enabled: typeof model.enabled === 'boolean' ? model.enabled : undefined,
        costTier: readCostTier(model.costTier ?? model.cost_tier),
        taskRoles: readTaskRoles(model.taskRoles ?? model.task_roles),
        contextWindow: readNumber(model, ['contextWindow', 'context_window']),
      },
    ];
  });
}

function readCostTier(value: unknown): ClodexUserModel['costTier'] {
  if (typeof value !== 'string') return undefined;
  if (
    value === 'free' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high'
  ) {
    return value;
  }
  return undefined;
}

function readTaskRoles(value: unknown): ClodexUserModel['taskRoles'] {
  if (!Array.isArray(value)) return undefined;
  const roles = value.filter(
    (item): item is NonNullable<ClodexUserModel['taskRoles']>[number] =>
      item === 'analysis' ||
      item === 'coding' ||
      item === 'review' ||
      item === 'general',
  );
  return roles.length > 0 ? roles : undefined;
}

function readTelegramStart(value: unknown): ClodexTelegramStart {
  const data = unwrapApiData(value);
  if (!isRecord(data)) {
    throw new Error('Clodex Telegram login returned an invalid response.');
  }

  const token = readString(data, ['token']);
  const telegramUrl = readString(data, ['telegram_url', 'telegramUrl']);
  if (!token || !telegramUrl) {
    throw new Error('Clodex Telegram login did not return a Telegram URL.');
  }

  return {
    token,
    botName: readString(data, ['bot_name', 'botName']),
    expiresAt: readNumber(data, ['expires_at', 'expiresAt']),
    telegramUrl,
  };
}

function readTelegramStatus(value: unknown): ClodexTelegramStatus {
  const data = unwrapApiData(value);
  if (!isRecord(data)) {
    throw new Error('Clodex Telegram status returned an invalid response.');
  }

  const status = readString(data, ['status']);
  if (
    status !== 'pending' &&
    status !== 'consumed' &&
    status !== 'delivered' &&
    status !== 'expired' &&
    status !== 'failed' &&
    status !== 'not_found'
  ) {
    throw new Error('Clodex Telegram status returned an unknown state.');
  }

  return {
    status,
    message: readString(data, ['message']),
    user: readSelf(data.user),
    accessToken: readString(data, ['accessToken', 'access_token', 'token']),
    created: typeof data.created === 'boolean' ? data.created : undefined,
  };
}

function readAccessToken(value: unknown): string {
  const data = unwrapApiData(value);
  if (typeof data === 'string' && data.length > 0) return data;
  if (isRecord(data)) {
    const token = readString(data, ['accessToken', 'access_token', 'token']);
    if (token) return token;
  }

  throw new Error('Clodex did not return an access token.');
}

export class ClodexRequestError extends Error {
  public readonly status: number;
  public readonly code?: string;

  public constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ClodexRequestError';
    this.status = status;
    this.code = code;
  }
}

function shouldTryLegacyTelegramEndpoint(err: unknown): boolean {
  return (
    err instanceof ClodexRequestError &&
    (err.status === 404 || err.status === 405)
  );
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  parse: (value: unknown) => T,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  let payload: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }

  if (!response.ok) {
    const { message, code } = readApiError(payload, response.status);
    throw new ClodexRequestError(message, response.status, code);
  }

  return parse(payload);
}

async function requestJsonWithResponse<T>(
  url: string,
  init: RequestInit,
  parse: (value: unknown, response: Response) => T,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  let payload: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }

  if (!response.ok) {
    const { message, code } = readApiError(payload, response.status);
    throw new ClodexRequestError(message, response.status, code);
  }

  return parse(payload, response);
}

function bearerHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function splitCombinedSetCookieHeader(header: string): string[] {
  return header.split(/,(?=\s*[^;,=\s]+=[^;]+)/g).map((value) => value.trim());
}

function getSetCookieHeaders(headers: Headers): string[] {
  const headersWithCookies = headers as Headers & {
    getSetCookie?: () => string[];
    raw?: () => Record<string, string[] | undefined>;
  };

  const setCookie = headersWithCookies.getSetCookie?.();
  if (setCookie && setCookie.length > 0) return setCookie;

  const rawSetCookie = headersWithCookies.raw?.()['set-cookie'];
  if (rawSetCookie && rawSetCookie.length > 0) return rawSetCookie;

  const combined = headers.get('set-cookie');
  return combined ? splitCombinedSetCookieHeader(combined) : [];
}

function toCookieHeader(setCookieHeaders: string[]): string | undefined {
  const cookiePairs = setCookieHeaders
    .map((cookie) => cookie.split(';', 1)[0]?.trim())
    .filter((cookie): cookie is string => Boolean(cookie));

  return cookiePairs.length > 0 ? cookiePairs.join('; ') : undefined;
}

export async function openClodexTelegramInSystemApp(
  login: ClodexTelegramStart,
): Promise<void> {
  if (login.botName) {
    const deepLink = new URL('tg://resolve');
    deepLink.searchParams.set('domain', login.botName);
    deepLink.searchParams.set('start', login.token);
    try {
      await shell.openExternal(deepLink.toString(), { activate: true });
      return;
    } catch {
      // Fall back to the https://t.me link returned by Clodex below.
    }
  }

  await shell.openExternal(login.telegramUrl, { activate: true });
}

export class ClodexAuthInterop {
  public async exchangePkceAuthorizationCode(options: {
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    signal?: AbortSignal;
  }): Promise<ClodexSession> {
    return requestJson(
      joinUrl(CLODEX_API_URL, '/v1/auth/electron/token'),
      {
        method: 'POST',
        signal: options.signal,
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: options.clientId,
          redirect_uri: options.redirectUri,
          code: options.code,
          code_verifier: options.codeVerifier,
        }),
      },
      readSession,
    );
  }

  public async startTelegramLogin(): Promise<ClodexTelegramStart> {
    try {
      return await requestJson(
        joinUrl(CLODEX_API_URL, '/ide/auth/telegram/start'),
        {
          method: 'POST',
          body: JSON.stringify({ client_id: IDE_CLIENT_ID }),
        },
        readTelegramStart,
      );
    } catch (err) {
      if (!shouldTryLegacyTelegramEndpoint(err)) throw err;

      return requestJson(
        joinUrl(CLODEX_API_URL, '/oauth/telegram/start'),
        {
          method: 'POST',
          body: JSON.stringify({ mode: 'login' }),
        },
        readTelegramStart,
      );
    }
  }

  public async getTelegramLoginStatus(
    token: string,
  ): Promise<ClodexTelegramStatus> {
    const readStatus = (path: string) => {
      const url = new URL(joinUrl(CLODEX_API_URL, path));
      url.searchParams.set('token', token);

      return requestJsonWithResponse(
        url.toString(),
        { method: 'GET' },
        (payload, response) => ({
          ...readTelegramStatus(payload),
          cookieHeader: toCookieHeader(getSetCookieHeaders(response.headers)),
        }),
      );
    };

    try {
      return await readStatus('/ide/auth/telegram/status');
    } catch (err) {
      if (!shouldTryLegacyTelegramEndpoint(err)) throw err;
      return readStatus('/oauth/telegram/status');
    }
  }

  public async exchangeDashboardSessionForAccessToken(
    cookieHeader: string,
    userId?: string,
  ): Promise<string> {
    return requestJson(
      joinUrl(CLODEX_API_URL, '/user/token'),
      {
        method: 'GET',
        headers: {
          Cookie: cookieHeader,
          ...(userId ? { 'New-Api-User': userId } : {}),
        },
      },
      readAccessToken,
    );
  }

  public async getSelf(accessToken: string): Promise<ClodexUser | undefined> {
    return requestJson(
      joinUrl(CLODEX_API_URL, '/ide/user/self'),
      { method: 'GET', headers: bearerHeaders(accessToken) },
      readSelf,
    );
  }

  public async getIdeKeys(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<ClodexIdeKey[]> {
    return requestJson(
      joinUrl(CLODEX_API_URL, '/ide/keys'),
      { method: 'GET', headers: bearerHeaders(accessToken), signal },
      readIdeKeys,
    );
  }

  public async createIdeToken(
    accessToken: string,
    keyId?: string,
    route?: ClodexIdeTokenRequestRoute,
    signal?: AbortSignal,
  ): Promise<ClodexIdeToken> {
    const url = new URL(joinUrl(CLODEX_API_URL, '/ide/token'));
    if (keyId) url.searchParams.set('keyId', keyId);
    if (route?.provider) url.searchParams.set('provider', route.provider);
    if (route?.modelId) url.searchParams.set('modelId', route.modelId);
    if (route?.group) url.searchParams.set('group', route.group);

    const body =
      keyId || route?.provider || route?.modelId
        ? {
            ...(keyId ? { keyId } : {}),
            ...(route?.provider ? { provider: route.provider } : {}),
            ...(route?.modelId ? { modelId: route.modelId } : {}),
            ...(route?.group ? { group: route.group } : {}),
          }
        : undefined;

    return requestJson(
      url.toString(),
      {
        method: 'POST',
        headers: bearerHeaders(accessToken),
        signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      readIdeToken,
    );
  }

  public async getUserModels(
    accessToken: string,
    keyId?: string,
  ): Promise<ClodexUserModel[]> {
    const url = new URL(joinUrl(CLODEX_API_URL, '/ide/user/models'));
    if (keyId) url.searchParams.set('keyId', keyId);

    return requestJson(
      url.toString(),
      { method: 'GET', headers: bearerHeaders(accessToken) },
      readUserModels,
    );
  }
}

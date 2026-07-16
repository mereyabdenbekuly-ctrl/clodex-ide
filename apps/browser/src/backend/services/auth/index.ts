import type { KartonContract } from '@shared/karton-contracts/ui';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import {
  createBetterAuthClient,
  type BetterAuthClient,
} from './server-interop';
import {
  ClodexAuthInterop,
  ClodexRequestError,
  type ClodexIdeKey,
  type ClodexUserModel,
  openClodexLoginInSystemBrowser,
  openClodexTelegramInSystemApp,
} from './clodex';
import type {
  ModelProvider,
  SocialAuthProvider,
} from '@shared/karton-contracts/ui/shared-types';
import { ALL_CALLBACK_PROTOCOLS } from './callback-scheme';
import type { DevLoopbackAuthServer } from './dev-loopback-auth';
import type { NotificationService } from '../notification';
import type { IdentifierService } from '../identifier';
import { DisposableService } from '../disposable';
import { z } from 'zod';
import {
  readPersistedData,
  writePersistedData,
} from '../../utils/persisted-data';
import {
  validateApiKeys,
  type ApiKeysInput,
} from '../../utils/validate-api-keys';
import {
  normalizeIdeTokenExpiresAt,
  parseIdeTokenExpiresAt,
} from './token-expiry';

const CREDENTIALS_KEY = 'auth-session' as const;
const CREDENTIALS_STORAGE_OPTIONS = {
  encrypt: true,
  requireEncryption: true,
  allowPlaintextMigration: true,
} as const;

const credentialsSchema = z
  .object({
    token: z.string(),
    user: z
      .object({
        id: z.string(),
        email: z.string().optional(),
        name: z.string().optional(),
        username: z.string().optional(),
        displayName: z.string().optional(),
        group: z.string().optional(),
      })
      .optional(),
    activeKeyId: z.string().optional(),
  })
  .nullable();

type StoredCredentials = z.infer<typeof credentialsSchema>;

export type AuthState = KartonContract['state']['userAccount'];

type AuthUser = NonNullable<AuthState['user']>;
type AuthBalance = NonNullable<AuthState['balance']>;
type AuthModel = NonNullable<AuthState['models']>[number];
type AuthKey = NonNullable<AuthState['keys']>[number];

const SESSION_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SOCIAL_AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const TELEGRAM_AUTH_POLL_INTERVAL_MS = 2 * 1000;
const TELEGRAM_AUTH_TIMEOUT_MS = SOCIAL_AUTH_TIMEOUT_MS;
const ACCOUNT_AUTH_DISABLED_ERROR =
  'Account sign-in is disabled in this distribution.';
const isAccountAuthEnabled = __APP_AUTH_ENABLED__;
const IDE_MODEL_TOKEN_REFRESH_SKEW_MS = 60_000;
const isClodexAuthEnabled =
  isAccountAuthEnabled &&
  process.env.CLODEX_AUTH_ENABLED !== 'false' &&
  Boolean(process.env.CLODEX_API_URL || process.env.CLODEX_ORIGIN);

type IdeModelTokenCacheEntry = {
  token: string;
  expiresAt?: string;
  keyId?: string;
  keyName?: string;
  group?: string;
};

type ModelAccessRoute = {
  provider?: ModelProvider | string;
  modelId?: string;
};

const MODEL_PROVIDER_ALIASES: Record<ModelProvider, string[]> = {
  anthropic: ['anthropic', 'claude', 'opus', 'sonnet', 'haiku'],
  openai: ['openai', 'gpt', 'o1', 'o3', 'o4'],
  google: ['google', 'gemini'],
  moonshotai: ['moonshotai', 'moonshot', 'kimi'],
  alibaba: ['alibaba', 'qwen', 'dashscope'],
  deepseek: ['deepseek'],
  'z-ai': ['z-ai', 'zai', 'glm'],
  minimax: ['minimax'],
  'xiaomi-mimo': ['xiaomi-mimo', 'xiaomi', 'mimo'],
  mistral: ['mistral', 'mistralai'],
};

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

function inferProviderFromText(value: string | undefined): Set<ModelProvider> {
  const providers = new Set<ModelProvider>();
  if (!value) return providers;
  const normalized = normalizeToken(value);
  for (const [provider, aliases] of Object.entries(MODEL_PROVIDER_ALIASES) as [
    ModelProvider,
    string[],
  ][]) {
    if (aliases.some((alias) => normalized.includes(alias))) {
      providers.add(provider);
    }
  }
  return providers;
}

function normalizeRouteProvider(
  provider: ModelAccessRoute['provider'],
  modelId?: string,
): ModelProvider | undefined {
  const normalizedProvider =
    typeof provider === 'string' ? normalizeToken(provider) : undefined;
  for (const candidate of Object.keys(
    MODEL_PROVIDER_ALIASES,
  ) as ModelProvider[]) {
    if (candidate === normalizedProvider) return candidate;
  }

  const providerSignals = inferProviderFromText(normalizedProvider);
  if (providerSignals.size > 0) return [...providerSignals][0];

  const modelSignals = inferProviderFromText(modelId);
  return modelSignals.size > 0 ? [...modelSignals][0] : undefined;
}

function getBareRouteModelId(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  return modelId.split('/').pop() ?? modelId;
}

function clodexKeyStatusAllowsUse(key: ClodexIdeKey): boolean {
  if (!key.status) return true;
  const status = normalizeToken(key.status);
  return !['disabled', 'expired', 'inactive', 'revoked', 'blocked'].includes(
    status,
  );
}

function clodexKeyProviderSignals(key: ClodexIdeKey): Set<ModelProvider> {
  const signals = new Set<ModelProvider>();
  for (const value of [key.name, key.group, ...(key.protocols ?? [])]) {
    for (const provider of inferProviderFromText(value)) signals.add(provider);
  }
  if (key.baseUrls) {
    for (const provider of Object.keys(key.baseUrls) as ModelProvider[]) {
      if (key.baseUrls[provider as keyof typeof key.baseUrls]) {
        signals.add(provider);
      }
    }
  }
  for (const limit of key.modelLimits ?? []) {
    for (const provider of inferProviderFromText(limit)) signals.add(provider);
  }
  return signals;
}

function clodexKeyIsUniversalAll(key: ClodexIdeKey): boolean {
  return normalizeToken(key.group ?? '') === 'all';
}

function clodexGroupIsUniversalAll(group: string | undefined): boolean {
  return normalizeToken(group ?? '') === 'all';
}

function clodexRuntimeGroupForProvider(
  provider: ModelProvider,
): string | undefined {
  switch (provider) {
    case 'openai':
      return 'GPT';
    case 'anthropic':
      return 'CLAUDE';
    case 'google':
      return 'GEMINI';
    default:
      return undefined;
  }
}

function clodexKeyMatchesModelLimit(
  key: ClodexIdeKey,
  provider: ModelProvider,
  modelId?: string,
): boolean {
  if (!modelId || !key.modelLimits || key.modelLimits.length === 0) {
    return false;
  }

  const bareModelId = getBareRouteModelId(modelId) ?? modelId;
  const normalizedModelId = normalizeToken(modelId);
  const normalizedBareModelId = normalizeToken(bareModelId);
  const candidates = new Set([
    normalizedModelId,
    normalizedBareModelId,
    `${provider}/${normalizedModelId}`,
    `${provider}/${normalizedBareModelId}`,
  ]);

  return key.modelLimits.some((limit) => {
    const normalizedLimit = normalizeToken(limit);
    if (candidates.has(normalizedLimit)) return true;
    if (normalizedLimit === provider || normalizedLimit === `${provider}/*`) {
      return true;
    }
    if (
      normalizedLimit.startsWith(`${provider}/`) &&
      normalizedLimit.endsWith('*')
    ) {
      return true;
    }
    return normalizedLimit.endsWith(`/${normalizedBareModelId}`);
  });
}

function scoreClodexKeyForRoute({
  key,
  provider,
  modelId,
  activeKeyId,
}: {
  key: ClodexIdeKey;
  provider: ModelProvider;
  modelId?: string;
  activeKeyId?: string;
}): number {
  if (!clodexKeyStatusAllowsUse(key)) return Number.NEGATIVE_INFINITY;

  const modelLimitMatch = clodexKeyMatchesModelLimit(key, provider, modelId);
  if (key.modelLimitsEnabled && !modelLimitMatch) {
    return Number.NEGATIVE_INFINITY;
  }

  const providerSignals = clodexKeyProviderSignals(key);

  let score = 0;
  if (modelLimitMatch) score += 100;
  if (clodexKeyIsUniversalAll(key)) score += 120;
  if (providerSignals.has(provider)) score += 50;
  if (providerSignals.size === 0 || key.isDefault) score += 5;
  if (activeKeyId && String(key.id) === String(activeKeyId)) score += 200;
  return score;
}

function formatRouteTokenCacheKey({
  keyId,
  provider,
  modelId,
}: {
  keyId: string;
  provider: ModelProvider;
  modelId?: string;
}): string {
  return [keyId, provider, normalizeToken(modelId ?? '*')].join(':');
}

function formatProviderLabel(provider: ModelProvider): string {
  switch (provider) {
    case 'anthropic':
      return 'Anthropic';
    case 'openai':
      return 'OpenAI';
    case 'google':
      return 'Google/Gemini';
    case 'moonshotai':
      return 'Moonshot/Kimi';
    case 'alibaba':
      return 'Alibaba/Qwen';
    case 'deepseek':
      return 'DeepSeek';
    case 'z-ai':
      return 'Z.ai/GLM';
    case 'minimax':
      return 'MiniMax';
    case 'xiaomi-mimo':
      return 'Xiaomi MiMo';
    case 'mistral':
      return 'Mistral';
  }
}

export class AuthService extends DisposableService {
  private readonly identifierService: IdentifierService;
  private readonly uiKarton: KartonService;
  private readonly notificationService: NotificationService;
  private readonly logger: Logger;

  private _credentials: StoredCredentials = null;
  private clodexInterop: ClodexAuthInterop;
  private authClient: BetterAuthClient;
  private ideModelToken: {
    token: string;
    expiresAt?: string;
    keyId?: string;
    keyName?: string;
    group?: string;
  } | null = null;
  private ideModelTokenByKeyId = new Map<string, IdeModelTokenCacheEntry>();
  private pendingIdeModelTokenRefreshes = new Map<
    string,
    Promise<string | undefined>
  >();
  private clodexUserModels: ClodexUserModel[] = [];
  private clodexIdeKeys: ClodexIdeKey[] = [];

  private _refreshInterval: NodeJS.Timeout | null = null;
  private authChangeCallbacks: ((newAuthState: AuthState) => void)[] = [];
  private pendingHandoffAuth: {
    resolve: (result: { error?: string }) => void;
    timeout: NodeJS.Timeout;
  } | null = null;
  private activeLoopbackAuthServer: DevLoopbackAuthServer | null = null;

  private constructor(
    identifierService: IdentifierService,
    uiKarton: KartonService,
    notificationService: NotificationService,
    logger: Logger,
  ) {
    super();
    this.identifierService = identifierService;
    this.uiKarton = uiKarton;
    this.notificationService = notificationService;
    this.logger = logger;
    this.clodexInterop = new ClodexAuthInterop();
    this.authClient = createBetterAuthClient(
      () => this._credentials?.token ?? null,
      (token) => {
        this.persistCredentials({
          ...this._credentials,
          token,
        });
        this.logger.debug('[AuthService] Token captured/refreshed');
      },
    );
  }

  private persistCredentials(credentials: StoredCredentials): void {
    this._credentials = credentials;
    void writePersistedData(
      CREDENTIALS_KEY,
      credentialsSchema,
      credentials,
      CREDENTIALS_STORAGE_OPTIONS,
    ).catch((error) => {
      this.logger.error(
        `[AuthService] Failed to persist encrypted credentials: ${error}`,
      );
    });
  }

  private async initialize(): Promise<void> {
    if (!isAccountAuthEnabled) {
      this._credentials = null;
      this.updateAuthState((draft) => {
        draft.userAccount = {
          status: 'unauthenticated',
          machineId: this.identifierService.getMachineId(),
          models: [],
          keys: [],
          activeKeyId: undefined,
          isSwitchingKey: false,
          ideToken: undefined,
        };
      });
      this.registerProcedureHandlers();
      this.logger.debug(
        `[AuthService] Account authentication disabled for ${__APP_DISTRIBUTION_MODE__} distribution`,
      );
      return;
    }

    const persisted = await readPersistedData(
      CREDENTIALS_KEY,
      credentialsSchema,
      null,
      CREDENTIALS_STORAGE_OPTIONS,
    );

    if (persisted?.token) {
      this._credentials = persisted;
      this.logger.debug(
        '[AuthService] Restored persisted credentials, validating session...',
      );

      await this.refreshSession();
    } else {
      this.updateAuthState((draft) => {
        draft.userAccount = {
          status: 'unauthenticated',
          machineId: this.identifierService.getMachineId(),
          models: [],
          keys: [],
          activeKeyId: undefined,
          isSwitchingKey: false,
          ideToken: undefined,
        };
      });
    }

    this._refreshInterval = setInterval(() => {
      if (this._credentials?.token) {
        void this.refreshSession();
      }
    }, SESSION_REFRESH_INTERVAL_MS);

    this.registerProcedureHandlers();
    this.logger.debug('[AuthService] Initialized');
  }

  private registerProcedureHandlers(): void {
    this.uiKarton.registerServerProcedureHandler(
      'userAccount.sendOtp',
      async (
        _callingClientId: string,
        email: string,
        turnstileToken: string,
      ) => {
        return this.sendOtp(email, turnstileToken);
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'userAccount.verifyOtp',
      async (_callingClientId: string, email: string, code: string) => {
        return this.verifyOtp(email, code);
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'userAccount.signInSocial',
      async (_callingClientId: string, provider: SocialAuthProvider) => {
        return this.signInSocial(provider);
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'userAccount.signInEmail',
      async (_callingClientId: string) => {
        return this.signInEmail();
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'userAccount.signInTelegram',
      async (_callingClientId: string) => {
        return this.signInTelegram();
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'userAccount.logout',
      async (_callingClientId: string) => {
        await this.logout();
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'userAccount.refreshStatus',
      async (_callingClientId: string) => {
        await this.refreshSession();
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'userAccount.refreshKeys',
      async (_callingClientId: string) => {
        await this.refreshClodexKeys();
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'userAccount.selectKey',
      async (_callingClientId: string, keyId: string) => {
        return this.selectClodexKey(keyId);
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'userAccount.validateApiKeys',
      async (_callingClientId: string, keys: ApiKeysInput) => {
        this.logger.debug('[AuthService] Validating API keys');
        return validateApiKeys(keys);
      },
    );
  }

  public static async create(
    identifierService: IdentifierService,
    uiKarton: KartonService,
    notificationService: NotificationService,
    logger: Logger,
  ): Promise<AuthService> {
    const authService = new AuthService(
      identifierService,
      uiKarton,
      notificationService,
      logger,
    );
    await authService.initialize();
    return authService;
  }

  protected async onTeardown(): Promise<void> {
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
    }

    await this.cancelPendingHandoffAuth({
      error: 'Sign-in was cancelled.',
    });

    await this.disposeActiveLoopbackAuthServer();

    this.uiKarton.removeServerProcedureHandler('userAccount.sendOtp');
    this.uiKarton.removeServerProcedureHandler('userAccount.verifyOtp');
    this.uiKarton.removeServerProcedureHandler('userAccount.signInSocial');
    this.uiKarton.removeServerProcedureHandler('userAccount.signInEmail');
    this.uiKarton.removeServerProcedureHandler('userAccount.signInTelegram');
    this.uiKarton.removeServerProcedureHandler('userAccount.logout');
    this.uiKarton.removeServerProcedureHandler('userAccount.refreshStatus');
    this.uiKarton.removeServerProcedureHandler('userAccount.refreshKeys');
    this.uiKarton.removeServerProcedureHandler('userAccount.selectKey');
    this.uiKarton.removeServerProcedureHandler('userAccount.validateApiKeys');
    this.authChangeCallbacks = [];

    this.logger.debug('[AuthService] Teardown complete');
  }

  // ---------------------------------------------------------------------------
  // OTP flow
  // ---------------------------------------------------------------------------

  public async sendOtp(
    email: string,
    turnstileToken?: string,
  ): Promise<{ error?: string }> {
    if (!isAccountAuthEnabled) return { error: ACCOUNT_AUTH_DISABLED_ERROR };
    try {
      const { error } = await this.authClient.emailOtp.sendVerificationOtp({
        email,
        type: 'sign-in',
        fetchOptions: turnstileToken
          ? { headers: { 'x-captcha-response': turnstileToken } }
          : undefined,
      });
      if (error) {
        this.logger.error(`[AuthService] Failed to send OTP: ${error.message}`);
        return { error: error.message };
      }
      this.logger.debug(`[AuthService] OTP sent to ${email}`);
      return {};
    } catch (err) {
      this.logger.error(`[AuthService] Unexpected error sending OTP: ${err}`);
      return { error: 'An unexpected error occurred.' };
    }
  }

  public async verifyOtp(
    email: string,
    code: string,
  ): Promise<{ error?: string }> {
    if (!isAccountAuthEnabled) return { error: ACCOUNT_AUTH_DISABLED_ERROR };
    try {
      const { data, error } = await this.authClient.signIn.emailOtp({
        email,
        otp: code,
      });

      if (error) {
        this.logger.error(
          `[AuthService] Failed to verify OTP: ${error.message}`,
        );
        return { error: error.message };
      }

      // The global onSuccess handler already persisted the token.
      // Now update auth state with the user info.
      const user = data?.user;
      this.updateAuthState((draft) => {
        draft.userAccount = {
          ...draft.userAccount,
          status: 'authenticated',
          machineId: this.identifierService.getMachineId(),
          user: user
            ? {
                id: user.id,
                email: user.email ?? '',
                name: user.name ?? undefined,
              }
            : undefined,
        };
      });

      const currentToken = this._credentials?.token;
      if (user && currentToken) {
        this.persistCredentials({
          ...this._credentials,
          token: currentToken,
          user: {
            id: user.id,
            email: user.email ?? undefined,
            name: user.name ?? undefined,
          },
        });
      }

      this.logger.debug('[AuthService] Signed in via OTP');
      return {};
    } catch (err) {
      this.logger.error(`[AuthService] Unexpected error verifying OTP: ${err}`);
      return { error: 'An unexpected error occurred.' };
    }
  }

  private completePendingHandoffAuth(result: { error?: string }): void {
    if (!this.pendingHandoffAuth) return;
    clearTimeout(this.pendingHandoffAuth.timeout);
    const { resolve } = this.pendingHandoffAuth;
    this.pendingHandoffAuth = null;
    void this.disposeActiveLoopbackAuthServer();
    resolve(result);
  }

  private async cancelPendingHandoffAuth(result: {
    error?: string;
  }): Promise<void> {
    if (!this.pendingHandoffAuth) return;
    clearTimeout(this.pendingHandoffAuth.timeout);
    const { resolve } = this.pendingHandoffAuth;
    this.pendingHandoffAuth = null;
    await this.disposeActiveLoopbackAuthServer();
    resolve(result);
  }

  private async disposeActiveLoopbackAuthServer(): Promise<void> {
    const server = this.activeLoopbackAuthServer;
    if (!server) return;
    this.activeLoopbackAuthServer = null;
    await server.dispose();
  }

  private persistAuthenticatedSession(session: {
    token: string;
    user?: {
      id: string;
      email?: string;
      name?: string;
      username?: string;
      displayName?: string;
      group?: string;
      balance?: AuthBalance;
    };
    activeKeyId?: string;
  }): void {
    this.persistCredentials({
      token: session.token,
      user: session.user,
      activeKeyId: session.activeKeyId ?? this._credentials?.activeKeyId,
    });

    this.updateAuthState((draft) => {
      draft.userAccount = {
        ...draft.userAccount,
        status: 'authenticated',
        machineId: this.identifierService.getMachineId(),
        user: session.user
          ? this.toAuthUser(session.user)
          : draft.userAccount.user,
        balance: session.user?.balance ?? draft.userAccount.balance,
      };
    });
  }

  private toAuthUser(user: {
    id: string;
    email?: string;
    name?: string;
    username?: string;
    displayName?: string;
    group?: string;
  }): AuthUser {
    return {
      id: user.id,
      email: user.email ?? '',
      name: user.name,
      username: user.username,
      displayName: user.displayName,
      group: user.group,
    };
  }

  private async completeClodexSession(session: {
    accessToken: string;
    user?: {
      id: string;
      email?: string;
      name?: string;
      username?: string;
      displayName?: string;
      group?: string;
      balance?: AuthBalance;
    };
  }): Promise<{ error?: string }> {
    const keys = await this.refreshClodexKeys(session.accessToken);
    const activeKeyId = this.resolveActiveClodexKeyId(keys);
    const ideModelToken = await this.refreshIdeModelToken(
      session.accessToken,
      activeKeyId,
    );
    if (!ideModelToken) {
      const message = 'Clodex did not issue an IDE model token.';
      this.logger.error(`[AuthService] ${message}`);
      return { error: message };
    }

    this.persistAuthenticatedSession({
      token: session.accessToken,
      user: session.user,
      activeKeyId,
    });

    void this.refreshClodexUserModels(activeKeyId);
    return {};
  }

  private isIdeModelTokenFresh(keyId?: string): boolean {
    if (!this.ideModelToken?.token) return false;
    if (
      keyId &&
      this.ideModelToken.keyId &&
      String(this.ideModelToken.keyId) !== String(keyId)
    ) {
      return false;
    }
    if (!this.ideModelToken.expiresAt) return true;
    const expiresAt = parseIdeTokenExpiresAt(this.ideModelToken.expiresAt);
    if (expiresAt == null) return true;
    return Date.now() + IDE_MODEL_TOKEN_REFRESH_SKEW_MS < expiresAt;
  }

  private isCachedIdeModelTokenFresh(
    token: IdeModelTokenCacheEntry | undefined,
    keyId?: string,
  ): token is IdeModelTokenCacheEntry {
    if (!token?.token) return false;
    if (keyId && token.keyId && String(token.keyId) !== String(keyId)) {
      return false;
    }
    if (!token.expiresAt) return true;
    const expiresAt = parseIdeTokenExpiresAt(token.expiresAt);
    if (expiresAt == null) return true;
    return Date.now() + IDE_MODEL_TOKEN_REFRESH_SKEW_MS < expiresAt;
  }

  private clearModelAccessTokenCache(): void {
    this.ideModelTokenByKeyId.clear();
    this.pendingIdeModelTokenRefreshes.clear();
  }

  public get modelAccessToken(): string | undefined {
    this.assertNotDisposed();
    if (!isAccountAuthEnabled) return undefined;
    if (isClodexAuthEnabled) {
      return this.isIdeModelTokenFresh()
        ? this.ideModelToken?.token
        : undefined;
    }
    return this._credentials?.token ?? undefined;
  }

  public async ensureModelAccessToken(): Promise<string | undefined> {
    this.assertNotDisposed();
    if (!isAccountAuthEnabled) return undefined;
    if (!isClodexAuthEnabled) {
      return this._credentials?.token ?? undefined;
    }

    const activeKeyId =
      this.uiKarton.state.userAccount.activeKeyId ?? this.ideModelToken?.keyId;
    if (this.isIdeModelTokenFresh(activeKeyId)) {
      return this.ideModelToken?.token;
    }

    return this.refreshIdeModelToken(undefined, activeKeyId);
  }

  public async ensureModelAccessTokenForRoute(
    route: ModelAccessRoute,
  ): Promise<string | undefined> {
    this.assertNotDisposed();
    if (!isAccountAuthEnabled) return undefined;
    if (!isClodexAuthEnabled) {
      return this._credentials?.token ?? undefined;
    }

    const provider = normalizeRouteProvider(route.provider, route.modelId);
    if (!provider) return this.ensureModelAccessToken();

    const keys =
      this.clodexIdeKeys.length > 0
        ? this.clodexIdeKeys
        : await this.refreshClodexKeys();
    const activeKeyId =
      this.uiKarton.state.userAccount.activeKeyId ??
      this._credentials?.activeKeyId ??
      this.ideModelToken?.keyId;

    const ranked = keys
      .map((key) => ({
        key,
        score: scoreClodexKeyForRoute({
          key,
          provider,
          modelId: route.modelId,
          activeKeyId,
        }),
      }))
      .filter(({ score }) => score > Number.NEGATIVE_INFINITY)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.key.name.localeCompare(b.key.name);
      });

    const selectedKey = ranked[0]?.key;
    if (!selectedKey) {
      throw new Error(
        `No Clodex key/channel available for ${formatProviderLabel(provider)} model ${route.modelId ?? 'unknown'}. ` +
          `Select or connect a Clodex key with ${formatProviderLabel(provider)} access.`,
      );
    }

    const selectedKeyId = String(selectedKey.id);
    const routeCacheKey = formatRouteTokenCacheKey({
      keyId: selectedKeyId,
      provider,
      modelId: route.modelId,
    });
    const cached = this.ideModelTokenByKeyId.get(routeCacheKey);
    if (this.isCachedIdeModelTokenFresh(cached, selectedKeyId)) {
      return cached.token;
    }

    const accessToken = this._credentials?.token;
    if (!accessToken) return undefined;

    try {
      const runtimeGroup = clodexRuntimeGroupForProvider(provider);
      const issuedToken = await this.clodexInterop.createIdeToken(
        accessToken,
        selectedKey.id,
        {
          provider,
          modelId: route.modelId,
          ...(clodexKeyIsUniversalAll(selectedKey)
            ? { group: runtimeGroup }
            : {}),
        },
      );
      const issuedGroup = issuedToken.group ?? selectedKey.group;
      if (
        clodexKeyIsUniversalAll(selectedKey) &&
        clodexGroupIsUniversalAll(issuedGroup)
      ) {
        throw new Error(
          `Clodex returned virtual ALL for key "${selectedKey.name}" while routing ${formatProviderLabel(provider)} model ${route.modelId ?? 'unknown'}. ` +
            `The gateway must issue a concrete ${runtimeGroup ?? 'provider'} runtime token for ALL keys.`,
        );
      }
      const cachedToken: IdeModelTokenCacheEntry = {
        ...issuedToken,
        expiresAt: normalizeIdeTokenExpiresAt(issuedToken.expiresAt),
        keyId: selectedKey.id,
        keyName: selectedKey.name ?? issuedToken.keyName,
        group: issuedGroup,
      };
      this.ideModelTokenByKeyId.set(routeCacheKey, cachedToken);
      this.logger.debug(
        `[AuthService] Refreshed route-specific Clodex IDE model token for ${formatProviderLabel(provider)} model ${route.modelId ?? 'unknown'} via key "${selectedKey.name}"`,
      );
      return cachedToken.token;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[AuthService] Failed to refresh route-specific Clodex IDE model token: ${err}`,
      );
      throw new Error(
        `Failed to refresh Clodex IDE token for ${formatProviderLabel(provider)} model ${route.modelId ?? 'unknown'}. ${reason}`,
      );
    }
  }

  public async refreshIdeModelToken(
    accessTokenOverride?: string,
    keyIdOverride?: string,
  ): Promise<string | undefined> {
    this.assertNotDisposed();
    const requestedKeyId =
      keyIdOverride ??
      this.uiKarton.state.userAccount.activeKeyId ??
      this._credentials?.activeKeyId ??
      this.resolveKnownIdeTokenKeyId();
    if (this.isIdeModelTokenFresh(requestedKeyId)) {
      return this.ideModelToken?.token;
    }

    const accessToken = accessTokenOverride ?? this._credentials?.token;
    if (!accessToken) {
      this.ideModelToken = null;
      this.clearModelAccessTokenCache();
      return undefined;
    }

    const refreshCacheKey = [
      accessTokenOverride ? 'override' : 'session',
      requestedKeyId ?? 'default',
    ].join(':');
    const pendingRefresh =
      this.pendingIdeModelTokenRefreshes.get(refreshCacheKey);
    if (pendingRefresh) return pendingRefresh;

    const refresh = this.refreshIdeModelTokenUncached(
      accessToken,
      requestedKeyId,
    ).finally(() => {
      this.pendingIdeModelTokenRefreshes.delete(refreshCacheKey);
    });
    this.pendingIdeModelTokenRefreshes.set(refreshCacheKey, refresh);
    return refresh;
  }

  private async refreshIdeModelTokenUncached(
    accessToken: string,
    requestedKeyId?: string,
  ): Promise<string | undefined> {
    try {
      const issuedToken = await this.clodexInterop.createIdeToken(
        accessToken,
        requestedKeyId,
      );
      const activeKeyId = this.resolveIssuedIdeTokenSourceKeyId(
        requestedKeyId,
        issuedToken.keyId,
      );
      const activeKey = this.findClodexKey(activeKeyId);
      this.ideModelToken = {
        ...issuedToken,
        expiresAt: normalizeIdeTokenExpiresAt(issuedToken.expiresAt),
        keyId: activeKeyId ?? issuedToken.keyId,
        keyName: activeKey?.name ?? issuedToken.keyName,
        group: activeKey?.group ?? issuedToken.group,
      };
      if (this.ideModelToken.keyId) {
        this.ideModelTokenByKeyId.set(String(this.ideModelToken.keyId), {
          ...this.ideModelToken,
        });
      }
      this.updateAuthState((draft) => {
        draft.userAccount.ideToken = {
          keyId: this.ideModelToken?.keyId,
          keyName: this.ideModelToken?.keyName,
          group: this.ideModelToken?.group,
          expiresAt: this.ideModelToken?.expiresAt,
        };
        draft.userAccount.activeKeyId = activeKeyId;
      });
      if (this.clodexIdeKeys.length === 0) {
        const fallbackKeys = this.createFallbackClodexKeys();
        if (fallbackKeys.length > 0) {
          this.clodexIdeKeys = fallbackKeys;
          this.setClodexKeys(fallbackKeys, activeKeyId);
        }
      }
      this.persistActiveKeyId(activeKeyId);
      this.logger.debug('[AuthService] Refreshed Clodex IDE model token');
      return this.ideModelToken.token;
    } catch (err) {
      this.logger.warn(
        `[AuthService] Failed to refresh Clodex IDE model token: ${err}`,
      );
      return undefined;
    }
  }

  private async refreshClodexKeys(
    accessTokenOverride?: string,
  ): Promise<ClodexIdeKey[]> {
    const accessToken = accessTokenOverride ?? this._credentials?.token;
    if (!accessToken) {
      this.clodexIdeKeys = [];
      this.setClodexKeys([], undefined);
      return [];
    }

    if (!isClodexAuthEnabled) {
      return [];
    }

    try {
      this.clodexIdeKeys = await this.clodexInterop.getIdeKeys(accessToken);
      const activeKeyId = this.resolveActiveClodexKeyId(this.clodexIdeKeys);
      this.setClodexKeys(this.clodexIdeKeys, activeKeyId);
      this.logger.debug(
        `[AuthService] Loaded ${this.clodexIdeKeys.length} Clodex IDE keys`,
      );
      return this.clodexIdeKeys;
    } catch (err) {
      this.logger.warn(`[AuthService] Failed to load Clodex IDE keys: ${err}`);
      const fallbackKeys = this.createFallbackClodexKeys();
      this.clodexIdeKeys = fallbackKeys;
      const activeKeyId = this.resolveActiveClodexKeyId(fallbackKeys);
      this.setClodexKeys(fallbackKeys, activeKeyId);
      return fallbackKeys;
    }
  }

  private async refreshClodexUserModels(keyId?: string): Promise<void> {
    const accessToken = this._credentials?.token;
    if (!accessToken) {
      this.clodexUserModels = [];
      this.setClodexModels([]);
      return;
    }

    const activeKeyId =
      keyId ??
      this.uiKarton.state.userAccount.activeKeyId ??
      this.ideModelToken?.keyId;

    try {
      const models = await this.clodexInterop.getUserModels(
        accessToken,
        activeKeyId,
      );
      this.clodexUserModels = models.filter((model) => model.enabled !== false);
      this.setClodexModels(this.clodexUserModels);
      this.logger.debug(
        `[AuthService] Loaded ${this.clodexUserModels.length} Clodex user models`,
      );
    } catch (err) {
      this.logger.warn(
        `[AuthService] Failed to load Clodex user models: ${err}`,
      );
    }
  }

  private setClodexModels(models: AuthModel[]): void {
    this.updateAuthState((draft) => {
      draft.userAccount.models = models;
    });
  }

  private setClodexKeys(keys: AuthKey[], activeKeyId?: string): void {
    this.updateAuthState((draft) => {
      draft.userAccount.keys = keys;
      draft.userAccount.activeKeyId = activeKeyId;
    });
  }

  private resolveActiveClodexKeyId(keys: ClodexIdeKey[]): string | undefined {
    const current =
      this.uiKarton.state.userAccount.activeKeyId ??
      this._credentials?.activeKeyId ??
      this.ideModelToken?.keyId;
    if (current && keys.some((key) => String(key.id) === String(current))) {
      return current;
    }

    return (
      keys.find((key) => clodexKeyIsUniversalAll(key))?.id ??
      keys.find((key) => key.isDefault)?.id ??
      keys[0]?.id
    );
  }

  private findClodexKey(keyId?: string): ClodexIdeKey | undefined {
    if (!keyId) return undefined;
    return this.clodexIdeKeys.find((key) => String(key.id) === String(keyId));
  }

  private resolveKnownIdeTokenKeyId(): string | undefined {
    const keyId = this.ideModelToken?.keyId;
    return this.findClodexKey(keyId)?.id;
  }

  private resolveIssuedIdeTokenSourceKeyId(
    requestedKeyId?: string,
    issuedKeyId?: string,
  ): string | undefined {
    if (requestedKeyId) return requestedKeyId;
    return this.findClodexKey(issuedKeyId)?.id;
  }

  private createFallbackClodexKeys(): ClodexIdeKey[] {
    if (!this.ideModelToken?.keyId && !this.ideModelToken?.keyName) return [];
    const id =
      this.ideModelToken.keyId ??
      this.uiKarton.state.userAccount.activeKeyId ??
      'clodex-ide';
    return [
      {
        id,
        name: this.ideModelToken.keyName ?? 'Clodex IDE key',
        group: this.ideModelToken.group,
        isDefault: true,
      },
    ];
  }

  private persistActiveKeyId(activeKeyId?: string): void {
    const credentials = this._credentials;
    if (!credentials || credentials.activeKeyId === activeKeyId) return;
    this.persistCredentials({
      ...credentials,
      activeKeyId,
    });
  }

  public async selectClodexKey(keyId: string): Promise<{ error?: string }> {
    this.assertNotDisposed();
    if (!isAccountAuthEnabled) return { error: ACCOUNT_AUTH_DISABLED_ERROR };
    if (!isClodexAuthEnabled) {
      return {};
    }

    if (!this._credentials?.token) {
      return { error: 'Sign in to Clodex before selecting a key.' };
    }

    const keys =
      this.clodexIdeKeys.length > 0
        ? this.clodexIdeKeys
        : await this.refreshClodexKeys();
    const key = keys.find((item) => String(item.id) === String(keyId));
    if (!key) {
      return { error: 'Selected Clodex key is not available.' };
    }

    this.updateAuthState((draft) => {
      draft.userAccount.isSwitchingKey = true;
      draft.userAccount.activeKeyId = key.id;
    });

    try {
      const token = await this.refreshIdeModelToken(undefined, key.id);
      if (!token) {
        return { error: 'Clodex did not issue a token for this key.' };
      }

      await this.refreshClodexUserModels(key.id);
      this.persistActiveKeyId(key.id);
      return {};
    } catch (err) {
      this.logger.warn(`[AuthService] Failed to switch Clodex key: ${err}`);
      return { error: 'Failed to switch Clodex key.' };
    } finally {
      this.updateAuthState((draft) => {
        draft.userAccount.isSwitchingKey = false;
      });
    }
  }

  public async handleAuthCallbackUrl(url: string): Promise<boolean> {
    if (!isAccountAuthEnabled) return false;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }

    let activeLoopbackCallback: URL | null = null;
    if (this.activeLoopbackAuthServer) {
      try {
        activeLoopbackCallback = new URL(
          this.activeLoopbackAuthServer.callbackUrl,
        );
      } catch {
        activeLoopbackCallback = null;
      }
    }
    const isLoopbackCallback =
      !!activeLoopbackCallback &&
      parsed.protocol === activeLoopbackCallback.protocol &&
      parsed.host === activeLoopbackCallback.host &&
      parsed.pathname === activeLoopbackCallback.pathname;

    if (!ALL_CALLBACK_PROTOCOLS.has(parsed.protocol) && !isLoopbackCallback) {
      this.logger.warn(
        `[AuthService] Auth callback protocol mismatch: got ${parsed.protocol}, expected one of ${[...ALL_CALLBACK_PROTOCOLS].join(', ')}`,
      );
      return false;
    }

    const callbackPath = parsed.hostname
      ? `/${parsed.hostname}${parsed.pathname}`
      : parsed.pathname;
    const isAuthCallback =
      callbackPath === '/auth/callback' ||
      callbackPath.includes('/auth') ||
      parsed.searchParams.has('error') ||
      parsed.hash.startsWith('#token=');

    if (!isAuthCallback) {
      return false;
    }
    if (!this.pendingHandoffAuth) {
      return false;
    }
    const currentPending = this.pendingHandoffAuth;

    const fragmentParams = new URLSearchParams(parsed.hash.slice(1));
    const callbackError =
      parsed.searchParams.get('error_description') ??
      parsed.searchParams.get('error') ??
      fragmentParams.get('error_description') ??
      fragmentParams.get('error');

    if (callbackError) {
      this.logger.error(
        `[AuthService] Social sign-in failed: ${callbackError}`,
      );
      this.completePendingHandoffAuth({ error: callbackError });
      return true;
    }

    const code = parsed.searchParams.get('code') ?? fragmentParams.get('code');
    const token =
      fragmentParams.get('token') ?? parsed.searchParams.get('token');

    if (!code && !token) {
      const message = 'Sign-in callback did not include a code or token.';
      this.logger.error(`[AuthService] ${message}`);
      this.completePendingHandoffAuth({ error: message });
      return true;
    }

    try {
      if (code) {
        const session = await this.clodexInterop.exchangeCode(code);
        if (this.pendingHandoffAuth !== currentPending) {
          this.logger.debug(
            '[AuthService] Ignoring stale Clodex sign-in callback',
          );
          return true;
        }

        const result = await this.completeClodexSession(session);
        if (result.error) {
          this.completePendingHandoffAuth(result);
          return true;
        }

        this.logger.debug('[AuthService] Completed Clodex sign-in callback');
        this.completePendingHandoffAuth({});
        return true;
      }

      if (!token) {
        const message = 'Sign-in callback did not include a token.';
        this.logger.error(`[AuthService] ${message}`);
        this.completePendingHandoffAuth({ error: message });
        return true;
      }

      const { data, error } = await this.authClient.authenticate({ token });
      if (this.pendingHandoffAuth !== currentPending) {
        this.logger.debug(
          '[AuthService] Ignoring stale sign-in callback after authentication',
        );
        return true;
      }
      if (error || !data?.token) {
        const message = error?.message ?? 'Sign-in failed.';
        this.logger.error(`[AuthService] Sign-in failed: ${message}`);
        if (this.pendingHandoffAuth !== currentPending) {
          this.logger.debug(
            '[AuthService] Ignoring stale sign-in failure after authentication',
          );
          return true;
        }
        this.completePendingHandoffAuth({ error: message });
        return true;
      }

      this.persistAuthenticatedSession({
        token: data.token,
        user: {
          id: data.user.id,
          email: data.user.email ?? undefined,
          name: data.user.name ?? undefined,
        },
      });

      this.logger.debug('[AuthService] Completed sign-in callback');
      this.completePendingHandoffAuth({});
      void this.refreshSession().catch((refreshError) => {
        this.logger.warn(
          `[AuthService] Session refresh after sign-in failed: ${refreshError}`,
        );
      });
      return true;
    } catch (err) {
      this.logger.error(
        `[AuthService] Unexpected error handling auth callback: ${err}`,
      );
      if (this.pendingHandoffAuth !== currentPending) {
        this.logger.debug(
          '[AuthService] Ignoring stale sign-in error after callback failure',
        );
        return true;
      }
      this.completePendingHandoffAuth({
        error: 'Failed to complete sign-in.',
      });
      return true;
    }
  }

  public async signInSocial(
    provider: SocialAuthProvider,
  ): Promise<{ error?: string }> {
    if (!isAccountAuthEnabled) return { error: ACCOUNT_AUTH_DISABLED_ERROR };
    if (this.pendingHandoffAuth) {
      this.logger.debug(
        '[AuthService] Cancelling previous sign-in before starting a new one',
      );
      await this.cancelPendingHandoffAuth({
        error: 'Sign-in was cancelled.',
      });
    }

    const completion = new Promise<{ error?: string }>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingHandoffAuth = null;
        void this.disposeActiveLoopbackAuthServer();
        resolve({ error: 'Social sign-in timed out.' });
      }, SOCIAL_AUTH_TIMEOUT_MS);

      this.pendingHandoffAuth = { resolve, timeout };
    });

    try {
      this.logger.debug(
        `[AuthService] Starting Clodex sign-in via ${provider}`,
      );
      await openClodexLoginInSystemBrowser();
      return await completion;
    } catch (err) {
      await this.disposeActiveLoopbackAuthServer();
      this.logger.error(
        `[AuthService] Unexpected error during social sign-in: ${err}`,
      );
      this.completePendingHandoffAuth({
        error: 'Failed to complete social sign-in.',
      });
      return await completion;
    }
  }

  // ---------------------------------------------------------------------------
  // Email sign-in via console (desktop handoff)
  // ---------------------------------------------------------------------------

  public async signInEmail(): Promise<{ error?: string }> {
    if (!isAccountAuthEnabled) return { error: ACCOUNT_AUTH_DISABLED_ERROR };
    if (this.pendingHandoffAuth) {
      this.logger.debug(
        '[AuthService] Cancelling previous sign-in before starting email sign-in',
      );
      await this.cancelPendingHandoffAuth({
        error: 'Sign-in was cancelled.',
      });
    }

    const completion = new Promise<{ error?: string }>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingHandoffAuth = null;
        resolve({ error: 'Email sign-in timed out.' });
      }, SOCIAL_AUTH_TIMEOUT_MS);

      this.pendingHandoffAuth = { resolve, timeout };
    });

    try {
      this.logger.debug('[AuthService] Starting Clodex sign-in via browser');
      await openClodexLoginInSystemBrowser();
      const result = await completion;
      return result;
    } catch (err) {
      this.logger.error(
        `[AuthService] Unexpected error during email sign-in: ${err}`,
      );
      this.completePendingHandoffAuth({
        error: 'Failed to open email sign-in.',
      });
      return await completion;
    }
  }

  public async signInTelegram(): Promise<{ error?: string }> {
    if (!isAccountAuthEnabled) return { error: ACCOUNT_AUTH_DISABLED_ERROR };
    if (this.pendingHandoffAuth) {
      this.logger.debug(
        '[AuthService] Cancelling previous sign-in before starting Telegram sign-in',
      );
      await this.cancelPendingHandoffAuth({
        error: 'Sign-in was cancelled.',
      });
    }

    try {
      this.logger.debug('[AuthService] Starting Clodex sign-in via Telegram');
      const login = await this.clodexInterop.startTelegramLogin();
      await openClodexTelegramInSystemApp(login);

      const deadline = Math.min(
        login.expiresAt ? login.expiresAt * 1000 : Number.POSITIVE_INFINITY,
        Date.now() + TELEGRAM_AUTH_TIMEOUT_MS,
      );

      while (Date.now() < deadline) {
        await new Promise((resolve) =>
          setTimeout(resolve, TELEGRAM_AUTH_POLL_INTERVAL_MS),
        );

        const status = await this.clodexInterop.getTelegramLoginStatus(
          login.token,
        );

        if (status.status === 'pending') continue;

        if (status.status === 'consumed') {
          const accessToken =
            status.accessToken ??
            (status.cookieHeader
              ? await this.clodexInterop.exchangeDashboardSessionForAccessToken(
                  status.cookieHeader,
                  status.user?.id,
                )
              : undefined);

          if (!accessToken) {
            return {
              error:
                'Telegram sign-in completed, but Clodex did not return an access token.',
            };
          }

          const result = await this.completeClodexSession({
            accessToken,
            user: status.user,
          });
          if (result.error) return result;

          this.logger.debug('[AuthService] Completed Clodex Telegram sign-in');
          return {};
        }

        return {
          error:
            status.message ||
            (status.status === 'expired'
              ? 'Telegram sign-in link expired.'
              : 'Telegram sign-in failed.'),
        };
      }

      return { error: 'Telegram sign-in timed out.' };
    } catch (err) {
      this.logger.error(
        `[AuthService] Unexpected error during Telegram sign-in: ${err}`,
      );
      return { error: 'Failed to complete Telegram sign-in.' };
    }
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  private async refreshSession(): Promise<void> {
    if (!isAccountAuthEnabled) {
      this._credentials = null;
      this.ideModelToken = null;
      this.clearModelAccessTokenCache();
      this.clodexUserModels = [];
      this.clodexIdeKeys = [];
      this.updateAuthState((draft) => {
        draft.userAccount = {
          status: 'unauthenticated',
          machineId: this.identifierService.getMachineId(),
          models: [],
          keys: [],
          activeKeyId: undefined,
          isSwitchingKey: false,
          ideToken: undefined,
        };
      });
      return;
    }

    if (!this._credentials?.token) {
      this.ideModelToken = null;
      this.clearModelAccessTokenCache();
      this.clodexUserModels = [];
      this.clodexIdeKeys = [];
      this.updateAuthState((draft) => {
        draft.userAccount = {
          status: 'unauthenticated',
          machineId: this.identifierService.getMachineId(),
          models: [],
          keys: [],
          activeKeyId: undefined,
          isSwitchingKey: false,
          ideToken: undefined,
        };
      });
      return;
    }

    try {
      if (isClodexAuthEnabled) {
        const user = await this.clodexInterop.getSelf(this._credentials.token);
        const credentials = this._credentials;
        if (user && credentials) {
          this.persistCredentials({
            ...credentials,
            user,
          });
        }

        this.updateAuthState((draft) => {
          draft.userAccount = {
            ...draft.userAccount,
            status: 'authenticated',
            machineId: this.identifierService.getMachineId(),
            user: user ? this.toAuthUser(user) : draft.userAccount.user,
            balance: user?.balance ?? draft.userAccount.balance,
          };
        });

        const keys = await this.refreshClodexKeys();
        const activeKeyId = this.resolveActiveClodexKeyId(keys);
        await this.refreshIdeModelToken(undefined, activeKeyId);
        void this.refreshClodexUserModels(activeKeyId);
        return;
      }

      const { data, error } = await this.authClient.getSession();

      if (error || !data) {
        this.logger.warn(
          `[AuthService] Session refresh failed: ${error?.message ?? 'no session'} (status: ${error?.status ?? 'unknown'})`,
        );
        // Only treat definitive auth rejections as unauthenticated.
        // 5xx, 429, or any other non-auth HTTP error means the server is
        // temporarily unavailable — keep credentials intact.
        const isAuthRejection = error?.status === 401 || error?.status === 403;
        if (isAuthRejection) {
          this.persistCredentials(null);
          this.ideModelToken = null;
          this.clearModelAccessTokenCache();
          this.clodexUserModels = [];
          this.clodexIdeKeys = [];
          this.updateAuthState((draft) => {
            draft.userAccount = {
              status: 'unauthenticated',
              machineId: this.identifierService.getMachineId(),
              models: [],
              keys: [],
              activeKeyId: undefined,
              isSwitchingKey: false,
              ideToken: undefined,
            };
          });
        } else {
          this.updateAuthState((draft) => {
            draft.userAccount.status = 'server_unreachable';
          });
        }
        return;
      }

      const user = data.user;
      const credentials = this._credentials;
      if (user && credentials) {
        this.persistCredentials({
          ...credentials,
          user: {
            id: user.id,
            email: user.email ?? undefined,
            name: user.name ?? undefined,
          },
        });
      }

      this.updateAuthState((draft) => {
        draft.userAccount = {
          ...draft.userAccount,
          status: 'authenticated',
          machineId: this.identifierService.getMachineId(),
          user: user
            ? {
                id: user.id,
                email: user.email ?? '',
                name: user.name ?? undefined,
              }
            : draft.userAccount.user,
        };
      });

      const token = this._credentials?.token;
      if (token) {
        void this.refreshIdeModelToken();
      }
    } catch (err) {
      if (
        err instanceof ClodexRequestError &&
        (err.status === 401 || err.status === 403)
      ) {
        this.persistCredentials(null);
        this.ideModelToken = null;
        this.clearModelAccessTokenCache();
        this.clodexUserModels = [];
        this.clodexIdeKeys = [];
        this.updateAuthState((draft) => {
          draft.userAccount = {
            status: 'unauthenticated',
            machineId: this.identifierService.getMachineId(),
            models: [],
            keys: [],
            activeKeyId: undefined,
            isSwitchingKey: false,
            ideToken: undefined,
          };
        });
        return;
      }

      this.logger.error(`[AuthService] Failed to refresh session: ${err}`);
      this.updateAuthState((draft) => {
        draft.userAccount.status = 'server_unreachable';
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  public async logout(): Promise<void> {
    if (isAccountAuthEnabled) {
      try {
        await this.authClient.signOut();
      } catch {
        // Sign-out may fail if server is unreachable; we still clear local state.
      }
    }

    this.persistCredentials(null);
    this.ideModelToken = null;
    this.clearModelAccessTokenCache();
    this.clodexUserModels = [];
    this.clodexIdeKeys = [];

    this.updateAuthState((draft) => {
      draft.userAccount = {
        status: 'unauthenticated',
        machineId: this.identifierService.getMachineId(),
        models: [],
        keys: [],
        activeKeyId: undefined,
        isSwitchingKey: false,
        ideToken: undefined,
      };
    });

    this.notificationService.showNotification({
      title: 'Logged out',
      message: 'You have been logged out of Clodex.',
      type: 'info',
      duration: 5000,
      actions: [],
    });

    this.logger.debug('[AuthService] Logged out');
  }

  public get authState(): AuthState {
    this.assertNotDisposed();
    return this.uiKarton.state.userAccount;
  }

  public get accessToken(): string | undefined {
    this.assertNotDisposed();
    if (!isAccountAuthEnabled) return undefined;
    return this._credentials?.token ?? undefined;
  }

  public async refreshAuthState(): Promise<AuthState> {
    await this.refreshSession();
    return this.authState;
  }

  // ---------------------------------------------------------------------------
  // State management
  // ---------------------------------------------------------------------------

  private updateAuthState(
    draft: Parameters<typeof this.uiKarton.setState>[0],
  ): void {
    const oldState = structuredClone(this.uiKarton.state.userAccount);
    this.uiKarton.setState(draft);
    const newState = this.uiKarton.state.userAccount;
    if (JSON.stringify(oldState) !== JSON.stringify(newState)) {
      for (const callback of this.authChangeCallbacks) {
        try {
          callback(newState);
        } catch {
          // NO-OP
        }
      }
    }
  }

  public registerAuthStateChangeCallback(
    callback: (newAuthState: AuthState) => void,
  ): void {
    this.authChangeCallbacks.push(callback);
  }

  public unregisterAuthStateChangeCallback(
    callback: (newAuthState: AuthState) => void,
  ): void {
    this.authChangeCallbacks = this.authChangeCallbacks.filter(
      (c) => c !== callback,
    );
  }
}

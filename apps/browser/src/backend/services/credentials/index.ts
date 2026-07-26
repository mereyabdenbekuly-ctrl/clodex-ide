import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { DisposableService } from '../disposable';
import type { Logger } from '../logger';
import {
  readPersistedData,
  writePersistedData,
} from '../../utils/persisted-data';
import {
  credentialTypeRegistry,
  extractSecretFieldNames,
  type CredentialTypeId,
  type CredentialInputData,
  type ResolvedCredential,
  type SecretEntry,
} from '@shared/credential-types';

const STORAGE_NAME = 'credentials' as const;
const MCP_CUSTOM_STORAGE_NAME = 'mcp-custom-credentials' as const;
const PROVIDER_API_KEYS_STORAGE_NAME = 'provider-api-keys' as const;
const STORAGE_OPTIONS = {
  encrypt: true,
  requireEncryption: true,
  allowPlaintextMigration: true,
} as const;

/**
 * Zod schema for the on-disk credentials store.
 * Keyed by credential type ID, each value is a flat string-to-string record
 * matching the fields declared in the credential type's schema.
 */
const credentialsStoreSchema = z.record(
  z.string(),
  z.record(z.string(), z.string()),
);

type CredentialsStore = z.infer<typeof credentialsStoreSchema>;

const providerCredentialReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^provider\.[a-z0-9]+(?:[-_.][a-z0-9]+)*$/);

const providerApiKeysStoreSchema = z.record(
  providerCredentialReferenceSchema,
  z.object({ apiKey: z.string().min(1).max(32_768) }).strict(),
);
type ProviderApiKeysStore = z.infer<typeof providerApiKeysStoreSchema>;

const mcpCustomCredentialIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^mcp-custom\.[a-z0-9]+(?:[-_.][a-z0-9]+)*$/);

const mcpCustomCredentialFieldSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/);

const mcpCustomCredentialsStoreSchema = z.record(
  mcpCustomCredentialIdSchema,
  z
    .object({
      displayName: z.string().trim().min(1).max(120),
      fields: z.record(
        mcpCustomCredentialFieldSchema,
        z
          .object({
            value: z
              .string()
              .min(1)
              .max(16_384)
              .refine((value) => !value.includes('\0')),
            allowedOrigins: z.array(z.string().url().max(4_096)).max(32),
          })
          .strict(),
      ),
    })
    .strict(),
);

type McpCustomCredentialsStore = z.infer<
  typeof mcpCustomCredentialsStoreSchema
>;

export interface McpCustomCredentialInput {
  credentialId: string;
  displayName: string;
  field: string;
  secret: string;
  allowedOrigins: string[];
}

export interface McpCustomCredentialDescriptor {
  credentialId: string;
  displayName: string;
  fields: string[];
  allowedOrigins: string[];
}

/**
 * Generates a 6-character hex nonce for placeholder uniqueness.
 */
function generateNonce(): string {
  return randomBytes(3).toString('hex');
}

/**
 * Manages encrypted credential storage and placeholder-based resolution.
 *
 * Credentials are stored in a single encrypted JSON file (`credentials.json`)
 * using Electron's safeStorage (OS keychain integration). Each credential
 * conforms to a registered `CredentialTypeDefinition` that declares its schema,
 * which fields are secrets, and an optional refresh/validation hook.
 *
 * The `resolve()` method returns an agent-safe object where secret fields are
 * replaced with opaque placeholders, plus a `secretMap` for the sandbox worker's
 * fetch proxy to perform real substitution at network time.
 */
export class CredentialsService extends DisposableService {
  private readonly logger: Logger;

  private store: CredentialsStore = {};
  private mcpCustomStore: McpCustomCredentialsStore = {};
  private providerApiKeysStore: ProviderApiKeysStore = {};
  private saveQueue: Promise<void> = Promise.resolve();
  private mcpCustomSaveQueue: Promise<void> = Promise.resolve();
  private providerApiKeysSaveQueue: Promise<void> = Promise.resolve();
  private readonly providerApiKeyListeners = new Set<() => void>();
  private accessTokenProvider?: () => string | undefined;

  private constructor(logger: Logger) {
    super();
    this.logger = logger;
  }

  public static async create(logger: Logger): Promise<CredentialsService> {
    const instance = new CredentialsService(logger);
    await instance.initialize();
    return instance;
  }

  private async initialize(): Promise<void> {
    this.logger.debug('[CredentialsService] Initializing...');
    [this.store, this.mcpCustomStore, this.providerApiKeysStore] =
      await Promise.all([
        readPersistedData(
          STORAGE_NAME,
          credentialsStoreSchema,
          {},
          STORAGE_OPTIONS,
        ),
        readPersistedData(
          MCP_CUSTOM_STORAGE_NAME,
          mcpCustomCredentialsStoreSchema,
          {},
          STORAGE_OPTIONS,
        ),
        readPersistedData(
          PROVIDER_API_KEYS_STORAGE_NAME,
          providerApiKeysStoreSchema,
          {},
          STORAGE_OPTIONS,
        ),
      ]);
    this.logger.debug(
      `[CredentialsService] Loaded ${Object.keys(this.store).length} registered, ` +
        `${Object.keys(this.mcpCustomStore).length} custom MCP, and ` +
        `${Object.keys(this.providerApiKeysStore).length} provider credential(s)`,
    );
  }

  private async save(): Promise<void> {
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(() =>
        writePersistedData(
          STORAGE_NAME,
          credentialsStoreSchema,
          this.store,
          STORAGE_OPTIONS,
        ),
      );
    return this.saveQueue;
  }

  private async saveMcpCustom(): Promise<void> {
    this.mcpCustomSaveQueue = this.mcpCustomSaveQueue
      .catch(() => undefined)
      .then(() =>
        writePersistedData(
          MCP_CUSTOM_STORAGE_NAME,
          mcpCustomCredentialsStoreSchema,
          this.mcpCustomStore,
          STORAGE_OPTIONS,
        ),
      );
    return this.mcpCustomSaveQueue;
  }

  private async mutateProviderApiKeys(
    mutate: (draft: ProviderApiKeysStore) => boolean,
  ): Promise<boolean> {
    const operation = this.providerApiKeysSaveQueue
      .catch(() => undefined)
      .then(async () => {
        const nextStore = structuredClone(this.providerApiKeysStore);
        if (!mutate(nextStore)) return false;
        await writePersistedData(
          PROVIDER_API_KEYS_STORAGE_NAME,
          providerApiKeysStoreSchema,
          nextStore,
          STORAGE_OPTIONS,
        );
        // Publish only after the encrypted write succeeds. Readers and route
        // listeners therefore observe one atomic credential generation.
        this.providerApiKeysStore = nextStore;
        this.notifyProviderApiKeyListeners();
        return true;
      });
    this.providerApiKeysSaveQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  public async setProviderApiKey(
    reference: string,
    apiKey: string,
  ): Promise<void> {
    this.assertNotDisposed();
    const parsedReference = providerCredentialReferenceSchema.parse(reference);
    const parsedApiKey = z
      .string()
      .trim()
      .min(1)
      .max(32_768)
      .refine((value) => !value.includes('\0'))
      .parse(apiKey);
    const changed = await this.mutateProviderApiKeys((draft) => {
      if (draft[parsedReference]?.apiKey === parsedApiKey) return false;
      draft[parsedReference] = { apiKey: parsedApiKey };
      return true;
    });
    if (!changed) return;
    this.logger.debug(
      `[CredentialsService] Stored provider API key: ${parsedReference}`,
    );
  }

  public getProviderApiKey(reference: string): string | null {
    this.assertNotDisposed();
    const parsed = providerCredentialReferenceSchema.safeParse(reference);
    if (!parsed.success) return null;
    return this.providerApiKeysStore[parsed.data]?.apiKey ?? null;
  }

  public hasProviderApiKey(reference: string): boolean {
    return this.getProviderApiKey(reference) != null;
  }

  public async deleteProviderApiKey(reference: string): Promise<void> {
    this.assertNotDisposed();
    const parsedReference = providerCredentialReferenceSchema.parse(reference);
    const changed = await this.mutateProviderApiKeys((draft) => {
      if (!(parsedReference in draft)) return false;
      delete draft[parsedReference];
      return true;
    });
    if (!changed) return;
    this.logger.debug(
      `[CredentialsService] Deleted provider API key: ${parsedReference}`,
    );
  }

  public addProviderApiKeyListener(listener: () => void): void {
    this.assertNotDisposed();
    this.providerApiKeyListeners.add(listener);
  }

  public removeProviderApiKeyListener(listener: () => void): void {
    this.providerApiKeyListeners.delete(listener);
  }

  private notifyProviderApiKeyListeners(): void {
    for (const listener of this.providerApiKeyListeners) {
      try {
        listener();
      } catch (error) {
        this.logger.debug(
          `[CredentialsService] Provider credential listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Register a callback that provides the clodex access token
   * at resolve time. Called once during app initialization.
   */
  public setAccessTokenProvider(provider: () => string | undefined): void {
    this.accessTokenProvider = provider;
  }

  /**
   * Store credential data for a registered type.
   * Validates that the type exists and the data matches its schema.
   *
   * The `data` parameter is fully typed per credential type, e.g.
   * `set('figma-pat', { token: '...' })` expects exactly `{ token: string }`.
   */
  public async set<T extends CredentialTypeId>(
    typeId: T,
    data: CredentialInputData<T>,
  ): Promise<void> {
    this.assertNotDisposed();
    if (typeId === 'clodex-auth') {
      throw new Error('clodex-auth credential is managed automatically');
    }
    const typeDef = credentialTypeRegistry[typeId];
    if (!typeDef) throw new Error(`Unknown credential type: ${typeId}`);

    typeDef.schema.parse(data);

    this.store[typeId] = data as Record<string, string>;
    await this.save();

    this.logger.debug(`[CredentialsService] Stored credential: ${typeId}`);
  }

  /**
   * Remove stored credential data for a type.
   */
  public async delete(typeId: CredentialTypeId): Promise<void> {
    this.assertNotDisposed();
    if (typeId === 'clodex-auth') {
      throw new Error('clodex-auth credential is managed automatically');
    }
    if (!(typeId in this.store)) return;

    delete this.store[typeId];
    await this.save();

    this.logger.debug(`[CredentialsService] Deleted credential: ${typeId}`);
  }

  /**
   * Check whether credential data is stored for a type.
   */
  public has(typeId: CredentialTypeId): boolean {
    this.assertNotDisposed();
    return typeId in this.store;
  }

  /**
   * Return the list of credential type IDs that have stored data.
   */
  public listConfigured(): CredentialTypeId[] {
    this.assertNotDisposed();
    return Object.keys(this.store).filter(
      (k) => k in credentialTypeRegistry,
    ) as CredentialTypeId[];
  }

  /**
   * Store one user-named MCP secret. The value is kept only in the encrypted
   * custom MCP credential store and is never returned through Karton.
   *
   * Empty `allowedOrigins` means local stdio use only. Remote MCP resolution
   * fails closed unless the endpoint origin is explicitly listed.
   */
  public async setMcpCustomCredential(
    input: McpCustomCredentialInput,
  ): Promise<void> {
    this.assertNotDisposed();
    const credentialId = mcpCustomCredentialIdSchema.parse(input.credentialId);
    const displayName = z
      .string()
      .trim()
      .min(1)
      .max(120)
      .parse(input.displayName);
    const field = mcpCustomCredentialFieldSchema.parse(input.field);
    const secret = z
      .string()
      .min(1)
      .max(16_384)
      .refine((value) => !value.includes('\0'))
      .parse(input.secret);
    const allowedOrigins = input.allowedOrigins.map(normalizeMcpAllowedOrigin);
    const existing = this.mcpCustomStore[credentialId];
    this.mcpCustomStore[credentialId] = {
      displayName,
      fields: {
        ...(existing?.fields ?? {}),
        [field]: {
          value: secret,
          allowedOrigins: [...new Set(allowedOrigins)],
        },
      },
    };
    await this.saveMcpCustom();
    this.logger.debug(
      `[CredentialsService] Stored custom MCP credential field: ${credentialId}.${field}`,
    );
  }

  public async deleteMcpCustomCredential(credentialId: string): Promise<void> {
    this.assertNotDisposed();
    const parsedId = mcpCustomCredentialIdSchema.parse(credentialId);
    if (!(parsedId in this.mcpCustomStore)) return;
    delete this.mcpCustomStore[parsedId];
    await this.saveMcpCustom();
    this.logger.debug(
      `[CredentialsService] Deleted custom MCP credential: ${parsedId}`,
    );
  }

  public listMcpCustomCredentials(): McpCustomCredentialDescriptor[] {
    this.assertNotDisposed();
    return Object.entries(this.mcpCustomStore)
      .map(([credentialId, credential]) => ({
        credentialId,
        displayName: credential.displayName,
        fields: Object.keys(credential.fields).sort(),
        allowedOrigins: [
          ...new Set(
            Object.values(credential.fields).flatMap(
              (field) => field.allowedOrigins,
            ),
          ),
        ].sort(),
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  /**
   * Resolve a stored credential for use in the sandbox.
   *
   * 1. Loads the stored data (returns `null` if none exists).
   * 2. Runs the credential type's `onGet` hook with real (decrypted) values.
   *    This allows validation or token refresh in the main process.
   * 3. If `onGet` updated the data, re-persists the changes.
   * 4. Builds the agent-safe result: plain fields pass through,
   *    secret fields become `{{CRED:<typeId>:<field>:<nonce>}}` placeholders.
   * 5. Returns `{ data, secretMap }` for the sandbox worker.
   */
  public async resolve(
    typeId: CredentialTypeId,
  ): Promise<ResolvedCredential | null> {
    this.assertNotDisposed();

    if (typeId === 'clodex-auth') {
      return this.resolveClodexAuth();
    }

    const typeDef = credentialTypeRegistry[typeId];
    if (!typeDef) return null;

    const raw = this.store[typeId];
    if (!raw) return null;

    let current: Record<string, string>;
    try {
      // .brand() is type-level only in Zod v4; .parse() returns plain strings at runtime
      current = typeDef.schema.parse(raw) as unknown as Record<string, string>;
    } catch {
      this.logger.error(
        `[CredentialsService] Stored data for ${typeId} failed schema validation`,
      );
      return null;
    }

    const refreshed = (await (
      typeDef.onGet as (arg: unknown) => Promise<unknown>
    )(current)) as Record<string, string> | null;
    if (refreshed === null) {
      this.logger.warn(
        `[CredentialsService] onGet returned null for ${typeId} (invalid/expired)`,
      );
      return null;
    }

    if (JSON.stringify(refreshed) !== JSON.stringify(current)) {
      this.store[typeId] = refreshed;
      await this.save();
      this.logger.debug(
        `[CredentialsService] onGet updated data for ${typeId}, persisted`,
      );
    }

    const secretFields = new Set(
      extractSecretFieldNames(typeDef.schema as z.ZodObject<z.ZodRawShape>),
    );
    const data: Record<string, string> = {};
    const secretMap = new Map<string, SecretEntry>();

    for (const [field, value] of Object.entries(refreshed)) {
      if (secretFields.has(field)) {
        const nonce = generateNonce();
        const placeholder = `{{CRED:${typeId}:${field}:${nonce}}}`;
        data[field] = placeholder;
        secretMap.set(placeholder, {
          value,
          allowedOrigins: typeDef.allowedOrigins,
        });
      } else {
        data[field] = value;
      }
    }

    return { data, secretMap };
  }

  /**
   * Resolve exactly one secret field for a privileged main-process consumer.
   *
   * This deliberately reuses the placeholder-based `resolve()` path so schema
   * validation, refresh hooks, clodex-auth handling, and allowed-origin
   * metadata stay centralized. Plain (non-secret) fields are not returned.
   */
  public async resolveSecretField(
    typeId: string,
    field: string,
  ): Promise<SecretEntry | null> {
    this.assertNotDisposed();
    const custom = this.mcpCustomStore[typeId];
    if (custom) {
      const secret = custom.fields[field];
      return secret
        ? {
            value: secret.value,
            allowedOrigins: [...secret.allowedOrigins],
          }
        : null;
    }
    if (!(typeId in credentialTypeRegistry)) return null;
    const resolved = await this.resolve(typeId as CredentialTypeId);
    if (!resolved) return null;
    const placeholder = resolved.data[field];
    if (!placeholder) return null;
    return resolved.secretMap.get(placeholder) ?? null;
  }

  private resolveClodexAuth(): ResolvedCredential | null {
    const token = this.accessTokenProvider?.();
    if (!token) return null;

    const typeDef = credentialTypeRegistry['clodex-auth'];
    const nonce = generateNonce();
    const placeholder = `{{CRED:clodex-auth:accessToken:${nonce}}}`;
    const secretMap = new Map<string, SecretEntry>();
    secretMap.set(placeholder, {
      value: token,
      allowedOrigins: typeDef.allowedOrigins,
    });

    return {
      data: { accessToken: placeholder },
      secretMap,
    };
  }

  protected async onTeardown(): Promise<void> {
    await Promise.all([
      this.saveQueue.catch(() => undefined),
      this.mcpCustomSaveQueue.catch(() => undefined),
      this.providerApiKeysSaveQueue.catch(() => undefined),
    ]);
    this.logger.debug('[CredentialsService] Teardown complete');
  }
}

function normalizeMcpAllowedOrigin(value: string): string {
  const url = new URL(value.trim());
  const isLoopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error(
      'Custom MCP credential origins must use HTTPS unless they target loopback',
    );
  }
  if (url.username || url.password) {
    throw new Error(
      'Custom MCP credential origins may not contain credentials',
    );
  }
  return url.origin;
}

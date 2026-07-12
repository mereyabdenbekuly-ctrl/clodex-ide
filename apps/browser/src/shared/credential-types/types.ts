import { z } from 'zod';

/**
 * Internal marker used by `credentialField()` to tag secret fields.
 * Checked at runtime via `schema.description` to identify which fields
 * in a credential schema should be encrypted and placeholder-replaced.
 */
const CREDENTIAL_FIELD_MARKER = '__credential__';

/**
 * Zod string type marked as a secret credential value.
 *
 * Uses `.describe()` for runtime detection (Zod v4 `.brand()` is type-level
 * only) and `.brand()` for compile-time type safety.
 *
 * Fields using this type will be:
 * - Encrypted at rest in the credentials store
 * - Replaced with opaque placeholders when returned to the sandbox VM
 * - Automatically substituted with real values by the proxied `fetch`
 *
 * Non-credential fields (plain `z.string()`) are visible to the agent as-is.
 */
export const credentialField = () =>
  z.string().describe(CREDENTIAL_FIELD_MARKER).brand<'CredentialField'>();

/** Inferred TypeScript type for a credential field value. */
export type CredentialFieldValue = z.infer<ReturnType<typeof credentialField>>;

/**
 * UI metadata for a single credential field.
 * Used by the settings UI to render labelled inputs with help links.
 */
export interface CredentialFieldMetadata {
  description: string;
  helpText?: string;
  helpUrl?: string;
}

/**
 * Full definition of a credential type.
 *
 * @typeParam TShape - The Zod raw shape describing the credential's fields.
 *
 * Credential types are registered in code (not user-defined) and describe:
 * - The data shape (which fields exist, which are secrets)
 * - Per-field UI metadata for the settings page
 * - An `onGet` hook for validation/refresh before returning to the caller
 */
export interface CredentialTypeDefinition<
  TShape extends z.ZodRawShape = z.ZodRawShape,
> {
  /** Human-readable name shown in settings UI. */
  displayName: string;
  /** Short description of what this credential is for. */
  description: string;
  /** Zod object schema. Secret fields use `credentialField()`, plain fields use `z.string()`. */
  schema: z.ZodObject<TShape>;
  /**
   * Origins (scheme + host + optional port) to which the fetch proxy is
   * allowed to send secret field values, e.g. `['https://api.figma.com']`.
   * Requests to any other origin that contain credential placeholders will
   * be rejected at the proxy level.
   */
  allowedOrigins: string[];
  /**
   * UI metadata keyed by credential (secret) field name.
   * Only secret fields need entries here; plain fields are rendered without extra metadata.
   */
  fieldMetadata: Partial<Record<keyof TShape, CredentialFieldMetadata>>;
  /**
   * Called in the main process before returning a credential to the sandbox.
   * Receives the current stored data with real (decrypted) values.
   * Can validate, refresh tokens, or transform data.
   *
   * @returns Updated data to persist and return, or `null` if the credential
   *          is invalid/expired and cannot be recovered.
   */
  onGet: (
    current: z.infer<z.ZodObject<TShape>>,
  ) => Promise<z.infer<z.ZodObject<TShape>> | null>;
}

/**
 * Checks whether a Zod schema field is a credential (secret) field.
 * Detects the `__credential__` marker set by `credentialField()` via `.describe()`.
 */
export function isCredentialFieldSchema(schema: z.ZodTypeAny): boolean {
  return (
    (schema as { description?: string }).description === CREDENTIAL_FIELD_MARKER
  );
}

/**
 * Walks a `ZodObject` shape and returns the names of fields that use
 * `credentialField()` (i.e. are marked as secrets).
 */
export function extractSecretFieldNames<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
): string[] {
  const shape = schema.shape;
  const secretFields: string[] = [];
  for (const key of Object.keys(shape)) {
    if (isCredentialFieldSchema(shape[key] as z.ZodTypeAny)) {
      secretFields.push(key);
    }
  }
  return secretFields;
}

/**
 * A single secret entry resolved for fetch proxy substitution.
 */
export interface SecretEntry {
  value: string;
  allowedOrigins: string[];
}

/**
 * Result of resolving a credential via `CredentialsService.resolve()`.
 */
export interface ResolvedCredential {
  /**
   * Agent-safe data object. Plain fields contain real values;
   * secret fields contain placeholder strings like `{{CRED:figma-pat:token:a8f3c1}}`.
   */
  data: Record<string, string>;
  /**
   * Maps each placeholder string to its real value and allowed origins.
   * The sandbox worker stores this for fetch proxy substitution.
   */
  secretMap: Map<string, SecretEntry>;
}

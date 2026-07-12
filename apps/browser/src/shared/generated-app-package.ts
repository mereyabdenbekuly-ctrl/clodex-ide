import { z } from 'zod';
import {
  generatedAppIdentitySchema,
  generatedAppManifestSchema,
} from './generated-app-manifest';

export const GENERATED_APP_PACKAGE_ATTESTATION_SCHEMA_VERSION = 1 as const;
export const GENERATED_APP_PACKAGE_SCHEMA_VERSION = 1 as const;

const generatedAppPublisherSchema = z
  .object({
    publisherId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    keyId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    publicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const generatedAppPackagePayloadSchema = z
  .object({
    schemaVersion: z.literal(GENERATED_APP_PACKAGE_ATTESTATION_SCHEMA_VERSION),
    manifest: generatedAppManifestSchema,
    identity: generatedAppIdentitySchema,
    publisher: generatedAppPublisherSchema,
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      payload.expiresAt &&
      Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Package attestation expiry must be after its issue time',
      });
    }
  });
export type GeneratedAppPackagePayload = z.infer<
  typeof generatedAppPackagePayloadSchema
>;

export const generatedAppPackageAttestationSchema =
  generatedAppPackagePayloadSchema
    .extend({
      signature: z
        .object({
          algorithm: z.literal('ed25519'),
          value: z
            .string()
            .regex(
              /^[A-Za-z0-9+/]{86}==$/,
              'Ed25519 signatures must be canonical base64',
            ),
        })
        .strict(),
    })
    .strict();
export type GeneratedAppPackageAttestation = z.infer<
  typeof generatedAppPackageAttestationSchema
>;

const generatedAppPackageFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(1_024)
      .refine(
        (value) =>
          !value.includes('\\') &&
          !value.startsWith('/') &&
          !value.split('/').includes('..') &&
          !value.split('/').includes(''),
        'Generated app package paths must be normalized and relative',
      ),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(20 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    contentBase64: z.string().max(28 * 1024 * 1024),
  })
  .strict();
export type GeneratedAppPackageFile = z.infer<
  typeof generatedAppPackageFileSchema
>;

export const generatedAppPackageSchema = z
  .object({
    schemaVersion: z.literal(GENERATED_APP_PACKAGE_SCHEMA_VERSION),
    attestation: generatedAppPackageAttestationSchema,
    publicKeyPem: z
      .string()
      .min(1)
      .max(4_096)
      .refine(
        (value) => value.includes('BEGIN PUBLIC KEY'),
        'Generated app package must include an SPKI public key',
      ),
    files: z.array(generatedAppPackageFileSchema).min(2).max(5_000),
  })
  .strict()
  .superRefine((value, context) => {
    const paths = new Set<string>();
    for (let index = 0; index < value.files.length; index += 1) {
      const file = value.files[index]!;
      if (paths.has(file.path)) {
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message: `Generated app package path "${file.path}" is duplicated`,
        });
      }
      paths.add(file.path);
    }
  });
export type GeneratedAppPackage = z.infer<typeof generatedAppPackageSchema>;

export function canonicalizeGeneratedAppPackagePayload(
  payload: GeneratedAppPackagePayload,
): string {
  return JSON.stringify(
    sortJsonValue(generatedAppPackagePayloadSchema.parse(payload)),
  );
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJsonValue(nested)]),
  );
}

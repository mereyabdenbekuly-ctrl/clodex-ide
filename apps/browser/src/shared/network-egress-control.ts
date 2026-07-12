import { z } from 'zod';
import {
  networkPolicyDecisionReasonSchema,
  networkPolicyPrincipalKindSchema,
  networkPolicyProtocolSchema,
  type NetworkPolicyDecisionReason,
  type NetworkPolicyDestinationGrant,
  type NetworkPolicyMode,
  type NetworkPolicyPrincipalKind,
  type NetworkPolicyProtocol,
} from './network-policy';

export const NETWORK_EGRESS_CONTROL_LIMITS = {
  maxGrants: 256,
  minTtlMs: 60_000,
  maxTtlMs: 30 * 24 * 60 * 60 * 1_000,
  defaultSessionTtlMs: 60 * 60 * 1_000,
  defaultAuditLimit: 100,
  maxAuditLimit: 1_000,
} as const;

export const networkEgressGrantScopeSchema = z.enum(['session', 'persistent']);
export type NetworkEgressGrantScope = z.infer<
  typeof networkEgressGrantScopeSchema
>;

const networkEgressGrantFields = {
  id: z.string().uuid(),
  protocol: networkPolicyProtocolSchema,
  hostname: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65_535),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().nullable(),
};

export const networkEgressGrantSchema = z
  .object({
    ...networkEgressGrantFields,
    scope: networkEgressGrantScopeSchema,
  })
  .strict();
export type NetworkEgressGrant = z.infer<typeof networkEgressGrantSchema>;

export const persistentNetworkEgressGrantSchema = z
  .object({
    ...networkEgressGrantFields,
    scope: z.literal('persistent'),
  })
  .strict();
export type PersistentNetworkEgressGrant = z.infer<
  typeof persistentNetworkEgressGrantSchema
>;

export const networkEgressPreferencesSchema = z
  .object({
    browserGrants: z
      .array(persistentNetworkEgressGrantSchema)
      .max(NETWORK_EGRESS_CONTROL_LIMITS.maxGrants)
      .default([]),
  })
  .default({ browserGrants: [] })
  .catch({ browserGrants: [] });
export type NetworkEgressPreferences = z.infer<
  typeof networkEgressPreferencesSchema
>;

export const networkEgressGrantInputSchema = z
  .object({
    scope: networkEgressGrantScopeSchema,
    protocol: networkPolicyProtocolSchema,
    hostname: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    ttlMs: z
      .number()
      .int()
      .min(NETWORK_EGRESS_CONTROL_LIMITS.minTtlMs)
      .max(NETWORK_EGRESS_CONTROL_LIMITS.maxTtlMs)
      .nullable()
      .optional(),
  })
  .strict();
export type NetworkEgressGrantInput = z.infer<
  typeof networkEgressGrantInputSchema
>;

export const networkEgressSnapshotInputSchema = z
  .object({
    auditLimit: z
      .number()
      .int()
      .min(1)
      .max(NETWORK_EGRESS_CONTROL_LIMITS.maxAuditLimit)
      .optional(),
  })
  .strict()
  .optional();
export type NetworkEgressSnapshotInput = z.infer<
  typeof networkEgressSnapshotInputSchema
>;

export type NetworkEgressComponentStatus =
  | 'active'
  | 'disabled'
  | 'unavailable'
  | 'fail-closed';

export interface NetworkEgressAuditEntry {
  sequence: number;
  createdAt: number;
  principalKind: NetworkPolicyPrincipalKind;
  destinationHostHash: string | null;
  destinationPort: number | null;
  protocol: NetworkPolicyProtocol | null;
  decision: 'allow' | 'deny';
  reason: NetworkPolicyDecisionReason;
  policyHash: string;
  eventHash: string;
}

export interface NetworkEgressControlSnapshot {
  featureEnabled: boolean;
  policyEngine: {
    status: NetworkEgressComponentStatus;
  };
  proxy: {
    status: NetworkEgressComponentStatus;
  };
  browser: {
    status: NetworkEgressComponentStatus;
    failClosed: boolean;
    sharedSessionScope: true;
    policyMode: NetworkPolicyMode | null;
    policyVersion: number | null;
    policyHash: string | null;
    allowedHostPatterns: number;
  };
  grants: NetworkEgressGrant[];
  audit: {
    status: 'verified' | 'unavailable';
    records: NetworkEgressAuditEntry[];
    truncated: boolean;
  };
}

export interface NetworkEgressAuditExportResult {
  canceled: boolean;
  count: number;
  filePath?: string;
}

export function toNetworkPolicyDestinationGrant(
  grant: Pick<
    NetworkEgressGrant,
    'protocol' | 'hostname' | 'port' | 'expiresAt'
  >,
): NetworkPolicyDestinationGrant {
  return {
    protocol: grant.protocol,
    hostname: grant.hostname,
    port: grant.port,
    ...(grant.expiresAt === null ? {} : { expiresAt: grant.expiresAt }),
  };
}

// Keep these schemas referenced here so UI/backend consumers share one source
// of truth even when they only import the structural TypeScript interfaces.
export const networkEgressAuditEntrySchema = z
  .object({
    sequence: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    principalKind: networkPolicyPrincipalKindSchema,
    destinationHostHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    destinationPort: z.number().int().min(1).max(65_535).nullable(),
    protocol: networkPolicyProtocolSchema.nullable(),
    decision: z.enum(['allow', 'deny']),
    reason: networkPolicyDecisionReasonSchema,
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
    eventHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

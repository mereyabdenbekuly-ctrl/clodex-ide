import { z } from 'zod';

export const networkPolicyModeSchema = z.enum([
  'deny-all',
  'allowlist',
  'unrestricted',
]);
export type NetworkPolicyMode = z.infer<typeof networkPolicyModeSchema>;

export const networkPolicyProtocolSchema = z.enum([
  'http',
  'https',
  'ws',
  'wss',
]);
export type NetworkPolicyProtocol = z.infer<typeof networkPolicyProtocolSchema>;

const networkPolicyHostPatternSchema = z.string().trim().min(1).max(253);

export const networkPolicyDestinationGrantSchema = z
  .object({
    protocol: networkPolicyProtocolSchema,
    hostname: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    expiresAt: z.number().int().nonnegative().optional(),
  })
  .strict();
export type NetworkPolicyDestinationGrant = z.infer<
  typeof networkPolicyDestinationGrantSchema
>;

export const networkPolicySchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    version: z.number().int().positive(),
    mode: networkPolicyModeSchema,
    allowedHosts: z.array(networkPolicyHostPatternSchema).max(256).default([]),
    allowedPorts: z
      .array(z.number().int().min(1).max(65_535))
      .max(256)
      .default([]),
    allowedDestinations: z
      .array(networkPolicyDestinationGrantSchema)
      .max(256)
      .default([]),
    allowPrivateNetworks: z.boolean().default(false),
    allowLoopback: z.boolean().default(false),
    allowIpLiterals: z.boolean().default(false),
  })
  .strict();
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;

export const DEFAULT_DENY_NETWORK_POLICY: NetworkPolicy = {
  id: 'default-deny',
  version: 1,
  mode: 'deny-all',
  allowedHosts: [],
  allowedPorts: [],
  allowedDestinations: [],
  allowPrivateNetworks: false,
  allowLoopback: false,
  allowIpLiterals: false,
};

export const networkPolicyPrincipalKindSchema = z.enum([
  'agent',
  'tool',
  'runtime',
  'mcp',
  'artifact',
  'browser',
  'runner',
]);
export type NetworkPolicyPrincipalKind = z.infer<
  typeof networkPolicyPrincipalKindSchema
>;

export const networkPolicyScopeSchema = z
  .object({
    principalKind: networkPolicyPrincipalKindSchema,
    principalId: z.string().min(1).max(512),
    jobId: z.string().min(1).max(512).optional(),
    workspaceSnapshotHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type NetworkPolicyScope = z.infer<typeof networkPolicyScopeSchema>;

export const networkEgressRequestSchema = z
  .object({
    scope: networkPolicyScopeSchema,
    destination: z.string().trim().min(1).max(16_384),
  })
  .strict();
export type NetworkEgressRequest = z.infer<typeof networkEgressRequestSchema>;

export const networkPolicyDecisionReasonSchema = z.enum([
  'invalid-destination',
  'unsupported-protocol',
  'url-credentials-denied',
  'policy-deny-all',
  'loopback-denied',
  'private-network-denied',
  'ip-literal-denied',
  'port-not-allowed',
  'host-not-allowed',
  'dns-resolution-failed',
  'resolved-loopback-denied',
  'resolved-private-network-denied',
  'exact-destination-grant',
  'allowlisted',
  'unrestricted',
]);
export type NetworkPolicyDecisionReason = z.infer<
  typeof networkPolicyDecisionReasonSchema
>;

export const networkPolicyDecisionSchema = z
  .object({
    decision: z.enum(['allow', 'deny']),
    reason: networkPolicyDecisionReasonSchema,
    policyId: z.string().min(1).max(120),
    policyVersion: z.number().int().positive(),
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
    destination: z
      .object({
        protocol: networkPolicyProtocolSchema,
        hostname: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65_535),
        ipLiteral: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type NetworkPolicyDecision = z.infer<typeof networkPolicyDecisionSchema>;

export interface NetworkPolicyEvaluator {
  evaluate(input: NetworkEgressRequest): Promise<NetworkPolicyDecision>;
}

import { z } from 'zod';

export const agenticAppRuntimeDogfoodEventName =
  'agentic-app-runtime-dogfood' as const;

export const agenticAppRuntimeDogfoodTelemetrySchema = z
  .object({
    activity: z.enum([
      'preview-session',
      'capability-invocation',
      'sensitive-approval',
      'write-approval',
      'async-operation',
      'runtime-inspector',
      'package-trust-review',
      'security-control',
    ]),
    outcome: z.enum([
      'started',
      'closed',
      'success',
      'failure',
      'denied',
      'blocked',
      'violation',
    ]),
    principal_kind: z.enum(['agent', 'package', 'none']),
    app_instance_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    capability_kind: z
      .enum([
        'discovery',
        'mcp-read',
        'mcp-sensitive',
        'mcp-write',
        'agent-ask',
        'automation',
        'async-control',
      ])
      .optional(),
    operation_kind: z.enum(['mcp', 'automation']).optional(),
    security_control: z
      .enum([
        'session-replay',
        'principal-isolation',
        'secret-egress',
        'package-trust',
      ])
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.activity === 'preview-session' && !value.app_instance_hash) {
      context.addIssue({
        code: 'custom',
        path: ['app_instance_hash'],
        message: 'Preview session telemetry requires an anonymous app hash',
      });
    }
    if (value.activity === 'capability-invocation' && !value.capability_kind) {
      context.addIssue({
        code: 'custom',
        path: ['capability_kind'],
        message: 'Capability telemetry requires a bounded capability kind',
      });
    }
    if (value.activity === 'async-operation' && !value.operation_kind) {
      context.addIssue({
        code: 'custom',
        path: ['operation_kind'],
        message: 'Async telemetry requires a bounded operation kind',
      });
    }
    if (value.activity === 'security-control' && !value.security_control) {
      context.addIssue({
        code: 'custom',
        path: ['security_control'],
        message: 'Security telemetry requires a bounded control name',
      });
    }
  });

export type AgenticAppRuntimeDogfoodTelemetry = z.infer<
  typeof agenticAppRuntimeDogfoodTelemetrySchema
>;

export interface AgenticAppRuntimeTelemetryEvents {
  /**
   * Content-free prerelease observation.
   *
   * The anonymous app hash is an HMAC scoped to one installation. Prompts,
   * app IDs, agent IDs, package IDs, MCP names, arguments, results, errors,
   * approval tokens and operation IDs are forbidden.
   */
  [agenticAppRuntimeDogfoodEventName]: AgenticAppRuntimeDogfoodTelemetry;
}

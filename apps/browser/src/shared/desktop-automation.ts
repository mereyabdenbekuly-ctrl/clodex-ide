import { z } from 'zod';

export const DESKTOP_AUTOMATION_KILL_SWITCH_ACCELERATOR =
  'CommandOrControl+Shift+Escape';

export const desktopAutomationPermissionKindSchema = z.enum([
  'screen-recording',
  'accessibility',
]);
export type DesktopAutomationPermissionKind = z.infer<
  typeof desktopAutomationPermissionKindSchema
>;

export const desktopAutomationPermissionStatusSchema = z.enum([
  'unsupported',
  'not-determined',
  'granted',
  'denied',
  'restricted',
  'unknown',
]);
export type DesktopAutomationPermissionStatus = z.infer<
  typeof desktopAutomationPermissionStatusSchema
>;

export const desktopAutomationPermissionsSchema = z.object({
  screenRecording:
    desktopAutomationPermissionStatusSchema.default('not-determined'),
  accessibility:
    desktopAutomationPermissionStatusSchema.default('not-determined'),
  checkedAt: z.number().int().nonnegative().nullable().default(null),
});
export type DesktopAutomationPermissions = z.infer<
  typeof desktopAutomationPermissionsSchema
>;

export const desktopAutomationBundleIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/);

export const desktopAutomationAppSchema = z.object({
  name: z.string().min(1).max(160),
  bundleId: desktopAutomationBundleIdSchema,
  windowTitle: z.string().max(500).optional(),
});
export type DesktopAutomationApp = z.infer<typeof desktopAutomationAppSchema>;

export const desktopAutomationAppPolicyModeSchema = z.enum([
  'ask',
  'allow',
  'block',
]);
export type DesktopAutomationAppPolicyMode = z.infer<
  typeof desktopAutomationAppPolicyModeSchema
>;

export const desktopAutomationAppPolicySchema = z.object({
  bundleId: desktopAutomationBundleIdSchema,
  appName: z.string().min(1).max(160),
  mode: desktopAutomationAppPolicyModeSchema.default('ask'),
  updatedAt: z.number().int().nonnegative(),
});
export type DesktopAutomationAppPolicy = z.infer<
  typeof desktopAutomationAppPolicySchema
>;

export const desktopAutomationElementRoleSchema = z.enum([
  'AXButton',
  'AXCheckBox',
  'AXRadioButton',
  'AXPopUpButton',
  'AXMenuButton',
  'AXLink',
  'AXDisclosureTriangle',
]);
export type DesktopAutomationElementRole = z.infer<
  typeof desktopAutomationElementRoleSchema
>;

export const desktopAutomationRiskSchema = z.enum([
  'normal',
  'system',
  'irreversible',
]);
export type DesktopAutomationRisk = z.infer<typeof desktopAutomationRiskSchema>;

export const desktopAutomationElementSchema = z.object({
  targetId: z.string().uuid(),
  role: desktopAutomationElementRoleSchema,
  title: z.string().max(200),
  description: z.string().max(300).optional(),
  enabled: z.boolean(),
  risk: desktopAutomationRiskSchema,
});
export type DesktopAutomationElement = z.infer<
  typeof desktopAutomationElementSchema
>;

export const desktopAutomationInspectionSchema = z.object({
  snapshotId: z.string().uuid(),
  capturedAt: z.number().int().nonnegative(),
  app: desktopAutomationAppSchema,
  elements: z.array(desktopAutomationElementSchema).max(100),
  truncated: z.boolean(),
});
export type DesktopAutomationInspection = z.infer<
  typeof desktopAutomationInspectionSchema
>;

export const desktopAutomationOperationSchema = z.enum([
  'inspect',
  'capture',
  'press',
]);
export type DesktopAutomationOperation = z.infer<
  typeof desktopAutomationOperationSchema
>;

export const desktopAutomationPendingApprovalSchema = z.object({
  id: z.string().uuid(),
  operation: desktopAutomationOperationSchema,
  app: desktopAutomationAppSchema,
  targetId: z.string().uuid().optional(),
  targetRole: desktopAutomationElementRoleSchema.optional(),
  targetTitle: z.string().max(200).optional(),
  risk: desktopAutomationRiskSchema,
  description: z.string().min(1).max(300),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
export type DesktopAutomationPendingApproval = z.infer<
  typeof desktopAutomationPendingApprovalSchema
>;

export const desktopAutomationApprovalResponseSchema = z.enum([
  'allow-once',
  'always-allow',
  'block-once',
  'always-block',
]);
export type DesktopAutomationApprovalResponse = z.infer<
  typeof desktopAutomationApprovalResponseSchema
>;

export const desktopAutomationStateSchema = z.object({
  supported: z.boolean().default(false),
  enabled: z.boolean().default(false),
  active: z.boolean().default(false),
  sessionId: z.string().uuid().nullable().default(null),
  killSwitchRegistered: z.boolean().default(false),
  killSwitchEngaged: z.boolean().default(false),
  killSwitchAccelerator: z
    .string()
    .default(DESKTOP_AUTOMATION_KILL_SWITCH_ACCELERATOR),
  permissions: desktopAutomationPermissionsSchema.prefault({}),
  policies: z
    .record(desktopAutomationBundleIdSchema, desktopAutomationAppPolicySchema)
    .default({}),
  currentApp: desktopAutomationAppSchema.nullable().default(null),
  pendingApprovals: z
    .array(desktopAutomationPendingApprovalSchema)
    .max(20)
    .default([]),
  lastActionAt: z.number().int().nonnegative().nullable().default(null),
});
export type DesktopAutomationState = z.infer<
  typeof desktopAutomationStateSchema
>;

export interface DesktopAutomationAuditEvent {
  operation:
    | 'permission-check'
    | 'permission-request'
    | 'session-start'
    | 'session-stop'
    | 'kill-switch'
    | 'policy-decision'
    | 'capture'
    | 'inspect'
    | 'press';
  success: boolean;
  bundleId?: string;
  risk?: DesktopAutomationRisk;
  decision?: 'allow' | 'block' | 'ask' | 'human-allow' | 'human-block';
  reason?:
    | 'feature-disabled'
    | 'unsupported'
    | 'permission-missing'
    | 'kill-switch'
    | 'session-inactive'
    | 'app-blocked'
    | 'approval-expired'
    | 'invalid-target'
    | 'provider-error';
  elementRole?: DesktopAutomationElementRole;
  latencyMs?: number;
}

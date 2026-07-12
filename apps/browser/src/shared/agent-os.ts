import { z } from 'zod';
import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  remoteControlClientAttestationVerdictSchema,
  remoteControlCommandSchema,
  remoteControlNativeAttestationProviderSchema,
  remoteControlPlatformSchema,
  remoteControlTrustLevelSchema,
} from './remote-control-protocol';
import { guardianDogfoodStateSchema } from './guardian';
import { desktopAutomationStateSchema } from './desktop-automation';

export const chronicleEventSourceSchema = z.enum([
  'screen',
  'ocr',
  'summary',
  'manual',
]);
export type ChronicleEventSource = z.infer<typeof chronicleEventSourceSchema>;

export const chronicleEventSchema = z.object({
  id: z.string(),
  capturedAt: z.number().int().nonnegative(),
  source: chronicleEventSourceSchema,
  windowTitle: z.string().optional(),
  appBundleId: z.string().optional(),
  text: z.string().default(''),
  artifactPath: z.string().optional(),
  privacyFiltered: z.boolean().default(true),
});
export type ChronicleEvent = z.infer<typeof chronicleEventSchema>;

export const chronicleSegmentSchema = z.object({
  id: z.string(),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().nullable().default(null),
  displayId: z.string().optional(),
  frameDir: z.string(),
  ocrPath: z.string(),
  summaryPath: z.string(),
});
export type ChronicleSegment = z.infer<typeof chronicleSegmentSchema>;

export const chronicleRetentionSchema = z.enum([
  'off',
  '1-hour',
  '24-hours',
  '7-days',
]);
export type ChronicleRetention = z.infer<typeof chronicleRetentionSchema>;

export const chroniclePrivacyModeSchema = z.enum(['strict', 'balanced']);
export type ChroniclePrivacyMode = z.infer<typeof chroniclePrivacyModeSchema>;

export const chronicleStateSchema = z.object({
  enabled: z.boolean().default(false),
  recording: z.boolean().default(false),
  retention: chronicleRetentionSchema.default('24-hours'),
  privacyMode: chroniclePrivacyModeSchema.default('strict'),
  lastCaptureAt: z.number().int().nonnegative().nullable().default(null),
  events: z.array(chronicleEventSchema).default([]),
  segments: z.array(chronicleSegmentSchema).default([]),
});
export type ChronicleState = z.infer<typeof chronicleStateSchema>;

export const codexMicroActionSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum([
    'push-to-talk',
    'insert-text',
    'insert-skill-mention',
    'run-command',
    'open-command-palette',
    'custom',
  ]),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type CodexMicroAction = z.infer<typeof codexMicroActionSchema>;

export const codexMicroPositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type CodexMicroPosition = z.infer<typeof codexMicroPositionSchema>;

export const DEFAULT_CODEX_MICRO_ACTIONS: CodexMicroAction[] = [
  {
    id: 'push-to-talk',
    title: 'Push to talk',
    kind: 'push-to-talk',
    payload: {},
  },
  {
    id: 'new-agent',
    title: 'New agent',
    kind: 'custom',
    payload: { action: 'new-agent' },
  },
  {
    id: 'insert-skill',
    title: 'Insert @skill',
    kind: 'insert-skill-mention',
    payload: {},
  },
  {
    id: 'review',
    title: 'Run /review',
    kind: 'run-command',
    payload: { command: '/review ' },
  },
  {
    id: 'command-palette',
    title: 'Command palette',
    kind: 'open-command-palette',
    payload: {},
  },
  {
    id: 'stop-agent',
    title: 'Stop agent',
    kind: 'custom',
    payload: { action: 'stop-agent' },
  },
];

export const codexMicroStateSchema = z.object({
  enabled: z.boolean().default(false),
  expanded: z.boolean().default(false),
  connected: z.boolean().default(false),
  pushToTalkActive: z.boolean().default(false),
  lastInputAt: z.number().int().nonnegative().nullable().default(null),
  lastTriggeredActionId: z.string().nullable().default(null),
  position: codexMicroPositionSchema.nullable().default(null),
  actions: z
    .array(codexMicroActionSchema)
    .default(() => structuredClone(DEFAULT_CODEX_MICRO_ACTIONS)),
});
export type CodexMicroState = z.infer<typeof codexMicroStateSchema>;

export const browserUseApprovalModeSchema = z.enum(['ask', 'allow', 'block']);
export type BrowserUseApprovalMode = z.infer<
  typeof browserUseApprovalModeSchema
>;

export const browserUseCapabilitySchema = z.enum([
  'read',
  'click',
  'fileTransfer',
  'fullCdpAccess',
  'history',
]);
export type BrowserUseCapability = z.infer<typeof browserUseCapabilitySchema>;

export const browserUseOriginPolicySchema = z.object({
  origin: z.string().min(1),
  read: browserUseApprovalModeSchema.default('ask'),
  click: browserUseApprovalModeSchema.default('ask'),
  fileTransfer: browserUseApprovalModeSchema.default('ask'),
  fullCdpAccess: browserUseApprovalModeSchema.default('block'),
  history: browserUseApprovalModeSchema.default('ask'),
  routeCapture: z.boolean().default(false),
  updatedAt: z.number().int().nonnegative(),
});
export type BrowserUseOriginPolicy = z.infer<
  typeof browserUseOriginPolicySchema
>;

export const browserUsePendingApprovalSchema = z.object({
  id: z.string(),
  origin: z.string(),
  capability: browserUseCapabilitySchema,
  description: z.string(),
  createdAt: z.number().int().nonnegative(),
});
export type BrowserUsePendingApproval = z.infer<
  typeof browserUsePendingApprovalSchema
>;

export const browserUseApprovalResponseSchema = z.enum([
  'allow-once',
  'always-allow',
  'block-once',
  'always-block',
]);
export type BrowserUseApprovalResponse = z.infer<
  typeof browserUseApprovalResponseSchema
>;

export const browserUseStateSchema = z.object({
  enabled: z.boolean().default(false),
  policies: z.record(z.string(), browserUseOriginPolicySchema).default({}),
  pendingApprovals: z.array(browserUsePendingApprovalSchema).default([]),
});
export type BrowserUseState = z.infer<typeof browserUseStateSchema>;

export const debugInspectorEventSchema = z.object({
  id: z.string(),
  createdAt: z.number().int().nonnegative(),
  channel: z.enum([
    'rpc',
    'agent',
    'process',
    'browser',
    'desktop',
    'guardian',
    'hook',
    'remote',
  ]),
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  message: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type DebugInspectorEvent = z.infer<typeof debugInspectorEventSchema>;

export const debugInspectorStateSchema = z.object({
  enabled: z.boolean().default(false),
  paused: z.boolean().default(false),
  events: z.array(debugInspectorEventSchema).default([]),
});
export type DebugInspectorState = z.infer<typeof debugInspectorStateSchema>;

export const skillInstallRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  version: z.string().default('0.0.0'),
  sourcePath: z.string(),
  installPath: z.string(),
  installedAt: z.number().int().nonnegative(),
  status: z.enum(['installed', 'failed']),
  message: z.string().optional(),
});
export type SkillInstallRecord = z.infer<typeof skillInstallRecordSchema>;

export const skillInstallPreviewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  sourcePath: z.string(),
  packageSize: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  conflict: z.boolean(),
});
export type SkillInstallPreview = z.infer<typeof skillInstallPreviewSchema>;

export const hookTriggerSchema = z.enum([
  'before-turn',
  'after-turn',
  'before-command',
  'after-command',
  'before-file-edit',
  'after-file-edit',
  'approval-requested',
]);
export type HookTrigger = z.infer<typeof hookTriggerSchema>;

export const hookDefinitionSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  trigger: hookTriggerSchema,
  kind: z.enum(['prompt', 'command', 'agent']),
  body: z.string().min(1),
  enabled: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type HookDefinition = z.infer<typeof hookDefinitionSchema>;

export const hookRunRecordSchema = z.object({
  id: z.string(),
  hookId: z.string(),
  trigger: hookTriggerSchema,
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
  status: z.enum(['succeeded', 'failed', 'skipped']),
  output: z.string().optional(),
  error: z.string().optional(),
});
export type HookRunRecord = z.infer<typeof hookRunRecordSchema>;

export const hookRunResultSchema = z.object({
  promptText: z.string(),
  runs: z.array(hookRunRecordSchema),
});
export type HookRunResult = z.infer<typeof hookRunResultSchema>;

export const remoteControlClientSchema = z.object({
  id: z.string(),
  label: z.string(),
  deviceId: z.string().uuid().nullable().default(null),
  platform: remoteControlPlatformSchema.default('unknown'),
  protocolVersion: z
    .number()
    .int()
    .nonnegative()
    .default(REMOTE_CONTROL_PROTOCOL_VERSION),
  keyFingerprint: z.string().nullable().default(null),
  attestedAt: z.number().int().nonnegative().nullable().default(null),
  trustLevel: remoteControlTrustLevelSchema.default('software'),
  attestationProvider: remoteControlNativeAttestationProviderSchema
    .nullable()
    .default(null),
  attestationVerifiedAt: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .default(null),
  attestationVerdict:
    remoteControlClientAttestationVerdictSchema.default('software-only'),
  pairedAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative().nullable().default(null),
  revoked: z.boolean().default(false),
});
export type RemoteControlClient = z.infer<typeof remoteControlClientSchema>;

export const remoteControlPendingApprovalSchema = z.object({
  id: z.string().uuid(),
  clientId: z.string().uuid(),
  clientLabel: z.string().min(1).max(80),
  command: remoteControlCommandSchema,
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  explanation: z.string().min(1).max(200),
  irreversible: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
export type RemoteControlPendingApproval = z.infer<
  typeof remoteControlPendingApprovalSchema
>;

export const remoteControlStateSchema = z.object({
  enabled: z.boolean().default(false),
  allowRemoteCommands: z.boolean().default(false),
  serverUrl: z.string().nullable().default(null),
  serverFingerprint: z.string().nullable().default(null),
  protocolVersion: z
    .number()
    .int()
    .nonnegative()
    .default(REMOTE_CONTROL_PROTOCOL_VERSION),
  pairingUrl: z.string().nullable().default(null),
  pairingQrDataUrl: z.string().nullable().default(null),
  pairingCode: z.string().nullable().default(null),
  pairingExpiresAt: z.number().int().nonnegative().nullable().default(null),
  clients: z.record(z.string(), remoteControlClientSchema).default({}),
  pendingApprovals: z
    .array(remoteControlPendingApprovalSchema)
    .max(20)
    .default([]),
});
export type RemoteControlState = z.infer<typeof remoteControlStateSchema>;

export const agentOsStateSchema = z.object({
  chronicle: chronicleStateSchema.prefault({}),
  micro: codexMicroStateSchema.prefault({}),
  browserUse: browserUseStateSchema.prefault({}),
  desktopAutomation: desktopAutomationStateSchema.prefault({}),
  debugInspector: debugInspectorStateSchema.prefault({}),
  guardian: guardianDogfoodStateSchema.prefault({}),
  installedSkills: z.array(skillInstallRecordSchema).default([]),
  pendingSkillInstall: skillInstallPreviewSchema.nullable().default(null),
  hooks: z.array(hookDefinitionSchema).default([]),
  hookRuns: z.array(hookRunRecordSchema).default([]),
  remoteControl: remoteControlStateSchema.prefault({}),
});
export type AgentOsState = z.infer<typeof agentOsStateSchema>;

export function createDefaultAgentOsState(): AgentOsState {
  return agentOsStateSchema.parse({});
}

export const defaultAgentOsState: AgentOsState = createDefaultAgentOsState();

export const AGENT_OS_LIMITS = {
  maxChronicleEvents: 200,
  maxChronicleSegments: 100,
  maxDebugEvents: 500,
  maxGuardianAssessments: 100,
  maxHookRuns: 100,
  maxSkillPackageBytes: 20 * 1024 * 1024,
  maxSkillPackageFiles: 500,
  maxHookOutputBytes: 64 * 1024,
  browserApprovalTtlMs: 2 * 60 * 1000,
  desktopAutomationApprovalTtlMs: 2 * 60 * 1000,
  remotePairingTtlMs: 5 * 60 * 1000,
  remoteCommandApprovalTtlMs: 2 * 60 * 1000,
  remoteSessionTtlMs: 15 * 60 * 1000,
} as const;

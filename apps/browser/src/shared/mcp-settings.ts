export type McpSettingsTransportType = 'stdio' | 'streamable-http' | 'sse';

export type McpSettingsPolicyDefault = 'ask' | 'deny' | 'allow-read-only';
export type McpSettingsToolDecision = 'allow' | 'ask' | 'deny';

export type McpSettingsConfigValue =
  | {
      kind: 'literal';
      value: string;
    }
  | {
      kind: 'credential';
      credentialId: string;
      field: string;
    };

export type McpSettingsOAuth = {
  clientRegistrationId: string;
  scopes: string[];
  redirectMode: 'custom-scheme';
};

export type McpSettingsTransport =
  | {
      type: 'stdio';
      command: string;
      args: string[];
      cwd?: string;
      env: Record<string, McpSettingsConfigValue>;
    }
  | {
      type: 'streamable-http' | 'sse';
      url: string;
      headers: Record<string, McpSettingsConfigValue>;
      oauth?: McpSettingsOAuth;
    };

export type McpSettingsPolicy = {
  default: McpSettingsPolicyDefault;
  tools: Record<string, McpSettingsToolDecision>;
};

export type McpServerSettingsInput = {
  id: string;
  displayName: string;
  enabled: boolean;
  transport: McpSettingsTransport;
  policy: McpSettingsPolicy;
};

export type McpSettingsSource =
  | {
      kind: 'builtin';
      label: string;
      builtinId: string;
    }
  | {
      kind: 'user';
      label: string;
    }
  | {
      kind: 'plugin';
      label: string;
      pluginId: string;
      pluginVersion: string;
    }
  | {
      kind: 'imported';
      label: string;
      importer: 'claude-desktop';
      importedAt: number;
    };

export type McpSettingsGroup =
  | 'clodex-cloud'
  | 'local-custom'
  | 'installed-plugins';

export type McpSettingsTrust =
  | 'builtin'
  | 'user-code'
  | 'reviewed-import'
  | 'signed-plugin';

export type McpServerRuntimeStatus =
  | 'disabled'
  | 'disconnected'
  | 'connecting'
  | 'authorization-required'
  | 'connected'
  | 'degraded'
  | 'failed';

export type McpServerRuntimeSettings = {
  status: McpServerRuntimeStatus;
  lastError: string | null;
  connectedAt: number | null;
  updatedAt: number;
  restartCount: number;
  catalogRevision: number;
};

export type McpServerSettings = {
  id: string;
  displayName: string;
  enabled: boolean;
  source: McpSettingsSource;
  group: McpSettingsGroup;
  trust: McpSettingsTrust;
  transport: McpSettingsTransport;
  transportPreview: string;
  policy: McpSettingsPolicy;
  runtime: McpServerRuntimeSettings;
  canEdit: boolean;
  canRemove: boolean;
  oauth: {
    configured: boolean;
    authorizationPending: boolean;
  } | null;
};

export type McpCredentialOption = {
  credentialId: string;
  displayName: string;
  configured: boolean;
  custom: boolean;
  canDelete: boolean;
  allowedOrigins: string[];
  fields: Array<{
    name: string;
    label: string;
  }>;
};

export type McpCustomCredentialInput = {
  credentialId: string;
  displayName: string;
  field: string;
  secret: string;
  allowedOrigins: string[];
};

export type McpSettingsSnapshot = {
  servers: McpServerSettings[];
  credentials: McpCredentialOption[];
  updatedAt: number;
};

export type McpToolSettings = {
  name: string;
  title: string | null;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  effectiveDecision: McpSettingsToolDecision;
  effectiveReason:
    | 'explicit-deny'
    | 'explicit-ask'
    | 'explicit-allow'
    | 'irreversible'
    | 'default-deny'
    | 'default-ask'
    | 'default-read-only'
    | 'read-only-untrusted';
};

export type McpResourceSettings = {
  uri: string;
  name: string;
  title: string | null;
  description: string | null;
  mimeType: string | null;
  size: number | null;
};

export type McpResourceTemplateSettings = {
  uriTemplate: string;
  name: string;
  title: string | null;
  description: string | null;
  mimeType: string | null;
};

export type McpPromptSettings = {
  name: string;
  title: string | null;
  description: string | null;
  arguments: Array<{
    name: string;
    description: string | null;
    required: boolean;
  }>;
};

export type McpReadResourceInput = {
  serverId: string;
  uri: string;
};

export type McpGetPromptInput = {
  serverId: string;
  promptName: string;
  arguments: Record<string, string>;
};

export type McpServerLogSettings = {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
};

export type McpConnectionTestResult = {
  ok: boolean;
  message: string;
  server: McpServerSettings;
  tools: McpToolSettings[];
};

export type McpImportRequiredSecretSettings = {
  key: string;
  target: 'env' | 'header';
  suggestedCredentialId: string | null;
};

export type McpImportServerSettings = {
  sourceName: string;
  proposedId: string;
  displayName: string;
  supported: boolean;
  readyToImport: boolean;
  warnings: string[];
  requiredSecrets: McpImportRequiredSecretSettings[];
  transport: McpSettingsTransport | null;
  transportPreview: string | null;
};

export type McpImportPreviewSettings = {
  previewId: string;
  source: 'claude-desktop';
  sourcePath: string;
  expiresAt: number;
  servers: McpImportServerSettings[];
};

export type McpImportSecretMappingsInput = Record<
  string,
  Record<
    string,
    {
      kind: 'credential';
      credentialId: string;
      field: string;
    }
  >
>;

export type McpApplyImportInput = {
  previewId: string;
  serverIds: string[];
  mappings: McpImportSecretMappingsInput;
};

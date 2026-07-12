export const GENERATED_APP_LIBRARY_URL =
  'clodex://internal/generated-apps' as const;

export type GeneratedAppStatus =
  | 'ready'
  | 'broken'
  | 'missing'
  | 'regenerating';

export type GeneratedAppOwner = {
  /**
   * Generated applications remain filesystem artifacts owned by the agent
   * task that created them. Library metadata is user-owned local state.
   */
  kind: 'agent';
  agentId: string;
  taskTitle: string | null;
  workspacePath: string | null;
};

export type GeneratedApp = {
  /** URL-safe, deterministic identity derived from agentId + appId. */
  key: string;
  appId: string;
  owner: GeneratedAppOwner;
  title: string;
  description: string | null;
  status: GeneratedAppStatus;
  entryPath: string;
  previewUrl: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  regenerationRequestedAt: string | null;
  fileCount: number;
  totalBytes: number;
  error: string | null;
};

export type GeneratedAppsSummary = {
  total: number;
  ready: number;
  needsAttention: number;
  regenerating: number;
};

export type GeneratedAppsStatusFilter =
  | 'all'
  | 'ready'
  | 'attention'
  | 'regenerating';

export type GeneratedAppsSort = 'updated-desc' | 'opened-desc' | 'title-asc';

export type GeneratedAppsQuery = {
  query?: string;
  status?: GeneratedAppsStatusFilter;
  workspacePath?: string;
  ownerAgentId?: string;
  sort?: GeneratedAppsSort;
};

export type GeneratedAppsListResult = {
  apps: GeneratedApp[];
  summary: GeneratedAppsSummary;
};

export type GeneratedAppIdentityInput = {
  key: string;
};

export type GeneratedAppActionFailureCode =
  | 'not-found'
  | 'not-runnable'
  | 'unsafe-path'
  | 'owner-unavailable'
  | 'operation-failed';

export type GeneratedAppActionResult =
  | {
      ok: true;
      app: GeneratedApp;
      message: string;
    }
  | {
      ok: false;
      code: GeneratedAppActionFailureCode;
      message: string;
      retryable: boolean;
    };

export type LaunchGeneratedAppResult =
  | {
      ok: true;
      app: GeneratedApp;
      previewUrl: string;
    }
  | {
      ok: false;
      code: GeneratedAppActionFailureCode;
      message: string;
      retryable: boolean;
    };

export type GeneratedAppPublisherTrustEntry = {
  publisherId: string;
  keyId: string;
  publicKeyFingerprint: string;
  trustedAt: string;
  revokedAt: string | null;
};

export type GeneratedAppPublisherPolicy = {
  mode: 'allow-all' | 'allowlist';
  allowedPublisherIds: string[];
  allowedPublicKeyFingerprints: string[];
  updatedAt: string;
};

export type GeneratedAppPublisherAuditEvent = {
  id: string;
  at: string;
  operation: 'trust' | 'revoke' | 'policy-update' | 'policy-deny';
  publisherId: string | null;
  keyId: string | null;
  publicKeyFingerprint: string | null;
  reason: string | null;
};

export type GeneratedAppPublisherAdministration = {
  entries: GeneratedAppPublisherTrustEntry[];
  policy: GeneratedAppPublisherPolicy;
  audit: GeneratedAppPublisherAuditEvent[];
};

export type GeneratedAppPublisherPolicyInput = Pick<
  GeneratedAppPublisherPolicy,
  'mode' | 'allowedPublisherIds' | 'allowedPublicKeyFingerprints'
>;

const KEY_PREFIX = 'v1';

function encodeUtf8Hex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function decodeUtf8Hex(value: string): string | null {
  if (value.length === 0 || value.length % 2 !== 0) return null;
  if (!/^[0-9a-f]+$/i.test(value)) return null;

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function createGeneratedAppKey(agentId: string, appId: string): string {
  return `${KEY_PREFIX}_${encodeUtf8Hex(agentId)}_${encodeUtf8Hex(appId)}`;
}

export function decodeGeneratedAppKey(
  key: string,
): { agentId: string; appId: string } | null {
  const parts = key.split('_');
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) return null;

  const agentId = decodeUtf8Hex(parts[1] ?? '');
  const appId = decodeUtf8Hex(parts[2] ?? '');
  if (!agentId || !appId) return null;
  return { agentId, appId };
}

export function createGeneratedAppPreviewUrl(
  agentId: string,
  appId: string,
  cacheBust?: string,
): string {
  const search = new URLSearchParams({ agentId });
  if (cacheBust) search.set('t', cacheBust);
  return `clodex://internal/preview/${encodeURIComponent(appId)}?${search.toString()}`;
}

import { z } from 'zod';

const trimmedRequiredString = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} is too long.`);

export const remoteConnectionAuthTypeSchema = z.enum([
  'ssh-agent',
  'private-key',
  'password',
]);
export type RemoteConnectionAuthType = z.infer<
  typeof remoteConnectionAuthTypeSchema
>;

export const remoteConnectionHostKeyPolicySchema = z.enum([
  'strict',
  'accept-new',
]);
export type RemoteConnectionHostKeyPolicy = z.infer<
  typeof remoteConnectionHostKeyPolicySchema
>;

const remoteConnectionBaseInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: trimmedRequiredString('Name', 80),
  host: trimmedRequiredString('Host', 255)
    .refine((value) => !/[\s/@\0]/.test(value), {
      message: 'Host must not contain whitespace, slash, or @.',
    })
    .refine((value) => !value.startsWith('-'), {
      message: 'Host must not start with a dash.',
    }),
  port: z.coerce.number().int().min(1).max(65_535).default(22),
  username: trimmedRequiredString('Username', 128)
    .regex(
      /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/,
      'Username contains unsupported characters.',
    )
    .refine((value) => !value.startsWith('-'), {
      message: 'Username must not start with a dash.',
    }),
  remotePath: z
    .string()
    .trim()
    .max(4096)
    .refine((value) => !/[\0\r\n]/.test(value), {
      message: 'Remote path must be a single line.',
    })
    .optional()
    .default(''),
  hostKeyPolicy: remoteConnectionHostKeyPolicySchema.default('strict'),
});

const sshAgentAuthenticationSchema = z.object({
  type: z.literal('ssh-agent'),
});

const privateKeyAuthenticationSchema = z.object({
  type: z.literal('private-key'),
  identityFile: trimmedRequiredString('Identity file', 4096).refine(
    (value) => !/[\0\r\n]/.test(value),
    {
      message: 'Identity file must be a single path.',
    },
  ),
  /**
   * Optional replacement passphrase. Omit or send an empty string to preserve
   * the existing encrypted value while editing a saved connection.
   */
  secret: z.string().max(16_384).optional(),
  clearSecret: z.boolean().optional(),
});

const passwordAuthenticationSchema = z.object({
  type: z.literal('password'),
  /**
   * Optional replacement password. Omit or send an empty string to preserve
   * the existing encrypted value while editing a saved connection.
   */
  secret: z.string().max(16_384).optional(),
  clearSecret: z.boolean().optional(),
});

export const remoteConnectionInputSchema =
  remoteConnectionBaseInputSchema.extend({
    authentication: z.discriminatedUnion('type', [
      sshAgentAuthenticationSchema,
      privateKeyAuthenticationSchema,
      passwordAuthenticationSchema,
    ]),
  });
export type RemoteConnectionInput = z.infer<typeof remoteConnectionInputSchema>;

export type RemoteConnectionStatusState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export type RemoteConnectionPublic = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  hostKeyPolicy: RemoteConnectionHostKeyPolicy;
  authentication:
    | { type: 'ssh-agent' }
    | {
        type: 'private-key';
        identityFile: string;
        credentialConfigured: boolean;
      }
    | { type: 'password'; credentialConfigured: boolean };
  createdAt: number;
  updatedAt: number;
  lastCheckedAt: number | null;
  lastConnectedAt: number | null;
  lastCheckSucceeded: boolean | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  status: RemoteConnectionStatusState;
};

export type RemoteConnectionCapabilities = {
  sshExecutable: boolean;
  persistentSessions: boolean;
  passwordAuthentication: boolean;
  terminalHandoff: boolean;
};

export type RemoteConnectionsListResult = {
  connections: RemoteConnectionPublic[];
  capabilities: RemoteConnectionCapabilities;
  runnerConnectionId: string | null;
};

export type RemoteRunnerSelectionResult =
  | {
      ok: true;
      runnerConnectionId: string | null;
      connection?: RemoteConnectionPublic;
      message: string;
    }
  | RemoteConnectionFailure;

export type RemoteConnectionFailureCode =
  | 'not-found'
  | 'invalid-input'
  | 'credential-required'
  | 'ssh-unavailable'
  | 'unsupported-platform'
  | 'authentication-failed'
  | 'host-key-failed'
  | 'connection-timeout'
  | 'network-error'
  | 'terminal-unavailable'
  | 'operation-failed';

export type RemoteConnectionFailure = {
  ok: false;
  code: RemoteConnectionFailureCode;
  message: string;
  connection?: RemoteConnectionPublic;
};

export type SaveRemoteConnectionResult =
  | { ok: true; connection: RemoteConnectionPublic }
  | RemoteConnectionFailure;

export type DeleteRemoteConnectionResult =
  | { ok: true; id: string }
  | RemoteConnectionFailure;

export type RemoteConnectionOperationResult =
  | {
      ok: true;
      connection: RemoteConnectionPublic;
      message: string;
    }
  | RemoteConnectionFailure;

export type OpenRemoteTerminalResult =
  | {
      ok: true;
      connection: RemoteConnectionPublic;
      terminalId: string;
    }
  | RemoteConnectionFailure;

export const remoteConnectionExecutionInputSchema = z.object({
  connectionId: z.string().uuid(),
  command: z.string().trim().min(1).max(32_768),
  timeoutSeconds: z.coerce.number().int().min(1).max(120).default(30),
});
export type RemoteConnectionExecutionInput = z.infer<
  typeof remoteConnectionExecutionInputSchema
>;

export type RemoteConnectionExecutionResult =
  | {
      ok: true;
      connectionId: string;
      connectionName: string;
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
    }
  | RemoteConnectionFailure;

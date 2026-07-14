import { describe, expect, it } from 'vitest';
import {
  isMainToMcpHostMessage,
  isMcpHostToMainMessage,
  mcpElicitationRequestSchema,
  MCP_HOST_PROTOCOL_VERSION,
} from './protocol';

const connectionId = '11111111-1111-4111-8111-111111111111';

describe('MCP host protocol', () => {
  it('accepts a resolved stdio connect request', () => {
    expect(
      isMainToMcpHostMessage({
        type: 'connect-server',
        launchId: 'launch-1',
        requestId: 'request-1',
        serverId: 'local-server',
        connectionId,
        transport: {
          type: 'stdio',
          command: '/usr/local/bin/example-mcp',
          args: [],
          env: { PATH: '/usr/bin' },
        },
        secretValues: [],
      }),
    ).toBe(true);
  });

  it('accepts an authenticated network proxy for a remote connect request', () => {
    expect(
      isMainToMcpHostMessage({
        type: 'connect-server',
        launchId: 'launch-1',
        requestId: 'request-1',
        serverId: 'remote-server',
        connectionId,
        transport: {
          type: 'streamable-http',
          url: 'https://mcp.example.com/v1',
          headers: {},
        },
        secretValues: [],
        networkProxy: {
          url: 'http://127.0.0.1:4319',
          authorization: 'Basic managed-capability',
        },
      }),
    ).toBe(true);
  });

  it('rejects an unresolved credential reference in a host request', () => {
    expect(
      isMainToMcpHostMessage({
        type: 'connect-server',
        launchId: 'launch-1',
        requestId: 'request-1',
        serverId: 'local-server',
        connectionId,
        transport: {
          type: 'stdio',
          command: '/usr/local/bin/example-mcp',
          args: [],
          env: {
            API_TOKEN: {
              kind: 'credential',
              credentialId: 'github-pat',
              field: 'token',
            },
          },
        },
        secretValues: ['secret'],
      }),
    ).toBe(false);
  });

  it('accepts ready responses for the current protocol', () => {
    expect(
      isMcpHostToMainMessage({
        type: 'ready',
        protocolVersion: MCP_HOST_PROTOCOL_VERSION,
        launchId: 'launch-1',
        pid: 123,
        startedAt: Date.now(),
      }),
    ).toBe(true);
  });

  it('accepts narrowly scoped host OAuth storage requests', () => {
    expect(
      isMcpHostToMainMessage({
        type: 'oauth-rpc-request',
        launchId: 'launch-1',
        authRequestId: 'auth-request-1',
        serverId: 'remote-server',
        request: {
          operation: 'open-authorization',
          authorizationUrl:
            'https://mcp.example.com/authorize?response_type=code',
        },
      }),
    ).toBe(true);
  });

  it('accepts bounded resources, prompts, and list-changed messages', () => {
    expect(
      isMcpHostToMainMessage({
        type: 'resources-result',
        launchId: 'launch-1',
        requestId: 'request-1',
        serverId: 'remote-server',
        resources: [
          {
            uri: 'file:///workspace/README.md',
            name: 'README',
            mimeType: 'text/markdown',
          },
        ],
      }),
    ).toBe(true);
    expect(
      isMcpHostToMainMessage({
        type: 'list-changed',
        launchId: 'launch-1',
        serverId: 'remote-server',
        connectionId,
        kind: 'prompts',
        prompts: [
          {
            name: 'review',
            arguments: [{ name: 'focus', required: false }],
          },
        ],
      }),
    ).toBe(true);
  });

  it('rejects ambiguous or mismatched list-changed payloads', () => {
    expect(
      isMcpHostToMainMessage({
        type: 'list-changed',
        launchId: 'launch-1',
        serverId: 'remote-server',
        connectionId,
        kind: 'tools',
        tools: [{ name: 'read', inputSchema: { type: 'object' } }],
        prompts: [{ name: 'review' }],
      }),
    ).toBe(false);
    expect(
      isMcpHostToMainMessage({
        type: 'list-changed',
        launchId: 'launch-1',
        serverId: 'remote-server',
        connectionId,
        kind: 'resources',
        prompts: [{ name: 'review' }],
      }),
    ).toBe(false);
  });

  it('accepts bounded form elicitation RPC messages', () => {
    expect(
      isMcpHostToMainMessage({
        type: 'elicitation-rpc-request',
        launchId: 'launch-1',
        elicitationRequestId: 'elicitation-1',
        serverId: 'remote-server',
        agentInstanceId: 'agent-1',
        request: {
          message: 'Choose a deployment environment.',
          fields: [
            {
              id: 'environment',
              kind: 'select',
              label: 'Environment',
              required: true,
              options: [
                { value: 'staging', label: 'Staging' },
                { value: 'production', label: 'Production' },
              ],
            },
          ],
        },
      }),
    ).toBe(true);
    expect(
      isMainToMcpHostMessage({
        type: 'elicitation-rpc-result',
        launchId: 'launch-1',
        elicitationRequestId: 'elicitation-1',
        ok: true,
        result: {
          action: 'accept',
          content: { environment: 'staging' },
        },
      }),
    ).toBe(true);
  });

  it('rejects malformed elicitation results and duplicate fields', () => {
    expect(
      isMainToMcpHostMessage({
        type: 'elicitation-rpc-result',
        launchId: 'launch-1',
        elicitationRequestId: 'elicitation-1',
        ok: true,
        result: { action: 'accept' },
      }),
    ).toBe(false);
    expect(
      isMcpHostToMainMessage({
        type: 'elicitation-rpc-request',
        launchId: 'launch-1',
        elicitationRequestId: 'elicitation-1',
        serverId: 'remote-server',
        agentInstanceId: 'agent-1',
        request: {
          message: 'Provide values.',
          fields: [
            {
              id: 'value',
              kind: 'text',
              label: 'First',
              required: false,
            },
            {
              id: 'value',
              kind: 'text',
              label: 'Second',
              required: false,
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it('rejects contradictory elicitation constraints and invalid defaults', () => {
    const invalidFields = [
      {
        id: 'text',
        kind: 'text',
        label: 'Text',
        required: false,
        minLength: 5,
        maxLength: 2,
      },
      {
        id: 'number',
        kind: 'number',
        label: 'Number',
        required: false,
        integer: true,
        minimum: 1,
        maximum: 3,
        defaultValue: 2.5,
      },
      {
        id: 'select',
        kind: 'select',
        label: 'Select',
        required: false,
        options: [{ value: 'one', label: 'One' }],
        defaultValue: 'missing',
      },
      {
        id: 'multi',
        kind: 'multi-select',
        label: 'Multi',
        required: false,
        options: [
          { value: 'one', label: 'One' },
          { value: 'two', label: 'Two' },
        ],
        minItems: 2,
        maxItems: 1,
        defaultValues: ['missing'],
      },
    ];

    for (const field of invalidFields) {
      expect(
        mcpElicitationRequestSchema.safeParse({
          message: 'Provide a value.',
          fields: [field],
        }).success,
      ).toBe(false);
    }
  });

  it('accepts internally consistent elicitation constraints and defaults', () => {
    expect(
      mcpElicitationRequestSchema.safeParse({
        message: 'Provide deployment details.',
        fields: [
          {
            id: 'name',
            kind: 'text',
            label: 'Name',
            required: true,
            minLength: 2,
            maxLength: 20,
            defaultValue: 'API',
          },
          {
            id: 'replicas',
            kind: 'number',
            label: 'Replicas',
            required: true,
            integer: true,
            minimum: 1,
            maximum: 5,
            defaultValue: 2,
          },
          {
            id: 'regions',
            kind: 'multi-select',
            label: 'Regions',
            required: false,
            options: [
              { value: 'us', label: 'US' },
              { value: 'eu', label: 'EU' },
            ],
            minItems: 1,
            maxItems: 2,
            defaultValues: ['us'],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects raw OAuth tokens in connect configuration metadata', () => {
    expect(
      isMainToMcpHostMessage({
        type: 'connect-server',
        launchId: 'launch-1',
        requestId: 'request-1',
        serverId: 'remote-server',
        connectionId,
        transport: {
          type: 'streamable-http',
          url: 'https://mcp.example.com/rpc',
          headers: {},
          oauth: {
            clientRegistrationId: 'clodex-dynamic',
            redirectUrl: 'clodex-ide://mcp/oauth/callback',
            scopes: [],
            clientMetadata: {
              redirect_uris: ['clodex-ide://mcp/oauth/callback'],
            },
            allowedAuthorizationOrigins: ['https://mcp.example.com'],
            tokens: { access_token: 'must-not-be-here' },
          },
        },
        secretValues: [],
      }),
    ).toBe(false);
  });
});

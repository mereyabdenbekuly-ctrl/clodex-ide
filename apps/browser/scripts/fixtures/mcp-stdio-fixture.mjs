import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const server = new McpServer({
  name: 'clodex-mcp-stdio-smoke-fixture',
  version: '1.0.0',
});

registerContextFixtures(server, 'stdio');

server.registerTool(
  'echo',
  {
    description: 'Echo a message through the stdio fixture.',
    inputSchema: {
      message: z.string(),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: `stdio:${message}` }],
  }),
);

server.registerTool(
  'slow',
  {
    description:
      'Wait before returning so timeout and cancellation can be tested.',
    inputSchema: {
      delayMs: z.number().int().min(1).max(30_000),
    },
  },
  async ({ delayMs }) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      content: [{ type: 'text', text: `waited:${delayMs}` }],
    };
  },
);

server.registerTool(
  'elicit',
  {
    description: 'Request bounded form input through the MCP client.',
    inputSchema: {
      delayBeforeElicitMs: z.number().int().min(0).max(5_000).default(0),
      message: z.string().default('Choose deployment settings.'),
    },
  },
  async ({ delayBeforeElicitMs, message }) => {
    if (delayBeforeElicitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayBeforeElicitMs));
    }
    const result = await server.server.elicitInput({
      mode: 'form',
      message,
      requestedSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            title: 'Service name',
            minLength: 2,
            maxLength: 20,
          },
          replicas: {
            type: 'integer',
            title: 'Replicas',
            minimum: 1,
            maximum: 5,
            default: 2,
          },
          enabled: {
            type: 'boolean',
            title: 'Enabled',
            default: true,
          },
          environment: {
            type: 'string',
            title: 'Environment',
            oneOf: [
              { const: 'staging', title: 'Staging' },
              { const: 'production', title: 'Production' },
            ],
            default: 'staging',
          },
          regions: {
            type: 'array',
            title: 'Regions',
            items: {
              type: 'string',
              enum: ['us', 'eu'],
            },
            minItems: 1,
            maxItems: 2,
            default: ['us'],
          },
        },
        required: ['name', 'replicas', 'environment'],
      },
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action: result.action,
            content: result.content ?? null,
          }),
        },
      ],
    };
  },
);

let catalogChanged = false;
server.registerTool(
  'change_catalog',
  {
    description: 'Register additional fixture catalog entries.',
    inputSchema: {},
  },
  async () => {
    if (!catalogChanged) {
      catalogChanged = true;
      registerChangedCatalog(server, 'stdio');
    }
    return {
      content: [{ type: 'text', text: 'stdio:catalog-changed' }],
    };
  },
);

if (process.env.SMOKE_SECRET) {
  console.error(`fixture credential token=${process.env.SMOKE_SECRET}`);
}

await server.connect(new StdioServerTransport());

function registerContextFixtures(target, prefix) {
  target.registerResource(
    'readme',
    `smoke://${prefix}/readme`,
    {
      title: `${prefix} README`,
      description: `Static resource from the ${prefix} smoke fixture.`,
      mimeType: 'text/plain',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: `${prefix}:readme` }],
    }),
  );
  target.registerResource(
    'item',
    new ResourceTemplate(`smoke://${prefix}/items/{id}`, {
      list: undefined,
    }),
    {
      title: `${prefix} item`,
      description: `Templated resource from the ${prefix} smoke fixture.`,
      mimeType: 'text/plain',
    },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          text: `${prefix}:item:${String(variables.id)}`,
        },
      ],
    }),
  );
  target.registerPrompt(
    'review',
    {
      description: `Review prompt from the ${prefix} smoke fixture.`,
      argsSchema: { focus: z.string().optional() },
    },
    async ({ focus }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `${prefix}:review:${focus ?? 'general'}`,
          },
        },
      ],
    }),
  );
}

function registerChangedCatalog(target, prefix) {
  target.registerTool(
    'catalog_echo',
    {
      description: 'Tool registered after a list-changed event.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: `${prefix}:catalog-echo` }],
    }),
  );
  target.registerResource(
    'catalog-status',
    `smoke://${prefix}/catalog-status`,
    {
      description: 'Resource registered after a list-changed event.',
      mimeType: 'text/plain',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: `${prefix}:catalog-status` }],
    }),
  );
  target.registerPrompt(
    'catalog-review',
    {
      description: 'Prompt registered after a list-changed event.',
    },
    async () => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: `${prefix}:catalog-review` },
        },
      ],
    }),
  );
}

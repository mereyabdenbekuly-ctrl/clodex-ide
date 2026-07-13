import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({
  name: 'clodex-packaged-acceptance-fixture',
  version: '1.0.0',
});

server.registerTool(
  'health_check',
  {
    description: 'Return a deterministic local health response.',
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }),
);

const transport = new StdioServerTransport();
let closing = false;

process.stdin.once('end', () => {
  if (closing) return;
  closing = true;
  void server.close().finally(() => process.exit(0));
});

void server.connect(transport).catch(() => {
  process.stderr.write('MCP_ACCEPTANCE_FIXTURE status=failed\n');
  process.exit(1);
});

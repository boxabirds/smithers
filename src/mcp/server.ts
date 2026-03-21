import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type pg from 'pg';
import type { Config } from '../config.js';
import { validateBearerToken } from './auth.js';
import {
  handleSearchKnowledge,
  handleGetActions,
  handleGetOpenQuestions,
  handleGetProjects,
  handleGetDecisions,
  handleGetDigest,
  handleGetEntityContext,
} from './tools.js';
import { z } from 'zod';

const TOOL_COUNT = 7;

export interface McpServerHandle {
  close: () => Promise<void>;
}

export async function startMcpServer(config: Config, pool: pg.Pool): Promise<McpServerHandle> {
  if (!config.mcp.authToken) {
    throw new Error('MCP_AUTH_TOKEN must be configured');
  }

  const mcp = new McpServer({
    name: 'discord-secretary',
    version: '0.1.0',
  });

  // Register tools
  mcp.tool(
    'search_knowledge',
    'Search across all entity types in the knowledge base',
    {
      query: z.string().describe('Free text search query'),
      type: z.string().optional().describe('Filter by entity type'),
      status: z.string().optional().describe('Filter by status'),
      since: z.string().optional().describe('ISO date - only entities seen after this'),
      limit: z.number().optional().describe('Max results (default 20)'),
    },
    async ({ query, type, status, since, limit }) => {
      const result = await handleSearchKnowledge(pool, { query, type, status, since, limit });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'get_actions',
    'Get open action items',
    {
      assignee: z.string().optional().describe('Filter by assignee'),
      status: z.enum(['open', 'stale', 'all']).optional().describe('Filter by status (default open)'),
      since: z.string().optional().describe('ISO date'),
    },
    async ({ assignee, status, since }) => {
      const result = await handleGetActions(pool, { assignee, status, since });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'get_open_questions',
    'Get unanswered questions',
    {
      since: z.string().optional().describe('ISO date'),
      channel: z.string().optional().describe('Channel ID filter'),
    },
    async ({ since, channel }) => {
      const result = await handleGetOpenQuestions(pool, { since, channel });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'get_projects',
    'Get project summaries',
    {
      status: z.enum(['active', 'stale', 'all']).optional().describe('Filter by status'),
    },
    async ({ status }) => {
      const result = await handleGetProjects(pool, { status });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'get_decisions',
    'Get recent decisions',
    {
      since: z.string().optional().describe('ISO date'),
      limit: z.number().optional().describe('Max results (default 20)'),
    },
    async ({ since, limit }) => {
      const result = await handleGetDecisions(pool, { since, limit });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'get_digest',
    'Get a cross-cutting summary for a time window',
    {
      since: z.string().describe('Start date (ISO)'),
      until: z.string().optional().describe('End date (ISO, defaults to now)'),
    },
    async ({ since, until }) => {
      const result = await handleGetDigest(pool, { since, until });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'get_entity_context',
    'Get raw conversation context around a specific entity',
    {
      entity_id: z.number().describe('Entity ID'),
      messages_before: z.number().optional().describe('Messages before evidence (default 5)'),
      messages_after: z.number().optional().describe('Messages after evidence (default 5)'),
    },
    async ({ entity_id, messages_before, messages_after }) => {
      const result = await handleGetEntityContext(pool, { entity_id, messages_before, messages_after });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  // HTTP server with SSE transport
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', tools: TOOL_COUNT }));
      return;
    }

    // Auth check for MCP endpoints (use pathname to ignore query params)
    const pathname = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;
    if (pathname === '/sse' || pathname === '/message') {
      if (!validateBearerToken(req.headers.authorization, config)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    // SSE endpoint
    if (req.method === 'GET' && pathname === '/sse') {
      const transport = new SSEServerTransport('/message', res);
      transports.set(transport.sessionId, transport);

      // Clean up transport when the SSE connection closes
      res.on('close', () => {
        transports.delete(transport.sessionId);
      });

      await mcp.connect(transport);
      return;
    }

    // Message endpoint
    if (req.method === 'POST' && req.url?.startsWith('/message')) {
      const sessionId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('sessionId');
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        res.writeHead(404);
        res.end('Session not found');
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  const port = config.mcp.port;

  await new Promise<void>((resolve) => {
    httpServer.listen(port, () => {
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        service: 'mcp',
        message: `MCP server listening on port ${port}`,
        tools: TOOL_COUNT,
      }));
      resolve();
    });
  });

  return {
    close: async () => {
      for (const transport of transports.values()) {
        await transport.close();
      }
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

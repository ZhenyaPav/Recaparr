import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { RecapServiceError, type RecapService } from './recap-service.js';

function createServer(config: Config, service: RecapService, logger: Logger): McpServer {
  const server = new McpServer({ name: 'recaparr', version: '0.1.4' });
  server.registerTool('get_recap', {
    title: 'Get movie or episode recap',
    description: 'Returns a cached spoiler recap for a Jellyfin movie or episode. Cache misses and forced refreshes continue asynchronously; pending results indicate that generation is in progress.',
    inputSchema: {
      jellyfin_id: z.string().min(8).max(64).describe('Jellyfin movie or episode item ID'),
      force_regenerate: z.boolean().optional().default(false).describe('Regenerate this language even when a cached recap exists'),
      language: z.string().optional().default(config.summaryLanguage).describe('BCP-47 output language; defaults to server configuration')
    }
  }, async (input) => {
    try {
      const result = await service.getRecap(input);
      logger.info('MCP get_recap completed', {
        jellyfinId: input.jellyfin_id,
        language: result.language,
        status: result.status,
        stale: Boolean(result.stale)
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result as unknown as Record<string, unknown> };
    } catch (error) {
      if (error instanceof RecapServiceError) {
        logger.warn('MCP get_recap rejected', {
          jellyfinId: input.jellyfin_id,
          code: error.code,
          error: error.message
        });
        const payload = { code: error.code, message: error.message, ...error.details };
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error('MCP get_recap failed', { jellyfinId: input.jellyfin_id, error: message });
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code: 'RECAPARR_ERROR', message }) }] };
    }
  });
  return server;
}

export function mcpHandler(config: Config, service: RecapService, logger: Logger) {
  return async (request: Request, response: Response): Promise<void> => {
    const server = createServer(config, service, logger);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      logger.error('MCP request failed', { error: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) response.status(500).json({ error: 'MCP request failed' });
    }
  };
}

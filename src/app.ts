import express, { type Express } from 'express';
import type { Config } from './config.js';
import type { RecapDatabase } from './database.js';
import type { Logger } from './logger.js';
import type { PathMapper } from './path-mapper.js';
import type { RecapService } from './recap-service.js';
import { bearerAuth } from './auth.js';
import { mcpHandler } from './mcp.js';
import { parseRadarrWebhook, parseSonarrWebhook } from './webhooks.js';

export function createApp(config: Config, database: RecapDatabase, mapper: PathMapper, service: RecapService, logger: Logger): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb', type: ['application/json', 'application/*+json'] }));

  app.get('/healthz', (_request, response) => {
    try {
      database.ping();
      response.json({ status: 'ok', version: '0.1.0' });
    } catch {
      response.status(503).json({ status: 'unhealthy' });
    }
  });

  const auth = bearerAuth(config.apiToken);
  app.post('/mcp', auth, mcpHandler(config, service, logger));
  app.all('/mcp', auth, (_request, response) => response.status(405).json({ error: 'Method not allowed' }));

  const webhook = (source: 'sonarr' | 'radarr') => (request: express.Request, response: express.Response) => {
    try {
      const parsed = source === 'sonarr' ? parseSonarrWebhook(request.body, mapper) : parseRadarrWebhook(request.body, mapper);
      if (parsed.test) { response.json({ status: 'ok', test: true }); return; }
      if (parsed.ignored) { response.json({ status: 'ignored' }); return; }
      const itemIds = parsed.items.map((identity) => service.ingest(identity).id);
      response.status(202).json({ status: config.eagerGeneration ? 'queued' : 'recorded', items: itemIds.length, itemIds });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('invalid webhook', { source, error: message });
      response.status(400).json({ error: message });
    }
  };
  app.post('/webhooks/sonarr', auth, webhook('sonarr'));
  app.post('/webhooks/radarr', auth, webhook('radarr'));

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    logger.warn('HTTP request rejected', { error: error instanceof Error ? error.message : String(error) });
    response.status(400).json({ error: 'Invalid request' });
  });
  return app;
}

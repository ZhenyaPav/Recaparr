import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { RecapDatabase } from './database.js';
import { JellyfinClient } from './jellyfin.js';
import { Logger } from './logger.js';
import { PathMapper } from './path-mapper.js';
import { GenerationQueue } from './queue.js';
import { RecapService } from './recap-service.js';
import { SubtitleExtractor } from './subtitles.js';
import { Summarizer } from './summarizer.js';

const config = loadConfig();
const logger = new Logger(config.logLevel);
const database = new RecapDatabase(config.databasePath);
const mapper = new PathMapper(config.mediaRoot, config.arrPathPrefix, config.jellyfinPathPrefix);
const jellyfin = new JellyfinClient(config.jellyfinUrl, config.jellyfinApiKey, mapper, {
  userId: config.jellyfinUserId,
  logger
});
const subtitles = new SubtitleExtractor(config.preferredSubtitleLanguage, config.ffprobeBin, config.ffmpegBin);
const summarizer = new Summarizer(config);
const queue = new GenerationQueue(config, database, mapper, subtitles, summarizer, logger);
const service = new RecapService(config, database, jellyfin, queue, logger);
const server = createServer(createApp(config, database, mapper, service, logger));

queue.start();
server.listen(config.port, '0.0.0.0', () => logger.info('Recaparr listening', {
  port: config.port,
  version: '0.1.4',
  eagerGeneration: config.eagerGeneration,
  lazyGeneration: config.lazyGeneration,
  preferredSubtitleLanguage: config.preferredSubtitleLanguage,
  summaryLanguage: config.summaryLanguage,
  jellyfinUserConfigured: Boolean(config.jellyfinUserId),
  llmBaseUrl: config.llmBaseUrl,
  llmModel: config.llmModel,
  llmThinking: config.llmThinking
}));

function shutdown(signal: string): void {
  logger.info('shutting down', { signal });
  queue.stop();
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

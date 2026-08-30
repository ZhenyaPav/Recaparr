import type { Config } from './config.js';
import type { RecapDatabase } from './database.js';
import type { Logger } from './logger.js';
import type { PathMapper } from './path-mapper.js';
import type { SubtitleExtractor } from './subtitles.js';
import type { Summarizer } from './summarizer.js';

export class GenerationQueue {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    private readonly config: Config,
    private readonly database: RecapDatabase,
    private readonly pathMapper: PathMapper,
    private readonly subtitles: SubtitleExtractor,
    private readonly summarizer: Summarizer,
    private readonly logger: Logger
  ) {}

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.processNext(), 1_000);
    this.timer.unref();
    this.logger.info('generation queue started');
    this.wake();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.logger.info('generation queue stopped');
  }

  wake(): void { setImmediate(() => void this.processNext()); }

  async processNext(): Promise<boolean> {
    if (this.running || this.stopped) return false;
    const job = this.database.nextDueJob();
    if (!job) return false;
    this.running = true;
    const startedAt = Date.now();
    this.database.markGenerating(job.itemId, job.language);
    this.logger.info('generation started', {
      itemId: job.itemId,
      jellyfinId: job.item.jellyfinId,
      language: job.language,
      kind: job.item.kind,
      attempt: job.attempts + 1
    });
    try {
      const shared = this.database.completedRecapForPath(job.item.path, job.language, job.itemId);
      if (shared?.recap) {
        this.database.markSuccess(job.itemId, job.language, shared.recap);
        this.logger.info('generation reused recap for shared media file', {
          itemId: job.itemId,
          sourceItemId: shared.itemId,
          language: job.language
        });
      } else {
        const mediaPath = this.pathMapper.assertReadableMediaFile(job.item.path);
        const { text, candidate } = await this.subtitles.extract(mediaPath);
        this.logger.info('subtitle selected', {
          itemId: job.itemId,
          source: candidate.source,
          language: candidate.language,
          preferred: candidate.preferred,
          forced: candidate.forced,
          label: candidate.label,
          transcriptCharacters: text.length
        });
        this.logger.info('summary generation requested', {
          itemId: job.itemId,
          language: job.language,
          model: this.config.llmModel
        });
        const recap = await this.summarizer.summarize(text, job.item, job.language);
        this.database.markSuccess(job.itemId, job.language, recap);
        this.logger.info('summary generation received', {
          itemId: job.itemId,
          language: job.language,
          recapCharacters: recap.length,
          recap
        });
      }
      this.logger.info('generation completed', {
        itemId: job.itemId,
        language: job.language,
        elapsedMs: Date.now() - startedAt
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = this.database.markFailure(job.itemId, job.language, message, this.config.retryDelaysMs);
      this.logger.warn('generation failed', {
        itemId: job.itemId,
        language: job.language,
        status: state.status,
        attempts: state.attempts,
        nextAttemptAt: state.nextAttemptAt,
        elapsedMs: Date.now() - startedAt,
        error: message
      });
    } finally {
      this.running = false;
      if (!this.stopped) this.wake();
    }
    return true;
  }
}

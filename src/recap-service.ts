import type { Config } from './config.js';
import { normalizeLanguage } from './config.js';
import type { RecapDatabase } from './database.js';
import type { GenerationQueue } from './queue.js';
import type { JellyfinClient } from './jellyfin.js';
import type { GetRecapInput, GetRecapResult, MediaIdentity, MediaItem } from './types.js';

export class RecapServiceError extends Error {
  constructor(message: string, readonly code: string, readonly details: Record<string, unknown> = {}) { super(message); }
}

export class RecapService {
  constructor(
    private readonly config: Config,
    private readonly database: RecapDatabase,
    private readonly jellyfin: JellyfinClient,
    private readonly queue: GenerationQueue
  ) {}

  ingest(identity: MediaIdentity): MediaItem {
    const item = this.database.upsertItem(identity);
    if (this.config.eagerGeneration) {
      this.database.enqueue(item.id, this.config.summaryLanguage, false);
      this.queue.wake();
    }
    return item;
  }

  async getRecap(input: GetRecapInput): Promise<GetRecapResult> {
    const language = normalizeLanguage(input.language ?? this.config.summaryLanguage);
    const identity = await this.jellyfin.resolve(input.jellyfin_id);
    const item = this.database.upsertItem(identity);
    let recap = this.database.getRecap(item.id, language);
    const active = recap && ['queued', 'generating', 'retrying'].includes(recap.status);

    if (input.force_regenerate) {
      if (!this.config.lazyGeneration) throw this.disabledError(item.id, language, 'Forced regeneration is disabled');
      if (!active) recap = this.database.enqueue(item.id, language, true);
      this.queue.wake();
      return this.pendingResult(item, recap!, true);
    }

    if (recap?.status === 'completed' && recap.recap) {
      return {
        status: 'completed', jellyfinId: input.jellyfin_id, language, title: item.title,
        recap: recap.recap, generatedAt: recap.generatedAt ?? undefined
      };
    }
    if (active) return this.pendingResult(item, recap!, Boolean(recap!.recap));
    if (!this.config.lazyGeneration) throw this.disabledError(item.id, language, 'No cached recap exists and lazy generation is disabled');

    recap = this.database.enqueue(item.id, language, true);
    this.queue.wake();
    return this.pendingResult(item, recap, Boolean(recap.recap));
  }

  private disabledError(itemId: number, language: string, message: string): RecapServiceError {
    return new RecapServiceError(message, 'RECAP_NOT_FOUND_LAZY_DISABLED', {
      language, availableLanguages: this.database.availableLanguages(itemId)
    });
  }

  private pendingResult(item: MediaItem, recap: NonNullable<ReturnType<RecapDatabase['getRecap']>>, regenerating: boolean): GetRecapResult {
    const result: GetRecapResult = {
      status: regenerating && recap.recap ? 'regenerating' : recap.status,
      jellyfinId: item.jellyfinId!, language: recap.language, title: item.title,
      message: recap.status === 'retrying' ? recap.error ?? 'Waiting to retry generation' : 'Recap generation is in progress'
    };
    if (recap.recap) {
      result.recap = recap.recap;
      result.stale = true;
      if (recap.generatedAt) result.generatedAt = recap.generatedAt;
    }
    if (recap.nextAttemptAt) result.retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(recap.nextAttemptAt) - Date.now()) / 1000));
    else result.retryAfterSeconds = 5;
    return result;
  }
}

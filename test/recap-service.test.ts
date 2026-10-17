import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecapDatabase } from '../src/database.js';
import { RecapService, RecapServiceError } from '../src/recap-service.js';
import { testConfig } from './helpers.js';
import { Logger } from '../src/logger.js';

let database: RecapDatabase | undefined;
afterEach(() => database?.close());

function setup(lazyGeneration = true) {
  database = new RecapDatabase(':memory:');
  const config = testConfig({ lazyGeneration });
  const jellyfin = { resolve: vi.fn().mockResolvedValue({ kind: 'movie', jellyfinId: 'abcdef123456', path: '/media/a.mkv', title: 'A', tmdbId: '1' }) };
  const queue = { wake: vi.fn() };
  const service = new RecapService(config, database, jellyfin as never, queue as never, new Logger('error'));
  return { service, queue };
}

describe('RecapService', () => {
  it('queues language-specific cache misses', async () => {
    const { service, queue } = setup();
    const result = await service.getRecap({ jellyfin_id: 'abcdef123456', language: 'ro' });
    expect(result).toMatchObject({ status: 'queued', language: 'ro', message: 'Recap generation is in progress' });
    expect(result).not.toHaveProperty('retryAfterSeconds');
    expect(queue.wake).toHaveBeenCalled();
  });

  it('returns cached recaps', async () => {
    const { service } = setup();
    const item = database!.upsertItem({ kind: 'movie', jellyfinId: 'abcdef123456', path: '/media/a.mkv', title: 'A', tmdbId: '1' });
    database!.enqueue(item.id, 'en');
    database!.markSuccess(item.id, 'en', 'The recap');
    expect(await service.getRecap({ jellyfin_id: 'abcdef123456' })).toMatchObject({ status: 'completed', recap: 'The recap' });
  });

  it.each(['completed', 'queued', 'generating', 'retrying', 'failed'] as const)('invalidates the old result and forces generation from %s', async (status) => {
    const { service, queue } = setup();
    const item = database!.upsertItem({ kind: 'movie', jellyfinId: 'abcdef123456', path: '/media/a.mkv', title: 'A', tmdbId: '1' });
    database!.enqueue(item.id, 'en');
    database!.markSuccess(item.id, 'en', 'Old recap');
    database!.db.prepare('UPDATE recaps SET status = ?, error = ?, attempts = 3, next_attempt_at = ? WHERE item_id = ? AND language = ?')
      .run(status, 'Old OpenRouter error', '2999-01-01T00:00:00.000Z', item.id, 'en');

    const result = await service.getRecap({ jellyfin_id: 'abcdef123456', force_regenerate: true });
    const expectedStatus = status === 'generating' ? 'generating' : 'queued';
    expect(result).toEqual({
      status: expectedStatus, jellyfinId: 'abcdef123456', language: 'en', title: 'A',
      message: 'Recap generation is in progress'
    });
    expect(database!.getRecap(item.id, 'en')).toMatchObject({
      status: expectedStatus, recap: null, error: null, generatedAt: null, attempts: 0
    });
    expect(database!.nextDueJob()?.itemId).toBe(status === 'generating' ? undefined : item.id);
    expect(queue.wake).toHaveBeenCalledOnce();
    expect(await service.getRecap({ jellyfin_id: 'abcdef123456' })).toEqual(result);
  });

  it('treats lazy generation as a hard kill switch', async () => {
    const { service } = setup(false);
    await expect(service.getRecap({ jellyfin_id: 'abcdef123456', force_regenerate: true })).rejects.toMatchObject({ code: 'RECAP_NOT_FOUND_LAZY_DISABLED' } satisfies Partial<RecapServiceError>);
  });
});

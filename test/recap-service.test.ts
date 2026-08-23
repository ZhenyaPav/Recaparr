import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecapDatabase } from '../src/database.js';
import { RecapService, RecapServiceError } from '../src/recap-service.js';
import { testConfig } from './helpers.js';

let database: RecapDatabase | undefined;
afterEach(() => database?.close());

function setup(lazyGeneration = true) {
  database = new RecapDatabase(':memory:');
  const config = testConfig({ lazyGeneration });
  const jellyfin = { resolve: vi.fn().mockResolvedValue({ kind: 'movie', jellyfinId: 'abcdef123456', path: '/media/a.mkv', title: 'A', tmdbId: '1' }) };
  const queue = { wake: vi.fn() };
  const service = new RecapService(config, database, jellyfin as never, queue as never);
  return { service, queue };
}

describe('RecapService', () => {
  it('queues language-specific cache misses', async () => {
    const { service, queue } = setup();
    const result = await service.getRecap({ jellyfin_id: 'abcdef123456', language: 'ro' });
    expect(result).toMatchObject({ status: 'queued', language: 'ro' });
    expect(queue.wake).toHaveBeenCalled();
  });

  it('returns cached recaps', async () => {
    const { service } = setup();
    const item = database!.upsertItem({ kind: 'movie', jellyfinId: 'abcdef123456', path: '/media/a.mkv', title: 'A', tmdbId: '1' });
    database!.enqueue(item.id, 'en');
    database!.markSuccess(item.id, 'en', 'The recap');
    expect(await service.getRecap({ jellyfin_id: 'abcdef123456' })).toMatchObject({ status: 'completed', recap: 'The recap' });
  });

  it('preserves stale recaps while forcing regeneration', async () => {
    const { service } = setup();
    const item = database!.upsertItem({ kind: 'movie', jellyfinId: 'abcdef123456', path: '/media/a.mkv', title: 'A', tmdbId: '1' });
    database!.enqueue(item.id, 'en');
    database!.markSuccess(item.id, 'en', 'Old recap');
    expect(await service.getRecap({ jellyfin_id: 'abcdef123456', force_regenerate: true })).toMatchObject({ status: 'regenerating', recap: 'Old recap', stale: true });
  });

  it('treats lazy generation as a hard kill switch', async () => {
    const { service } = setup(false);
    await expect(service.getRecap({ jellyfin_id: 'abcdef123456', force_regenerate: true })).rejects.toMatchObject({ code: 'RECAP_NOT_FOUND_LAZY_DISABLED' } satisfies Partial<RecapServiceError>);
  });
});

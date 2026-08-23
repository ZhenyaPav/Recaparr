import { afterEach, describe, expect, it } from 'vitest';
import { RecapDatabase } from '../src/database.js';

let database: RecapDatabase | undefined;
afterEach(() => database?.close());

describe('RecapDatabase', () => {
  it('reconciles webhook and Jellyfin identities using provider IDs', () => {
    database = new RecapDatabase(':memory:');
    const imported = database.upsertItem({ kind: 'movie', path: '/media/movies/a.mkv', title: 'A', tmdbId: '42', radarrId: '7' });
    const resolved = database.upsertItem({ kind: 'movie', jellyfinId: 'abcdef123456', path: '/media/movies/a.mkv', title: 'A', tmdbId: '42' });
    expect(resolved.id).toBe(imported.id);
    expect(resolved.jellyfinId).toBe('abcdef123456');
  });

  it('stores recaps per language and preserves stale text during force regeneration', () => {
    database = new RecapDatabase(':memory:');
    const item = database.upsertItem({ kind: 'movie', path: '/media/a.mkv', title: 'A', tmdbId: '1' });
    database.enqueue(item.id, 'en');
    database.markSuccess(item.id, 'en', 'Old recap');
    database.enqueue(item.id, 'ro');
    database.markSuccess(item.id, 'ro', 'Recapitulare');
    const forced = database.enqueue(item.id, 'en', true);
    expect(forced.status).toBe('queued');
    expect(forced.recap).toBe('Old recap');
    expect(database.availableLanguages(item.id)).toEqual(['en', 'ro']);
  });

  it('persists bounded retries and ends in failed state', () => {
    database = new RecapDatabase(':memory:');
    const item = database.upsertItem({ kind: 'movie', path: '/media/a.mkv', title: 'A' });
    database.enqueue(item.id, 'en');
    database.markGenerating(item.id, 'en');
    expect(database.markFailure(item.id, 'en', 'missing subtitles', [1]).status).toBe('retrying');
    expect(database.markFailure(item.id, 'en', 'still missing', [1]).status).toBe('failed');
  });

  it('reuses a completed recap for another logical episode sharing a file', () => {
    database = new RecapDatabase(':memory:');
    const one = database.upsertItem({ kind: 'episode', path: '/media/double.mkv', title: 'Part 1', seriesTvdbId: '9', seasonNumber: 1, episodeNumber: 1 });
    const two = database.upsertItem({ kind: 'episode', path: '/media/double.mkv', title: 'Part 2', seriesTvdbId: '9', seasonNumber: 1, episodeNumber: 2 });
    database.enqueue(one.id, 'en');
    database.markSuccess(one.id, 'en', 'Shared recap');
    expect(database.completedRecapForPath('/media/double.mkv', 'en', two.id)?.recap).toBe('Shared recap');
  });
});

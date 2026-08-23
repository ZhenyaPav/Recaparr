import { describe, expect, it } from 'vitest';
import { PathMapper } from '../src/path-mapper.js';
import { parseRadarrWebhook, parseSonarrWebhook } from '../src/webhooks.js';

const mapper = new PathMapper('/media', '/downloads', '/data');

describe('Arr webhooks', () => {
  it('parses Radarr imports', () => {
    const result = parseRadarrWebhook({ eventType: 'Download', movie: { id: 3, title: 'Movie', tmdbId: 10 }, movieFile: { path: '/downloads/movies/Movie.mkv' } }, mapper);
    expect(result.items[0]).toMatchObject({ kind: 'movie', path: '/media/movies/Movie.mkv', tmdbId: '10', radarrId: '3' });
  });

  it('matches Sonarr season-pack files by episode numbers', () => {
    const result = parseSonarrWebhook({
      eventType: 'ImportComplete', series: { id: 1, title: 'Show', tvdbId: 99 },
      episodes: [
        { id: 11, title: 'One', seasonNumber: 1, episodeNumber: 1, tvdbId: 101 },
        { id: 12, title: 'Two', seasonNumber: 1, episodeNumber: 2, tvdbId: 102 }
      ],
      episodeFiles: [
        { path: '/downloads/tv/Show.S01E02.mkv' },
        { path: '/downloads/tv/Show.S01E01.mkv' }
      ]
    }, mapper);
    expect(result.items.map((item) => [item.path, item.episodeNumber])).toEqual([
      ['/media/tv/Show.S01E02.mkv', 2], ['/media/tv/Show.S01E01.mkv', 1]
    ]);
  });

  it('associates all episodes in a multi-episode file', () => {
    const result = parseSonarrWebhook({ eventType: 'Download', series: { title: 'Show', tvdbId: 99 }, episodes: [
      { id: 1, title: 'One', seasonNumber: 1, episodeNumber: 1 },
      { id: 2, title: 'Two', seasonNumber: 1, episodeNumber: 2 }
    ], episodeFile: { path: '/downloads/tv/Show.S01E01E02.mkv' } }, mapper);
    expect(result.items).toHaveLength(2);
    expect(new Set(result.items.map((item) => item.path))).toEqual(new Set(['/media/tv/Show.S01E01E02.mkv']));
  });
});

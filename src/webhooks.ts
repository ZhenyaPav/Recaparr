import type { PathMapper } from './path-mapper.js';
import type { MediaIdentity } from './types.js';

type JsonObject = Record<string, any>;

function value(object: JsonObject | undefined, ...keys: string[]): any {
  for (const key of keys) if (object?.[key] !== undefined && object[key] !== null) return object[key];
  return undefined;
}

function stringValue(input: unknown): string | undefined {
  return input === undefined || input === null || input === '' ? undefined : String(input);
}

function numberValue(input: unknown): number | undefined {
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface ParsedWebhook {
  test: boolean;
  ignored: boolean;
  items: MediaIdentity[];
}

export function parseRadarrWebhook(payload: JsonObject, mapper: PathMapper): ParsedWebhook {
  const eventType = String(value(payload, 'eventType', 'EventType') ?? '').toLowerCase();
  if (eventType === 'test') return { test: true, ignored: false, items: [] };
  if (!['download', 'import', 'upgrade'].includes(eventType)) return { test: false, ignored: true, items: [] };
  const movie = value(payload, 'movie', 'Movie') as JsonObject | undefined;
  const movieFile = value(payload, 'movieFile', 'MovieFile') as JsonObject | undefined;
  const sourcePath = stringValue(value(movieFile, 'path', 'Path') ?? value(movie, 'filePath', 'FilePath'));
  if (!movie || !sourcePath) throw new Error('Radarr webhook is missing movie or movieFile.path');
  return {
    test: false,
    ignored: false,
    items: [{
      kind: 'movie', path: mapper.fromArr(sourcePath), title: String(value(movie, 'title', 'Title') ?? 'Unknown movie'),
      tmdbId: stringValue(value(movie, 'tmdbId', 'TmdbId')), imdbId: stringValue(value(movie, 'imdbId', 'ImdbId')),
      radarrId: stringValue(value(movie, 'id', 'Id'))
    }]
  };
}

function episodeKeysFromFilename(filename: string): Set<string> {
  const keys = new Set<string>();
  for (const match of filename.matchAll(/[Ss](\d{1,2})[Ee](\d{1,3})/g)) keys.add(`${Number(match[1])}:${Number(match[2])}`);
  for (const match of filename.matchAll(/(?:^|\D)(\d{1,2})x(\d{1,3})(?:\D|$)/gi)) keys.add(`${Number(match[1])}:${Number(match[2])}`);
  return keys;
}

export function parseSonarrWebhook(payload: JsonObject, mapper: PathMapper): ParsedWebhook {
  const eventType = String(value(payload, 'eventType', 'EventType') ?? '').toLowerCase();
  if (eventType === 'test') return { test: true, ignored: false, items: [] };
  if (!['download', 'import', 'upgrade', 'importcomplete'].includes(eventType)) return { test: false, ignored: true, items: [] };
  const series = value(payload, 'series', 'Series') as JsonObject | undefined;
  const episodes = (value(payload, 'episodes', 'Episodes') ?? []) as JsonObject[];
  const singleFile = value(payload, 'episodeFile', 'EpisodeFile') as JsonObject | undefined;
  const files = singleFile ? [singleFile] : ((value(payload, 'episodeFiles', 'EpisodeFiles') ?? []) as JsonObject[]);
  if (!series || files.length === 0 || episodes.length === 0) throw new Error('Sonarr webhook is missing series, episodes, or episode files');

  const assignments = new Map<JsonObject, JsonObject[]>();
  for (const file of files) {
    const filePath = String(value(file, 'path', 'Path') ?? '');
    const keys = episodeKeysFromFilename(filePath);
    const matched = episodes.filter((episode) => keys.has(`${numberValue(value(episode, 'seasonNumber', 'SeasonNumber'))}:${numberValue(value(episode, 'episodeNumber', 'EpisodeNumber'))}`));
    if (matched.length) assignments.set(file, matched);
  }
  if (files.length === 1) assignments.set(files[0]!, episodes);
  else if (assignments.size === 0 && files.length === episodes.length) files.forEach((file, index) => assignments.set(file, [episodes[index]!]));
  else {
    const assigned = new Set([...assignments.values()].flat());
    const unassignedEpisodes = episodes.filter((episode) => !assigned.has(episode));
    const unassignedFiles = files.filter((file) => !assignments.has(file));
    unassignedFiles.forEach((file, index) => {
      const episode = unassignedEpisodes[index];
      if (episode) assignments.set(file, [episode]);
    });
  }

  const items: MediaIdentity[] = [];
  for (const [file, fileEpisodes] of assignments) {
    const sourcePath = stringValue(value(file, 'path', 'Path'));
    if (!sourcePath) continue;
    for (const episode of fileEpisodes) {
      items.push({
        kind: 'episode', path: mapper.fromArr(sourcePath),
        title: String(value(episode, 'title', 'Title') ?? 'Unknown episode'),
        seriesTitle: String(value(series, 'title', 'Title') ?? 'Unknown series'),
        seasonNumber: numberValue(value(episode, 'seasonNumber', 'SeasonNumber')),
        episodeNumber: numberValue(value(episode, 'episodeNumber', 'EpisodeNumber')),
        tvdbId: stringValue(value(episode, 'tvdbId', 'TvdbId')),
        seriesTvdbId: stringValue(value(series, 'tvdbId', 'TvdbId')),
        tmdbId: stringValue(value(series, 'tmdbId', 'TmdbId')),
        imdbId: stringValue(value(series, 'imdbId', 'ImdbId')),
        sonarrId: stringValue(value(episode, 'id', 'Id'))
      });
    }
  }
  if (items.length === 0) throw new Error('Sonarr webhook episode files could not be matched to episodes');
  return { test: false, ignored: false, items };
}

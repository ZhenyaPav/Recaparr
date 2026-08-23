import type { MediaIdentity } from './types.js';
import type { PathMapper } from './path-mapper.js';

interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;
  Path?: string;
  SeriesId?: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProviderIds?: Record<string, string>;
  MediaSources?: Array<{ Path?: string }>;
}

export class JellyfinClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly pathMapper: PathMapper,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async resolve(jellyfinId: string): Promise<MediaIdentity> {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(jellyfinId)) throw new Error('Invalid Jellyfin item ID');
    const item = await this.getItem(jellyfinId);
    const jellyfinPath = item.Path ?? item.MediaSources?.find((source) => source.Path)?.Path;
    if (!jellyfinPath) throw new Error('Jellyfin item has no local media path');
    const mappedPath = this.pathMapper.fromJellyfin(jellyfinPath);
    const providers = item.ProviderIds ?? {};

    if (item.Type === 'Movie') {
      return {
        kind: 'movie', jellyfinId: item.Id, path: mappedPath, title: item.Name,
        tmdbId: providers.Tmdb, imdbId: providers.Imdb, tvdbId: providers.Tvdb
      };
    }
    if (item.Type === 'Episode') {
      const series = item.SeriesId ? await this.getItem(item.SeriesId) : undefined;
      return {
        kind: 'episode', jellyfinId: item.Id, path: mappedPath, title: item.Name,
        seriesTitle: item.SeriesName ?? series?.Name,
        seasonNumber: item.ParentIndexNumber, episodeNumber: item.IndexNumber,
        tmdbId: providers.Tmdb, imdbId: providers.Imdb, tvdbId: providers.Tvdb,
        seriesTvdbId: series?.ProviderIds?.Tvdb
      };
    }
    if (item.Type === 'Series') throw new Error('A Jellyfin episode ID is required; series IDs are not supported');
    throw new Error(`Unsupported Jellyfin item type: ${item.Type}`);
  }

  private async getItem(id: string): Promise<JellyfinItem> {
    const url = new URL(`${this.baseUrl}/Items/${encodeURIComponent(id)}`);
    url.searchParams.set('Fields', 'Path,ProviderIds,MediaSources');
    const response = await this.fetchImpl(url, { headers: { 'X-Emby-Token': this.apiKey } });
    if (response.status === 404) throw new Error(`Jellyfin item not found: ${id}`);
    if (!response.ok) throw new Error(`Jellyfin request failed with HTTP ${response.status}`);
    return await response.json() as JellyfinItem;
  }
}

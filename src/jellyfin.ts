import type { MediaIdentity } from './types.js';
import type { PathMapper } from './path-mapper.js';
import type { Logger } from './logger.js';

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

interface JellyfinUser {
  Id: string;
  Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean };
}

interface JellyfinClientOptions {
  userId?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export class JellyfinClient {
  private userId?: string;
  private userResolution?: Promise<string>;
  private readonly logger?: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly pathMapper: PathMapper,
    options: JellyfinClientOptions = {}
  ) {
    this.userId = options.userId;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async resolve(jellyfinId: string): Promise<MediaIdentity> {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(jellyfinId)) throw new Error('Invalid Jellyfin item ID');
    this.logger?.info('Jellyfin item lookup started', { jellyfinId });
    const item = await this.getItem(jellyfinId);
    const jellyfinPath = item.Path ?? item.MediaSources?.find((source) => source.Path)?.Path;
    if (!jellyfinPath) throw new Error('Jellyfin item has no local media path');
    const mappedPath = this.pathMapper.fromJellyfin(jellyfinPath);
    const providers = item.ProviderIds ?? {};

    if (item.Type === 'Movie') {
      this.logger?.info('Jellyfin item resolved', { jellyfinId, kind: 'movie' });
      return {
        kind: 'movie', jellyfinId: item.Id, path: mappedPath, title: item.Name,
        tmdbId: providers.Tmdb, imdbId: providers.Imdb, tvdbId: providers.Tvdb
      };
    }
    if (item.Type === 'Episode') {
      const series = item.SeriesId ? await this.getItem(item.SeriesId) : undefined;
      this.logger?.info('Jellyfin item resolved', { jellyfinId, kind: 'episode' });
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
    const userId = await this.getUserId();
    const url = new URL(`${this.baseUrl}/Items/${encodeURIComponent(id)}`);
    url.searchParams.set('userId', userId);
    const response = await this.request(url);
    if (response.status === 404) throw new Error(`Jellyfin item not found: ${id}`);
    if (!response.ok) throw await this.responseError(response, `item ${id}`);
    return await response.json() as JellyfinItem;
  }

  private async getUserId(): Promise<string> {
    if (this.userId) return this.userId;
    this.userResolution ??= this.discoverUserId().catch((error: unknown) => {
      this.userResolution = undefined;
      throw error;
    });
    return this.userResolution;
  }

  private async discoverUserId(): Promise<string> {
    const response = await this.request(new URL(`${this.baseUrl}/Users`));
    if (!response.ok) throw await this.responseError(response, 'user discovery');
    const users = await response.json() as JellyfinUser[];
    const enabled = users.filter((user) => user.Id && !user.Policy?.IsDisabled);
    const selected = enabled.find((user) => user.Policy?.IsAdministrator) ?? enabled[0];
    if (!selected) throw new Error('Jellyfin has no enabled user; set JELLYFIN_USER_ID explicitly');
    this.userId = selected.Id;
    this.logger?.info('Jellyfin user automatically selected', {
      administrator: Boolean(selected.Policy?.IsAdministrator),
      enabledUserCount: enabled.length
    });
    return selected.Id;
  }

  private async request(url: URL): Promise<Response> {
    try {
      return await this.fetchImpl(url, { headers: { 'X-Emby-Token': this.apiKey } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
      throw new Error(`Jellyfin request failed: ${message}${cause}`, { cause: error });
    }
  }

  private async responseError(response: Response, operation: string): Promise<Error> {
    const body = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500);
    const detail = body ? `: ${body}` : '';
    return new Error(`Jellyfin ${operation} failed with HTTP ${response.status}${detail}`);
  }
}

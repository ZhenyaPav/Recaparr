export type MediaKind = 'movie' | 'episode';
export type RecapStatus = 'missing' | 'queued' | 'generating' | 'retrying' | 'failed' | 'completed';

export interface MediaIdentity {
  kind: MediaKind;
  jellyfinId?: string;
  path: string;
  title: string;
  seriesTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  tmdbId?: string;
  imdbId?: string;
  tvdbId?: string;
  seriesTvdbId?: string;
  radarrId?: string;
  sonarrId?: string;
}

export interface MediaItem extends MediaIdentity {
  id: number;
  createdAt: string;
  updatedAt: string;
}

export interface RecapRecord {
  itemId: number;
  language: string;
  status: RecapStatus;
  recap: string | null;
  error: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  generatedAt: string | null;
  requestedAt: string;
}

export interface GenerationJob extends RecapRecord {
  item: MediaItem;
}

export interface GetRecapInput {
  jellyfin_id: string;
  force_regenerate?: boolean;
  language?: string;
}

export interface GetRecapResult {
  status: RecapStatus | 'regenerating';
  jellyfinId: string;
  language: string;
  title: string;
  recap?: string;
  generatedAt?: string;
  stale?: boolean;
  retryAfterSeconds?: number;
  message?: string;
  availableLanguages?: string[];
}

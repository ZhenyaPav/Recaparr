import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { GenerationJob, MediaIdentity, MediaItem, RecapRecord, RecapStatus } from './types.js';

type DbRow = Record<string, unknown>;

const now = () => new Date().toISOString();

function optional(value: string | number | undefined): string | number | null {
  return value ?? null;
}

function mapItem(row: DbRow): MediaItem {
  return {
    id: Number(row.id),
    kind: row.kind as MediaItem['kind'],
    jellyfinId: row.jellyfin_id ? String(row.jellyfin_id) : undefined,
    path: String(row.path),
    title: String(row.title),
    seriesTitle: row.series_title ? String(row.series_title) : undefined,
    seasonNumber: row.season_number === null ? undefined : Number(row.season_number),
    episodeNumber: row.episode_number === null ? undefined : Number(row.episode_number),
    tmdbId: row.tmdb_id ? String(row.tmdb_id) : undefined,
    imdbId: row.imdb_id ? String(row.imdb_id) : undefined,
    tvdbId: row.tvdb_id ? String(row.tvdb_id) : undefined,
    seriesTvdbId: row.series_tvdb_id ? String(row.series_tvdb_id) : undefined,
    radarrId: row.radarr_id ? String(row.radarr_id) : undefined,
    sonarrId: row.sonarr_id ? String(row.sonarr_id) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapRecap(row: DbRow): RecapRecord {
  return {
    itemId: Number(row.item_id),
    language: String(row.language),
    status: row.status as RecapStatus,
    recap: row.recap === null ? null : String(row.recap),
    error: row.error === null ? null : String(row.error),
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at === null ? null : String(row.next_attempt_at),
    generatedAt: row.generated_at === null ? null : String(row.generated_at),
    requestedAt: String(row.requested_at)
  };
}

export class RecapDatabase {
  readonly db: Database.Database;

  constructor(filename: string) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.db.prepare("UPDATE recaps SET status = 'queued', next_attempt_at = ? WHERE status = 'generating'").run(now());
  }

  close(): void { this.db.close(); }
  ping(): void { this.db.prepare('SELECT 1').get(); }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('movie', 'episode')),
        jellyfin_id TEXT UNIQUE,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        series_title TEXT,
        season_number INTEGER,
        episode_number INTEGER,
        tmdb_id TEXT,
        imdb_id TEXT,
        tvdb_id TEXT,
        series_tvdb_id TEXT,
        radarr_id TEXT,
        sonarr_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_items_path ON items(path);
      CREATE INDEX IF NOT EXISTS idx_items_movie_ids ON items(kind, tmdb_id, imdb_id, radarr_id);
      CREATE INDEX IF NOT EXISTS idx_items_episode_ids ON items(kind, tvdb_id, series_tvdb_id, season_number, episode_number, sonarr_id);
      CREATE TABLE IF NOT EXISTS recaps (
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        language TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('missing', 'queued', 'generating', 'retrying', 'failed', 'completed')),
        recap TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        generated_at TEXT,
        requested_at TEXT NOT NULL,
        force_regenerate INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (item_id, language)
      );
      CREATE INDEX IF NOT EXISTS idx_recaps_due ON recaps(status, next_attempt_at);
    `);
    if (!(this.db.pragma('table_info(recaps)') as DbRow[]).some((column) => column.name === 'force_regenerate')) {
      this.db.exec('ALTER TABLE recaps ADD COLUMN force_regenerate INTEGER NOT NULL DEFAULT 0');
    }
  }

  upsertItem(identity: MediaIdentity): MediaItem {
    const existing = this.findMatchingItem(identity);
    const timestamp = now();
    if (existing) {
      this.db.prepare(`
        UPDATE items SET
          jellyfin_id = COALESCE(@jellyfinId, jellyfin_id), path = @path, title = @title,
          series_title = COALESCE(@seriesTitle, series_title), season_number = COALESCE(@seasonNumber, season_number),
          episode_number = COALESCE(@episodeNumber, episode_number), tmdb_id = COALESCE(@tmdbId, tmdb_id),
          imdb_id = COALESCE(@imdbId, imdb_id), tvdb_id = COALESCE(@tvdbId, tvdb_id),
          series_tvdb_id = COALESCE(@seriesTvdbId, series_tvdb_id), radarr_id = COALESCE(@radarrId, radarr_id),
          sonarr_id = COALESCE(@sonarrId, sonarr_id), updated_at = @updatedAt
        WHERE id = @id
      `).run(this.params(identity, timestamp, existing.id));
      return this.getItem(existing.id)!;
    }

    const result = this.db.prepare(`
      INSERT INTO items (
        kind, jellyfin_id, path, title, series_title, season_number, episode_number,
        tmdb_id, imdb_id, tvdb_id, series_tvdb_id, radarr_id, sonarr_id, created_at, updated_at
      ) VALUES (
        @kind, @jellyfinId, @path, @title, @seriesTitle, @seasonNumber, @episodeNumber,
        @tmdbId, @imdbId, @tvdbId, @seriesTvdbId, @radarrId, @sonarrId, @createdAt, @updatedAt
      )
    `).run({ ...this.params(identity, timestamp), createdAt: timestamp });
    return this.getItem(Number(result.lastInsertRowid))!;
  }

  private params(identity: MediaIdentity, timestamp: string, id?: number): Record<string, unknown> {
    return {
      id: id ?? null,
      kind: identity.kind,
      jellyfinId: optional(identity.jellyfinId),
      path: identity.path,
      title: identity.title,
      seriesTitle: optional(identity.seriesTitle),
      seasonNumber: optional(identity.seasonNumber),
      episodeNumber: optional(identity.episodeNumber),
      tmdbId: optional(identity.tmdbId),
      imdbId: optional(identity.imdbId),
      tvdbId: optional(identity.tvdbId),
      seriesTvdbId: optional(identity.seriesTvdbId),
      radarrId: optional(identity.radarrId),
      sonarrId: optional(identity.sonarrId),
      updatedAt: timestamp
    };
  }

  private findMatchingItem(identity: MediaIdentity): MediaItem | undefined {
    let row: DbRow | undefined;
    if (identity.jellyfinId) {
      row = this.db.prepare('SELECT * FROM items WHERE jellyfin_id = ?').get(identity.jellyfinId) as DbRow | undefined;
    }
    if (!row && identity.kind === 'movie') {
      if (identity.tmdbId) row = this.db.prepare("SELECT * FROM items WHERE kind = 'movie' AND tmdb_id = ? LIMIT 1").get(identity.tmdbId) as DbRow | undefined;
      if (!row && identity.imdbId) row = this.db.prepare("SELECT * FROM items WHERE kind = 'movie' AND imdb_id = ? LIMIT 1").get(identity.imdbId) as DbRow | undefined;
      if (!row && identity.radarrId) row = this.db.prepare("SELECT * FROM items WHERE kind = 'movie' AND radarr_id = ? LIMIT 1").get(identity.radarrId) as DbRow | undefined;
    }
    if (!row && identity.kind === 'episode') {
      if (identity.tvdbId) row = this.db.prepare("SELECT * FROM items WHERE kind = 'episode' AND tvdb_id = ? LIMIT 1").get(identity.tvdbId) as DbRow | undefined;
      if (!row && identity.seriesTvdbId && identity.seasonNumber !== undefined && identity.episodeNumber !== undefined) {
        row = this.db.prepare(`SELECT * FROM items WHERE kind = 'episode' AND series_tvdb_id = ? AND season_number = ? AND episode_number = ? LIMIT 1`)
          .get(identity.seriesTvdbId, identity.seasonNumber, identity.episodeNumber) as DbRow | undefined;
      }
      if (!row && identity.sonarrId) row = this.db.prepare("SELECT * FROM items WHERE kind = 'episode' AND sonarr_id = ? LIMIT 1").get(identity.sonarrId) as DbRow | undefined;
    }
    return row ? mapItem(row) : undefined;
  }

  getItem(id: number): MediaItem | undefined {
    const row = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as DbRow | undefined;
    return row ? mapItem(row) : undefined;
  }

  getRecap(itemId: number, language: string): RecapRecord | undefined {
    const row = this.db.prepare('SELECT * FROM recaps WHERE item_id = ? AND language = ?').get(itemId, language) as DbRow | undefined;
    return row ? mapRecap(row) : undefined;
  }

  availableLanguages(itemId: number): string[] {
    return (this.db.prepare("SELECT language FROM recaps WHERE item_id = ? AND recap IS NOT NULL ORDER BY language").all(itemId) as DbRow[])
      .map((row) => String(row.language));
  }

  enqueue(itemId: number, language: string, force = false): RecapRecord {
    const current = this.getRecap(itemId, language);
    if (!force && current && ['queued', 'generating', 'retrying', 'completed'].includes(current.status)) return current;
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO recaps (item_id, language, status, recap, error, attempts, next_attempt_at, generated_at, requested_at, force_regenerate)
      VALUES (?, ?, 'queued', NULL, NULL, 0, ?, NULL, ?, ?)
      ON CONFLICT(item_id, language) DO UPDATE SET
        status = CASE WHEN recaps.status = 'generating' THEN 'generating' ELSE 'queued' END,
        recap = NULL, error = NULL, generated_at = NULL, attempts = 0,
        next_attempt_at = CASE WHEN recaps.status = 'generating' THEN NULL ELSE excluded.next_attempt_at END,
        requested_at = excluded.requested_at, force_regenerate = excluded.force_regenerate
    `).run(itemId, language, timestamp, timestamp, force ? 1 : 0);
    return this.getRecap(itemId, language)!;
  }

  nextDueJob(at = now()): GenerationJob | undefined {
    const row = this.db.prepare(`
      SELECT r.*, i.id AS i_id, i.kind AS i_kind, i.jellyfin_id AS i_jellyfin_id,
        i.path AS i_path, i.title AS i_title, i.series_title AS i_series_title,
        i.season_number AS i_season_number, i.episode_number AS i_episode_number,
        i.tmdb_id AS i_tmdb_id, i.imdb_id AS i_imdb_id, i.tvdb_id AS i_tvdb_id,
        i.series_tvdb_id AS i_series_tvdb_id, i.radarr_id AS i_radarr_id,
        i.sonarr_id AS i_sonarr_id, i.created_at AS i_created_at, i.updated_at AS i_updated_at
      FROM recaps r JOIN items i ON i.id = r.item_id
      WHERE r.status IN ('queued', 'retrying') AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= ?)
      ORDER BY r.requested_at LIMIT 1
    `).get(at) as DbRow | undefined;
    if (!row) return undefined;
    const itemRow: DbRow = {};
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith('i_')) itemRow[key.slice(2)] = value;
    }
    return { ...mapRecap(row), item: mapItem(itemRow), forceRegenerate: Boolean(row.force_regenerate) };
  }

  markGenerating(itemId: number, language: string): void {
    this.db.prepare("UPDATE recaps SET status = 'generating', next_attempt_at = NULL WHERE item_id = ? AND language = ?").run(itemId, language);
  }

  markSuccess(itemId: number, language: string, recap: string): void {
    const timestamp = now();
    this.db.prepare(`UPDATE recaps SET status = 'completed', recap = ?, error = NULL, next_attempt_at = NULL, generated_at = ? WHERE item_id = ? AND language = ?`)
      .run(recap, timestamp, itemId, language);
  }

  markFailure(itemId: number, language: string, error: string, retryDelaysMs: number[]): RecapRecord {
    const current = this.getRecap(itemId, language)!;
    const attempts = current.attempts + 1;
    const delay = retryDelaysMs[attempts - 1];
    const status: RecapStatus = delay === undefined ? 'failed' : 'retrying';
    const nextAttempt = delay === undefined ? null : new Date(Date.now() + delay).toISOString();
    this.db.prepare(`UPDATE recaps SET status = ?, error = ?, attempts = ?, next_attempt_at = ? WHERE item_id = ? AND language = ?`)
      .run(status, error.slice(0, 2000), attempts, nextAttempt, itemId, language);
    return this.getRecap(itemId, language)!;
  }

  completedRecapForPath(pathValue: string, language: string, exceptItemId: number): RecapRecord | undefined {
    const row = this.db.prepare(`
      SELECT r.* FROM recaps r JOIN items i ON i.id = r.item_id
      WHERE i.path = ? AND r.language = ? AND r.status = 'completed' AND r.recap IS NOT NULL AND i.id != ? LIMIT 1
    `).get(pathValue, language, exceptItemId) as DbRow | undefined;
    return row ? mapRecap(row) : undefined;
  }
}

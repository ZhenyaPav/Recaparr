import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bearerAuth } from '../src/auth.js';
import { RecapDatabase } from '../src/database.js';
import { JellyfinClient } from '../src/jellyfin.js';
import { PathMapper } from '../src/path-mapper.js';
import { GenerationQueue } from '../src/queue.js';
import { Summarizer } from '../src/summarizer.js';
import { testConfig } from './helpers.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

describe('service integration boundaries', () => {
  it('enforces bearer authentication', () => {
    const middleware = bearerAuth('test-token');
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    middleware({ header: vi.fn().mockReturnValue(undefined) } as never, response as never, next);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();

    response.status.mockClear();
    middleware({ header: vi.fn().mockReturnValue('Bearer test-token') } as never, response as never, next);
    expect(response.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('resolves Jellyfin episodes and their series provider identity', async () => {
    const requests: Request[] = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.includes('/Items/episode123')) return new Response(JSON.stringify({
        Id: 'episode123', Name: 'Pilot', Type: 'Episode', Path: '/data/tv/Show.S01E01.mkv',
        SeriesId: 'series123', SeriesName: 'Show', ParentIndexNumber: 1, IndexNumber: 1, ProviderIds: { Tvdb: '101' }
      }), { status: 200 });
      return new Response(JSON.stringify({ Id: 'series123', Name: 'Show', Type: 'Series', ProviderIds: { Tvdb: '99' } }), { status: 200 });
    });
    const client = new JellyfinClient('http://jellyfin:8096', 'secret-key', new PathMapper('/media', '/downloads', '/data'), {
      userId: 'user123',
      fetchImpl: fakeFetch as typeof fetch
    });
    await expect(client.resolve('episode123')).resolves.toMatchObject({
      kind: 'episode', path: '/media/tv/Show.S01E01.mkv', tvdbId: '101', seriesTvdbId: '99', seasonNumber: 1, episodeNumber: 1
    });
    expect(requests.every((request) => request.headers.get('X-Emby-Token') === 'secret-key')).toBe(true);
    expect(requests.every((request) => !request.url.includes('secret-key'))).toBe(true);
    expect(requests.every((request) => new URL(request.url).searchParams.get('userId') === 'user123')).toBe(true);
  });

  it('automatically selects an enabled Jellyfin administrator once', async () => {
    const requests: Request[] = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith('/Users')) return new Response(JSON.stringify([
        { Id: 'disabled-user', Policy: { IsAdministrator: true, IsDisabled: true } },
        { Id: 'regular-user', Policy: { IsAdministrator: false, IsDisabled: false } },
        { Id: 'admin-user', Policy: { IsAdministrator: true, IsDisabled: false } }
      ]));
      return new Response(JSON.stringify({
        Id: 'movie123', Name: 'Movie', Type: 'Movie', Path: '/data/movies/Movie.mkv'
      }));
    });
    const client = new JellyfinClient('http://jellyfin:8096', 'secret-key', new PathMapper('/media', '/downloads', '/data'), {
      fetchImpl: fakeFetch as typeof fetch
    });

    await client.resolve('movie123');
    await client.resolve('movie123');

    expect(requests.filter((request) => request.url.endsWith('/Users'))).toHaveLength(1);
    expect(requests.filter((request) => request.url.includes('/Items/')).every((request) =>
      new URL(request.url).searchParams.get('userId') === 'admin-user')).toBe(true);
  });

  it('includes Jellyfin response details in lookup errors', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response('Readable Jellyfin error', { status: 400 }));
    const client = new JellyfinClient('http://jellyfin:8096', 'secret-key', new PathMapper('/media', '/downloads', '/data'), {
      userId: 'user123',
      fetchImpl: fakeFetch as typeof fetch
    });
    await expect(client.resolve('movie123')).rejects.toThrow('HTTP 400: Readable Jellyfin error');
  });

  it('sends cleaned text, not a media path, to summarize', async () => {
    let observedInput = '';
    const runner = vi.fn(async (_command: string, _args: string[], options?: { input?: string }) => {
      observedInput = options?.input ?? '';
      return { stdout: JSON.stringify({ summary: 'Generated recap' }), stderr: '' };
    });
    const summarizer = new Summarizer(testConfig(), runner as never);
    const result = await summarizer.summarize('Only subtitle dialogue.', {
      id: 1, kind: 'movie', path: '/media/secret/movie.mkv', title: 'Movie', createdAt: '', updatedAt: ''
    }, 'en');
    expect(result).toBe('Generated recap');
    expect(observedInput).toContain('Only subtitle dialogue.');
    expect(observedInput).not.toContain('/media/secret/movie.mkv');
  });

  it('processes one queued generation and reuses it for a shared file', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recaparr-queue-'));
    cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
    const mediaPath = path.join(directory, 'double.mkv');
    await fs.writeFile(mediaPath, 'fixture');
    const database = new RecapDatabase(':memory:');
    cleanup.push(() => database.close());
    const one = database.upsertItem({ kind: 'episode', path: mediaPath, title: 'One', seriesTvdbId: '1', seasonNumber: 1, episodeNumber: 1 });
    const two = database.upsertItem({ kind: 'episode', path: mediaPath, title: 'Two', seriesTvdbId: '1', seasonNumber: 1, episodeNumber: 2 });
    database.enqueue(one.id, 'en');
    database.enqueue(two.id, 'en');
    const subtitles = { extract: vi.fn().mockResolvedValue({ text: 'subtitle text', candidate: { source: 'external', language: 'en' } }) };
    const summarizer = { summarize: vi.fn().mockResolvedValue('Shared recap') };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const queue = new GenerationQueue(testConfig({ mediaRoot: directory }), database, new PathMapper(directory, '/downloads', '/data'), subtitles as never, summarizer as never, logger as never);
    await queue.processNext();
    await new Promise((resolve) => setTimeout(resolve, 20));
    queue.stop();
    expect(summarizer.summarize).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('summary generation received', {
      itemId: one.id, language: 'en', recapCharacters: 12, recap: 'Shared recap'
    });
    expect(database.getRecap(two.id, 'en')?.recap).toBe('Shared recap');
  });
});

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
    const episodeId = '11111111111111111111111111111111';
    const seriesId = '22222222222222222222222222222222';
    const requests: Request[] = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.includes(`/Items/${episodeId}`)) return new Response(JSON.stringify({
        Id: episodeId, Name: 'Pilot', Type: 'Episode', Path: '/data/tv/Show.S01E01.mkv',
        SeriesId: seriesId, SeriesName: 'Show', ParentIndexNumber: 1, IndexNumber: 1, ProviderIds: { Tvdb: '101' }
      }), { status: 200 });
      return new Response(JSON.stringify({ Id: seriesId, Name: 'Show', Type: 'Series', ProviderIds: { Tvdb: '99' } }), { status: 200 });
    });
    const client = new JellyfinClient('http://jellyfin:8096', 'secret-key', new PathMapper('/media', '/downloads', '/data'), {
      userId: 'user123',
      fetchImpl: fakeFetch as typeof fetch
    });
    await expect(client.resolve(episodeId)).resolves.toMatchObject({
      kind: 'episode', path: '/media/tv/Show.S01E01.mkv', tvdbId: '101', seriesTvdbId: '99', seasonNumber: 1, episodeNumber: 1
    });
    expect(requests.every((request) => request.headers.get('X-Emby-Token') === 'secret-key')).toBe(true);
    expect(requests.every((request) => !request.url.includes('secret-key'))).toBe(true);
    expect(requests.every((request) => new URL(request.url).searchParams.get('userId') === 'user123')).toBe(true);
  });

  it('automatically selects an enabled Jellyfin administrator once', async () => {
    const movieId = '33333333333333333333333333333333';
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
        Id: movieId, Name: 'Movie', Type: 'Movie', Path: '/data/movies/Movie.mkv'
      }));
    });
    const client = new JellyfinClient('http://jellyfin:8096', 'secret-key', new PathMapper('/media', '/downloads', '/data'), {
      fetchImpl: fakeFetch as typeof fetch
    });

    await client.resolve(movieId);
    await client.resolve(movieId);

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
    await expect(client.resolve('33333333333333333333333333333333')).rejects.toThrow('HTTP 400: Readable Jellyfin error');
  });

  it('rejects malformed Jellyfin item IDs before making a request', async () => {
    const fakeFetch = vi.fn();
    const client = new JellyfinClient('http://jellyfin:8096', 'secret-key', new PathMapper('/media', '/downloads', '/data'), {
      userId: '0123456789abcdef0123456789abcdef',
      fetchImpl: fakeFetch as typeof fetch
    });

    await expect(client.resolve('7e895da8b65cd6600963ecfc7e7b92d')).rejects.toThrow(
      'expected a 32-character hexadecimal GUID'
    );
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['https://openrouter.ai/api/v1', undefined],
    ['https://openrouter.ai/api/v1', 'none'],
    ['http://127.0.0.1:18080/v1/', 'none'],
    ['http://127.0.0.1:18080/v1', 'high']
  ] as const)('sends subtitle text directly to %s with thinking %s', async (llmBaseUrl, llmThinking) => {
    const requests: Request[] = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json({ choices: [{ message: { content: ' Generated recap ' }, finish_reason: 'stop' }] });
    });
    const summarizer = new Summarizer(testConfig({
      llmBaseUrl, llmThinking, promptFile: path.resolve('prompts/recap.md')
    }), fakeFetch as typeof fetch);
    const result = await summarizer.summarize('Only subtitle dialogue.', {
      id: 1, kind: 'episode', path: '/media/secret/episode.mkv', title: 'Pilot', seriesTitle: 'Show',
      seasonNumber: 1, episodeNumber: 2, createdAt: '', updatedAt: ''
    }, 'ro');
    expect(result).toBe('Generated recap');
    expect(fakeFetch).toHaveBeenCalledOnce();
    const request = requests[0]!;
    expect(request.url).toBe(`${llmBaseUrl.replace(/\/$/, '')}/chat/completions`);
    expect(request.method).toBe('POST');
    expect(request.headers.get('Authorization')).toBe('Bearer test-key');
    expect(request.headers.get('Content-Type')).toBe('application/json');
    const body = await request.json();
    expect(body).toEqual({
      model: 'deepseek/deepseek-v4-flash-latest',
      messages: [
        { role: 'system', content: `${(await fs.readFile('prompts/recap.md', 'utf8')).trim()}\n\nWrite the recap in ro.` },
        { role: 'user', content: 'Media type: episode\nTitle: Pilot\nSeries: Show\nSeason: 1\nEpisode: 2\n\nSubtitle transcript:\nOnly subtitle dialogue.' }
      ],
      stream: false,
      ...(llmThinking ? { reasoning_effort: llmThinking } : {})
    });
    expect(JSON.stringify(body)).not.toContain('/media/secret/episode.mkv');
  });

  it.each([
    ['not JSON', 'LLM returned invalid JSON'],
    ['{}', 'LLM returned an invalid chat completion'],
    ['{"choices":[]}', 'LLM returned an invalid chat completion'],
    ['{"choices":[{"message":{"content":42}}]}', 'LLM returned an invalid chat completion'],
    ['{"choices":[{"message":{"content":null,"reasoning_content":"Only thinking"}}]}', 'LLM returned an empty recap'],
    ['{"choices":[{"message":{"content":"  "}}]}', 'LLM returned an empty recap'],
    ['{"choices":[{"message":{"content":"Partial recap"},"finish_reason":"length"}]}', 'LLM response was truncated']
  ])('rejects unusable LLM response %s', async (body, message) => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response(body));
    const summarizer = new Summarizer(testConfig({ promptFile: path.resolve('prompts/recap.md') }), fakeFetch);
    await expect(summarizer.summarize('Subtitle dialogue.', {
      id: 1, kind: 'movie', path: '/media/movie.mkv', title: 'Movie', createdAt: '', updatedAt: ''
    }, 'en')).rejects.toThrow(message);
  });

  it('reports provider HTTP errors without making internal retries', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response('Insufficient credits', { status: 402 }));
    const summarizer = new Summarizer(testConfig({ promptFile: path.resolve('prompts/recap.md') }), fakeFetch);
    await expect(summarizer.summarize('Subtitle dialogue.', {
      id: 1, kind: 'movie', path: '/media/movie.mkv', title: 'Movie', createdAt: '', updatedAt: ''
    }, 'en')).rejects.toThrow('LLM request failed with HTTP 402: Insufficient credits');
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it('aborts generation at the configured timeout', async () => {
    const fakeFetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const summarizer = new Summarizer(testConfig({
      promptFile: path.resolve('prompts/recap.md'), generationTimeoutMs: 20
    }), fakeFetch as typeof fetch);
    await expect(summarizer.summarize('Subtitle dialogue.', {
      id: 1, kind: 'movie', path: '/media/movie.mkv', title: 'Movie', createdAt: '', updatedAt: ''
    }, 'en')).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('upgrades an existing database and persists forced generation across restarts', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recaparr-migration-'));
    cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'recaps.sqlite');
    let database = new RecapDatabase(filename);
    cleanup.push(() => database.close());
    const item = database.upsertItem({ kind: 'movie', path: '/media/movie.mkv', title: 'Movie' });
    database.enqueue(item.id, 'en');
    database.markSuccess(item.id, 'en', 'Old recap');
    database.db.exec('ALTER TABLE recaps DROP COLUMN force_regenerate');
    database.close();

    database = new RecapDatabase(filename);
    expect(database.getRecap(item.id, 'en')?.recap).toBe('Old recap');
    database.enqueue(item.id, 'en', true);
    database.close();

    database = new RecapDatabase(filename);
    expect(database.nextDueJob()).toMatchObject({ itemId: item.id, forceRegenerate: true, recap: null, error: null });
  });

  it('reuses recaps for a shared file but generates fresh text when forced', async () => {
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
    const summarizer = { summarize: vi.fn().mockResolvedValueOnce('Shared recap').mockResolvedValue('Fresh recap') };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const queue = new GenerationQueue(testConfig({ mediaRoot: directory }), database, new PathMapper(directory, '/downloads', '/data'), subtitles as never, summarizer as never, logger as never);
    vi.spyOn(queue, 'wake').mockImplementation(() => {});
    await queue.processNext();
    await queue.processNext();
    expect(summarizer.summarize).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('summary generation received', {
      itemId: one.id, language: 'en', recapCharacters: 12, recap: 'Shared recap'
    });
    expect(database.getRecap(two.id, 'en')?.recap).toBe('Shared recap');

    database.enqueue(two.id, 'en', true);
    expect(database.getRecap(two.id, 'en')?.recap).toBeNull();
    await queue.processNext();
    expect(summarizer.summarize).toHaveBeenCalledTimes(2);
    expect(database.getRecap(two.id, 'en')?.recap).toBe('Fresh recap');
    expect(database.getRecap(one.id, 'en')?.recap).toBe('Shared recap');
  });
});

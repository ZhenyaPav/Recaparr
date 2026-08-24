import type { Config } from '../src/config.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 8080,
    apiToken: 'test-token',
    llmApiKey: 'test-key',
    llmBaseUrl: 'https://openrouter.ai/api/v1',
    llmModel: 'deepseek/deepseek-v4-flash-latest',
    eagerGeneration: true,
    lazyGeneration: true,
    preferredSubtitleLanguage: 'en',
    summaryLanguage: 'en',
    jellyfinUrl: 'http://jellyfin:8096',
    jellyfinApiKey: 'jellyfin-key',
    jellyfinUserId: '11111111111111111111111111111111',
    databasePath: ':memory:',
    mediaRoot: '/media',
    arrPathPrefix: '/downloads',
    jellyfinPathPrefix: '/data',
    retryDelaysMs: [300_000, 1_800_000],
    generationTimeoutMs: 600_000,
    summarizeBin: 'summarize',
    ffmpegBin: 'ffmpeg',
    ffprobeBin: 'ffprobe',
    promptFile: '/app/prompts/recap.md',
    logLevel: 'error',
    ...overrides
  };
}

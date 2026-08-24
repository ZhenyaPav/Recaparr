import { describe, expect, it } from 'vitest';
import { loadConfig, normalizeLanguage } from '../src/config.js';

const required = {
  RECAPARR_API_TOKEN: 'token',
  RECAPARR_LLM_API_KEY: 'key',
  JELLYFIN_API_KEY: 'jellyfin'
};

describe('configuration', () => {
  it('loads documented defaults', () => {
    const config = loadConfig(required);
    expect(config.llmBaseUrl).toBe('https://openrouter.ai/api/v1');
    expect(config.llmModel).toBe('deepseek/deepseek-v4-flash-latest');
    expect(config.eagerGeneration).toBe(true);
    expect(config.lazyGeneration).toBe(true);
    expect(config.retryDelaysMs).toEqual([5, 30, 120, 480, 1440].map((minutes) => minutes * 60_000));
  });

  it('parses switches and languages', () => {
    const config = loadConfig({
      ...required,
      RECAPARR_EAGER_GENERATION: 'off',
      RECAPARR_LAZY_GENERATION: '0',
      RECAPARR_SUMMARY_LANGUAGE: 'pt-br',
      JELLYFIN_USER_ID: '4b79fe40f1e46f1df5dff64720dbece9'
    });
    expect(config.eagerGeneration).toBe(false);
    expect(config.lazyGeneration).toBe(false);
    expect(config.summaryLanguage).toBe('pt-BR');
    expect(config.jellyfinUserId).toBe('4b79fe40f1e46f1df5dff64720dbece9');
  });

  it('rejects malformed language values', () => expect(() => normalizeLanguage('../en')).toThrow('Invalid language'));
  it('rejects malformed Jellyfin user IDs', () => expect(() => loadConfig({ ...required, JELLYFIN_USER_ID: 'not-a-guid' })).toThrow('JELLYFIN_USER_ID'));
  it('requires secrets', () => expect(() => loadConfig({})).toThrow('RECAPARR_API_TOKEN is required'));
});

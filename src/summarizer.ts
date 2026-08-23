import type { Config } from './config.js';
import type { MediaItem } from './types.js';
import type { ProcessRunner } from './process.js';
import { runProcess } from './process.js';

function modelForSummarize(model: string): string {
  return model.startsWith('openai/') ? model : `openai/${model}`;
}

export class Summarizer {
  constructor(private readonly config: Config, private readonly runner: ProcessRunner = runProcess) {}

  async summarize(transcript: string, item: MediaItem, language: string): Promise<string> {
    const context = [
      `Media type: ${item.kind}`,
      `Title: ${item.title}`,
      item.seriesTitle ? `Series: ${item.seriesTitle}` : '',
      item.seasonNumber !== undefined ? `Season: ${item.seasonNumber}` : '',
      item.episodeNumber !== undefined ? `Episode: ${item.episodeNumber}` : ''
    ].filter(Boolean).join('\n');
    const input = `${context}\n\nSubtitle transcript:\n${transcript}`;
    const result = await this.runner(this.config.summarizeBin, [
      '-', '--model', modelForSummarize(this.config.llmModel),
      '--prompt-file', this.config.promptFile,
      '--language', language,
      '--length', 'long',
      '--force-summary', '--json', '--no-cache', '--no-color',
      '--timeout', `${this.config.generationTimeoutMs}ms`
    ], {
      input,
      timeoutMs: this.config.generationTimeoutMs + 10_000,
      env: {
        ...process.env,
        OPENAI_API_KEY: this.config.llmApiKey,
        OPENAI_BASE_URL: this.config.llmBaseUrl,
        OPENAI_USE_CHAT_COMPLETIONS: 'true',
        NO_COLOR: '1'
      }
    });
    let payload: unknown;
    try { payload = JSON.parse(result.stdout); }
    catch { throw new Error(`summarize returned invalid JSON: ${result.stdout.slice(0, 500)}`); }
    const summary = typeof payload === 'object' && payload !== null && 'summary' in payload
      ? (payload as { summary?: unknown }).summary : undefined;
    if (typeof summary !== 'string' || !summary.trim()) throw new Error('summarize returned an empty summary');
    return summary.trim();
  }
}

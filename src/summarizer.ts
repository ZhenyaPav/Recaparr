import fs from 'node:fs/promises';
import { z } from 'zod';
import type { Config } from './config.js';
import type { MediaItem } from './types.js';

const completionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullish() }),
    finish_reason: z.string().nullish()
  })).nonempty()
});

export class Summarizer {
  constructor(private readonly config: Config, private readonly fetchImpl: typeof fetch = fetch) {}

  async summarize(transcript: string, item: MediaItem, language: string): Promise<string> {
    const context = [
      `Media type: ${item.kind}`,
      `Title: ${item.title}`,
      item.seriesTitle ? `Series: ${item.seriesTitle}` : '',
      item.seasonNumber !== undefined ? `Season: ${item.seasonNumber}` : '',
      item.episodeNumber !== undefined ? `Episode: ${item.episodeNumber}` : ''
    ].filter(Boolean).join('\n');
    const input = `${context}\n\nSubtitle transcript:\n${transcript}`;
    const prompt = await fs.readFile(this.config.promptFile, 'utf8');
    const response = await this.fetchImpl(`${this.config.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.llmApiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(this.config.generationTimeoutMs),
      body: JSON.stringify({
        model: this.config.llmModel,
        messages: [
          { role: 'system', content: `${prompt.trim()}\n\nWrite the recap in ${language}.` },
          { role: 'user', content: input }
        ],
        stream: false,
        ...(this.config.llmThinking ? { reasoning_effort: this.config.llmThinking } : {})
      })
    });
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500);
      throw new Error(`LLM request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error('LLM returned invalid JSON', { cause: error });
      throw error;
    }
    const completion = completionSchema.safeParse(payload);
    if (!completion.success) throw new Error('LLM returned an invalid chat completion');
    const choice = completion.data.choices[0]!;
    if (choice.finish_reason === 'length') throw new Error('LLM response was truncated (finish_reason: length)');
    const summary = choice.message.content?.trim();
    if (!summary) throw new Error('LLM returned an empty recap');
    return summary;
  }
}

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanSubtitleText, SubtitleExtractor } from '../src/subtitles.js';
import type { ProcessRunner } from '../src/process.js';

const tempDirs: string[] = [];
afterEach(async () => Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

describe('subtitle extraction', () => {
  it('cleans SRT, VTT, and ASS markup and duplicates', () => {
    const input = `WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n<i>Hello</i>\nHello\n[Music]\nDialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,World\\Nagain`;
    expect(cleanSubtitleText(input)).toBe('Hello\nWorld again');
  });

  it('orders preferred embedded, preferred external, other embedded, other external', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recaparr-subtitles-'));
    tempDirs.push(directory);
    const media = path.join(directory, 'Example.S01E01.mkv');
    await fs.writeFile(media, '');
    await fs.writeFile(path.join(directory, 'Example.S01E01.en.srt'), 'English external subtitle text '.repeat(10));
    await fs.writeFile(path.join(directory, 'Example.S01E01.ro.srt'), 'Romanian external subtitle text '.repeat(10));
    const runner: ProcessRunner = async (_command, args) => {
      if (args.includes('-show_streams')) return { stdout: JSON.stringify({ streams: [
        { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'ron', title: 'Romanian' }, disposition: {} },
        { index: 3, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng', title: 'English' }, disposition: {} }
      ] }), stderr: '' };
      return { stdout: 'embedded subtitle '.repeat(20), stderr: '' };
    };
    const extractor = new SubtitleExtractor('en', 'ffprobe', 'ffmpeg', runner);
    const candidates = await extractor.candidates(media);
    expect(candidates.map(({ source, language }) => `${language}:${source}`)).toEqual([
      'en:embedded', 'en:external', 'ro:embedded', 'ro:external'
    ]);
  });

  it('falls through an unusable preferred track', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recaparr-subtitles-'));
    tempDirs.push(directory);
    const media = path.join(directory, 'Movie.mkv');
    await fs.writeFile(media, '');
    await fs.writeFile(path.join(directory, 'Movie.ro.srt'), 'Dialog suficient pentru a reprezenta subtitrarea episodului. '.repeat(10));
    const runner: ProcessRunner = async (_command, args) => args.includes('-show_streams')
      ? { stdout: JSON.stringify({ streams: [{ index: 1, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'en' }, disposition: {} }] }), stderr: '' }
      : { stdout: 'too short', stderr: '' };
    const result = await new SubtitleExtractor('en', 'ffprobe', 'ffmpeg', runner).extract(media);
    expect(result.candidate.language).toBe('ro');
    expect(result.candidate.source).toBe('external');
  });

  it.each(['Signs and Songs(Half-Baked)', 'Signs & Songs', 'Signs+Songs', 'Signs Only', 'Songs-only'])(
    'skips a default %s track in favor of full dialogue', async (title) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recaparr-subtitles-'));
      tempDirs.push(directory);
      const media = path.join(directory, 'Example.S02E02.mkv');
      const extractedStreams: string[] = [];
      const runner: ProcessRunner = async (_command, args) => {
        if (args.includes('-show_streams')) return { stdout: JSON.stringify({ streams: [
          { index: 3, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'eng', title }, disposition: { default: 1 } },
          { index: 4, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'eng', title: 'Full Subs(Half-Baked)' }, disposition: {} }
        ] }), stderr: '' };
        extractedStreams.push(args[args.indexOf('-map') + 1]!);
        return { stdout: 'Full episode dialogue. '.repeat(20), stderr: '' };
      };
      const result = await new SubtitleExtractor('en', 'ffprobe', 'ffmpeg', runner).extract(media);
      expect(result.candidate.streamIndex).toBe(4);
      expect(extractedStreams).toEqual(['0:4']);
    }
  );

  it('rejects signs-only sidecars even when they exceed the minimum length', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recaparr-subtitles-'));
    tempDirs.push(directory);
    const media = path.join(directory, 'Example.S02E02.mkv');
    await fs.writeFile(path.join(directory, 'Example.S02E02.en.signs-and-songs.srt'), 'Episode title and next episode preview. '.repeat(20));
    const runner: ProcessRunner = async () => ({ stdout: JSON.stringify({ streams: [] }), stderr: '' });
    await expect(new SubtitleExtractor('en', 'ffprobe', 'ffmpeg', runner).extract(media))
      .rejects.toThrow('No usable text subtitles found');
  });
});

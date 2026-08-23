import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProcessRunner } from './process.js';
import { runProcess } from './process.js';

interface ProbeStream {
  index: number;
  codec_name?: string;
  codec_type?: string;
  tags?: { language?: string; title?: string };
  disposition?: { default?: number; forced?: number; commentary?: number; hearing_impaired?: number };
}

export interface SubtitleCandidate {
  source: 'embedded' | 'external';
  language: string;
  label: string;
  streamIndex?: number;
  filePath?: string;
  preferred: boolean;
  default: boolean;
  forced: boolean;
  commentary: boolean;
}

const TEXT_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'microdvd']);
const EXTENSIONS = new Set(['.srt', '.vtt', '.ass', '.ssa']);
const LANGUAGE_ALIASES: Record<string, string> = {
  en: 'en', eng: 'en', english: 'en', ro: 'ro', ron: 'ro', rum: 'ro', romanian: 'ro',
  ru: 'ru', rus: 'ru', russian: 'ru', de: 'de', deu: 'de', ger: 'de', german: 'de',
  fr: 'fr', fra: 'fr', fre: 'fr', french: 'fr', es: 'es', spa: 'es', spanish: 'es',
  it: 'it', ita: 'it', italian: 'it', pt: 'pt', por: 'pt', portuguese: 'pt',
  ja: 'ja', jpn: 'ja', japanese: 'ja', ko: 'ko', kor: 'ko', korean: 'ko',
  zh: 'zh', zho: 'zh', chi: 'zh', chinese: 'zh', und: 'und', unknown: 'und'
};

export function canonicalLanguage(value: string | undefined): string {
  if (!value) return 'und';
  const lower = value.trim().toLowerCase().replace('_', '-');
  return LANGUAGE_ALIASES[lower] ?? LANGUAGE_ALIASES[lower.split('-')[0]!] ?? lower.split('-')[0]!;
}

function sidecarLanguage(mediaStem: string, filename: string): string {
  const withoutExtension = filename.slice(0, -path.extname(filename).length);
  const suffix = withoutExtension.slice(mediaStem.length).replace(/^[._ -]+/, '');
  for (const token of suffix.split(/[._ -]+/)) {
    const language = canonicalLanguage(token);
    if (language !== token.toLowerCase() || LANGUAGE_ALIASES[token.toLowerCase()]) return language;
  }
  return 'und';
}

export function rankSubtitle(candidate: SubtitleCandidate): number {
  const languageGroup = candidate.preferred ? 0 : 2;
  const sourceGroup = candidate.source === 'embedded' ? 0 : 1;
  return (languageGroup + sourceGroup) * 100 + (candidate.forced ? 30 : 0) + (candidate.commentary ? 40 : 0) - (candidate.default ? 1 : 0);
}

export function cleanSubtitleText(input: string): string {
  const lines: string[] = [];
  let inEvents = false;
  for (const raw of input.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let line = raw.trim();
    if (/^\[Events\]$/i.test(line)) { inEvents = true; continue; }
    if (/^\[.+\]$/.test(line)) { inEvents = false; continue; }
    if (/^(WEBVTT|NOTE\b|STYLE\b|REGION\b)/i.test(line)) continue;
    if (/^\d+$/.test(line) || /-->/i.test(line)) continue;
    if (/^(Dialogue|Comment):/i.test(line)) {
      if (!inEvents && !/^Dialogue:/i.test(line)) continue;
      const parts = line.split(',');
      line = parts.length >= 10 ? parts.slice(9).join(',') : line.replace(/^[^:]+:\s*/, '');
    } else if (/^(Format|Script Info|Title|PlayRes[XY]|WrapStyle|ScaledBorderAndShadow):/i.test(line)) {
      continue;
    }
    line = line
      .replace(/\{[^}]*\}/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line || /^\[[^\]]*(music|applause|silence|sound)[^\]]*\]$/i.test(line)) continue;
    if (lines.at(-1) !== line) lines.push(line);
  }
  return lines.join('\n');
}

export class SubtitleExtractor {
  constructor(
    private readonly preferredLanguage: string,
    private readonly ffprobeBin = 'ffprobe',
    private readonly ffmpegBin = 'ffmpeg',
    private readonly runner: ProcessRunner = runProcess
  ) {}

  async candidates(mediaPath: string): Promise<SubtitleCandidate[]> {
    const preferred = canonicalLanguage(this.preferredLanguage);
    const embedded = await this.embeddedCandidates(mediaPath, preferred);
    const external = await this.externalCandidates(mediaPath, preferred);
    return [...embedded, ...external]
      .filter((candidate) => !candidate.commentary)
      .sort((a, b) => rankSubtitle(a) - rankSubtitle(b) || a.label.localeCompare(b.label));
  }

  async extract(mediaPath: string): Promise<{ text: string; candidate: SubtitleCandidate }> {
    const candidates = await this.candidates(mediaPath);
    const nonForced = candidates.filter((candidate) => !candidate.forced);
    const usable = nonForced.length > 0 ? nonForced : candidates;
    for (const candidate of usable) {
      try {
        const raw = candidate.source === 'external'
          ? await fs.readFile(candidate.filePath!, 'utf8')
          : (await this.runner(this.ffmpegBin, ['-v', 'error', '-i', mediaPath, '-map', `0:${candidate.streamIndex}`, '-f', 'srt', 'pipe:1'])).stdout;
        const text = cleanSubtitleText(raw);
        if (text.length >= 100) return { text, candidate };
      } catch {
        // Try the next ranked subtitle track.
      }
    }
    throw new Error('No usable text subtitles found');
  }

  private async embeddedCandidates(mediaPath: string, preferred: string): Promise<SubtitleCandidate[]> {
    const result = await this.runner(this.ffprobeBin, ['-v', 'error', '-show_streams', '-of', 'json', mediaPath]);
    const parsed = JSON.parse(result.stdout) as { streams?: ProbeStream[] };
    return (parsed.streams ?? [])
      .filter((stream) => stream.codec_type === 'subtitle' && TEXT_CODECS.has(stream.codec_name ?? ''))
      .map((stream) => {
        const language = canonicalLanguage(stream.tags?.language);
        const title = stream.tags?.title ?? `stream ${stream.index}`;
        return {
          source: 'embedded' as const,
          language,
          label: title,
          streamIndex: stream.index,
          preferred: language === preferred,
          default: stream.disposition?.default === 1,
          forced: stream.disposition?.forced === 1 || /forced/i.test(title),
          commentary: stream.disposition?.commentary === 1 || /commentary/i.test(title)
        };
      });
  }

  private async externalCandidates(mediaPath: string, preferred: string): Promise<SubtitleCandidate[]> {
    const directory = path.dirname(mediaPath);
    const stem = path.basename(mediaPath, path.extname(mediaPath));
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .filter((entry) => {
        const candidateStem = entry.name.slice(0, -path.extname(entry.name).length);
        return candidateStem === stem || candidateStem.startsWith(`${stem}.`) || candidateStem.startsWith(`${stem}_`) || candidateStem.startsWith(`${stem}-`);
      })
      .map((entry) => {
        const language = sidecarLanguage(stem, entry.name);
        return {
          source: 'external' as const,
          language,
          label: entry.name,
          filePath: path.join(directory, entry.name),
          preferred: language === preferred,
          default: false,
          forced: /(?:^|[._ -])forced(?:[._ -]|$)/i.test(entry.name),
          commentary: /(?:^|[._ -])commentary(?:[._ -]|$)/i.test(entry.name)
        };
      });
  }
}

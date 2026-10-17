import path from 'node:path';

export interface Config {
  port: number;
  apiToken: string;
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  llmThinking?: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
  eagerGeneration: boolean;
  lazyGeneration: boolean;
  preferredSubtitleLanguage: string;
  summaryLanguage: string;
  jellyfinUrl: string;
  jellyfinApiKey: string;
  jellyfinUserId?: string;
  databasePath: string;
  mediaRoot: string;
  arrPathPrefix: string;
  jellyfinPathPrefix: string;
  retryDelaysMs: number[];
  generationTimeoutMs: number;
  ffmpegBin: string;
  ffprobeBin: string;
  promptFile: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const LANGUAGE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (/^(true|1|yes|on)$/i.test(value)) return true;
  if (/^(false|0|no|off)$/i.test(value)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function thinkingLevel(value: string | undefined): Config['llmThinking'] {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!['none', 'low', 'medium', 'high', 'xhigh'].includes(normalized)) {
    throw new Error('RECAPARR_LLM_THINKING must be one of: none, low, medium, high, xhigh');
  }
  return normalized as Config['llmThinking'];
}

export function normalizeLanguage(value: string): string {
  const normalized = value.trim();
  if (!LANGUAGE_RE.test(normalized)) {
    throw new Error(`Invalid language code: ${value}`);
  }
  const [base, ...rest] = normalized.split('-');
  return [base!.toLowerCase(), ...rest.map((part) => part.length === 2 ? part.toUpperCase() : part)].join('-');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const retryMinutes = (env.RECAPARR_RETRY_DELAYS_MINUTES ?? '5,30,120,480,1440')
    .split(',')
    .map((part) => positiveInteger(part.trim(), 0, 'RECAPARR_RETRY_DELAYS_MINUTES'));
  const promptFile = env.RECAPARR_PROMPT_FILE ?? path.resolve(process.cwd(), 'prompts/recap.md');

  const jellyfinUserId = env.JELLYFIN_USER_ID?.trim();
  if (jellyfinUserId && !/^[a-fA-F0-9]{32}$|^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(jellyfinUserId)) {
    throw new Error('JELLYFIN_USER_ID must be a Jellyfin GUID');
  }

  return {
    port: positiveInteger(env.RECAPARR_PORT, 8080, 'RECAPARR_PORT'),
    apiToken: required(env, 'RECAPARR_API_TOKEN'),
    llmApiKey: required(env, 'RECAPARR_LLM_API_KEY'),
    llmBaseUrl: (env.RECAPARR_LLM_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    llmModel: env.RECAPARR_LLM_MODEL?.trim() || 'deepseek/deepseek-v4-flash-latest',
    llmThinking: thinkingLevel(env.RECAPARR_LLM_THINKING),
    eagerGeneration: booleanValue(env.RECAPARR_EAGER_GENERATION, true),
    lazyGeneration: booleanValue(env.RECAPARR_LAZY_GENERATION, true),
    preferredSubtitleLanguage: normalizeLanguage(env.RECAPARR_PREFERRED_SUBTITLE_LANGUAGE ?? 'en'),
    summaryLanguage: normalizeLanguage(env.RECAPARR_SUMMARY_LANGUAGE ?? 'en'),
    jellyfinUrl: (env.JELLYFIN_URL ?? 'http://jellyfin:8096').replace(/\/$/, ''),
    jellyfinApiKey: required(env, 'JELLYFIN_API_KEY'),
    jellyfinUserId,
    databasePath: env.RECAPARR_DATABASE_PATH ?? '/data/recaparr.sqlite',
    mediaRoot: path.resolve(env.RECAPARR_MEDIA_ROOT ?? '/media'),
    arrPathPrefix: path.posix.resolve(env.RECAPARR_ARR_PATH_PREFIX ?? '/downloads'),
    jellyfinPathPrefix: path.posix.resolve(env.RECAPARR_JELLYFIN_PATH_PREFIX ?? '/data'),
    retryDelaysMs: retryMinutes.map((minutes) => minutes * 60_000),
    generationTimeoutMs: positiveInteger(env.RECAPARR_GENERATION_TIMEOUT_MS, 600_000, 'RECAPARR_GENERATION_TIMEOUT_MS'),
    ffmpegBin: env.RECAPARR_FFMPEG_BIN ?? 'ffmpeg',
    ffprobeBin: env.RECAPARR_FFPROBE_BIN ?? 'ffprobe',
    promptFile,
    logLevel: (env.RECAPARR_LOG_LEVEL as Config['logLevel'] | undefined) ?? 'info'
  };
}

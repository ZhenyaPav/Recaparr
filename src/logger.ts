const ranks = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof ranks;

export class Logger {
  constructor(private readonly minimum: Level = 'info') {}

  debug(message: string, fields: Record<string, unknown> = {}): void { this.write('debug', message, fields); }
  info(message: string, fields: Record<string, unknown> = {}): void { this.write('info', message, fields); }
  warn(message: string, fields: Record<string, unknown> = {}): void { this.write('warn', message, fields); }
  error(message: string, fields: Record<string, unknown> = {}): void { this.write('error', message, fields); }

  private write(level: Level, message: string, fields: Record<string, unknown>): void {
    if (ranks[level] < ranks[this.minimum]) return;
    process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`);
  }
}

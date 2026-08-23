import fs from 'node:fs';
import path from 'node:path';

export class PathMapper {
  constructor(
    private readonly mediaRoot: string,
    private readonly arrPrefix: string,
    private readonly jellyfinPrefix: string
  ) {}

  fromArr(input: string): string { return this.translate(input, this.arrPrefix); }
  fromJellyfin(input: string): string { return this.translate(input, this.jellyfinPrefix); }

  assertReadableMediaFile(input: string): string {
    const resolved = fs.realpathSync(input);
    const relative = path.relative(fs.realpathSync(this.mediaRoot), resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Resolved media path is outside RECAPARR_MEDIA_ROOT');
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error('Resolved media path is not a file');
    return resolved;
  }

  private translate(input: string, sourcePrefix: string): string {
    if (!input || !path.posix.isAbsolute(input)) throw new Error('Media path must be absolute');
    const normalized = path.posix.normalize(input);
    const relative = path.posix.relative(sourcePrefix, normalized);
    if (relative.startsWith('..') || path.posix.isAbsolute(relative)) {
      throw new Error(`Media path is outside configured prefix ${sourcePrefix}`);
    }
    const translated = path.resolve(this.mediaRoot, ...relative.split('/'));
    const rootRelative = path.relative(this.mediaRoot, translated);
    if (rootRelative.startsWith('..') || path.isAbsolute(rootRelative)) throw new Error('Translated media path escapes media root');
    return translated;
  }
}

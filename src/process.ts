import { spawn } from 'node:child_process';

export interface ProcessResult { stdout: string; stderr: string; }
export type ProcessRunner = (command: string, args: string[], options?: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<ProcessResult>;

export const runProcess: ProcessRunner = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let settled = false;
  const timeout = options.timeoutMs ? setTimeout(() => {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
  }, options.timeoutMs) : undefined;

  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.on('error', (error) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    reject(error);
  });
  child.on('close', (code, signal) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
    if (code === 0) resolve(result);
    else reject(new Error(`${command} failed (${signal ?? code}): ${result.stderr.slice(-2000)}`));
  });
  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();
});

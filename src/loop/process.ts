import { spawn, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, relative, sep, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function safePath(root: string, path: string): string {
  const base = realpathSync(root), rel = relative(resolve(root), resolve(path));
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || rel.startsWith(sep)) throw new Error('Path outside project root');
  let current = base;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if (existsSync(current) || (() => { try { lstatSync(current); return true; } catch { return false; } })()) {
      if (lstatSync(current).isSymbolicLink()) throw new Error('Symlink path is unsupported');
    }
  }
  return resolve(base, rel);
}

export function processIdentity(pid: number): string {
  return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
}
export function acquireProjectLock(root: string): () => void {
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, encoding: 'utf8' }).trim();
  const path = safePath(gitDir, join(gitDir, 'orca-loop.lock'));
  const owner = { pid: process.pid, started: processIdentity(process.pid), key: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(owner)); } finally { closeSync(fd); }
      return () => {
        const current = JSON.parse(readFileSync(path, 'utf8'));
        if (current.key !== owner.key) throw new Error('Loop lock ownership changed');
        unlinkSync(path);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = JSON.parse(readFileSync(path, 'utf8'));
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || typeof previous.started !== 'string') throw new Error('Invalid project lock; operator recovery required');
      let live = true;
      try { process.kill(previous.pid, 0); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') live = false; else throw e;
      }
      if (live && processIdentity(previous.pid) === previous.started) throw new Error('Project loop already running: live lock owner');
      unlinkSync(path);
    }
  }
  throw new Error('Project loop lock unavailable');
}

export interface ProcessResult { exit_code: number | null; stdout: string; stderr: string; timed_out: boolean; output_exceeded: boolean }
export function runBounded(opts: { command: string; args: string[]; cwd: string; timeoutMs: number;
  env?: Record<string, string>; maxOutputBytes?: number }): Promise<ProcessResult> {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) return Promise.reject(new Error('Wall-clock budget exhausted'));
  const cap = opts.maxOutputBytes ?? 1024 * 1024;
  return new Promise((accept, reject) => {
    const child = spawn(opts.command, opts.args, { cwd: opts.cwd, detached: true,
      stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', ...opts.env } });
    let out = Buffer.alloc(0), err = Buffer.alloc(0), bytes = 0;
    const result: ProcessResult = { exit_code: null, stdout: '', stderr: '', timed_out: false, output_exceeded: false };
    const kill = () => {
      if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => { result.timed_out = true; kill(); }, opts.timeoutMs);
    const collect = (which: 'out' | 'err', data: Buffer) => {
      const saved = data.subarray(0, Math.max(0, cap - bytes));
      if (which === 'out') out = Buffer.concat([out, saved]); else err = Buffer.concat([err, saved]);
      bytes += data.length;
      if (bytes > cap) { result.output_exceeded = true; kill(); }
    };
    child.stdout.on('data', b => collect('out', b));
    child.stderr.on('data', b => collect('err', b));
    child.on('error', error => { clearTimeout(timer); kill(); reject(error); });
    child.on('close', code => {
      clearTimeout(timer); kill();
      result.exit_code = result.timed_out || result.output_exceeded ? null : code;
      result.stdout = out.toString('utf8'); result.stderr = err.toString('utf8'); accept(result);
    });
  });
}

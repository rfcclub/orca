import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('project lock pid reuse', () => {
  const lockRepo = () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-lock-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    return { root, lock: join(root, '.git', 'orca-loop.lock') };
  };
  const liveOwner = () => spawn('sleep', ['30'], { stdio: 'ignore' });

  it('[LOC-004] replaces a new-format lock whose pid was reused', async () => {
    const { acquireProjectLock } = await import('../../src/loop/process.js');
    const { root, lock } = lockRepo();
    const owner = liveOwner();
    try {
      writeFileSync(lock, JSON.stringify({ pid: owner.pid, started: { 'C/UTC': 'Thu Jan  1 00:00:00 1970' }, key: 'reused' }));
      const release = acquireProjectLock(root);
      expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid);
      release();
    } finally { owner.kill(); rmSync(root, { recursive: true, force: true }); }
  });
});

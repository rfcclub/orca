import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const modulePath = '../../dist/loop/process.js';
it('bounded process preserves argv and receives only selected environment', async () => {
  const api = await import(modulePath).catch(() => null);
  expect(api?.runBounded).toBeTypeOf('function');
  process.env.ORCA_LOOP_PRIVATE_FIXTURE = 'should not be inherited';
  try {
    const r = await api!.runBounded({ command: process.execPath,
      args: ['-e', 'console.log(JSON.stringify([process.argv[1],process.env.ORCA_LOOP_PRIVATE_FIXTURE,process.env.VISIBLE]))', 'literal $(false)'],
      cwd: process.cwd(), timeoutMs: 2000, env: { VISIBLE: 'selected' } });
    expect(r.exit_code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(['literal $(false)', null, 'selected']);
  } finally { delete process.env.ORCA_LOOP_PRIVATE_FIXTURE; }
});

it('wall-clock timeout kills the process group including a delayed descendant write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-loop-timeout-'));
  try {
    const api = await import(modulePath).catch(() => null);
    expect(api?.runBounded).toBeTypeOf('function');
    writeFileSync(join(root, 'child.cjs'), `setTimeout(()=>require('fs').writeFileSync('escaped','bad'),500);`);
    const start = Date.now();
    const r = await api!.runBounded({ command: process.execPath, args: ['-e',
      `require('child_process').spawn(process.execPath,['child.cjs'],{stdio:'inherit'});setInterval(()=>{},1000);`],
      cwd: root, timeoutMs: 100 });
    expect(r.timed_out).toBe(true);
    expect(Date.now() - start).toBeLessThan(1500);
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(existsSync(join(root, 'escaped'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('output flooding is bounded and never an exit-zero success', async () => {
  const api = await import(modulePath).catch(() => null);
  expect(api?.runBounded).toBeTypeOf('function');
  const r = await api!.runBounded({ command: process.execPath,
    args: ['-e', 'setInterval(()=>process.stdout.write("x".repeat(5000)),1)'],
    cwd: process.cwd(), timeoutMs: 2000, maxOutputBytes: 10000 });
  expect(r.output_exceeded).toBe(true);
  expect(r.stdout.length).toBeLessThanOrEqual(10000);
  expect(r.exit_code).not.toBe(0);
});

it('[LOC-001] processIdentity is the same under any caller locale', async () => {
  const { processIdentity } = await import('../../src/loop/process.js');
  const saved = process.env.LC_ALL;
  try {
    process.env.LC_ALL = 'en_CA.UTF-8';
    const regional = processIdentity(process.pid);
    process.env.LC_ALL = 'C';
    const c = processIdentity(process.pid);
    expect(regional).toBe(c);
  } finally {
    if (saved === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = saved;
  }
});

it('[LOC-002] processIdentity is the same under any caller timezone', async () => {
  const { processIdentity } = await import('../../src/loop/process.js');
  const saved = process.env.TZ;
  try {
    process.env.TZ = 'America/Toronto';
    const local = processIdentity(process.pid);
    process.env.TZ = 'UTC';
    const utc = processIdentity(process.pid);
    expect(local).toBe(utc);
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

describe('project lock across Orca versions', () => {
  const lockRepo = () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-lock-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    return { root, lock: join(root, '.git', 'orca-loop.lock') };
  };
  const liveOwner = () => spawn('sleep', ['30'], { stdio: 'ignore' });

  it('[LOC-003] keeps a live lock written by an older Orca', async () => {
    const { acquireProjectLock } = await import('../../src/loop/process.js');
    const { root, lock } = lockRepo();
    const owner = liveOwner();
    try {
      // An older Orca stored lstart in its own locale and timezone, with no identity_format.
      const legacy = JSON.stringify({ pid: owner.pid, started: 'Wed  4 Nov 21:32:50 2026', key: 'old-orca' });
      writeFileSync(lock, legacy);
      let error: Error | null = null;
      try { acquireProjectLock(root)(); } catch (e) { error = e as Error; }
      expect(String(error?.message)).toContain('operator recovery required');
      expect(readFileSync(lock, 'utf8')).toBe(legacy);
    } finally { owner.kill(); rmSync(root, { recursive: true, force: true }); }
  });

  it('[LOC-004] replaces a new-format lock whose pid was reused', async () => {
    const { acquireProjectLock } = await import('../../src/loop/process.js');
    const { root, lock } = lockRepo();
    const owner = liveOwner();
    try {
      writeFileSync(lock, JSON.stringify({ pid: owner.pid, started: 'Thu Jan  1 00:00:00 1970', key: 'reused', identity_format: 'C/UTC' }));
      const release = acquireProjectLock(root);
      expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid);
      release();
    } finally { owner.kill(); rmSync(root, { recursive: true, force: true }); }
  });
});

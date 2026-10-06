import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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

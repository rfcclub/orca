import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeGitHub } from '../helpers/fake-github.js';
import { resolveStatus, remotePhase, parseIssueRef } from '../../src/issue/status.js';
import { cmdStatus } from '../../src/cli/commands/status.js';
import { sc } from '../helpers/sc.js';

const O = 'Offline Operation';
const G = 'GitHub State When Available';
const D = 'Disagreement Is Reported';

describe('resolveStatus (pure)', () => {
  it('local only when there is no remote', () => {
    const r = resolveStatus('tdd', { state: 'none' });
    expect(r.lines).toEqual(['phase: tdd (source: local)']);
    expect(r.disagree).toBe(false);
  });
  it('says GitHub is unavailable and keeps the local phase', () => {
    const r = resolveStatus('tdd', { state: 'unavailable' });
    expect(r.lines[0]).toBe('phase: tdd (source: local)');
    expect(r.lines.join('\n')).toMatch(/GitHub state unavailable/);
    expect(r.disagree).toBe(false);
  });
  it('shows source github when both agree', () => {
    const r = resolveStatus('design', { state: 'ok', phase: 'design' });
    expect(r.lines.join('\n')).toContain('phase: design (source: github');
    expect(r.lines.join('\n')).not.toMatch(/disagree/);
    expect(r.disagree).toBe(false);
  });
  it('shows both values and says so when they differ', () => {
    const r = resolveStatus('tdd', { state: 'ok', phase: 'verified' });
    const out = r.lines.join('\n');
    expect(out).toContain('github: verified');
    expect(out).toContain('local: tdd');
    expect(out).toMatch(/sources disagree/);
    expect(r.disagree).toBe(true);
  });
});

describe('remotePhase / parseIssueRef', () => {
  it('reads the phase from the single orca phase label and ignores other labels', () => {
    expect(remotePhase(['bug', 'orca:approved', 'orca:design'])).toBe('design');
    expect(remotePhase(['orca:blocked'])).toBe('blocked');
    expect(remotePhase(['bug', 'orca:approved'])).toBeNull();
  });
  it('parses the Issue line of an intent', () => {
    expect(parseIssueRef('# Intent: x\n\nIssue: GotakoVN/orca#12\n')).toEqual({ repo: 'GotakoVN/orca', number: 12 });
    expect(parseIssueRef('# Intent: x\n')).toBeNull();
    expect(parseIssueRef('Issue: not a ref\n')).toBeNull();
  });
});

describe('orca status against a project', () => {
  let root: string;
  let originalCwd: string;
  let logs: string[];

  function change(files: Record<string, string>): void {
    const dir = join(root, 'openspec', 'changes', 'demo');
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), content, 'utf-8');
    }
  }
  const out = () => logs.join('\n');
  const withIssue = '# Intent: demo\n\nIssue: GotakoVN/orca#12\n';

  beforeEach(() => {
    originalCwd = process.cwd();
    root = mkdtempSync(join(tmpdir(), 'orca-status-'));
    process.chdir(root);
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  });
  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it(`${sc(O, 'No issue for the change')}`, async () => {
    change({ 'intent.md': '# Intent: demo\n' });
    let asked = 0;
    await cmdStatus({ portFor: () => { asked++; return new FakeGitHub(); } });
    expect(out()).toContain('demo');
    expect(out()).not.toMatch(/github/i);
    expect(asked).toBe(0);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it(`${sc(O, 'No network')}`, async () => {
    change({ 'intent.md': withIssue, 'design.md': 'x' });
    const gh = new FakeGitHub();
    gh.failAll(new Error('offline'));
    await cmdStatus({ portFor: () => gh });
    expect(out()).toContain('phase: design (source: local)');
    expect(out()).toMatch(/GitHub state unavailable/);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('treats a hung GitHub call as unavailable after the timeout', async () => {
    change({ 'intent.md': withIssue, 'design.md': 'x' });
    const hung = { getIssue: () => new Promise(() => {}) } as unknown as FakeGitHub;
    await cmdStatus({ portFor: () => hung, timeoutMs: 20 });
    expect(out()).toMatch(/GitHub state unavailable/);
  });

  it('treats a missing gh login or repo (portFor throws) as unavailable', async () => {
    change({ 'intent.md': withIssue, 'design.md': 'x' });
    await cmdStatus({ portFor: () => { throw new Error('gh not installed'); } });
    expect(out()).toMatch(/GitHub state unavailable/);
  });

  it(`${sc(G, 'GitHub reachable')}`, async () => {
    change({ 'intent.md': withIssue, 'design.md': 'x' });
    const gh = new FakeGitHub();
    gh.addIssue({ number: 12, author: 'a', labels: ['orca:design'], body: '' });
    await cmdStatus({ portFor: () => gh });
    expect(out()).toContain('phase: design (source: github');
  });

  it(`${sc(D, 'Labels and files disagree')}`, async () => {
    change({ 'intent.md': withIssue, 'tasks.md': 'x', 'plan.json': JSON.stringify({ tasks: [{ id: 't', status: 'in_progress' }] }) });
    const gh = new FakeGitHub();
    gh.addIssue({ number: 12, author: 'a', labels: ['orca:verified'], body: '' });
    await cmdStatus({ portFor: () => gh });
    expect(out()).toContain('github: verified');
    expect(out()).toContain('local: tdd');
    expect(out()).toMatch(/sources disagree/);
  });

  it(`${sc(D, 'Labels and files agree')}`, async () => {
    change({ 'intent.md': withIssue, 'tasks.md': 'x', 'plan.json': JSON.stringify({ tasks: [{ id: 't', status: 'in_progress' }] }) });
    const gh = new FakeGitHub();
    gh.addIssue({ number: 12, author: 'a', labels: ['orca:tdd'], body: '' });
    await cmdStatus({ portFor: () => gh });
    expect(out()).toContain('phase: tdd (source: github');
    expect(out()).not.toMatch(/disagree/);
  });

  it('keeps the existing status output for every change', async () => {
    change({ 'intent.md': '# Intent: demo\n' });
    await cmdStatus({ portFor: () => new FakeGitHub() });
    expect(out()).toContain('LoomKit Status');
    expect(out()).toContain('Active changes: 1');
  });
});

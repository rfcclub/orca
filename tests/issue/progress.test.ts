import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeGitHub } from '../helpers/fake-github.js';
import { localPhase } from '../../src/issue/phase.js';
import {
  PHASE_LABELS, PROGRESS_MARKER, syncPhaseLabel, renderProgress, upsertProgress,
} from '../../src/issue/progress.js';
import { APPROVED_LABEL } from '../../src/issue/approve-flow.js';
import { sc } from '../helpers/sc.js';

const L = 'Phase Label';
const P = 'Single Progress Comment';
const W = 'Workflow Is The Only Writer';

let gh: FakeGitHub;
beforeEach(() => {
  gh = new FakeGitHub();
  gh.addIssue({ number: 12, author: 'a', labels: ['enhancement', 'orca:spec'], body: '' });
});

const phaseLabels = async () => (await gh.getIssue(12)).labels.filter(l => PHASE_LABELS.includes(l));

describe('syncPhaseLabel', () => {
  it(`${sc(L, 'Label follows the phase')}`, async () => {
    await syncPhaseLabel(gh, 12, 'design');
    const labels = (await gh.getIssue(12)).labels;
    expect(labels).toContain('orca:design');
    expect(labels).not.toContain('orca:spec');
  });

  it(`${sc(L, 'Blocked change')}`, async () => {
    await syncPhaseLabel(gh, 12, 'blocked');
    expect(await phaseLabels()).toEqual(['orca:blocked']);
  });

  it(`${sc(W, 'Hand-edited phase label')}`, async () => {
    await syncPhaseLabel(gh, 12, 'design');
    await gh.removeLabel(12, 'orca:design');
    await gh.addLabel(12, 'orca:verified'); // a person's edit
    await syncPhaseLabel(gh, 12, 'design');
    const labels = (await gh.getIssue(12)).labels;
    expect(labels).toContain('orca:design');
    expect(labels).not.toContain('orca:verified');
  });

  it('never touches labels it does not own (shape label, approval label)', async () => {
    await gh.addLabel(12, APPROVED_LABEL);
    await syncPhaseLabel(gh, 12, 'tdd');
    const labels = (await gh.getIssue(12)).labels;
    expect(labels).toContain('enhancement');
    expect(labels).toContain(APPROVED_LABEL);
  });

  it('writes nothing when the label is already right', async () => {
    await syncPhaseLabel(gh, 12, 'spec');
    expect(gh.calls.filter(c => c.startsWith('addLabel') || c.startsWith('removeLabel'))).toEqual([]);
  });
});

describe('renderProgress and upsertProgress', () => {
  const base = { phase: 'design' as const, owner: 'GotakoVN' };

  it(`${sc(L, 'Cross-repo dependency as issue link')}`, () => {
    const body = renderProgress({ ...base, blockedBy: ['other-repo#3'], scenarios: [] });
    expect(body).toContain('[other-repo#3](https://github.com/GotakoVN/other-repo/issues/3)');
  });

  it('links a fully qualified dependency as given', () => {
    const body = renderProgress({ ...base, blockedBy: ['acme/lib#9'], scenarios: [] });
    expect(body).toContain('[acme/lib#9](https://github.com/acme/lib/issues/9)');
  });

  it(`${sc(P, 'Scenario checklist')}`, () => {
    const body = renderProgress({
      ...base,
      scenarios: [
        { id: 'SC-001', passing: true, testUrl: 'https://example.test/t1' },
        { id: 'SC-002', passing: false },
      ],
    });
    expect(body).toContain('- [x] [SC-001](https://example.test/t1)');
    expect(body).toContain('- [ ] SC-002');
    expect(body.startsWith(PROGRESS_MARKER)).toBe(true);
  });

  it(`${sc(P, 'First run creates the comment')}`, async () => {
    await upsertProgress(gh, 12, renderProgress({ ...base, scenarios: [] }));
    const comments = await gh.listComments(12);
    expect(comments.filter(c => c.body.includes(PROGRESS_MARKER))).toHaveLength(1);
  });

  it(`${sc(P, 'Later run updates the comment')}`, async () => {
    await upsertProgress(gh, 12, renderProgress({ ...base, scenarios: [{ id: 'SC-001', passing: false }] }));
    gh.calls.length = 0;
    await upsertProgress(gh, 12, renderProgress({ ...base, scenarios: [{ id: 'SC-001', passing: true }] }));
    const comments = await gh.listComments(12);
    expect(comments.filter(c => c.body.includes(PROGRESS_MARKER))).toHaveLength(1);
    expect(comments[0].body).toContain('- [x] SC-001');
    expect(gh.calls.some(c => c.startsWith('updateComment'))).toBe(true);
    expect(gh.calls.some(c => c.startsWith('createComment'))).toBe(false);
  });

  it('does not write when the progress comment is already current', async () => {
    const body = renderProgress({ ...base, scenarios: [] });
    await upsertProgress(gh, 12, body);
    gh.calls.length = 0;
    await upsertProgress(gh, 12, body);
    expect(gh.calls.filter(c => c.startsWith('updateComment') || c.startsWith('createComment'))).toEqual([]);
  });

  it('ignores a marker comment that a person planted when a bot login is given', async () => {
    const planted = await gh.createComment(12, `${PROGRESS_MARKER}\nfake progress`);
    gh.setCommentAuthor(planted.id, 'mallory');
    await upsertProgress(gh, 12, renderProgress({ ...base, scenarios: [] }), { botLogin: 'orca[bot]' });
    const comments = await gh.listComments(12);
    expect(comments.find(c => c.author === 'mallory')!.body).toContain('fake progress');
    expect(comments.filter(c => c.author === 'orca[bot]' && c.body.includes(PROGRESS_MARKER))).toHaveLength(1);
  });
});

describe('localPhase', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orca-phase-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const write = (rel: string, content = 'x') => {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, 'utf-8');
  };

  it('is intent for a folder with only intent.md', () => {
    write('intent.md');
    expect(localPhase(dir)).toBe('intent');
  });
  it('is spec once a spec exists', () => {
    write('intent.md'); write('specs/a/spec.md');
    expect(localPhase(dir)).toBe('spec');
  });
  it('is design once design.md exists', () => {
    write('specs/a/spec.md'); write('design.md');
    expect(localPhase(dir)).toBe('design');
  });
  it('is plan once tasks.md exists', () => {
    write('design.md'); write('tasks.md');
    expect(localPhase(dir)).toBe('plan');
  });
  it('is tdd once a plan.json task has started', () => {
    write('tasks.md');
    write('plan.json', JSON.stringify({ tasks: [{ id: 't1', status: 'in_progress' }] }));
    expect(localPhase(dir)).toBe('tdd');
  });
  it('stays plan while every plan.json task is pending', () => {
    write('tasks.md');
    write('plan.json', JSON.stringify({ tasks: [{ id: 't1', status: 'pending' }] }));
    expect(localPhase(dir)).toBe('plan');
  });
  it('is verified once the gate file says passed', () => {
    write('tasks.md');
    write('.loomkit-verify.json', JSON.stringify({ passed: true }));
    expect(localPhase(dir)).toBe('verified');
  });
  it('is not verified when the gate file says failed', () => {
    write('tasks.md');
    write('.loomkit-verify.json', JSON.stringify({ passed: false }));
    expect(localPhase(dir)).toBe('plan');
  });
  it('survives a corrupt plan.json or gate file', () => {
    write('tasks.md'); write('plan.json', '{not json'); write('.loomkit-verify.json', '{nope');
    expect(localPhase(dir)).toBe('plan');
  });
});

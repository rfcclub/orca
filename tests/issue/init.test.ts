import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeGitHub } from '../helpers/fake-github.js';
import { initRepo, WORKFLOW_TEMPLATE } from '../../src/issue/init.js';
import { APPROVED_LABEL } from '../../src/issue/approve-flow.js';
import { sc } from '../helpers/sc.js';

let root: string;
let gh: FakeGitHub;
const wf = () => join(root, '.github', 'workflows', 'orca-issue.yml');
const actors = () => join(root, 'openspec', 'actors.yaml');
const init = (extra: Record<string, unknown> = {}) =>
  initRepo({ port: gh, projectRoot: root, reviewers: ['alice'], agents: ['agent-oc'], log: () => {}, ...extra });

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'orca-init-')); gh = new FakeGitHub(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('initRepo', () => {
  it(`${sc('Labels Ensured', 'Labels created once')}`, async () => {
    await init();
    await init();
    for (const l of ['intent', 'spec', 'design', 'plan', 'tdd', 'verified', 'blocked']) {
      expect(gh.labelsEnsured).toContain(`orca:${l}`);
    }
    expect(gh.labelsEnsured).toContain(APPROVED_LABEL);
    expect(new Set(gh.labelsEnsured).size).toBe(gh.labelsEnsured.length);
  });

  it(`${sc('Workflow And Actors Written', 'Files written')}`, async () => {
    await init();
    expect(readFileSync(wf(), 'utf-8')).toBe(WORKFLOW_TEMPLATE);
    const a = readFileSync(actors(), 'utf-8');
    expect(a).toMatch(/login: alice\s+kind: human/);
    expect(a).toContain('- agent-oc');
  });

  it(`${sc('Workflow And Actors Written', 'Existing files kept')}`, async () => {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(wf(), 'custom\n');
    await init();
    expect(readFileSync(wf(), 'utf-8')).toBe('custom\n');
  });

  it(`${sc('Workflow And Actors Written', 'Overwrite on request')}`, async () => {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(wf(), 'custom\n');
    await init({ force: true });
    expect(readFileSync(wf(), 'utf-8')).toBe(WORKFLOW_TEMPLATE);
  });

  it(`${sc('A Human Reviewer Is Required', 'No reviewer')}`, async () => {
    await expect(init({ reviewers: [] })).rejects.toThrow(/reviewer/);
    expect(existsSync(wf())).toBe(false);
    expect(existsSync(actors())).toBe(false);
    expect(gh.labelsEnsured).toEqual([]);
  });

  it('the embedded workflow template equals this repo\'s workflow file', () => {
    expect(WORKFLOW_TEMPLATE).toBe(readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'orca-issue.yml'), 'utf-8'));
  });
});

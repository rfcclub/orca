import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createChangeFromIssue, stampSpecIssue } from '../../src/issue/folder.js';
import { parseSpec } from '../../src/spec/parser.js';
import { sc } from '../helpers/sc.js';

const ENH_BODY = ['Problem', 'Desired outcome', 'Non-goals', 'Constraints', 'Success criteria']
  .map(h => `## ${h}\n\ntext for ${h}\n`).join('\n');
const BUG_BODY = ['Repro steps', 'Expected', 'Actual', 'Environment']
  .map(h => `### ${h}\n\ntext for ${h}\n`).join('\n');

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orca-folder-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const S = 'Small Bug Needs No Spec or Design';
const C = 'Change Folder From Approved Issue';

describe('createChangeFromIssue', () => {
  it(`${sc(S, 'Change folder for a bug')}`, () => {
    const out = createChangeFromIssue({
      issue: { number: 7, author: 'a', labels: ['bug'], body: BUG_BODY },
      repo: 'GotakoVN/orca', approved: true, changesDir: dir, name: 'fix-nan',
    });
    const files = readdirSync(out.dir).sort();
    expect(files).toEqual(['intent.md', 'tasks.md']);
    expect(existsSync(join(out.dir, 'specs'))).toBe(false);
    expect(existsSync(join(out.dir, 'design.md'))).toBe(false);
  });

  it(`${sc(C, 'Folder created from issue')}`, () => {
    const out = createChangeFromIssue({
      issue: { number: 12, author: 'a', labels: ['enhancement'], body: ENH_BODY },
      repo: 'GotakoVN/orca', approved: true, approvedBy: 'alice', changesDir: dir, name: 'issue-as-intent',
      now: () => new Date('2026-10-03T12:00:00Z'),
    });
    const intent = readFileSync(join(out.dir, 'intent.md'), 'utf-8');
    const lines = intent.split('\n');
    expect(lines[0]).toBe('# Intent: issue-as-intent');
    expect(lines[2]).toBe('Issue: GotakoVN/orca#12');
    expect(intent).toContain('text for Success criteria');
    expect(intent).toContain('Status: APPROVED');
    expect(intent).toContain('Approved by: alice');
    expect(intent).toContain('Date: 2026-10-03');
  });

  it(`${sc(C, 'Unapproved issue refused')}`, () => {
    expect(() => createChangeFromIssue({
      issue: { number: 12, author: 'a', labels: ['enhancement'], body: ENH_BODY },
      repo: 'GotakoVN/orca', approved: false, changesDir: dir, name: 'x-change',
    })).toThrow(/not approved/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it(`${sc(C, 'Spec traces to issue')}`, () => {
    const spec = '# thing Specification\n\n## Purpose\n\nwhy\n\n## Requirements\n\n### Requirement: A\n\nThe system SHALL do A.\n\n#### Scenario: s\n\n- **WHEN** x\n- **THEN** y\n';
    const stamped = stampSpecIssue(spec, 'GotakoVN/orca#12');
    expect(stamped.split('\n')[2]).toBe('Issue: GotakoVN/orca#12');
    const tree = parseSpec(stamped);
    expect(tree.title).toBe('thing');
    expect(tree.purpose).toBe('why');
    expect(tree.requirements[0].scenarios).toHaveLength(1);
  });

  it('stamping twice replaces the line instead of duplicating it', () => {
    const once = stampSpecIssue('# T\n\n## Purpose\n\np\n', 'o/r#1');
    const twice = stampSpecIssue(once, 'o/r#2');
    expect(twice.match(/^Issue:/gm)).toHaveLength(1);
    expect(twice).toContain('Issue: o/r#2');
  });

  it('refuses a non-conforming issue and writes nothing', () => {
    expect(() => createChangeFromIssue({
      issue: { number: 12, author: 'a', labels: ['enhancement'], body: '## Problem\n\nonly\n' },
      repo: 'o/r', approved: true, changesDir: dir, name: 'x-change',
    })).toThrow(/non-conforming/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses to overwrite an existing change folder', () => {
    const input = {
      issue: { number: 12, author: 'a', labels: ['enhancement'], body: ENH_BODY },
      repo: 'o/r', approved: true, changesDir: dir, name: 'x-change',
    };
    createChangeFromIssue(input);
    expect(() => createChangeFromIssue(input)).toThrow(/already exists/);
  });

  it('rejects a change name that could escape the changes directory', () => {
    expect(() => createChangeFromIssue({
      issue: { number: 12, author: 'a', labels: ['enhancement'], body: ENH_BODY },
      repo: 'o/r', approved: true, changesDir: dir, name: '../evil',
    })).toThrow(/invalid change name/);
  });

  it('renders proposed items with their tag and acceptance', () => {
    const out = createChangeFromIssue({
      issue: { number: 12, author: 'a', labels: ['enhancement'], body: ENH_BODY },
      repo: 'o/r', approved: true, changesDir: dir, name: 'x-change',
      proposed: [
        { section: 'Constraints', text: 'keep it small' },
        { section: 'Constraints', text: 'no network', acceptedBy: 'alice' },
      ],
    });
    const intent = readFileSync(join(out.dir, 'intent.md'), 'utf-8');
    expect(intent).toContain('- [orca-proposed] Constraints | keep it small');
    expect(intent).toContain('- [orca-proposed accepted-by:alice] Constraints | no network');
  });
});

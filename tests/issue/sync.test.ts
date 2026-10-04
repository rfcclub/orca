import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeGitHub } from '../helpers/fake-github.js';
import { syncChange, parseBlockedBy } from '../../src/issue/sync.js';
import { PROGRESS_MARKER } from '../../src/issue/progress.js';

const SPEC = `# demo Specification

## Purpose

p

## Requirements

### Requirement: R

The system SHALL do R.

#### Scenario: one

- **WHEN** a
- **THEN** b

#### Scenario: two

- **WHEN** a
- **THEN** b

### Requirement: Optional bit

The system MAY do Z.

#### Scenario: zed

- **WHEN** a
- **THEN** b
`;

let dir: string;
let gh: FakeGitHub;
const write = (rel: string, content: string) => {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content, 'utf-8');
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-sync-'));
  gh = new FakeGitHub();
  gh.addIssue({ number: 12, author: 'a', labels: ['enhancement', 'orca:intent'], body: '' });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const base = () => ({ issueNo: 12, repo: 'GotakoVN/orca', sha: 'abc123', changeDir: dir, botLogin: 'orca[bot]' });

describe('parseBlockedBy', () => {
  it('reads comma-separated refs from a Blocked by line', () => {
    expect(parseBlockedBy('# x\n\nBlocked by: other-repo#3, acme/lib#9\n')).toEqual(['other-repo#3', 'acme/lib#9']);
  });
  it('returns nothing when the line is absent or empty', () => {
    expect(parseBlockedBy('# x\n')).toEqual([]);
    expect(parseBlockedBy('Blocked by:\n')).toEqual([]);
  });
});

describe('syncChange', () => {
  it('sets the phase label and writes one progress comment with the scenario checklist', async () => {
    write('intent.md', '# Intent: demo\n\nIssue: GotakoVN/orca#12\n');
    write('specs/demo/spec.md', SPEC);
    write('design.md', 'x');
    write('.traceability.yaml', 'scenarios:\n  - scenario: r-one\n    status: passing\n    test: tests/issue/one.test.ts\n  - scenario: r-two\n    status: failing\n');

    await syncChange(gh, base());

    const issue = await gh.getIssue(12);
    expect(issue.labels).toContain('orca:design');
    expect(issue.labels).not.toContain('orca:intent');
    const progress = (await gh.listComments(12)).filter(c => c.body.includes(PROGRESS_MARKER));
    expect(progress).toHaveLength(1);
    expect(progress[0].body).toContain('- [x] [r-one](https://github.com/GotakoVN/orca/blob/abc123/tests/issue/one.test.ts)');
    expect(progress[0].body).toContain('- [ ] r-two');
    expect(progress[0].body).not.toContain('r-optional-bit-zed'); // MAY scenarios are not mandatory
  });

  it('labels the change blocked and links the dependency', async () => {
    write('intent.md', '# Intent: demo\n\nIssue: GotakoVN/orca#12\nBlocked by: other-repo#3\n');
    await syncChange(gh, base());
    expect((await gh.getIssue(12)).labels).toContain('orca:blocked');
    const body = (await gh.listComments(12))[0].body;
    expect(body).toContain('[other-repo#3](https://github.com/GotakoVN/other-repo/issues/3)');
  });

  it('is idempotent: a second run leaves one comment and the same labels', async () => {
    write('intent.md', '# Intent: demo\n\nIssue: GotakoVN/orca#12\n');
    await syncChange(gh, base());
    const before = (await gh.getIssue(12)).labels.slice().sort();
    await syncChange(gh, base());
    expect((await gh.listComments(12)).filter(c => c.body.includes(PROGRESS_MARKER))).toHaveLength(1);
    expect((await gh.getIssue(12)).labels.slice().sort()).toEqual(before);
  });
});

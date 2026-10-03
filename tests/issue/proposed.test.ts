import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findUnacceptedProposed } from '../../src/issue/proposed.js';
import { cmdVerify } from '../../src/cli/commands/verify.js';
import { sc } from '../helpers/sc.js';

const SPEC = `# demo Specification

## Purpose

p

## Requirements

### Requirement: R

The system SHALL do R.

#### Scenario: s

- **WHEN** a
- **THEN** b
`;

let root: string;
let originalCwd: string;
let logs: string[];

function makeChange(intentMd: string | null): string {
  const changeDir = join(root, 'openspec', 'changes', 'demo');
  mkdirSync(join(changeDir, 'specs', 'demo'), { recursive: true });
  writeFileSync(join(changeDir, 'specs', 'demo', 'spec.md'), SPEC, 'utf-8');
  writeFileSync(join(changeDir, '.traceability.yaml'), `scenarios:\n  - scenario: r-s\n    status: passing\n`, 'utf-8');
  if (intentMd !== null) writeFileSync(join(changeDir, 'intent.md'), intentMd, 'utf-8');
  return changeDir;
}

function runVerify(changeDir: string) {
  process.chdir(root);
  cmdVerify('demo');
  return JSON.parse(readFileSync(join(changeDir, '.loomkit-verify.json'), 'utf-8'));
}

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'orca-proposed-'));
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
});
afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const A = 'Accepting Proposed Items';

describe('findUnacceptedProposed', () => {
  it('returns only proposed lines without an acceptance', () => {
    const md = [
      '- [author-stated] Problem | x',
      '- [orca-proposed] Constraints | keep it small',
      '- [orca-proposed accepted-by:alice] Constraints | no network',
      '* [orca-proposed] Problem | star bullet',
      'plain text mentioning [orca-proposed] in prose',
    ].join('\n');
    expect(findUnacceptedProposed(md)).toEqual(['Constraints | keep it small', 'Problem | star bullet']);
  });

  it('returns nothing for an intent without proposed items', () => {
    expect(findUnacceptedProposed('# Intent\n\nStatus: APPROVED\n')).toEqual([]);
  });
});

describe('coverage gate and orca-proposed items', () => {
  it(`${sc(A, 'Proposed criterion not yet accepted')}`, () => {
    const dir = makeChange('# Intent: demo\n\n- [orca-proposed] Success criteria | it is fast\n');
    const result = runVerify(dir);
    expect(result.coverage).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.unaccepted).toEqual(['Success criteria | it is fast']);
    expect(logs.join('\n')).toContain('Success criteria | it is fast');
    expect(logs.join('\n')).toContain('FAIL');
  });

  it(`${sc(A, 'Proposed criterion accepted')}`, () => {
    const dir = makeChange('# Intent: demo\n\n- [orca-proposed accepted-by:alice] Success criteria | it is fast\n');
    const result = runVerify(dir);
    expect(result.passed).toBe(true);
    expect(result.unaccepted).toBeUndefined();
    expect(logs.join('\n')).toContain('PASS');
  });

  it('leaves the old behaviour untouched when there is no intent.md', () => {
    const dir = makeChange(null);
    expect(existsSync(join(dir, 'intent.md'))).toBe(false);
    const result = runVerify(dir);
    expect(result.passed).toBe(true);
    expect(result.unaccepted).toBeUndefined();
  });
});

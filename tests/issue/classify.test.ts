import { describe, it, expect } from 'vitest';
import { classifyIssue } from '../../src/issue/classify.js';
import { sc } from '../helpers/sc.js';

const R = 'Issue Shape Classification';

const enhancement = (omit: string[] = []) =>
  ['Problem', 'Desired outcome', 'Non-goals', 'Constraints', 'Success criteria']
    .filter(h => !omit.includes(h))
    .map(h => `## ${h}\n\nsome ${h} text\n`)
    .join('\n');

describe('classifyIssue', () => {
  it(`${sc(R, 'Conforming enhancement issue')}`, () => {
    const r = classifyIssue({ labels: ['enhancement'], body: enhancement() });
    expect(r.result).toBe('conforming');
    expect(r.missing).toEqual([]);
  });

  it(`${sc(R, 'Enhancement issue missing a section')}`, () => {
    const r = classifyIssue({ labels: ['enhancement'], body: enhancement(['Non-goals']) });
    expect(r.result).toBe('non-conforming');
    expect(r.missing).toContain('Non-goals');
  });

  it(`${sc(R, 'Conforming bug issue')}`, () => {
    const body = ['Repro steps', 'Expected', 'Actual', 'Environment']
      .map(h => `### ${h}\n\ntext for ${h}\n`).join('\n');
    const r = classifyIssue({ labels: ['bug'], body });
    expect(r.result).toBe('conforming');
  });

  it(`${sc(R, 'Issue without a shape label')}`, () => {
    const r = classifyIssue({ labels: ['question'], body: enhancement() });
    expect(r.result).toBe('non-conforming');
    expect(r.reason).toMatch(/no shape label/i);
  });

  it('treats a heading with an empty body as missing', () => {
    const body = enhancement(['Constraints']) + '\n## Constraints\n\n<!-- fill me -->\n';
    const r = classifyIssue({ labels: ['enhancement'], body });
    expect(r.missing).toEqual(['Constraints']);
  });

  it('matches headings case-insensitively and ignoring hyphens', () => {
    const body = enhancement(['Non-goals']) + '\n## NON GOALS\n\nnothing\n';
    expect(classifyIssue({ labels: ['enhancement'], body }).result).toBe('conforming');
  });

  it('rejects an issue carrying both shape labels', () => {
    const r = classifyIssue({ labels: ['bug', 'enhancement'], body: enhancement() });
    expect(r.result).toBe('non-conforming');
    expect(r.reason).toMatch(/both/i);
  });
});

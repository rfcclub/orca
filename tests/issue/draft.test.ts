import { describe, it, expect } from 'vitest';
import { draftMissing, localProvider, type DraftProvider } from '../../src/issue/draft.js';
import { loadConfig } from '../../src/config/loader.js';
import { sc } from '../helpers/sc.js';

const ENH_SECTIONS = ['Problem', 'Desired outcome', 'Non-goals', 'Constraints', 'Success criteria'];
const enh = (omit: string[]) =>
  ENH_SECTIONS.filter(h => !omit.includes(h)).map(h => `## ${h}\n\nauthor wrote ${h}\nsecond line of ${h}\n`).join('\n');

function spy(name: string): DraftProvider & { calls: string[] } {
  const calls: string[] = [];
  return { name, calls, async complete(prompt: string) { calls.push(prompt); return `proposed line from ${name}`; } } as DraftProvider & { calls: string[] };
}

const tagged = (comment: string) =>
  comment.split('\n').filter(l => l.trim() && !l.startsWith('<!--'));

const T = 'Marked Drafting of Missing Sections';
const P = 'Per-Repository Drafting Provider';

describe('draftMissing', () => {
  it(`${sc(T, 'Drafted line tagging')}`, async () => {
    const local = spy('local');
    const comment = (await draftMissing({
      issue: { labels: ['enhancement'], body: enh(['Constraints']) },
      providers: { local }, config: { provider: 'local' },
    }))!;
    const lines = tagged(comment);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      const tags = l.match(/\[(author-stated|orca-proposed)\]/g) ?? [];
      expect(tags, l).toHaveLength(1);
    }
    expect(lines.filter(l => l.includes('author wrote Problem')).every(l => l.startsWith('[author-stated]'))).toBe(true);
    expect(lines.some(l => l.startsWith('[author-stated]') && l.includes('second line of Problem'))).toBe(true);
    expect(lines.some(l => l.startsWith('[orca-proposed]') && l.includes('Constraints') && l.includes('proposed line from local'))).toBe(true);
  });

  it(`${sc(T, 'Success criteria become questions')}`, async () => {
    const local = spy('local');
    const comment = (await draftMissing({
      issue: { labels: ['enhancement'], body: enh(['Success criteria']) },
      providers: { local }, config: { provider: 'local' },
    }))!;
    const sectionLines = tagged(comment).filter(l => l.includes('| ') && l.includes('Success criteria'));
    expect(sectionLines.length).toBeGreaterThan(0);
    for (const l of sectionLines) expect(l).toMatch(/^\[orca-proposed\] Success criteria \| QUESTION: /);
    expect(local.calls.every(c => !c.includes('Success criteria'))).toBe(true);
  });

  it(`${sc(T, 'Non-goals become questions')}`, async () => {
    const local = spy('local');
    const comment = (await draftMissing({
      issue: { labels: ['enhancement'], body: enh(['Non-goals']) },
      providers: { local }, config: { provider: 'local' },
    }))!;
    const sectionLines = tagged(comment).filter(l => l.includes('Non-goals |'));
    expect(sectionLines.length).toBeGreaterThan(0);
    for (const l of sectionLines) expect(l).toMatch(/^\[orca-proposed\] Non-goals \| QUESTION: /);
    expect(local.calls.every(c => !c.includes('Non-goals'))).toBe(true);
  });

  it(`${sc(P, 'Provider configured')}`, async () => {
    const local = spy('local');
    const remote = spy('remote');
    await draftMissing({
      issue: { labels: ['enhancement'], body: enh(['Constraints']) },
      providers: { local, remote }, config: { provider: 'local' },
    });
    expect(local.calls.length).toBeGreaterThan(0);
    expect(remote.calls).toHaveLength(0);
  });

  it(`${sc(P, 'No provider configured')}`, async () => {
    const local = spy('local');
    await expect(draftMissing({
      issue: { labels: ['enhancement'], body: enh(['Constraints']) },
      providers: { local }, config: {},
    })).rejects.toThrow(/drafting\.provider/);
    expect(local.calls).toHaveLength(0);
  });

  it('fails when the configured provider is not registered, without calling any other', async () => {
    const local = spy('local');
    await expect(draftMissing({
      issue: { labels: ['enhancement'], body: enh(['Constraints']) },
      providers: { local }, config: { provider: 'nope' },
    })).rejects.toThrow(/unknown drafting provider "nope"/);
    expect(local.calls).toHaveLength(0);
  });

  it('never has a model write bug facts: every missing bug section is a question', async () => {
    const local = spy('local');
    const comment = (await draftMissing({
      issue: { labels: ['bug'], body: '### Environment\n\nmacOS\n' },
      providers: { local }, config: { provider: 'local' },
    }))!;
    expect(local.calls).toHaveLength(0);
    for (const s of ['Repro steps', 'Expected', 'Actual']) {
      expect(comment).toMatch(new RegExp(`\\[orca-proposed\\] ${s} \\| QUESTION: `));
    }
  });

  it('returns null for a conforming issue', async () => {
    const out = await draftMissing({
      issue: { labels: ['enhancement'], body: enh([]) }, providers: { local: spy('local') }, config: { provider: 'local' },
    });
    expect(out).toBeNull();
  });

  it('ships a local stub provider that needs no network', async () => {
    expect(localProvider.name).toBe('local');
    expect(await localProvider.complete('Section: Constraints')).toContain('Constraints');
  });
});

describe('config', () => {
  it('reads drafting.provider from config.yaml', () => {
    expect(loadConfig('drafting:\n  provider: local\n').drafting?.provider).toBe('local');
  });
  it('leaves drafting undefined when absent', () => {
    expect(loadConfig('').drafting).toBeUndefined();
  });
});

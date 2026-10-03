import { classifyIssue, norm, sectionBodies, SHAPE_SECTIONS } from './classify.js';

export interface DraftProvider {
  name: string;
  complete(prompt: string): Promise<string>;
}

export interface DraftConfig {
  provider?: string;
}

/** Offline stub so the drafting path is testable without any model or network. */
export const localProvider: DraftProvider = {
  name: 'local',
  async complete(prompt: string) {
    const section = prompt.match(/^Section: (.+)$/m)?.[1] ?? 'section';
    return `Proposed text for ${section} (local stub, no model was called).`;
  },
};

/**
 * Sections orca must never write: they are the author's facts or commitments, so
 * a missing one becomes a question. Writing them would fabricate intent.
 */
const QUESTION_ONLY = new Set(
  ['Non-goals', 'Success criteria', 'Repro steps', 'Expected', 'Actual', 'Environment'].map(norm),
);

export const DRAFT_MARKER = '<!-- orca-draft -->';

/**
 * Drafts the missing sections of a non-conforming issue as one comment. Every
 * content line is `[author-stated] <Section> | text` or `[orca-proposed] <Section> | text`.
 * Returns null when the issue is already conforming.
 */
export async function draftMissing(input: {
  issue: { labels: string[]; body: string };
  providers: Record<string, DraftProvider>;
  config: DraftConfig;
}): Promise<string | null> {
  const { issue, providers, config } = input;

  const provider = config.provider
    ? providers[config.provider]
    : undefined;
  if (!config.provider) {
    throw new Error('drafting.provider is not set in the repository config; refusing to send issue text to any model');
  }
  if (!provider) {
    throw new Error(`unknown drafting provider "${config.provider}"`);
  }

  const classification = classifyIssue(issue);
  if (classification.result === 'conforming' || !classification.shape) return null;

  const bodies = sectionBodies(issue.body);
  const lines: string[] = [DRAFT_MARKER];

  for (const name of SHAPE_SECTIONS[classification.shape]) {
    const text = bodies.get(norm(name)) ?? '';
    if (text) {
      for (const l of text.split('\n').map(x => x.trim()).filter(Boolean)) {
        lines.push(`[author-stated] ${name} | ${l}`);
      }
    }
  }

  for (const name of classification.missing) {
    if (QUESTION_ONLY.has(norm(name))) {
      lines.push(`[orca-proposed] ${name} | QUESTION: What are the ${name.toLowerCase()}? The author must answer; orca does not propose this.`);
      continue;
    }
    const reply = await provider.complete(`Section: ${name}\n\nIssue body:\n${issue.body}`);
    for (const l of reply.split('\n').map(x => x.trim()).filter(Boolean)) {
      lines.push(`[orca-proposed] ${name} | ${l}`);
    }
  }

  return lines.join('\n') + '\n';
}

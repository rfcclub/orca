import { parse as parseYaml } from 'yaml';
import type { ActorKind, Actors } from './types.js';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function parseActors(yamlText: string): Actors {
  const raw = (parseYaml(yamlText) ?? {}) as { reviewers?: unknown; agents?: unknown };
  const reviewers = Array.isArray(raw.reviewers) ? raw.reviewers : [];
  const agents = Array.isArray(raw.agents) ? raw.agents : [];

  return {
    reviewers: reviewers.map((r: { login?: unknown; kind?: unknown }) => {
      if (typeof r?.login !== 'string' || !r.login) throw new Error('actors.yaml: reviewer entry needs a login');
      const kind = r.kind ?? 'human';
      if (kind !== 'human' && kind !== 'agent') {
        throw new Error(`actors.yaml: reviewer "${r.login}" has invalid kind "${String(kind)}" (expected human or agent)`);
      }
      return { login: r.login, kind: kind as ActorKind };
    }),
    agents: agents.filter((a): a is string => typeof a === 'string'),
  };
}

export function kindOf(login: string, actors: Actors): ActorKind {
  const reviewer = actors.reviewers.find(r => same(r.login, login));
  if (reviewer) return reviewer.kind;
  if (actors.agents.some(a => same(a, login))) return 'agent';
  return 'human';
}

export type ApprovalDecision = { ok: true } | { ok: false; reason: 'not-reviewer' | 'self-approval' };

/**
 * Pure decision. Authority comes from role data only; comment text is never an input.
 * Four-eyes (design D3): an agent may not approve work it authored; a human may.
 */
export function decideApproval(input: { approver: string; authors: string[]; actors: Actors }): ApprovalDecision {
  const { approver, authors, actors } = input;
  if (!actors.reviewers.some(r => same(r.login, approver))) {
    return { ok: false, reason: 'not-reviewer' };
  }
  if (kindOf(approver, actors) === 'agent' && authors.some(a => same(a, approver))) {
    return { ok: false, reason: 'self-approval' };
  }
  return { ok: true };
}

export type ActorKind = 'human' | 'agent';

export interface Issue {
  number: number;
  author: string;
  labels: string[];
  body: string;
}

export interface Comment {
  id: number;
  author: string;
  body: string;
}

export interface Reviewer {
  login: string;
  kind: ActorKind;
}

/** Project role data, read from `openspec/actors.yaml` on the default branch. */
export interface Actors {
  reviewers: Reviewer[];
  /** Logins that are agents but hold no reviewer role (authors only). */
  agents: string[];
}

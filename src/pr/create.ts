import { authFromEnv, getInstallationToken, type AppAuth } from './auth.js';

export interface CreatePrInput {
  repo: string;
  head: string;
  title: string;
  body?: string;
  base?: string;
  /** Adds "Closes #N" to the PR body so merging closes the intent of record. */
  issue?: number;
  auth?: AppAuth;
}

export interface CreatedPr {
  url: string;
  number: number;
}

/** Creates a pull request as the github-app GitHub App installation. */
export async function createPr(input: CreatePrInput): Promise<CreatedPr> {
  const auth = input.auth ?? authFromEnv();
  const { token } = await getInstallationToken(auth, input.repo);
  const body = input.issue
    ? `${input.body ? input.body + '\n\n' : ''}Closes #${input.issue}`
    : input.body ?? '';
  const res = await fetch(`https://api.github.com/repos/${input.repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'orca-colony',
    },
    body: JSON.stringify({ title: input.title, head: input.head, base: input.base, body }),
  });
  const data = (await res.json()) as { html_url?: string; number?: number; message?: string };
  if (!res.ok || !data.html_url || !data.number) {
    throw new Error(`PR create failed: ${res.status} ${data.message ?? JSON.stringify(data)}`.slice(0, 300));
  }
  return { url: data.html_url, number: data.number };
}

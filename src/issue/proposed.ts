const PROPOSED_RE = /^\s*[-*]\s+\[orca-proposed(?:\s+accepted-by:(\S+))?\]\s*(.+?)\s*$/;

/**
 * Items orca proposed that no reviewer accepted yet, as `Section | text`.
 * An item is accepted when its tag reads `[orca-proposed accepted-by:<login>]`.
 */
export function findUnacceptedProposed(intentMd: string): string[] {
  const out: string[] = [];
  for (const line of intentMd.split('\n')) {
    const m = line.match(PROPOSED_RE);
    if (m && !m[1]) out.push(m[2]);
  }
  return out;
}

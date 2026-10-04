export type Shape = 'bug' | 'enhancement';

export const SHAPE_SECTIONS: Record<Shape, string[]> = {
  bug: ['Repro steps', 'Expected', 'Actual', 'Environment'],
  enhancement: ['Problem', 'Desired outcome', 'Non-goals', 'Constraints', 'Success criteria'],
};

export interface Classification {
  result: 'conforming' | 'non-conforming';
  shape?: Shape;
  missing: string[];
  reason?: string;
}

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Map of normalised heading -> body text, for headings of any level. */
export function sectionBodies(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = body.split('\n');
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current === null) return;
    const text = buf.join('\n').replace(/<!--[\s\S]*?-->/g, '').trim();
    // a repeated heading counts if either occurrence has content
    if (text || !out.has(current)) out.set(current, text || out.get(current) || '');
  };
  for (const line of lines) {
    const h = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (h) {
      flush();
      current = norm(h[1]);
      buf = [];
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

export function classifyIssue(issue: { labels: string[]; body: string }): Classification {
  const isBug = issue.labels.includes('bug');
  const isEnh = issue.labels.includes('enhancement');

  if (isBug && isEnh) {
    return { result: 'non-conforming', missing: [], reason: 'issue carries both shape labels (bug and enhancement)' };
  }
  if (!isBug && !isEnh) {
    return { result: 'non-conforming', missing: [], reason: 'no shape label present (expected bug or enhancement)' };
  }

  const shape: Shape = isBug ? 'bug' : 'enhancement';
  const bodies = sectionBodies(issue.body);
  const missing = SHAPE_SECTIONS[shape].filter(name => !(bodies.get(norm(name)) ?? '').length);

  return missing.length === 0
    ? { result: 'conforming', shape, missing: [] }
    : { result: 'non-conforming', shape, missing, reason: `missing sections: ${missing.join(', ')}` };
}

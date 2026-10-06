import { parseAssertion } from './assertion.js';

export interface Scenario {
  id: string;
  title: string;
  given: string[];
  when: string[];
  then: { text: string; assertion: ReturnType<typeof parseAssertion> }[];
}

export interface Property {
  id: string;
  title: string;
  given: string[];
  then: Scenario['then'];
  runs: number | null;
  maxDiscardRatio?: number;
  coverage: Record<string, number>;
  errors: string[];
}

export interface Requirement {
  title: string;
  strength: 'SHALL' | 'MUST' | 'SHOULD' | 'MAY';
  description: string;
  scenarios: Scenario[];
  properties?: Property[];
}

export interface SpecTree {
  schemaVersion: number;
  title: string;
  purpose: string;
  requirements: Requirement[];
  warnings: string[];
}

const RFC2119 = ['SHALL', 'MUST', 'SHOULD', 'MAY'] as const;
const MAX_SCHEMA_VERSION = 1;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function parseSpec(markdown: string): SpecTree {
  const warnings: string[] = [];
  let schemaVersion = 1;

  // Check schema_version line
  const versionMatch = markdown.match(/^schema_version:\s*(\d+)/m);
  if (versionMatch) {
    schemaVersion = parseInt(versionMatch[1], 10);
    if (schemaVersion > MAX_SCHEMA_VERSION) {
      warnings.push(`spec uses schema v${schemaVersion}, Orca supports up to v${MAX_SCHEMA_VERSION}`);
    }
  }

  // Extract title
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].replace(/\s+Specification$/, '') : '';

  // Extract purpose
  const purposeMatch = markdown.match(/^##\s+Purpose\s*\n([\s\S]*?)(?=\n##\s)/m);
  const purpose = purposeMatch ? purposeMatch[1].trim() : '';

  // Extract requirements
  const requirements: Requirement[] = [];

  // Split by requirement headers
  const parts = markdown.split(/^###\s+Requirement:\s+/m).slice(1);

  for (const part of parts) {
    const firstLine = part.split('\n')[0];
    const reqTitle = firstLine.trim();
    const body = part.split('\n').slice(1).join('\n');

    // Extract description (text before first scenario)
    const descPart = body.split(/^####\s+(?:Scenario|Property):/m)[0].trim();
    const description = descPart;

    // Determine RFC 2119 strength
    let strength: Requirement['strength'] = 'SHALL';
    for (const kw of RFC2119) {
      if (description.includes(kw)) {
        strength = kw;
        break;
      }
    }
    if (!RFC2119.some(kw => description.includes(kw))) {
      warnings.push(`requirement "${reqTitle}" lacks RFC 2119 keyword, treating as SHALL`);
    }

    // Extract scenarios
    const scenarios: Scenario[] = [];
    const properties: Property[] = [];
    const blocks = body.split(/^####\s+(Scenario|Property):\s+/m);
    for (let index = 1; index < blocks.length; index += 2) {
      const scPart = blocks[index + 1];
      const scTitle = scPart.split('\n')[0].trim();
      const scBody = scPart.split('\n').slice(1).join('\n');
      if (blocks[index] === 'Property') {
        properties.push(parseProperty(reqTitle, scTitle, scBody));
        continue;
      }

      const given: string[] = [];
      const when: string[] = [];
      const then: Scenario['then'] = [];

      const lines = scBody.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();

        // Bold format: - **GIVEN** / - **WHEN** / - **THEN** / - **AND**
        // Plain format: - GIVEN / - WHEN / - THEN / - AND
        if (trimmed.match(/^- \*\*GIVEN\*\*/) || trimmed.match(/^- GIVEN\b/)) {
          const content = trimmed.replace(/^- \*\*GIVEN\*\*\s*/, '').replace(/^- GIVEN\s*/, '');
          given.push(content);
        } else if (trimmed.match(/^- \*\*WHEN\*\*/) || trimmed.match(/^- WHEN\b/)) {
          const content = trimmed.replace(/^- \*\*WHEN\*\*\s*/, '').replace(/^- WHEN\s*/, '');
          when.push(content);
        } else if (trimmed.match(/^- \*\*AND\*\*/) || trimmed.match(/^- AND\b/)) {
          const content = trimmed.replace(/^- \*\*AND\*\*\s*/, '').replace(/^- AND\s*/, '');
          // AND follows GIVEN, WHEN, or THEN (whichever was last)
          if (then.length > 0) {
            then.push({ text: content, assertion: parseAssertion(content) });
          } else if (when.length > 0) {
            when.push(content);
          } else {
            given.push(content);
          }
        } else if (trimmed.match(/^- \*\*THEN\*\*/) || trimmed.match(/^- THEN\b/)) {
          const content = trimmed.replace(/^- \*\*THEN\*\*\s*/, '').replace(/^- THEN\s*/, '');
          then.push({ text: content, assertion: parseAssertion(content) });
        }
      }

      const id = slugify(`${reqTitle} ${scTitle}`);
      scenarios.push({ id, title: scTitle, given, when, then });
    }

    requirements.push({ title: reqTitle, strength, description, scenarios,
      ...(properties.length ? { properties } : {}) });
  }

  return { schemaVersion, title, purpose, requirements, warnings };
}

function parseProperty(requirement: string, title: string, body: string): Property {
  const property: Property = { id: slugify(`${requirement} ${title}`), title,
    given: [], then: [], runs: null, coverage: {}, errors: [] };
  let forAll = 0;
  let runClauses = 0;
  let discardClauses = 0;
  for (const line of body.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    const match = /^-\s+(?:\*\*(FOR ALL|AND|THEN|RUNS|DISCARDS|COVERAGE)\*\*|(FOR ALL|AND|THEN|RUNS|DISCARDS|COVERAGE))\s+(.+)$/.exec(text);
    if (!match) { property.errors.push(`unsupported clause: ${text}`); continue; }
    const clause = match[1] ?? match[2];
    const value = match[3].trim();
    if (clause === 'FOR ALL') { forAll++; property.given.push(value); }
    else if (clause === 'AND') {
      if (!forAll) property.errors.push('AND before FOR ALL');
      if (property.then.length) property.then.push({ text: value, assertion: parseAssertion(value) });
      else property.given.push(value);
    } else if (clause === 'THEN') property.then.push({ text: value, assertion: parseAssertion(value) });
    else if (clause === 'RUNS') {
      runClauses++;
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) property.errors.push('RUNS must be a positive safe integer');
      else property.runs = Number(value);
    } else if (clause === 'DISCARDS') {
      discardClauses++;
      const ratio = /^<=\s*(\d+(?:\.\d+)?)%$/.exec(value);
      if (!ratio || Number(ratio[1]) >= 100) property.errors.push('DISCARDS must be <= a percentage below 100%');
      else property.maxDiscardRatio = Number(ratio[1]) / 100;
    } else {
      const coverage = /^(.+?)\s+>=\s*(\d+(?:\.\d+)?)%$/.exec(value);
      if (!coverage || Number(coverage[2]) > 100 || coverage[1] in property.coverage) property.errors.push('invalid or duplicate COVERAGE category');
      else property.coverage[coverage[1]] = Number(coverage[2]) / 100;
    }
  }
  if (forAll !== 1) property.errors.push('requires exactly one FOR ALL clause');
  if (!property.then.length) property.errors.push('missing THEN clause');
  if (runClauses !== 1) property.errors.push('requires exactly one RUNS clause');
  if (discardClauses > 1) property.errors.push('duplicate DISCARDS clause');
  return property;
}

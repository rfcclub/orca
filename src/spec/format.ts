import type { SpecTree } from '../spec/parser.js';

export function formatSpec(spec: SpecTree): string {
  const parts: string[] = [];

  if (spec.title) {
    parts.push(`# ${spec.title} Specification`);
    parts.push('');
  }

  if (spec.purpose) {
    parts.push('## Purpose');
    parts.push('');
    parts.push(spec.purpose);
    parts.push('');
  }

  parts.push('## Requirements');
  parts.push('');

  for (const req of spec.requirements) {
    parts.push(`### Requirement: ${req.title}`);
    parts.push('');
    parts.push(req.description);
    parts.push('');

    for (const sc of req.scenarios) {
      parts.push(`#### Scenario: ${sc.title}`);
      parts.push('');

      for (const given of sc.given) {
        parts.push(`- **GIVEN** ${given}`);
      }
      for (const when of sc.when) {
        parts.push(`- **WHEN** ${when}`);
      }
      for (const then of sc.then) {
        parts.push(`- **THEN** ${then.text}`);
      }
      parts.push('');
    }
    for (const property of req.properties ?? []) {
      parts.push(`#### Property: ${property.title}`, '');
      for (let index = 0; index < property.given.length; index++) {
        parts.push(`- **${index ? 'AND' : 'FOR ALL'}** ${property.given[index]}`);
      }
      for (const relation of property.then) parts.push(`- **THEN** ${relation.text}`);
      if (property.runs !== null) parts.push(`- **RUNS** ${property.runs}`);
      if (property.maxDiscardRatio !== undefined) parts.push(`- **DISCARDS** <= ${property.maxDiscardRatio * 100}%`);
      for (const [category, ratio] of Object.entries(property.coverage)) {
        parts.push(`- **COVERAGE** ${category} >= ${ratio * 100}%`);
      }
      parts.push('');
    }
  }

  return parts.join('\n');
}

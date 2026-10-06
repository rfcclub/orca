import { expect, it } from 'vitest';
import { parseSpec } from '../src/spec/parser.js';
import { formatSpec } from '../src/spec/format.js';
import { validateSpec } from '../src/spec/validator.js';
import { parseDeltaSpec, mergeSpecs } from '../src/spec/delta.js';

const property = `#### Property: future-independence
- **FOR ALL** bars: valid prices with gaps and halts
- **AND** tail: future bars
- **THEN** signals through t remain equal
- **RUNS** 1000
- **DISCARDS** <= 90%
- **COVERAGE** gap >= 5%
- **COVERAGE** halt >= 2%
`;
const req = `### Requirement: No lookahead
The strategy MUST NOT use future data.
`;
const mixed = `# Trading Specification
## Purpose
Detect future-data dependency.
## Requirements
${req}#### Scenario: before
- **WHEN** a bar arrives
- **THEN** use known data
${property}#### Scenario: after
- **GIVEN** a halt
- **WHEN** trading resumes
- **THEN** preserve alignment
`;

it('mixed Property/Scenario ordering retains independent clauses and stable IDs', () => {
  const r = parseSpec(mixed).requirements[0];
  expect(r.description).toBe('The strategy MUST NOT use future data.');
  expect(r.scenarios.map(s => [s.id, s.then.map(t => t.text)])).toEqual([
    ['no-lookahead-before', ['use known data']],
    ['no-lookahead-after', ['preserve alignment']],
  ]);
  expect(r.properties).toEqual([expect.objectContaining({
    id: 'no-lookahead-future-independence', title: 'future-independence',
    given: ['bars: valid prices with gaps and halts', 'tail: future bars'],
    then: [{ text: 'signals through t remain equal', assertion: expect.anything() }],
    runs: 1000, maxDiscardRatio: 0.9, coverage: { gap: 0.05, halt: 0.02 },
  })]);
});

it('Property format and delta archive roundtrip retain execution clauses', () => {
  const parsed = parseSpec(mixed);
  expect(parseSpec(formatSpec(parsed))).toEqual(parsed);
  const delta = parseDeltaSpec('## ADDED Requirements\n' + req + property);
  const merged = mergeSpecs(parseSpec('# Trading Specification\n## Requirements\n'), delta);
  expect(parseSpec(formatSpec(merged)).requirements[0].properties).toEqual(parsed.requirements[0].properties);
});

it.each([
  ['missing FOR ALL', property.replace(/- \*\*FOR ALL\*\*.*\n/, '')],
  ['missing THEN', property.replace(/- \*\*THEN\*\*.*\n/, '')],
  ['missing RUNS', property.replace(/- \*\*RUNS\*\*.*\n/, '')],
  ['invalid RUNS', property.replace('1000', '1.5')],
  ['negative RUNS', property.replace('1000', '-2')],
  ['duplicate RUNS', property + '- **RUNS** 2000\n'],
  ['invalid category', property.replace('gap >= 5%', 'gap >= 105%')],
])('invalid Property grammar rejects %s before execution', (_name, body) => {
  const result = validateSpec(req + body);
  expect(result.valid).toBe(false);
  expect(result.errors.join(' ')).toMatch(/property/i);
});

it('duplicate IDs across Scenario and Property cannot alias one executed assertion', () => {
  const result = validateSpec(req + property + '#### Scenario: future-independence\n- **WHEN** x\n- **THEN** y\n');
  expect(result.valid).toBe(false);
  expect(result.errors.join(' ')).toMatch(/duplicate/i);
});

it('legacy plain clauses and AND semantics remain compatible', () => {
  const r = parseSpec(req + '#### Scenario: legacy\n- GIVEN A\n- AND B\n- WHEN C\n- AND D\n- THEN E\n- AND F\n').requirements[0];
  expect(r.scenarios[0].given).toEqual(['A', 'B']);
  expect(r.scenarios[0].when).toEqual(['C', 'D']);
  expect(r.scenarios[0].then.map(t => t.text)).toEqual(['E', 'F']);
  expect(r.properties ?? []).toEqual([]);
});

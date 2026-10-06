import { parseSpec } from './parser.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateSpec(markdown: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check Purpose section (warning, not error — merged living specs may omit it)
  if (!markdown.includes('## Purpose')) {
    warnings.push('spec missing recommended section: Purpose');
  }

  // Check for OR in scenarios (both bold and plain format)
  const orMatch = markdown.match(/^- \*\*(WHEN|THEN)\*\*.*\bOR\b/gm);
  const orPlainMatch = markdown.match(/^- (WHEN|THEN)\b.*\bOR\b/gm);
  if (orMatch || orPlainMatch) {
    errors.push('OR not supported in scenarios, split into separate scenarios');
  }

  // Parse to check deeper
  const spec = parseSpec(markdown);
  warnings.push(...spec.warnings);

  // Check each scenario has THEN
  const ids = new Set<string>();
  for (const req of spec.requirements) {
    for (const block of [...req.scenarios, ...(req.properties ?? [])]) {
      if (ids.has(block.id)) errors.push(`duplicate scenario/property ID "${block.id}"`);
      ids.add(block.id);
    }
    for (const scenario of req.scenarios) {
      if (scenario.then.length === 0) {
        errors.push(`scenario "${scenario.id}" missing THEN clause`);
      }
    }
    for (const property of req.properties ?? []) {
      errors.push(...property.errors.map(error => `property "${property.id}": ${error}`));
    }
  }

  // Check schema version
  if (spec.schemaVersion > 1) {
    warnings.push(`spec uses schema v${spec.schemaVersion}, Orca supports up to v1`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { findChangeSpecFiles } from '../cli/utils.js';
import { parseSpec } from '../spec/parser.js';
import { findUnacceptedProposed } from '../issue/proposed.js';
import { executeTests, hashBytes, selectedFile, sourceBinding, validateExecutionReceipt,
  type ExecutionReceipt, type TestSelection } from './execution.js';
import { replayTests } from './replay.js';

const mappingSchema = z.object({
  scenario: z.string().min(1), test: z.string().min(1).optional(),
  assertion: z.string().min(1).optional(), status: z.string().optional(),
});

/** Derive requirements from current files rather than a cached assertion list. */
export function readTestContract(root: string, changeDir: string, name: string) {
  const specFiles = findChangeSpecFiles(changeDir, name);
  if (!specFiles.length) throw new Error('No spec.md found');
  const mandatory: string[] = [];
  const defaults: Record<string, string> = {};
  const inputs: Record<string, string | null> = {};
  for (const specFile of specFiles) {
    const text = readFileSync(specFile, 'utf8');
    inputs[relative(root, specFile)] = hashBytes(text);
    if (/^####\s+Property:/m.test(text)) throw new Error('Property execution is unsupported until the shared property adapter is installed');
    for (const req of parseSpec(text).requirements) {
      if (req.strength !== 'SHALL' && req.strength !== 'MUST') continue;
      for (const sc of req.scenarios) {
        if (mandatory.includes(sc.id)) throw new Error(`Duplicate required scenario ID: ${sc.id}`);
        mandatory.push(sc.id);
        defaults[sc.id] = `tests/${name}/${basename(dirname(specFile))}/${sc.id}.test.ts`;
      }
    }
  }
  const mappings = new Map<string, TestSelection>();
  const bookkeepingPassing: string[] = [];
  const trace = join(changeDir, '.traceability.yaml');
  inputs[relative(root, trace)] = existsSync(trace) ? hashBytes(readFileSync(trace)) : null;
  if (existsSync(trace)) {
    const data = z.object({ scenarios: z.array(z.unknown()).optional(), mappings: z.array(z.unknown()).optional() })
      .parse(parseYaml(readFileSync(trace, 'utf8')));
    const entries = data.scenarios ?? data.mappings;
    if (!entries) throw new Error('Traceability needs a scenarios or mappings array');
    for (const raw of entries) {
      const entry = mappingSchema.parse(raw);
      if (!mandatory.includes(entry.scenario)) continue;
      if (mappings.has(entry.scenario)) throw new Error(`Duplicate mapping: ${entry.scenario}`);
      mappings.set(entry.scenario, { id: entry.scenario, test: entry.test ?? defaults[entry.scenario],
        ...(entry.assertion ? { assertion: entry.assertion } : {}) });
      if (entry.status === 'passing') bookkeepingPassing.push(entry.scenario);
    }
  }
  const intent = join(changeDir, 'intent.md');
  inputs[relative(root, intent)] = existsSync(intent) ? hashBytes(readFileSync(intent)) : null;
  return { mandatory, inputs, bookkeepingPassing,
    selection: mandatory.map(id => mappings.get(id) ?? { id, test: defaults[id] }) };
}

const receiptSchema = z.object({
  version: z.literal(1), mode: z.literal('executable'), change: z.string(),
  passed: z.literal(true), execution_verified: z.literal(true),
  inputs: z.record(z.string(), z.string().nullable()),
  execution: z.unknown(),
  replay: z.object({
    passed: z.literal(true), base_revision: z.string().regex(/^[a-f0-9]{40,64}$/),
    setup: z.object({ harness: z.record(z.string(), z.string()) }),
  }).nullable(),
});

/** Cached flags are insufficient: validate freshness and execute the current contract again. */
export function checkChangeEvidence(root: string, changeDir: string, name: string, opts: { execute?: boolean } = {}): { valid: boolean; reasons: string[] } {
  try {
    const receipt = receiptSchema.parse(JSON.parse(readFileSync(join(changeDir, '.orca-verify.json'), 'utf8')));
    const current = readTestContract(root, changeDir, name);
    const execution = receipt.execution as ExecutionReceipt;
    if (receipt.change !== name || !validateExecutionReceipt(root, execution) || execution.outcome !== 'green' ||
        JSON.stringify(current.inputs) !== JSON.stringify(receipt.inputs) ||
        JSON.stringify(current.selection) !== JSON.stringify(execution.selection) ||
        JSON.stringify(sourceBinding(root)) !== JSON.stringify(execution.source) ||
        current.selection.some(s => execution.tests[s.test] !== hashBytes(readFileSync(selectedFile(root, s.test))))) {
      throw new Error('Executable verification receipt is stale or invalid');
    }
    const packagePath = createRequire(join(root, 'package.json')).resolve('vitest/package.json');
    const runner = realpathSync(join(dirname(packagePath), 'vitest.mjs'));
    if (runner !== execution.runner.entry || hashBytes(readFileSync(runner)) !== execution.runner.sha256 ||
        JSON.parse(readFileSync(packagePath, 'utf8')).version !== execution.runner.version ||
        process.version !== execution.runner.node_version) throw new Error('Runner binding changed');
    const intent = join(changeDir, 'intent.md');
    if (existsSync(intent) && findUnacceptedProposed(readFileSync(intent, 'utf8')).length) throw new Error('Unaccepted proposed intent criteria');
    if (receipt.replay && opts.execute !== false) {
      const harness = Object.entries(receipt.replay.setup.harness);
      if (harness.some(([path, hash]) => hashBytes(readFileSync(selectedFile(root, path))) !== hash)) {
        throw new Error('Replay harness changed');
      }
      const replay = replayTests(root, receipt.replay.base_revision, current.selection, harness.map(([path]) => path));
      if (!replay.passed) throw new Error(`Replay failed: ${replay.reasons.join('; ')}`);
    } else if (!receipt.replay && opts.execute !== false) {
      const rerun = executeTests(root, current.selection);
      if (rerun.outcome !== 'green') throw new Error(`Execution did not establish GREEN: ${rerun.reasons.join('; ')}`);
    }
    if (JSON.stringify(readTestContract(root, changeDir, name).inputs) !== JSON.stringify(current.inputs)) {
      throw new Error('Verification input changed during acceptance execution');
    }
    return { valid: true, reasons: [] };
  } catch (error) {
    return { valid: false, reasons: [(error as Error).message] };
  }
}

import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { hashBytes, selectedFile, sourceBinding, type ExecutionReceipt, type TestSelection } from './execution.js';

type Evidence = Pick<ExecutionReceipt, 'assertions' | 'reasons' | 'outcome'>;

/** The bun binary on PATH (or ORCA_BUN, which must be absolute), resolved to its real file. */
export function bunBinary(): string {
  const given = process.env.ORCA_BUN;
  if (given !== undefined && !isAbsolute(given)) throw new Error('ORCA_BUN must be an absolute path');
  const candidates = given ? [given] : (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(dir => join(dir, 'bun'));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
  }
  throw new Error('bun binary not found on PATH (set ORCA_BUN)');
}

// Wraps every matcher of expect(x) and expect(x).not so that a failing expectation carries the run's nonce.
// Bun's JUnit marks every failure "AssertionError" and gives no message, so the nonce is what tells an
// assertion failure from any other error in the (fail) block Bun prints.
const preloadSource = (mark: string) => `import { expect } from 'bun:test';
const mark = ${JSON.stringify(mark)};
const tag = error => { if (error instanceof Error && !String(error.message).startsWith(mark)) error.message = mark + ' ' + error.message; };
const seen = new Set();
const wrap = proto => {
  if (!proto || seen.has(proto)) return;
  seen.add(proto);
  for (const key of Object.getOwnPropertyNames(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, key);
    if (!d || typeof d.value !== 'function' || key === 'constructor') continue;
    const matcher = d.value;
    Object.defineProperty(proto, key, { ...d, value: function (...args) {
      try {
        const out = matcher.apply(this, args);
        return out && typeof out.then === 'function' ? out.then(v => v, e => { tag(e); throw e; }) : out;
      } catch (e) { tag(e); throw e; }
    } });
  }
};
const probe = expect(0);
wrap(Object.getPrototypeOf(probe));
wrap(Object.getPrototypeOf(probe.not));
`;

interface XmlNode { name: string; attrs: Record<string, string>; children: XmlNode[] }
const ELEMENTS = new Set(['testsuites', 'testsuite', 'testcase', 'failure', 'skipped', 'error']);

const decode = (text: string) => text.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]);

/** A strict reader for the JUnit Bun writes: known elements, attributes, whitespace. Anything else throws. */
function parseJunit(xml: string): XmlNode {
  const source = xml.replace(/^\s*<\?xml[^?]*\?>/, '');
  const token = /\s*(?:<(\/?)([A-Za-z][\w-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>)/y;
  const root: XmlNode = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  let at = 0;
  while (at < source.length) {
    if (/^\s*$/.test(source.slice(at))) break;
    token.lastIndex = at;
    const m = token.exec(source);
    if (!m) throw new Error(`unexpected JUnit content at ${at}`);
    at = token.lastIndex;
    const [, closing, name, attrText, selfClosing] = m;
    if (!ELEMENTS.has(name)) throw new Error(`unknown JUnit element <${name}>`);
    if (closing) {
      if (stack.length < 2 || stack[stack.length - 1].name !== name) throw new Error(`unbalanced JUnit </${name}>`);
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of attrText.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
    const node: XmlNode = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1 || root.children.length !== 1 || root.children[0].name !== 'testsuites') throw new Error('malformed JUnit report');
  return root.children[0];
}

interface BunCase { file: string; fullName: string; status: 'passed' | 'failed' | 'skipped'; assertions: number }

function casesOf(suites: XmlNode): BunCase[] {
  const out: BunCase[] = [];
  const walk = (node: XmlNode, describes: string[], file: string | null) => {
    for (const child of node.children) {
      if (child.name === 'testsuite') {
        // The first level is the file's suite; nested suites are describe blocks.
        walk(child, file === null ? [] : [...describes, child.attrs.name ?? ''], child.attrs.file ?? file);
      } else if (child.name === 'testcase') {
        const kinds = child.children.map(c => c.name);
        out.push({
          file: child.attrs.file ?? file ?? '',
          fullName: [...describes, child.attrs.name ?? ''].join(' > '),
          status: kinds.includes('failure') || kinds.includes('error') ? 'failed' : kinds.includes('skipped') ? 'skipped' : 'passed',
          assertions: Number(child.attrs.assertions ?? 'NaN'),
        });
      }
    }
  };
  walk(suites, [], null);
  return out;
}

/** (fail) blocks of Bun's stderr, keyed by file and full name. A block runs from the previous result line or file header. */
function failBlocks(stderr: string, files: string[], mark: string): Map<string, { marked: boolean; failures: string[] }> {
  const headers = new Set(files.map(f => `${f}:`));
  const blocks = new Map<string, { marked: boolean; failures: string[] }>();
  let file = '';
  let block: string[] = [];
  for (const line of stderr.split('\n')) {
    if (headers.has(line.trim())) { file = line.trim().slice(0, -1); block = []; continue; }
    const result = /^\((pass|fail|skip|todo)\) (.*?)(?: \[[\d.]+m?s\])?$/.exec(line);
    if (!result) { block.push(line); continue; }
    if (result[1] === 'fail') {
      const marked = block.find(l => l.includes(mark));
      const plain = block.find(l => /^(error: |[A-Za-z]*Error\b)/.test(l.trim()));
      const failures = marked !== undefined
        ? [`AssertionError: ${marked.replace(mark, '').replace(/^\s*error:\s*/, '').trim()}`]
        : [plain?.trim() ?? 'failure without an error line'];
      blocks.set(`${file}\0${result[2]}`, { marked: marked !== undefined, failures });
    }
    block = [];
  }
  return blocks;
}

const reportSchema = z.object({ junit: z.string(), stderr: z.string(), mark: z.string().regex(/^ORCA-ASSERT-[0-9a-f-]{36}$/) });

/** Evidence from a Bun receipt's report; the same rules as Vitest's, with RED told apart by the nonce. */
export function bunEvidence(root: string, selection: TestSelection[], report: string, exitCode: number | null): Evidence {
  const reasons: string[] = [];
  const assertions: ExecutionReceipt['assertions'] = [];
  let green = false;
  let red = false;
  try {
    const { junit, stderr, mark } = reportSchema.parse(JSON.parse(report));
    const suites = parseJunit(junit);
    const cases = casesOf(suites);
    const failedTotal = cases.filter(c => c.status === 'failed').length;
    if (Number(suites.attrs.tests) !== cases.length || Number(suites.attrs.failures) !== failedTotal) {
      reasons.push('Reporter assertion totals are inconsistent');
    }
    if (/Unhandled error/.test(stderr)) reasons.push('Bun reported an unhandled error outside a test');
    const blocks = failBlocks(stderr, [...new Set(cases.map(c => c.file))], mark);
    const passedSelected: string[] = [];
    for (const selected of selection) {
      const file = selectedFile(root, selected.test);
      const matches = cases.filter(c => existsSync(resolve(root, c.file)) && realpathSync(resolve(root, c.file)) === file)
        .filter(c => selected.assertion ? c.fullName === selected.assertion : c.fullName.includes(`[${selected.id}]`));
      if (matches.length !== 1) {
        reasons.push(`Expected exactly one executed assertion for ${selected.id}; found ${matches.length}`);
        continue;
      }
      const [match] = matches;
      const block = blocks.get(`${match.file}\0${match.fullName}`);
      if (match.status === 'passed') {
        if (!(match.assertions > 0)) reasons.push(`${selected.id} passed but ran no assertion`);
        passedSelected.push(selected.id);
      }
      assertions.push({ id: selected.id, test: selected.test, name: match.fullName, status: match.status,
        failures: match.status === 'failed' ? block?.failures ?? ['failure without a (fail) block'] : [] });
    }
    if (new Set(assertions.map(a => `${selectedFile(root, a.test)}\0${a.name}`)).size !== assertions.length) {
      reasons.push('An executed assertion was reused for multiple required IDs');
    }
    green = exitCode === 0 && failedTotal === 0 && assertions.length === selection.length &&
      assertions.every(a => a.status === 'passed');
    const failed = assertions.filter(a => a.status === 'failed');
    red = exitCode === 1 && assertions.length === selection.length &&
      assertions.every(a => a.status === 'passed' || a.status === 'failed') &&
      failed.length > 0 && failed.length === failedTotal &&
      failed.every(a => a.failures.length > 0 && a.failures.every(f => /^AssertionError\b/.test(f)));
    if (!green && !red) reasons.push('Required assertions did not establish GREEN or assertion-failure RED');
  } catch (error) {
    reasons.push(`Missing or invalid Bun report: ${(error as Error).message}`);
  }
  return { assertions, reasons, outcome: reasons.length === 0 ? green ? 'green' : red ? 'red' : 'inconclusive' : 'inconclusive' };
}

/** The identity a Bun receipt binds: the binary's real path, sha256 and `bun --version`. */
export function bunRunnerIdentity(): { entry: string; sha256: string; version: string } {
  const entry = bunBinary();
  return { entry, sha256: hashBytes(readFileSync(entry)), version: execFileSync(entry, ['--version'], { encoding: 'utf8' }).trim() };
}

/** Runs the selected bun:test files directly (no shell) and builds a receipt like executeTests' Vitest path. */
export function executeBunTests(root: string, selection: TestSelection[]): ExecutionReceipt {
  if (selection.some(s => s.property)) throw new Error('property receipts are not supported for tdd.framework bun');
  const tests = Object.fromEntries(selection.map(s => [s.test, hashBytes(readFileSync(selectedFile(root, s.test)))]));
  const runner = { ...bunRunnerIdentity(), node_version: process.version, framework: 'bun' as const };
  const entry = runner.entry;
  const source = sourceBinding(root);
  const base = realpathSync(root);
  const temp = mkdtempSync(join(tmpdir(), 'orca-bun-'));
  const mark = `ORCA-ASSERT-${randomUUID()}`;
  const preload = join(temp, 'orca-preload.js');
  const output = join(temp, 'report.xml');
  writeFileSync(preload, preloadSource(mark));
  // `bun test <arg>` treats a bare argument as a substring filter; a ./ path names exactly one file.
  const files = [...new Set(selection.map(s => `./${relative(base, selectedFile(root, s.test))}`))];
  const args = ['test', ...files, '--preload', preload, '--reporter=junit', `--reporter-outfile=${output}`];
  const started_at = new Date().toISOString();
  try {
    const run = spawnSync(entry, args, { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: 'true' } });
    const report = JSON.stringify({ junit: existsSync(output) ? readFileSync(output, 'utf8') : '', stderr: run.stderr ?? '', mark });
    const reasons: string[] = [];
    if (run.error) reasons.push(`Runner failed: ${run.error.message}`);
    const evidence = bunEvidence(root, selection, report, run.status);
    reasons.push(...evidence.reasons);
    if (JSON.stringify(sourceBinding(root)) !== JSON.stringify(source) ||
        selection.some(s => hashBytes(readFileSync(selectedFile(root, s.test))) !== tests[s.test]) ||
        hashBytes(readFileSync(entry)) !== runner.sha256) reasons.push('Execution inputs changed while the runner was running');
    return { version: 1, outcome: reasons.length === 0 ? evidence.outcome : 'inconclusive',
      source, tests, runner, selection, command: { executable: entry, args, exit_code: run.status,
        stdout: run.stdout ?? '', stderr: run.stderr ?? '' }, report, report_sha256: hashBytes(report),
      assertions: evidence.assertions, reasons, started_at, finished_at: new Date().toISOString() };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

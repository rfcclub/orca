import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { getChangeDir, getProjectRoot, changeExists, listChanges, findChangeSpecFiles } from '../utils.js';
import { calculateCoverage } from '../../tdd/traceability.js';
import { TransitionGuard } from '../../harness/transition-guard.js';
import { findUnacceptedProposed } from '../../issue/proposed.js';
import { VERIFY_FILE } from '../../legacy.js';
import { hasApprovalRecord } from '../../harness/gate-plan.js';
import { executeTests, hashBytes, type ExecutionReceipt, type TestSelection } from '../../verify/execution.js';
import { replayTests, type ReplayReceipt } from '../../verify/replay.js';
import { readTestContract } from '../../verify/change.js';

export interface VerifyOptions {
  skip?: boolean;
  expected?: 'green' | 'red';
  coverageOnly?: boolean;
  base?: string;
  harness?: string[];
}

export function cmdVerify(name?: string, opts: VerifyOptions = {}): void {
  const changes = name ? [name] : listChanges();

  if (changes.length === 0) {
    console.log('No changes to verify.');
    return;
  }

  for (const changeName of changes) {
    if (!changeExists(changeName) && name) {
      console.error(`✗  Change "${changeName}" not found.`);
      process.exitCode = 1;
      continue;
    }

    // Bulk verification inventories pending intent work without certifying it.
    // Explicit selection and approved/malformed executable work remain fail-closed.
    const dir = getChangeDir(changeName);
    const intentFile = join(dir, 'intent.md');
    if (!name && !findChangeSpecFiles(dir, changeName).length && existsSync(intentFile) &&
        !['proposal.md', 'design.md', 'tasks.md', 'plan.json'].some(file => existsSync(join(dir, file)))) {
      const intent = readFileSync(intentFile, 'utf8');
      if (/^Status:\s*DRAFT\b/m.test(intent) && !hasApprovalRecord(intent)) {
        console.log(`SKIP ${changeName}: unapproved intent-only draft (pending, not verified)`);
        continue;
      }
    }
    if (!verifyChange(changeName, opts)) process.exitCode = 1;
  }
}

function verifyChange(name: string, opts: VerifyOptions): boolean {
  const { skip = false, expected = 'green', coverageOnly = false, base, harness = [] } = opts;
  const changeDir = getChangeDir(name);
  const root = getProjectRoot();
  let mandatoryScenarios: string[] = [];
  let selection: TestSelection[] = [];
  let inputs: Record<string, string | null> = {};
  const reasons: string[] = [];
  let bookkeepingPassing: string[] = [];
  let execution: ExecutionReceipt | null = null;
  let replay: ReplayReceipt | null = null;

  try {
    if (coverageOnly && base) throw new Error('--coverage-only cannot be combined with --base');
    if (harness.length && !base) throw new Error('--harness requires --base');
    new TransitionGuard(changeDir).canEnter(expected === 'red' ? 'apply' : 'verify', skip);
    const contract = readTestContract(root, changeDir, name);
    mandatoryScenarios = contract.mandatory;
    selection = contract.selection;
    inputs = contract.inputs;
    bookkeepingPassing = contract.bookkeepingPassing;
    if (!coverageOnly) {
      if (base) {
        replay = replayTests(root, base, selection, harness);
        execution = replay.head;
        reasons.push(...replay.reasons);
      } else execution = executeTests(root, selection);
      reasons.push(...execution.reasons);
      for (const [path, digest] of Object.entries(inputs)) {
        const current = existsSync(join(root, path)) ? hashBytes(readFileSync(join(root, path))) : null;
        if (current !== digest) reasons.push(`Verification input changed during execution: ${path}`);
      }
    }
  } catch (error) {
    reasons.push((error as Error).message);
  }

  const passingTests = coverageOnly ? bookkeepingPassing : execution?.outcome === 'green' ? execution.assertions.map(a => a.id) : [];
  const result = calculateCoverage(mandatoryScenarios, passingTests, 100);

  // orca-proposed items count toward the gate only once a reviewer accepted them.
  const intentPath = join(changeDir, 'intent.md');
  const unaccepted = existsSync(intentPath) ? findUnacceptedProposed(readFileSync(intentPath, 'utf-8')) : [];
  const passed = (coverageOnly || execution?.outcome === 'green') && (!replay || replay.passed) &&
    result.passes && reasons.length === 0 && unaccepted.length === 0;
  const redRecorded = expected === 'red' && execution?.outcome === 'red' && reasons.length === 0 && unaccepted.length === 0;

  const verifyResult = {
    version: 1,
    mode: coverageOnly ? 'coverage-only' : 'executable',
    change: name,
    timestamp: new Date().toISOString(),
    total_scenarios: mandatoryScenarios.length,
    passing: passingTests.length,
    coverage: result.coverage,
    threshold: 100,
    passed: expected === 'green' && passed,
    execution_verified: !coverageOnly && expected === 'green' && passed,
    ...(expected === 'red' ? { red_recorded: redRecorded } : {}),
    execution,
    replay,
    inputs,
    reasons,
    uncovered: result.uncovered,
    ...(unaccepted.length > 0 ? { unaccepted } : {}),
  };

  const verifyPath = join(changeDir, expected === 'red' ? '.orca-red.json' : VERIFY_FILE);
  writeFileSync(verifyPath, JSON.stringify(verifyResult, null, 2), 'utf-8');

  const accepted = expected === 'red' ? redRecorded : passed;
  const icon = accepted ? '✓' : '✗';
  console.log(`\n${icon} ${name}`);
  console.log(`  Coverage: ${(result.coverage * 100).toFixed(0)}% (${passingTests.length}/${mandatoryScenarios.length})`);
  if (result.uncovered.length > 0) {
    console.log(`  Uncovered: ${result.uncovered.join(', ')}`);
  }
  if (unaccepted.length > 0) {
    console.log(`  Unaccepted orca-proposed items: ${unaccepted.join('; ')}`);
  }
  for (const reason of reasons) console.log(`  Evidence: ${reason}`);
  console.log(`  Verdict: ${redRecorded ? 'RED_RECORDED' : expected === 'green' && passed ? coverageOnly ? 'COVERAGE_ONLY_PASS (no tests executed)' : 'PASS' : 'FAIL'}`);
  return accepted;
}

export { findChangeSpecFiles };

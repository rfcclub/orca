import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { basename, join, resolve } from 'path'
import { parseSelfCheck } from './self-check.js'
import { readPhaseJson, recordGateVerdict, sha256String } from './phase-json.js'
import { readPlanJson } from './plan-json.js'
import { TransitionGuard } from './transition-guard.js'
import { reviewedCodeDiff, reviewedCodeFiles } from './code-diff.js'
import { selectTestEvidence } from './test-evidence.js'
import { parseSpec } from '../spec/parser.js'
import { createPropertySealBridge } from './property-seal.js'
import { normalizeGateVerdict, type GateVerdict, type VerdictEntry } from './types.js'
import { executeTests, sourceBinding, validateExecutionReceipt, type ExecutionReceipt } from '../verify/execution.js'
import { readTestContract } from '../verify/change.js'
import { replayTests } from '../verify/replay.js'

export interface GateCodeResult {
  verdict: GateVerdict
  trust_score: number
  bound_diff_sha256: string
  blocking_issues: Array<{ type: string; severity: string; evidence: string; rule_id?: string }>
  next_action: string
  advisory_notes?: string[]
  llm_hint?: string
  /** Files in the reviewed and bound diff (the whole working tree, not only this change). */
  reviewed_files: string[]
}

interface AssertionRecord { test: string; name: string; status: string; test_sha256: string }

/**
 * Seal's evidence.regression, produced by running this change's mapped tests now: once
 * against HEAD (the base the reviewed diff is taken from, with the current test files
 * overlaid) and once against the current tree. It counts only when HEAD fails with an
 * assertion error and the current tree passes. Receipt files are not read, so neither an
 * earlier RED nor an edited one can stand in. Bun projects, a committed fix (HEAD already
 * passes) or any error give undefined.
 */
export function regressionEvidence(root: string, changeDir: string): { red: AssertionRecord[]; green: AssertionRecord[] } | undefined {
  try {
    const { selection } = readTestContract(root, changeDir, basename(changeDir))
    if (!selection.length) return undefined
    const replay = replayTests(root, 'HEAD', selection)
    if (!replay.passed) return undefined
    const records = (run: ExecutionReceipt) => run.assertions.map(a =>
      ({ test: a.test, name: a.name, status: a.status, test_sha256: run.tests[a.test] ?? '' }))
    return { red: records(replay.base), green: records(replay.head) }
  } catch {
    return undefined
  }
}


export async function runGateCode(opts: {
  changeDir: string
  /** Repo root that plan.json task.files/task.test paths are relative to. Defaults to
   *  process.cwd() — matches PlanGuard's own projectRoot convention (plan-guard.ts),
   *  not a fixed '..' walk from changeDir, which breaks for any changeDir deeper than
   *  one level under the project root (e.g. openspec/changes/<name>/ or
   *  orca/changes/<name>/ — both real, both two levels deep, not one). */
  projectRoot?: string
  skipStateCheck?: boolean
  sealReviewFn?: (input: unknown) => Promise<unknown>
  llmProvider?: string
  selfCheckPath?: string
  /** Nested task review does not authorize the overall phase exit. */
  taskId?: string
  /** Byte ceiling for the reviewed git diff (default MAX_REVIEWED_DIFF_BYTES, 64 MiB). A larger
   *  diff makes the gate fail with diff_collection_failed; it is never truncated. */
  diffMaxBytes?: number
  /** Test seam for the Level 2b mutation probe (defaults to seal-gate's). */
  probeDeps?: ProbePlanTasksDeps
}): Promise<GateCodeResult> {
  const guard = new TransitionGuard(opts.changeDir)
  guard.canEnter(opts.taskId ? 'apply' : 'gate-code', opts.skipStateCheck)
  if (opts.taskId) {
    const task = readPlanJson(opts.changeDir).tasks.find(t => t.id === opts.taskId)
    const root = opts.projectRoot ?? process.cwd()
    if (task?.status !== 'complete' || !task.green || !validateExecutionReceipt(root, task.green) ||
        JSON.stringify(task.green.source) !== JSON.stringify(sourceBinding(root))) throw new Error('Fresh completed task required for nested gate')
    const fresh = executeTests(root, task.green.selection)
    if (fresh.outcome !== 'green' || JSON.stringify(fresh.tests) !== JSON.stringify(task.green.tests) ||
        fresh.runner.sha256 !== task.green.runner.sha256) throw new Error('Nested task gate GREEN changed')
  }

  const selfCheckPath = opts.selfCheckPath ?? join(opts.changeDir, 'self-check.md')
  if (!existsSync(selfCheckPath)) {
    throw new Error('self-check.md required before gate-code — run orca self-check first')
  }

  const selfCheck = parseSelfCheck(readFileSync(selfCheckPath, 'utf-8'))

  // Find spec file
  const specContent = findSpecContent(opts.changeDir)

  // Capture current diff — binds this verdict to exact code state
  // A collection failure (oversized diff, git error, git missing) throws DiffCollectionError
  // here, before anything is reviewed or recorded: never fall back to an empty diff or the claims.
  const diffOpts = { maxBytes: opts.diffMaxBytes }
  const diffOutput = reviewedCodeDiff(opts.changeDir, diffOpts)
  const diffSha256 = sha256String(diffOutput)
  const reviewed_files = reviewedCodeFiles(opts.changeDir, diffOpts)
  if (reviewedCodeDiff(opts.changeDir, diffOpts) !== diffOutput) throw new Error('Working tree changed while gate-code read the reviewed diff')

  // Load SEAL and TrustMemory
  const sealGate = await import('seal-gate')
  const { Seal } = sealGate
  const mandatoryProperties = parseSpec(specContent ?? '').requirements.some(req =>
    (req.strength === 'MUST' || req.strength === 'SHALL') && (req.properties?.length ?? 0) > 0)
  if (mandatoryProperties && typeof (sealGate as Record<string, unknown>).evaluatePropertyEvidence !== 'function') {
    throw new Error('Seal Property enforcement API unavailable; install the reviewed Seal candidate before gating mandatory Properties')
  }
  const propertyBridge = mandatoryProperties
    ? createPropertySealBridge(opts.projectRoot ?? process.cwd(), opts.changeDir, basename(opts.changeDir)) : undefined
  const TrustMemory = (sealGate as Record<string, unknown>).TrustMemory as
    | { fromJSON(data: Record<string, unknown[]>): { toJSON(): unknown }; new(): { toJSON(): unknown } }
    | undefined
  const trustMemoryPath = join(opts.changeDir, '.harness', 'trust-memory.json')
  let trustMemory: { toJSON(): unknown } | null = null
  if (TrustMemory) {
    trustMemory = existsSync(trustMemoryPath)
      ? TrustMemory.fromJSON(JSON.parse(readFileSync(trustMemoryPath, 'utf-8')))
      : new TrustMemory()
    Seal.withTrustMemory(trustMemory as never)
  }

  // Wire LLM reviewer if --llm was passed
  let llmHint: string | undefined
  if (opts.llmProvider !== undefined) {
    try {
      const { createReviewer, Seal: SealModule } = await import('seal-gate')
      if (typeof createReviewer === 'function') {
        const provider = opts.llmProvider || undefined  // empty string → auto-detect
        SealModule.withLLM(createReviewer({ provider }) as never)
      }
    } catch {
      // seal-gate < 0.4.0 doesn't export createReviewer — skip silently
    }
  }

  // All test-command records, in canonical order, bounded; see selectTestEvidence.
  const testEvidence = selectTestEvidence(selfCheck.evidence)

  // Build SEAL evidence from self-check references
  const regression = regressionEvidence(opts.projectRoot ?? process.cwd(), opts.changeDir)
  const references = selfCheck.evidence
    .filter(e => e.type === 'command')
    .map(e => ({ type: 'command' as const, command: e.command ?? '', exit_code: e.exit_code ?? 0, output: e.output ?? '' }))

  // Mandatory Property policy cannot be bypassed by a custom ordinary-review hook.
  const reviewFn = propertyBridge
    ? ((input: unknown) => (Seal.review as unknown as (input: unknown, options: unknown) => Promise<unknown>)(input,
      { propertyEvidenceVerifier: propertyBridge.verify }))
    : opts.sealReviewFn ?? ((input: unknown) => Seal.review(input as Parameters<typeof Seal.review>[0]))

  const sealResult = await reviewFn({
    artifact_type: 'code_diff',
    spec: specContent,
    output: diffOutput || selfCheck.claims.join('\n'),
    evidence: {
      diff: diffOutput,
      test_log: testEvidence.testLog,
      build_log: '',
      references,
      ...(regression ? { regression } : {}),
    },
    context: { agent_id: 'orca-agent', agent_role: 'developer',
      ...(propertyBridge ? { property_contracts: propertyBridge.contracts } : {}) },
  }) as {
    verdict: GateVerdict
    trust_score: number
    blocking_issues: Array<{ type: string; severity: string; evidence: string; rule_id?: string }>
    next_action: string
    advisory_notes?: string[]
  }

  // Persist TrustMemory
  if (trustMemory) {
    mkdirSync(join(opts.changeDir, '.harness'), { recursive: true })
    writeFileSync(trustMemoryPath, JSON.stringify(trustMemory.toJSON(), null, 2))
  }

  // Level 2b — mutation-probe each plan task's test to confirm it pins its behavior.
  // Unpinned tests (mutation survived) fold a SPEC_UNTESTED advisory + trust drop into the result.
  const resultWithProbe = await probePlanTasks(sealResult, opts.changeDir, {
    content: specContent,
    testLog: testEvidence.testLog,
    diffOutput,
  }, opts.probeDeps ?? {}, opts.projectRoot ?? process.cwd())

  // Replay and review run tests and tools; a tracked file they wrote would leave this verdict
  // bound to a diff that no longer exists, so stop instead of recording it.
  if (reviewedCodeDiff(opts.changeDir, diffOpts) !== diffOutput) {
    throw new Error('Reviewed diff changed during gate-code (a test or tool modified tracked files); no verdict recorded — rerun the gate')
  }

  // Build verdict entry for phase.json
  const verdictEntry: VerdictEntry = {
    verdict: normalizeGateVerdict(sealResult.verdict),
    bound_diff_sha256: diffSha256,
    evidence_bound: {
      test_log_sha256: testEvidence.sha256,
      ...(testEvidence.records.length ? { test_records: testEvidence.records } : {}),
      build_log_sha256: null,
    },
  }

  // Write verdict file
  const verdictDir = join(opts.changeDir, '.harness', 'gate-verdicts')
  mkdirSync(verdictDir, { recursive: true })
  writeFileSync(join(verdictDir, `${Date.now()}.json`), JSON.stringify({ ...resultWithProbe.result, ...verdictEntry,
    reviewed_files, regression_evidence: Boolean(regression),
    ...(opts.taskId ? { task_id: opts.taskId } : {}) }, null, 2))

  // Update phase.json
  try {
    if (!opts.taskId) recordGateVerdict(opts.changeDir, verdictEntry)
  } catch {
    // phase.json may not exist in degraded mode
  }

  // Detect LLM hint from assumptions
  if (opts.llmProvider !== undefined) {
    const assumptions = (sealResult as Record<string, unknown>).assumptions_detected as string[] | undefined
    if (assumptions?.some(a => typeof a === 'string' && a.includes('L2') && (a.includes('not reviewed') || a.includes('error')))) {
      llmHint = '💡 Tip: Set an API key env var (MINIMAX_PLAN_KEY, FIREWORKS_API_KEY, GEMINI_API_KEY, etc.) to enable LLM review.'
    }
  }

  return {
    verdict: normalizeGateVerdict(resultWithProbe.result.verdict),
    trust_score: resultWithProbe.result.trust_score,
    bound_diff_sha256: diffSha256,
    blocking_issues: resultWithProbe.result.blocking_issues,
    next_action: resultWithProbe.result.next_action,
    advisory_notes: resultWithProbe.result.advisory_notes,
    llm_hint: llmHint,
    reviewed_files,
  }
}

type ProbeOutcome =
  | { pinned: true; survivors: string[] }
  | { pinned: false; survivors: string[] }
  | { skipped: true; reason: string }

type ProbeOpt = {
  criterion: string
  test_file: string
  run_command: [string, string[]]
  workdir: string
  cap?: number
}

export type CheckTestPinsBehaviorFn = (opts: ProbeOpt) => Promise<ProbeOutcome>

export type ValidateWithProbeFn = (
  spec: string | null,
  testLog: string,
  diff: string,
  probeOpts: ProbeOpt[],
) => Promise<{
  issues: Array<{ type: string; evidence: string; trust_deduction?: number }>
  coverage: Array<{ criterion: string; pinned?: boolean }>
}>

export interface ProbePlanTasksDeps {
  validateWithProbe?: ValidateWithProbeFn
  checkTestPinsBehavior?: CheckTestPinsBehaviorFn
}

/**
 * Level 2b mutation-probe integration. Reads plan.json (if present), and for each task that
 * carries a `test`, confirms the test actually pins its behavior.
 *
 * Primary path: routes through `SpecCoverageValidator.validateWithProbe`, matching each task's
 * `acceptance` text against the Level-1 spec-coverage criteria `Seal.review()` already found in
 * spec.md — this reuses seal-gate's own per-criterion, capped trust-deduction policy
 * (`min(8, 20 - already_deducted)`) instead of a second, separately-invented one.
 *
 * Fallback path: `task.acceptance`'s wording won't always substring-match spec.md's criterion
 * text (they're two independently-written documents). A task whose criterion never matched any
 * Level-1-covered entry would otherwise be silently skipped by `validateWithProbe` — worse than
 * before this integration existed (no probe, no warning). Any such task is mutation-probed
 * directly via `checkTestPinsBehavior` instead, with a flat trust deduction, so a text-matching
 * miss never means silent no-op.
 */
export async function probePlanTasks<T extends { advisory_notes?: string[]; trust_score: number }>(
  result: T,
  changeDir: string,
  spec: { content: string | null; testLog: string; diffOutput: string },
  deps: ProbePlanTasksDeps = {},
  projectRoot: string = process.cwd(),
): Promise<{ result: T; probed: boolean }> {
  const planPath = join(changeDir, 'plan.json')
  if (!existsSync(planPath)) {
    return { result, probed: false }
  }

  let plan: ReturnType<typeof readPlanJson>
  try {
    plan = readPlanJson(changeDir)
  } catch {
    return { result, probed: false }
  }

  const testTasks = plan.tasks.filter(t => t.test && (t.status === 'complete' || t.status === 'in_progress'))
  if (testTasks.length === 0) {
    return { result, probed: false }
  }

  let validateWithProbe = deps.validateWithProbe
  let checkTestPinsBehavior = deps.checkTestPinsBehavior
  if (!validateWithProbe || !checkTestPinsBehavior) {
    try {
      const mod = (await import('seal-gate')) as {
        SpecCoverageValidator?: { validateWithProbe: ValidateWithProbeFn }
        checkTestPinsBehavior?: CheckTestPinsBehaviorFn
      }
      validateWithProbe ??= mod.SpecCoverageValidator?.validateWithProbe
      checkTestPinsBehavior ??= mod.checkTestPinsBehavior
    } catch {
      return { result, probed: false } // seal-gate <0.5 lacks it
    }
  }
  if (!validateWithProbe || !checkTestPinsBehavior) return { result, probed: false }

  const advisory = [...(result.advisory_notes ?? [])]
  let trustDrop = 0

  const probeOpts: Array<{ taskId: string; opt: ProbeOpt }> = []
  for (const task of testTasks) {
    const testFile = resolve(join(projectRoot, task.test))
    if (!existsSync(testFile)) {
      advisory.push(`mutation-probe: ${task.id} — test file not found: ${task.test}`)
      continue
    }
    probeOpts.push({
      taskId: task.id,
      opt: {
        criterion: task.acceptance,
        test_file: testFile,
        run_command: ['bun', ['test', testFile]],
        workdir: projectRoot,
        cap: 1, // pinned/unpinned is binary — one survivor is already proof, stop probing
      },
    })
  }
  if (probeOpts.length === 0) {
    return advisory.length === (result.advisory_notes?.length ?? 0)
      ? { result, probed: false }
      : { result: { ...result, advisory_notes: advisory }, probed: true }
  }

  const matchedTaskIds = new Set<string>()
  try {
    const probeResult = await validateWithProbe(spec.content, spec.testLog, spec.diffOutput, probeOpts.map(p => p.opt))
    for (const issue of probeResult.issues) {
      if (issue.type !== 'SPEC_UNTESTED') continue // Level-1 issues already counted by Seal.review() itself
      advisory.push(`mutation-probe: ${issue.evidence}`)
      trustDrop += issue.trust_deduction ?? 0
    }
    for (const { taskId, opt } of probeOpts) {
      const entry = probeResult.coverage.find(
        c => c.pinned !== undefined && c.criterion.includes(opt.criterion.slice(0, 100)),
      )
      if (entry) matchedTaskIds.add(taskId)
    }
  } catch {
    // validateWithProbe itself failed — every task falls through to the direct fallback below.
  }

  // Fallback: any task whose criterion text never matched a Level-1 coverage entry (including
  // every task, if validateWithProbe threw) is probed directly rather than silently dropped.
  for (const { taskId, opt } of probeOpts) {
    if (matchedTaskIds.has(taskId)) continue
    let outcome: ProbeOutcome
    try {
      outcome = await checkTestPinsBehavior(opt)
    } catch {
      continue
    }
    if ('skipped' in outcome && outcome.skipped) continue
    if ('pinned' in outcome && outcome.pinned === false) {
      advisory.push(
        `mutation-probe (fallback — criterion unmatched in spec.md): ${taskId} — test does NOT pin its behavior (SPEC_UNTESTED); ${outcome.survivors.length} survivor(s)`,
      )
      trustDrop += 3
    }
  }

  if (advisory.length === (result.advisory_notes?.length ?? 0) && trustDrop === 0) return { result, probed: true }

  return {
    result: {
      ...result,
      advisory_notes: advisory,
      trust_score: Math.max(0, result.trust_score - trustDrop),
    },
    probed: true,
  }
}

function findSpecContent(changeDir: string): string | null {
  const specsDir = join(changeDir, 'specs')
  if (!existsSync(specsDir)) return null
  try {
    const subdirs = readdirSync(specsDir)
    for (const sub of subdirs) {
      const specFile = join(specsDir, sub, 'spec.md')
      if (existsSync(specFile)) return readFileSync(specFile, 'utf-8')
    }
  } catch { /* */ }
  return null
}

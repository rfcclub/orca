import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { sha256String } from './phase-json.js'
import type { GateVerdict } from './types.js'

export class GatePlanError extends Error {}

export interface LockedCriterion {
  id: string
  text: string
  source_file: string
  source_line: number
}

export interface GatePlanResult {
  verdict: GateVerdict
  trust_score: number
  artifact: 'plan.json' | 'tasks.md'
  bound_artifact_sha256: string
  criteria_count: number
  blocking_issues: Array<{ type: string; severity: string; evidence: string; rule_id?: string }>
  next_action: string
  advisory_notes?: string[]
}

/** True only when intent.md carries the `## Intent Approval` record with `Status: APPROVED`. */
export function hasApprovalRecord(intentText: string): boolean {
  const section = /^##\s+Intent Approval\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(intentText)
  return section !== null && /^Status:\s*APPROVED\s*$/m.test(section[1])
}

/** Locked criteria = the bullets under `## Success Criteria`, one per bullet, in order. */
export function extractLockedCriteria(intentText: string, sourceFile: string): LockedCriterion[] {
  const lines = intentText.split('\n')
  const start = lines.findIndex(l => /^##\s+Success criteria\s*$/i.test(l))
  if (start === -1) return []
  const criteria: LockedCriterion[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break
    const bullet = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/.exec(lines[i])
    if (bullet) {
      criteria.push({ id: `SC-${criteria.length + 1}`, text: bullet[1], source_file: sourceFile, source_line: i + 1 })
    }
  }
  return criteria
}

async function defaultWireLlm(provider: string | undefined): Promise<void> {
  try {
    const { createReviewer, Seal } = await import('seal-gate')
    if (typeof createReviewer === 'function') {
      Seal.withLLM(createReviewer({ provider: provider || undefined }) as never)
    }
  } catch {
    // seal-gate < 0.4.0 has no createReviewer — run without an LLM reviewer
  }
}

export async function runGatePlan(opts: {
  changeDir: string
  /** Given only with `--llm`; an empty string means auto-detect. Absent means no LLM reviewer. */
  llmProvider?: string
  sealReviewFn?: (input: unknown) => Promise<unknown>
  wireLlm?: (provider: string | undefined) => Promise<void>
}): Promise<GatePlanResult> {
  const intentPath = join(opts.changeDir, 'intent.md')
  const intentText = existsSync(intentPath) ? readFileSync(intentPath, 'utf-8') : ''
  if (!hasApprovalRecord(intentText)) {
    throw new GatePlanError('intent has no approval record — gate-plan runs only for an approved intent')
  }

  const criteria = extractLockedCriteria(intentText, 'intent.md')
  if (criteria.length === 0) {
    throw new GatePlanError('success criteria cannot be locked — the approved intent has no bullets under "## Success Criteria"')
  }

  const artifact = existsSync(join(opts.changeDir, 'plan.json'))
    ? 'plan.json'
    : existsSync(join(opts.changeDir, 'tasks.md')) ? 'tasks.md' : null
  if (artifact === null) {
    throw new GatePlanError('plan artifact missing — the change needs plan.json or tasks.md')
  }
  const artifactText = readFileSync(join(opts.changeDir, artifact), 'utf-8')

  // Always regenerated from the approved intent; never read back as input.
  const harnessDir = join(opts.changeDir, '.harness')
  mkdirSync(harnessDir, { recursive: true })
  writeFileSync(join(harnessDir, 'locked-criteria.json'), JSON.stringify(criteria, null, 2) + '\n')

  let reviewFn = opts.sealReviewFn
  if (opts.llmProvider !== undefined) await (opts.wireLlm ?? defaultWireLlm)(opts.llmProvider)
  if (!reviewFn) {
    const { Seal } = await import('seal-gate')
    reviewFn = (input: unknown) => Seal.review(input as Parameters<typeof Seal.review>[0])
  }

  const sealResult = await reviewFn({
    artifact_type: 'plan_review',
    spec: intentText,
    output: artifactText,
    evidence: { diff: '', test_log: '', build_log: '', references: [] },
    context: { agent_id: 'orca-agent', agent_role: 'planner', locked_criteria: criteria },
  }) as {
    verdict: GateVerdict
    trust_score: number
    blocking_issues?: GatePlanResult['blocking_issues']
    next_action?: string
    advisory_notes?: string[]
  }

  const result: GatePlanResult = {
    verdict: sealResult.verdict,
    trust_score: sealResult.trust_score,
    artifact,
    bound_artifact_sha256: sha256String(artifactText),
    criteria_count: criteria.length,
    blocking_issues: sealResult.blocking_issues ?? [],
    next_action: sealResult.next_action ?? '',
    advisory_notes: sealResult.advisory_notes,
  }

  const verdictDir = join(harnessDir, 'gate-verdicts')
  mkdirSync(verdictDir, { recursive: true })
  writeFileSync(join(verdictDir, `${Date.now()}-plan.json`), JSON.stringify({ kind: 'plan', ...result }, null, 2))
  return result
}

export interface LatestVerdicts {
  code?: { verdict: GateVerdict; trust_score?: number }
  plan?: { verdict: GateVerdict; trust_score?: number }
}

/** Latest code verdict and latest plan verdict of a change; plan records carry `kind: "plan"`. */
export function readLatestVerdicts(changeDir: string): LatestVerdicts {
  const verdictDir = join(changeDir, '.harness', 'gate-verdicts')
  if (!existsSync(verdictDir)) return {}
  const latest: LatestVerdicts = {}
  for (const file of readdirSync(verdictDir).filter(f => f.endsWith('.json')).sort()) {
    const record = JSON.parse(readFileSync(join(verdictDir, file), 'utf-8'))
    if (record.kind === 'plan') latest.plan = record
    else latest.code = record
  }
  return latest
}

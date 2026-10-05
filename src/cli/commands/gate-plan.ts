import { getChangeDir, changeExists } from '../utils.js'
import { runGatePlan, GatePlanError } from '../../harness/gate-plan.js'

export async function cmdGatePlan(name: string, opts: { llm?: string } = {}): Promise<void> {
  if (!changeExists(name)) {
    console.error(`✗  Change "${name}" not found.`)
    process.exit(1)
  }

  console.log(`Running SEAL plan review on "${name}"...`)
  try {
    const result = await runGatePlan({ changeDir: getChangeDir(name), llmProvider: opts.llm })
    const ok = result.verdict === 'PASS' || result.verdict === 'PASS_WITH_WARNINGS'
    console.log(`\n${ok ? '✓' : '✗'}  Plan verdict: ${result.verdict}`)
    console.log(`  Trust score: ${result.trust_score}`)
    console.log(`  Reviewed: ${result.artifact} (${result.criteria_count} locked criteria)`)
    console.log(`  Artifact SHA256: ${result.bound_artifact_sha256.slice(0, 16)}...`)

    for (const note of result.advisory_notes ?? []) console.log(`  Advisory: ${note}`)
    for (const issue of result.blocking_issues) {
      console.log(`  [${issue.severity}] ${issue.type}: ${issue.evidence}`)
    }
    console.log(`\n  Next: ${result.next_action}`)
    if (!ok) process.exit(1)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`✗  ${err instanceof GatePlanError ? 'Cannot gate plan' : 'Gate failed'}: ${msg}`)
    process.exit(1)
  }
}

import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { listChanges, getChangeDir } from '../utils.js'
import { hasApprovalRecord, readLatestVerdicts } from '../../harness/gate-plan.js'
import { runPipelineGate } from '../../harness/pipeline-gate.js'
import type { PipelineVerdictEntry } from '../../harness/pipeline-gate.js'

export function cmdGatePipeline(): void {
  const changes = listChanges()

  if (changes.length === 0) {
    console.log('No changes found. Nothing to gate.')
    return
  }

  const verdicts: PipelineVerdictEntry[] = []

  for (const change of changes) {
    const changeDir = getChangeDir(change)
    const latest = readLatestVerdicts(changeDir)
    const intentPath = join(changeDir, 'intent.md')
    const required = existsSync(intentPath) && hasApprovalRecord(readFileSync(intentPath, 'utf-8'))
    verdicts.push({
      verdict: (latest.code?.verdict ?? undefined) as unknown as 'PASS',
      change,
      trust_score: latest.code?.trust_score,
      plan: { verdict: latest.plan?.verdict, required },
    })
  }

  const result = runPipelineGate(verdicts)
  const icon = result.decision === 'SHIP' ? '✓' : '✗'

  console.log(`\n${icon}  Pipeline decision: ${result.decision}`)
  console.log(`  ${result.summary}`)

  if (result.aggregate_trust_score !== undefined) {
    console.log(`  Aggregate trust score: ${result.aggregate_trust_score}`)
  }

  if (result.blocking && result.blocking.length > 0) {
    console.log('  Blocking changes:')
    for (const b of result.blocking) console.log(`    - ${b}`)
  }

  for (const w of result.warnings ?? []) console.log(`  ⚠ ${w}`)

  if (result.decision !== 'SHIP') process.exit(1)
}

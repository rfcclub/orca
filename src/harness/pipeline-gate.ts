import type { GateVerdict } from './types.js'

export type PipelineDecision = 'SHIP' | 'HOLD' | 'ESCALATE_TO_HUMAN'

export interface PipelineVerdictEntry {
  verdict: GateVerdict
  change?: string
  trust_score?: number
  /** Plan-gate state. `required` is true for changes made after gate-plan existed. */
  plan?: { verdict?: GateVerdict; required: boolean }
}

export interface PipelineResult {
  decision: PipelineDecision
  blocking?: string[]
  aggregate_trust_score?: number
  summary: string
  warnings?: string[]
}

export function runPipelineGate(verdicts: PipelineVerdictEntry[]): PipelineResult {
  if (verdicts.length === 0) {
    return { decision: 'HOLD', summary: 'No changes gated — hold by default' }
  }

  const blocks = verdicts.filter(v => v.verdict === 'BLOCK')
  if (blocks.length > 0) {
    return {
      decision: 'HOLD',
      blocking: blocks.map(v => v.change ?? 'unknown'),
      summary: `HOLD: ${blocks.length} change(s) have BLOCK verdict`,
    }
  }

  const ungated = verdicts.filter(v => !v.verdict)
  if (ungated.length > 0) {
    return {
      decision: 'HOLD',
      blocking: ungated.map(v => v.change ?? 'unknown'),
      summary: `HOLD: ${ungated.length} change(s) have not been gated`,
    }
  }

  const planBlocked = verdicts.filter(
    v => v.plan?.verdict === 'BLOCK' || v.plan?.verdict === 'REVISE' || v.plan?.verdict === 'ESCALATE_TO_HUMAN',
  )
  const planMissing = verdicts.filter(v => v.plan && !v.plan.verdict && v.plan.required)
  if (planBlocked.length > 0 || planMissing.length > 0) {
    return {
      decision: 'HOLD',
      blocking: [...planBlocked, ...planMissing].map(v => v.change ?? 'unknown'),
      summary: `HOLD: ${planBlocked.length} change(s) have a failing plan verdict, ${planMissing.length} have no plan verdict`,
    }
  }
  const warnings = verdicts
    .filter(v => v.plan && !v.plan.verdict && !v.plan.required)
    .map(v => `${v.change ?? 'unknown'}: no plan verdict (created before gate-plan existed)`)

  const revises = verdicts.filter(v => v.verdict === 'REVISE')
  if (revises.length >= 3) {
    return {
      decision: 'ESCALATE_TO_HUMAN',
      summary: `ESCALATE: ${revises.length} changes require revision`,
    }
  }

  const escalations = verdicts.filter(v => v.verdict === 'ESCALATE_TO_HUMAN')
  if (escalations.length > 0) {
    return {
      decision: 'ESCALATE_TO_HUMAN',
      summary: `ESCALATE: ${escalations.length} change(s) require human review`,
    }
  }

  const scores = verdicts.map(v => v.trust_score ?? 100).filter(s => s !== undefined)
  const aggregate = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : undefined

  return {
    decision: 'SHIP',
    aggregate_trust_score: aggregate,
    summary: `SHIP: all ${verdicts.length} change(s) passed — aggregate trust score ${aggregate ?? 'N/A'}`,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

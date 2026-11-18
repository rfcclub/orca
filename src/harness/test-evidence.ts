import { createHash } from 'node:crypto'
import type { EvidenceReference } from './types.js'

/**
 * Upper bound, in bytes, on the aggregated test evidence handed to the reviewer, the mutation
 * probe and the bound hash. Input above it is refused, never truncated.
 */
export const MAX_TEST_EVIDENCE_BYTES = 16 * 1024 * 1024

export interface TestRecordSummary {
  command: string
  exit_code: number | null
  output_bytes: number
  output_sha256: string
}

export interface TestEvidence {
  /** The text used as test_log for review, the mutation probe and the bound hash. */
  testLog: string
  /** sha256 of testLog, or null when there is no test output to bind. */
  sha256: string | null
  /** Per-record identity in canonical order (command, then raw record order). */
  records: TestRecordSummary[]
}

export class TestEvidenceError extends Error {
  readonly code = 'test_evidence_invalid' as const
  constructor(readonly reason: 'too_large' | 'malformed', message: string) {
    super(`test_evidence_invalid (${reason}): ${message}`)
    this.name = 'TestEvidenceError'
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/**
 * Selection contract for test evidence. Every command record whose command contains "test" is
 * selected (the same predicate gate-code always used), not just the first one.
 *
 * - Canonical order: records are sorted by command (code-unit order), and records with the same
 *   command keep their raw order. Reordering distinct commands therefore never changes the
 *   evidence or its hash.
 * - One selected record: testLog is that record's raw output and the hash is its sha256, exactly
 *   as before, so historical single-record receipts are unchanged.
 * - Several records: testLog is a framed aggregate. Each record carries its command, exit code,
 *   output byte count, output hash and raw output, and a header counts the records with a non-zero
 *   or missing exit code, so a failing record is always visible beside a passing one.
 * - Malformed records (non-string output, non-integer exit code) and an aggregate above
 *   MAX_TEST_EVIDENCE_BYTES are refused with TestEvidenceError.
 */
export function selectTestEvidence(evidence: EvidenceReference[], maxBytes = MAX_TEST_EVIDENCE_BYTES): TestEvidence {
  const selected = evidence
    .map((e, raw) => ({ e, raw }))
    .filter(({ e }) => e && typeof e === 'object' && typeof e.command === 'string' && e.command.includes('test'))
    .sort((a, b) => (a.e.command! < b.e.command! ? -1 : a.e.command! > b.e.command! ? 1 : a.raw - b.raw))
    .map(({ e, raw }) => {
      if (e.output !== undefined && typeof e.output !== 'string') {
        throw new TestEvidenceError('malformed', `record ${raw} (${JSON.stringify(e.command)}) has a non-string output`)
      }
      if (e.exit_code !== undefined && !Number.isInteger(e.exit_code)) {
        throw new TestEvidenceError('malformed', `record ${raw} (${JSON.stringify(e.command)}) has a non-integer exit_code`)
      }
      return { command: e.command!, exit_code: e.exit_code ?? null, output: e.output ?? '' }
    })

  const records: TestRecordSummary[] = selected.map(r => ({
    command: r.command, exit_code: r.exit_code, output_bytes: Buffer.byteLength(r.output), output_sha256: sha(r.output) }))
  const total = records.reduce((n, r) => n + r.output_bytes, 0)
  if (total > maxBytes) {
    throw new TestEvidenceError('too_large',
      `${selected.length} test records total ${total} output bytes, above the ${maxBytes}-byte bound; nothing was truncated`)
  }

  if (selected.length === 0) return { testLog: '', sha256: null, records }
  if (selected.length === 1) {
    const only = selected[0]!.output
    return { testLog: only, sha256: only ? sha(only) : null, records }
  }

  const failing = selected.filter(r => r.exit_code !== 0).length
  const parts = [`# orca test evidence: ${selected.length} records, ${failing} with a non-zero or missing exit code`]
  selected.forEach((r, i) => {
    const s = records[i]!
    parts.push([
      `=== record ${i + 1} of ${selected.length} ===`,
      `command: ${JSON.stringify(r.command)}`,
      `exit_code: ${r.exit_code ?? 'missing'}`,
      `output_bytes: ${s.output_bytes}`,
      `output_sha256: ${s.output_sha256}`,
      '--- output ---',
      r.output,
      `=== end record ${i + 1} ===`,
    ].join('\n'))
  })
  const testLog = parts.join('\n') + '\n'
  return { testLog, sha256: sha(testLog), records }
}

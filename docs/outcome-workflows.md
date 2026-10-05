# Outcome workflows

For findings, decisions or migrations, put one `orca-outcomes` YAML fence in the
existing tasks.md. Local intent.md is sufficient; GitHub issues are optional.
When GitHub integration is selected, the approved issue is the intent of record.
decision.md carries the narrative; `.harness/` holds captured receipts. Do not
duplicate these per stage.

`orca check-outcomes <change>` checks integrity offline and reports missing
evidence. `--local-review` verifies signatures from configured local reviewers;
`--online` reads the canonical issue and default-branch human reviewers.
Choose one adapter explicitly; they cannot be combined and never fall back to
each other. Local mode never invokes `gh` or makes network requests.
Output is `.harness/outcome-report.json`. Incomplete, review-required and
unsupported stages exit nonzero. Legacy changes without a fence retain their path.

## Common contract

```yaml
version: 1
intent_sha256: <sha256 of the exact approved intent.md>
stages:
  - id: finding
    outcome: investigation
    criteria: [SC-1]
    scope: {environment: workstation, revision: d8db401, boundary: verify CLI}
    evidence:
      - kind: observation
        path: .harness/verify-audit.json
        sha256: <sha256 of captured bytes>
        scope: {environment: workstation, revision: d8db401, boundary: verify CLI}
```

SC IDs come from gate-plan's approved-intent criteria. Receipt paths are relative
to the change folder. Hashes, nonempty bytes, realpath containment and exact scope
are checked. Stages with matching scopes can reference the same receipt.
The report identifies environment/revision/boundary; reviewers check freshness.

With GitHub integration, a configured human reviewer accepts a stage by posting the entire comment
`/accept-outcome <stage-id> <contract-digest>` on the canonical issue. The checker
prints the digest. Any changed stage, scope, obligation or evidence reference
invalidates old review. Agent comments, bot reports, local role files and YAML
flags cannot accept an outcome. Online mode only reads; it never posts approval.
The default check without a review adapter cannot establish acceptance, even
from an old cached report or an existing local signature.

Hashes prove bytes, not causal relevance or truth. Human review supplies semantic
acceptance. Seal retains plan/code review; this adds no new Seal detector.

## Local review

The normal local intent → spec → design → plan → TDD → verify → archive workflow
requires no GitHub account or signing keys. Only opt-in outcome stages that need
review use the setup below.

An operator provisions Ed25519 keys and pins the public key in
`~/.config/orca/reviewers.json` (or the absolute path in `ORCA_REVIEWERS_FILE`).
Configuration and private keys must resolve outside the project, including
through symlinks. A project cannot supply its own authority. The configuration
uses this shape:

```json
{
  "version": 1,
  "reviewers": [
    {"id": "owner", "kind": "human", "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"}
  ]
}
```

For a fresh setup, the operator can run this script in their own trusted shell.
It refuses to overwrite existing files:

```bash
node --input-type=module <<'JS'
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const directory = join(homedir(), '.config/orca');
const privatePath = join(directory, 'owner-review.pem');
const configPath = join(directory, 'reviewers.json');
if (existsSync(privatePath) || existsSync(configPath)) {
  throw new Error('Existing reviewer setup; inspect it instead of replacing it');
}
mkdirSync(directory, { recursive: true, mode: 0o700 });
const keys = generateKeyPairSync('ed25519');
writeFileSync(privatePath, keys.privateKey.export({type: 'pkcs8', format: 'pem'}), {flag: 'wx', mode: 0o600});
writeFileSync(configPath, JSON.stringify({
  version: 1,
  reviewers: [{id: 'owner', kind: 'human', publicKey: keys.publicKey.export({type: 'spki', format: 'pem'})}]
}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
JS
```

Review the intent, scope and actual evidence, then copy the exact digest from
`orca check-outcomes <change>`:

```bash
orca review-outcome my-change --stage decision --digest <current-digest> \
  --reviewer owner --key "$HOME/.config/orca/owner-review.pem"
orca check-outcomes my-change --local-review
```

The signer refuses incomplete, unsupported, unknown or stale stages.
`.harness/local-review.json` stores signatures bound to the stage and the whole
contract digest. Edited contracts invalidate signatures; removed reviewers
revoke their authority. Agent identities and forged signatures cannot accept.
File URLs such as `file:///absolute/path/follow-up.md` can link deferred local
work without an issue tracker.

A signature proves possession of the pinned key, not that a human physically
used it. Protect both the key and reviewer configuration from untrusted agents;
outside-project containment alone does not isolate processes with access to
the same account. Orca never generates or registers reviewer keys automatically.
The default offline report remains non-accepting; local signatures are checked
only with `--local-review`.

### Rollback plan for local review adoption

Keep the previous Orca package tarball and reviewer configuration before
adoption. To recover, reinstall that tarball (`npm install -g <previous.tgz>`)
and restore only the configuration entries changed for the rollout after
comparing current edits. Existing intents and evidence stay in place; stop
using `--local-review` while investigating. Remove a reviewer from the pinned
configuration to revoke their signatures. Recheck the CLI version and rerun
the ordinary local workflow before resuming.

## Investigation example: verifier audit

Capture command, timestamp, revision, exit status and output from a fixture.
At d8db401, a missing test plus three YAML passing entries produced `PASS (3/1)`.
A second probe completed a task using `--test-cmd true`, with null artifact hashes.
Append this to the common stage:

```yaml
question: Does verify execute the required test?
budget: Two probes, one minute
hypotheses:
  - prediction: A passing YAML entry bypasses a missing test file
    result: confirmed
    observations: [.harness/verify-audit.json]
unknowns: [Compatibility requirements for the replacement runner]
conclusion:
  status: conclusive
  reason: A missing test produced PASS; source reads YAML status
```

For `rootCause`, additionally capture confirming and alternative-refuting
observations. Symptom recovery alone is insufficient. Reuse Hammerhead logs.
An inconclusive result retains unknowns, records `reason` and `nextEvidence`,
and uses `status: inconclusive`. Human review yields `findings-reviewed` or
`findings-reviewed-inconclusive`, never code verification.

## Decision example: storage selection

Set `outcome: decision`, link a `kind: decision` receipt to decision.md and add:

```yaml
question: Which storage meets the measured workload?
options: [SQLite, PostgreSQL]
choice: SQLite
consequences: [A migration is required if measured limits are exceeded]
revisit: Sustained write contention exceeds the agreed threshold
obligations:
  - text: Implement the repository adapter
    verification: Integration tests against the adapter
    state: deferred
    followUp: https://github.com/example/project/issues/2
```

Acceptance yields `decision-accepted`; the adapter remains deferred. Fulfilled
obligations need a `kind: verification` reference. A bounded spike declares its
question, budget and disposal policy. Retained code follows the implementation path.

## Implementation example: adapter change

Use `outcome: implementation`, approved SC references and the code revision scope.
Continue intent → spec → tasks → RED/GREEN/REFACTOR → executable tests → gates.
Link runner evidence, not an assertion of success.

Legacy verify currently counts YAML status without running tests; plan-json can
accept `true`. Therefore this checker reports implementation as `unsupported`
until a trustworthy executable-evidence integration lands. No review overrides
that limitation. Run actual tests independently and retain JSON/log evidence.
A composed task promising implementation remains incomplete.

Verifier remediation owns runner results, bound test/source hashes, genuine RED
and bug-fix base/head replay. Property grammar, RUNS, seed, generator coverage,
shrinking and regression corpus belong with Orca #12. Mutation verdict changes
belong in Seal. Backtest/walk-forward performance is separate from correctness
tests; finite property runs do not prove correctness over all inputs.

## Migration example: format transition

Set `outcome: migration` and include:

```yaml
target: v2 records readable by the declared consumer
invariants: [record IDs and amounts preserved]
consumers: [production reader]
prerequisites: [verified backup and deployed v2 reader]
stopConditions: [read mismatch or excessive error rate]
recovery: Restore baseline where possible; otherwise rehearse forward recovery at the target boundary
```

Require scoped receipts of kinds `baseline`, `rehearsal`, `recovery`,
`authorization` and `live`. Authorization describes the specific cutover and stop
conditions; code review is not cutover permission. Rehearse before incremental,
authorized transition. Local fixtures prove their own transition/recovery only.
`rehearsal` cannot satisfy `live`; human review checks actual boundary provenance.
Missing live evidence is incomplete. Valid receipts and authenticated review
yield `migration-completed` only at the reported scope.

## Composition and adoption

Each stage keeps its own criteria, scope, evidence and state. References can be
shared. Aggregate completion requires every declared stage to reach its own
terminal state. Deferred decision obligations remain visible as follow-ups.
Decision-only work can complete with linked implementation work; a composed task
cannot omit promised code/migration or infer them from decision acceptance.

This opt-in integration leaves historical specs, verify files, existing coding
commands, archive behavior and the Orca loop intact. Require a current outcome
report during review before archiving outcome work. Cached reports are not
current verification or deployment permission.

### Rollback plan in the worked rehearsal
The change's `rehearsal.mjs` captures the baseline records, writes the new
envelope, reads it through the fixture consumer, and restores the exact saved
bytes. It asserts record preservation and byte equality after recovery. This
rollback script demonstrates a disposable local transition; production work
still needs recovery evidence and cutover authorization at its declared scope.

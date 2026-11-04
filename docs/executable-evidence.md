# Executable test evidence

Orca invokes the project's local Vitest runner directly. A local Git repository
with a HEAD commit and a local Vitest installation are prerequisites. GitHub and
network access are not required. Two runners are supported, chosen by
`tdd.framework` in `openspec/config.yaml` (or `orca/config.yaml`): `vitest` (the
default) and `bun`. Any other value is refused before a runner starts.

## Bun

```yaml
tdd:
  framework: bun
```

Orca runs the `bun` binary from `PATH` (or `ORCA_BUN`, an absolute path)
directly, never through a shell. It binds the binary's path, sha256 and
`bun --version`. Each selected file is passed as a `./`-prefixed path, because
`bun test` treats a bare argument as a substring filter. The run uses
`--reporter=junit` and an Orca preload.

Bun's JUnit labels every failure `AssertionError` and carries no message, so a
crash looks like a failed expectation there. The preload wraps the matchers of
`expect(x)` and `expect(x).not` (which also covers `.resolves`) so that a failing
expectation's message starts with a per-run nonce. Bun prints each failed test
as a `(fail) <describe > … > name>` line after its error. A failure counts as
assertion RED only when that block carries the nonce. A thrown `TypeError`, a
rejected promise, a timeout or a file that fails to load stays inconclusive.
A test that passes with zero `expect` calls is not GREEN. Exact `assertion`
names use Bun's form, `outer > inner > [id] name`.

The receipt's `report` is the JUnit text, Bun's stderr and the nonce, hashed
like Vitest's report, and `runner.framework` is `bun`. `validateExecutionReceipt`
derives the evidence again from that report. A test can read the nonce from the
preload and forge it, just as a Vitest test can throw its own `AssertionError`;
the guarantee is parity with Vitest, not more.

Not supported on Bun yet: property receipts and `--base` replay. Both are
refused with a reason and never fall back to Vitest.

## Assertion mapping

The current spec defines the required SHALL/MUST scenario IDs. The conventional
test path is `tests/<change>/<capability>/<scenario-id>.test.ts`. An explicit
mapping overrides that path:

```yaml
scenarios:
  - scenario: value-correct
    test: tests/value.test.ts
    assertion: value suite computes a value
```

Without `assertion`, exactly one executed test name must contain
`[value-correct]`. Skipped, absent, duplicated, reused or empty assertions do not
establish GREEN. Unknown YAML IDs do not contribute coverage. YAML `status` is
ignored by executable verify.

## RED and GREEN

`orca record-red <change>` writes `.orca-red.json` only as a RED record. A
failed Vitest assertion establishes RED; import, compile, startup and arbitrary
runtime exceptions remain inconclusive.

`plan-json start` (also available as `plan-json red`) executes `task.test` and
records RED before entering `in_progress`. `plan-json complete` requires that
record, unchanged test bytes, the same runner identity and an actual GREEN run.
An optional exact `--assertion` can be set when adding the task. `--test-cmd`
is rejected. Existing debug-session gates remain in effect.

`orca verify <change>` writes `.orca-verify.json` with the raw JSON reporter,
exit code, selected assertions, test hashes, local runner identity, Git HEAD,
dirty diff and current file tree hashes. Spec, mapping and intent bytes are
bound separately. Execution that changes those inputs is rejected.

## Bug regression replay

```sh
orca verify value-fix --base <commit> --harness tests/setup.ts,vitest.config.ts
```

Orca pins the base commit, runs the exact current source (including dirty
changes), and creates a detached temporary base worktree. It overlays identical
test and declared test-only harness bytes. The test must fail by assertion at
base and pass against the current source. Caller files and worktrees are
preserved; cleanup targets only Orca's temporary checkout. Symlink overlays
that could write outside the checkout are rejected.

The base uses the current local dependency installation. Its location and
lockfile hashes are recorded as setup evidence; this is not a historical
dependency reconstruction. Production modules cannot be declared as harness
overlays. A base import/setup failure is inconclusive and never RED.

## Receipt consumption and compatibility

Archive and implementation outcome checks derive the contract from current
files, validate receipt/source/test/runner freshness, and execute the mapped
assertions again. A replay receipt also requires replay again. Implementation
outcomes retain the independent authenticated human-review requirement.

`orca verify --coverage-only` preserves labeled historical YAML bookkeeping.
It writes `execution_verified: false` and cannot satisfy implementation or
ordinary archive. Historical receipts without executable evidence require a
new executable verify; deliberate force archive still requires its recorded
reason. Historical completed plan tasks do not acquire RED evidence
retroactively. Missing `phase.json` retains its compatibility warning; it
cannot bypass executable test checks.

These receipts establish finite test execution against bound inputs, assuming
the local test runner and runtime are trusted. They do not authenticate a
compromised runtime or establish that a test's asserted requirement is correct.
Property execution metadata and mutation policy are separate approved work.

## Repository migration and pending drafts

Legacy traceability can select an existing test using its exact Vitest `fullName` in `assertion`. The verifier still executes the file and requires exactly one unique executed assertion per required ID; YAML passing status is not proof.

Bulk `orca verify` reports explicit unapproved intent-only DRAFT folders as SKIP (pending, not verified), without writing a GREEN receipt. A named change without a spec, an approved missing spec, or a change with design/plan artifacts still fails closed. Draft inventory does not constitute acceptance.

Acceptance receipts pin the actual runner path, bytes and Node version. Moving a receipt to another machine or Node version requires fresh execution there. `plan-json complete --test-cmd` is no longer supported: task contracts select the actual runner and assertions.

Declared produced paths must exist as regular in-project files at completion. A task deleting a declared produced path fails closed; deletion is not certified by recording a null hash.

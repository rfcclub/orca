# Executable test evidence

Orca invokes the project's local Vitest runner directly. A local Git repository
with a HEAD commit and a local Vitest installation are prerequisites. GitHub and
network access are not required. The first adapter supports Vitest's JSON
reporter and Vitest `expect` assertions; other runners are unsupported.

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

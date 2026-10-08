# Property execution evidence

Property shares the existing spec parser, block IDs, traceability mappings and
executable verification from #14. The first adapter uses fast-check 4.10.2 under
local Vitest. GitHub is optional. Install Vitest in the project and make the
Orca package available to its test imports.

```markdown
### Requirement: No lookahead
The strategy MUST NOT use data after bar t when deciding at bar t.

#### Property: future-independence
- **FOR ALL** bars: positive stock prices, gaps, halts, zero volume
- **AND** k: nonnegative integer selecting t modulo bars.length
- **AND** tail: valid bars replacing bars after t
- **THEN** signals(bars)[0..t] equals signals(prefix ++ tail)[0..t]
- **RUNS** 1000
- **DISCARDS** <= 10%
- **COVERAGE** gap >= 5%
- **COVERAGE** halt >= 5%
- **COVERAGE** zero-volume >= 5%
```

IDs are the slug of requirement title plus block title:
`no-lookahead-future-independence`. Scenario and Property IDs must be unique.
FOR ALL and THEN are required; RUNS is a positive safe integer. AND before THEN
adds generator descriptions; AND after THEN adds a relation. Descriptions are
not interpreted as generators or code.

DISCARDS declares the maximum skipped/(successful+skipped) ratio. Without this
clause, zero discards are allowed; no universal permissive threshold is assumed.
COVERAGE declares a minimum fraction of successful evaluated inputs for each
category. Multiple labels may describe one input.

```yaml
scenarios:
  - scenario: no-lookahead-future-independence
    test: tests/no-lookahead.test.js
    generators:
      - tests/generator.js
    corpus: orca/corpus/no-lookahead-future-independence.json
```

The existing `scenario` mapping key also identifies a Property. Generator source
paths are required and hash-bound; inline definitions may map the test file.
Corpus paths must be `orca/corpus/<slug>.json` or
`openspec/corpus/<slug>.json`, without symlink ancestors.

```js
import { it, expect } from 'vitest';
import { assertProperty, fc } from '@gotako/orca/property';

it('[arithmetic-identity]', async () => {
  const run = await assertProperty({
    id: 'arithmetic-identity',
    seed: 123,
    numRuns: 1000,
    corpus: 'orca/corpus/arithmetic-identity.json',
    arbitrary: fc.integer(),
    predicate: n => n === n,
    classify: n => [n === 0 ? 'zero' : 'nonzero'],
  });
  expect(run.failed).toBe(false);
});
```

The helper owns `fc.check`, records its actual successful executions, precondition
skips, seed, shrinks and failure path, and observes categories on successful
predicate evaluations. Seed must be explicit and fit a signed 32-bit integer.
Predicates and classifiers should be deterministic and should not mutate inputs.
The helper's predicates may return false, throw an assertion or use `fc.pre`.
Setup/runtime exceptions and excessive framework skips are inconclusive.

The verifier supplies a fresh invocation ID and receipt directory. Missing,
duplicate, malformed, stale or incompatible helper receipts fail verification
even when the enclosing assertion passed. The current spec controls RUNS,
discard and category thresholds. The receipt binds adapter/framework hashes,
generator files, corpus bytes and #14 runner/test/source/reporter evidence.
Archive and outcome acceptance rerun this contract. `--coverage-only` is
bookkeeping and cannot establish Property execution.

## Concrete regression corpus

Every supported minimized failing input is saved with seed, path and framework
version. The helper replays all stored inputs directly against the predicate
before generating new samples. Changing the generator cannot remove those
evaluations. Skipped or failed corpus cases cannot establish GREEN.

The versioned codec preserves plain records, arrays and primitive values,
including NaN, infinities, negative zero, undefined and BigInt. Class instances,
functions and cyclic objects are unsupported; normalize them explicitly.
This preserves values rather than silently applying lossy JSON conversion.
Domain validity remains the author's responsibility.

Failed runs print seed/path/corpus replay instructions. A new corpus entry
changes verification inputs, so the failed run cannot also claim unchanged
acceptance evidence. Retain the case, fix the bug, then verify again; use
`record-red`/`verify --base` for actual regression evidence. Base/head replay
overlays identical generator and corpus bytes as well as the selected tests.
Property-found bugs should link their concrete case to the normal regression
scenario/bug intent; the helper does not invent issue acceptance.

## Isolated mutation probes

```json
{
  "version": 1,
  "id": "future-dependency",
  "rationale": "Replace the known-data threshold with a future-data threshold",
  "changes": [
    {
      "path": "src/strategy.js",
      "before_sha256": "<SHA256 of current source bytes>",
      "after": "<complete mutated source>"
    }
  ]
}
```

Run `orca property-probe <change> --property <id> --mutation <mutation.json>`.
The command executes baseline GREEN, copies the actual current source into an
owned temporary Git project, applies pinned edits and reruns the same tests.
It preserves the caller's dirty state and keeps setup/cleanup outcomes explicit.
Tests, generator definitions, dependencies and harness metadata cannot be
mutation targets. Unsupported snapshots or stale targets are invalid.

Receipts under `.harness/property-probes/` distinguish:

- `killed`: selected assertion-failure RED after a GREEN baseline.
- `survived`: the selected contract remains GREEN.
- `invalid`: setup, malformed/stale edits, inconclusive execution or cleanup.
- `unavailable`: no applicable mutation supplied; CLI exit 2.
- `equivalent`: a surviving probe accepted by a separate configured human
  signature. Survival alone never establishes equivalence.

Mutation rationale declares relevance; it is not automatic proof of relevance.
Orca records outcomes and does not turn them into a blocking MUST policy or
fabricate a successful kill count. Seal owns relevance/equivalence policy and
the blocking verdict. Compile failure is never a kill.

For equivalence, an operator imports `equivalenceDigest` from
`@gotako/orca/property/probe`, reads the preserved surviving receipt and supplies
a rationale. Sign `JSON.stringify(['orca-property-equivalence/v1', digest])`
with a configured human Ed25519 key, then supply:

```json
{"reviewer":"owner","rationale":"<reviewed reason>","signature":"<base64 signature>"}
```

Pass that file with `--equivalence <review.json>` and the same mutation file.
The command uses the preserved probe, verifies the operator-pinned signature
and source/test/runner freshness, then reruns the mutation before classifying it.
Keep reviewer configuration/private keys outside the project and review files
outside source paths (for example under the change's `.harness`).
The agent does not create operator authority or sign its own acceptance.

## Scope of the evidence

Finite samples establish tested observations, not mathematical correctness or
trading profitability. The trading example defines positive stock-price
validity, ten-bar warm-up, one output per bar, and future-tail timestamps aligned
after the retained prefix. Futures, NaN rejection and other event-stream domains
need their own declared generators and policies.

Hashes bind the installed adapter/framework entry and local code. They do not
attest a compromised runtime or every transitive dependency. Seed replay assumes
compatible generators/libraries; concrete corpus replay survives generator
changes. Hypothesis and other property frameworks are unsupported in this adapter.

Framework run semantics:
[fast-check RunDetails](https://fast-check.dev/docs/api/interfaces/RunDetailsCommon/).

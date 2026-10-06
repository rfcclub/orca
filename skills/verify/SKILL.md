---
name: verify
description: Use when checking scenario coverage, running test suite, and producing .orca-verify.json gate output
---

# Verify

## Overview

Check that all SHALL/MUST scenarios have passing tests, run the test suite, and produce a verified coverage gate report.

## When to Use

- Before archive — verify gate must pass
- After all TDD tasks for a change are complete
- When checking coverage status mid-implementation
- `/lk:verify` in Claude Code; equivalent trigger in other tools

## Instructions

1. Map every SHALL/MUST scenario to a local test file in `.traceability.yaml`.
   Name the Vitest assertion with `[scenario-id]` or provide its exact full
   name through `assertion`. A physical assertion cannot cover multiple IDs.
2. Run the full project tests and build and retain their real reporter output.
3. Run `orca verify <name>`. The CLI executes the mapped assertions itself and
   writes `.orca-verify.json`; never write or alter that receipt by hand.
4. For a bug regression, use `orca verify <name> --base <commit>`. Declare any
   required test-only setup files with comma-separated `--harness` paths.
   Setup/import failures are inconclusive, not RED.
5. Inspect `execution_verified`, `execution`, `replay`, `inputs` and `reasons`.
   `--coverage-only` is explicitly non-executable and cannot satisfy code
   acceptance or ordinary archive. Re-run verify after changes to inputs.

## Output

- `.orca-verify.json` in change directory

## Validation

- Is the JSON well-formed?
- Are mandatory scenarios calculated correctly (SHALL/MUST only)?
- PASS requires every mandatory assertion to execute successfully
- Timestamp is valid ISO-8601

## Anti-Patterns

- Including optional scenarios in mandatory coverage count
- Reporting gate=pass when tests fail
- Not reading the actual spec (hardcoded coverage numbers)
- Skipping traceability check
- Authoring a PASS receipt or treating YAML status as execution evidence

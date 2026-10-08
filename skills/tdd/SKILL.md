---
name: tdd
description: Use when implementing code following RED/GREEN/REFACTOR cycle with scenario traceability
---

# TDD (Test-Driven Development)

## Overview

Iron Law: no production code without a failing test first. RED → GREEN → REFACTOR cycle per requirement. Every test maps to a spec scenario.

## When to Use

- When implementing a task from tasks.md
- When writing production code
- When fixing a bug (write failing test first)
- `/lk:apply` in Claude Code; equivalent trigger in other tools

## Instructions

1. **Iron Law:** If any production code exists without a preceding failing test, **delete the code**, write the test first, then re-implement.
2. **RED phase:** Write a test that fails for the right reason:
   - Test exactly one scenario (or cohesive subset)
   - Test name references scenario ID: `[user-login-valid-credentials] user can login`
   - Run test → confirm RED (failure is informative, not a crash)
3. **GREEN phase:** Write minimal production code to pass the test:
   - No extra functionality beyond what the test demands
   - Run test → confirm GREEN
4. **REFACTOR phase:** Clean up:
   - Remove duplication
   - Improve naming
   - Extract helpers if needed
   - Tests must still pass after refactor
5. **Commit:** `feat: SC-001 — user login (tdd)`
6. **After all tasks complete:** Generate `.traceability.yaml` mapping.
   `status` is optional bookkeeping and never establishes execution:
   ```yaml
   scenarios:
     - scenario: user-login-valid-credentials
       test: tests/auth/login.test.ts
     - scenario: user-logout-session-cleared
       test: tests/auth/logout.test.ts
   ```
7. Record scenario RED with `orca record-red <name>` or task RED with
   `orca plan-json start <name> <task-id>` before production edits. Completion
   executes the unchanged task test directly; arbitrary shell commands are
   unsupported. Run executable verify after GREEN.

## Output

- Production code + test files
- `.traceability.yaml` in change directory

## Validation

- No production code committed without preceding failing test
- Every test name references a scenario ID
- REFACTOR does not break tests
- Traceability covers all SHALL/MUST scenarios

## Anti-Patterns

- Writing production code first (breaks Iron Law) — delete and restart
- Writing tests after code — delete code, rewrite test first
- Tests that pass for wrong reasons (false positives)
- Refactoring without re-running tests
- Missing traceability mapping at end

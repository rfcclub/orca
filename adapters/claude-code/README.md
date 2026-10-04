# Orca — Claude Code Adapter

Integrates Orca's spec-driven workflow into Claude Code via `CLAUDE.md` and skill files in `~/.claude/skills/`.

## How It Works

- **`CLAUDE.md`** — placed at project root, Claude Code reads it automatically for project-level instructions. Defines workflow commands (`/lk:*`), skill references, TDD enforcement rules.
- **`~/.claude/skills/orca-*/SKILL.md`** — per-phase instructions that Claude Code loads as domain skills. One per workflow phase (brainstorm, spec, design, plan, tdd, verify, archive).

## Setup

1. **Place `CLAUDE.md` at project root:**
   ```bash
   cp adapters/claude-code/CLAUDE.md <your-project>/CLAUDE.md
   ```

2. **Install skill files:**
   ```bash
   cd <your-project>   # must have orca/ directory
   bash adapters/claude-code/generate-skills.sh
   ```

3. **Verify installation:**
   ```bash
   ls ~/.claude/skills/orca-*/
   ```
   Should show 7 skill directories.

4. **Confirm `orca/config.yaml` exists** (scaffold with `orca init` when CLI is available).

## Usage

In Claude Code chat, use slash commands:

```
/lk:brainstorm  → explore a feature, produce proposal.md
/lk:spec        → write structured requirements
/lk:design      → produce technical design
/lk:plan        → break down into tasks
/lk:apply       → implement with RED/GREEN/REFACTOR
/lk:verify      → check coverage and run tests
/lk:archive     → merge verified change into living specs
```

## Updating Skills

If Orca skills are updated, re-run:

```bash
bash adapters/claude-code/generate-skills.sh
```

This overwrites only the Orca skills in `~/.claude/skills/orca-*/`.

## Notes

- Claude Code loads `CLAUDE.md` automatically when present in the project root.
- Skill files in `~/.claude/skills/orca-*` are auto-discovered by Claude Code.
- The `generate-skills.sh` script is safe to re-run (idempotent).
- To remove a skill, delete its directory: `rm -rf ~/.claude/skills/orca-<name>`.

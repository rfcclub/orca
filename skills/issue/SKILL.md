---
name: issue
description: Use when an intent should become a GitHub issue, or when preparing a repo to receive orca issues — create one idempotent never-approved issue from a change, or set up labels, workflow and reviewers
---

# Issue

## Overview

A GitHub issue typed `bug` or `enhancement` is the draft intent; a human approves it, then orca freezes it. Agents author issues, they never approve them. Two commands cover the agent side. The CLI binary is `loomkit` until the rename to `orca` lands.

## When to Use

- You decided a change deserves tracking as an issue (you choose which; orca does not bulk-import).
- A repo has no `orca-issue.yml` workflow, `orca:*` labels or `openspec/actors.yaml` yet.

## Create one issue from a change

```
loomkit issue create --from-change <name> --shape <bug|enhancement> [--title "<t>"] [--dry-run] [--repo owner/name]
```

- Reads `openspec/changes/<name>/intent.md`; the body is that text as written. Nothing is filled in.
- Always run `--dry-run` first: it prints the title, labels and which required sections are missing, with no GitHub call.
- A missing section is reported, not fixed: add it to intent.md yourself, from facts the author stated, or leave it. Never invent success criteria or non-goals.
- Idempotent: the URL is written to `openspec/changes/<name>/.issue`; a second call reports it and creates nothing.
- The issue carries only the shape label. Never add `orca:approved`; only a human reviewer approves.
- The intent text becomes public if the repo is public. Check the repo's visibility and that the text has no secrets or private content first.

## Prepare a repo

```
loomkit issue init --reviewer <login> [--reviewer <login>] [--agent <login>] [--force] [--repo owner/name]
```

- Ensures the `orca:*` labels and `orca:approved`, writes `.github/workflows/orca-issue.yml` and `openspec/actors.yaml`. Run it from the repo root.
- At least one human `--reviewer` is required. Put your own login under `--agent`.
- Existing files are kept unless `--force`. Commit the files on a branch and open a PR; actors.yaml is read from the default branch, so changing reviewers needs a reviewed PR.

## Rules

- Create at most what the owner asked for: the owner reviews a few intents a week, not the whole backlog.
- Use English only in intents and issues.
- Report the URL you created, or the reason you did not.

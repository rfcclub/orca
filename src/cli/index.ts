#!/usr/bin/env node

import { cmdInit } from './commands/init.js';
import { cmdIntent } from './commands/intent.js';
import { cmdSpec } from './commands/spec.js';
import { cmdDesign } from './commands/design.js';
import { cmdPlan } from './commands/plan.js';
import { cmdVerify } from './commands/verify.js';
import { cmdArchive } from './commands/archive.js';
import { cmdStatus } from './commands/status.js';
import { cmdAdapt } from './commands/adapt.js';
import { cmdPublish } from './commands/publish.js';
import { cmdShow } from './commands/show.js';
import { cmdSelfCheck } from './commands/self-check.js';
import { cmdGateCode } from './commands/gate-code.js';
import { cmdGatePlan } from './commands/gate-plan.js';
import { cmdCraft } from './commands/craft.js';
import { cmdGatePipeline } from './commands/gate-pipeline.js';
import { cmdLearn } from './commands/learn.js';
import { cmdPlanJson } from './commands/plan-json.js';
import { cmdIssue } from './commands/issue.js';
import { cmdPr } from './commands/pr.js';
import { cmdGha } from './commands/gha.js';
import { cmdCheckOutcomes } from './commands/check-outcomes.js';
import { cmdReviewOutcome } from './commands/review-outcome.js';
import { cmdPropertyProbe } from './commands/property-probe.js';
import { cmdLoop, cmdLoopWatch } from './commands/loop.js';

const command = process.argv[2];
const args = process.argv.slice(3);

async function main() {
switch (command) {
  case 'loop':
    if (!args[0] || args[0].startsWith('--')) throw new Error('Usage: orca loop <name> [--config loop.config.json]');
    await cmdLoop(args[0], args.slice(1));
    break;
  case 'loop-watch':
    await cmdLoopWatch(args);
    break;
  case 'init':
    cmdInit();
    break;
  case 'intent':
    if (!args[0]) { console.error('Usage: orca intent <name>'); process.exit(1); }
    cmdIntent(args[0]);
    break;
  case 'spec':
    if (!args[0]) { console.error('Usage: orca spec <name>'); process.exit(1); }
    cmdSpec(args[0]);
    break;
  case 'design':
    if (!args[0]) { console.error('Usage: orca design <name>'); process.exit(1); }
    cmdDesign(args[0]);
    break;
  case 'plan':
    if (!args[0]) { console.error('Usage: orca plan <name>'); process.exit(1); }
    cmdPlan(args[0]);
    break;
  case 'verify':
    cmdVerify(args[0]?.startsWith('--') ? undefined : args[0], {
      skip: args.includes('--skip-state-check'), coverageOnly: args.includes('--coverage-only'),
      base: argumentValue(args, '--base'),
      harness: argumentValue(args, '--harness')?.split(',').map(s => s.trim()).filter(Boolean),
    });
    break;
  case 'record-red':
    if (!args[0]) { console.error('Usage: orca record-red <name>'); process.exit(1); }
    cmdVerify(args[0], { expected: 'red' });
    break;
  case 'property-probe':
    if (!args[0] || !argumentValue(args, '--property')) {
      console.error('Usage: orca property-probe <name> --property <id> [--mutation <json>] [--equivalence <review.json>]');
      process.exit(1);
    }
    cmdPropertyProbe(args[0], { property: argumentValue(args, '--property')!,
      mutation: argumentValue(args, '--mutation'), equivalence: argumentValue(args, '--equivalence') });
    break;
  case 'check-outcomes':
    if (!args[0]) { console.error('Usage: orca check-outcomes <name> [--online | --local-review]'); process.exit(1); }
    await cmdCheckOutcomes(args[0], { online: args.includes('--online'), localReview: args.includes('--local-review') });
    break;
  case 'review-outcome':
    if (!args[0]) { console.error('Usage: orca review-outcome <name> --stage <id> --digest <sha256> --reviewer <id> --key <path>'); process.exit(1); }
    await cmdReviewOutcome(args[0], args.slice(1));
    break;
  case 'archive':
    if (!args[0]) { console.error('Usage: orca archive <name> [--force --reason="..."]'); process.exit(1); }
    const force = process.argv.includes('--force');
    const reasonIdx = process.argv.indexOf('--reason');
    const reason = reasonIdx >= 0 ? process.argv[reasonIdx + 1] : '';
    cmdArchive(args[0], { force, reason });
    break;
  case 'publish':
    const dryRun = process.argv.includes('--dry-run');
    cmdPublish({ dryRun });
    break;
  case 'show':
    cmdShow(args[0] || undefined);
    break;
  case 'status':
    await cmdStatus();
    break;
  case 'adapt':
    if (!args[0]) { console.error('Usage: orca adapt <tool> (claude-code | codex)'); process.exit(1); }
    cmdAdapt(args[0]);
    break;
  case 'self-check':
    if (!args[0]) { console.error('Usage: orca self-check <name>'); process.exit(1); }
    cmdSelfCheck(args[0]);
    break;
  case 'gate-code':
    if (!args[0]) { console.error('Usage: orca gate-code <name> [--skip-state-check] [--llm [provider]]'); process.exit(1); }
    {
      const llmIdx = args.indexOf('--llm')
      const llm = llmIdx >= 0 ? (args[llmIdx + 1] && !args[llmIdx + 1].startsWith('-') ? args[llmIdx + 1] : '') : undefined
      await cmdGateCode(args[0], { skip: process.argv.includes('--skip-state-check'), llm })
    }
    break;
  case 'gate-plan':
    if (!args[0]) { console.error('Usage: orca gate-plan <name> [--llm [provider]]'); process.exit(1); }
    {
      const llmIdx = args.indexOf('--llm')
      const llm = llmIdx >= 0 ? (args[llmIdx + 1] && !args[llmIdx + 1].startsWith('-') ? args[llmIdx + 1] : '') : undefined
      await cmdGatePlan(args[0], { llm })
    }
    break;
  case 'craft':
    if (!args[0]) { console.error('Usage: orca craft <name>'); process.exit(1); }
    cmdCraft(args[0]);
    break;
  case 'gate-pipeline':
    cmdGatePipeline();
    break;
  case 'learn':
    if (!args[0]) { console.error('Usage: orca learn <name>'); process.exit(1); }
    cmdLearn(args[0]);
    break;
  case 'plan-json':
    if (!args[0] || !args[1]) { console.error('Usage: orca plan-json <init|add|start|complete|finish|show> <name> [options]'); process.exit(1); }
    await cmdPlanJson(args[0], args[1], args.slice(2));
    break;
  case 'issue':
    await cmdIssue(args);
    break;
  case 'pr':
    await cmdPr(args);
    break;
  case 'gha':
    await cmdGha(args[0]);
    break;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
}

main().catch(err => { console.error(err); process.exit(1); });

function printHelp(): void {
  console.log(`
Orca — Harness Engineering Framework

Usage: orca <command> [options]

Workflow commands:
  init                    Scaffold orca/ directory
  intent <name>           Create an intent artifact (problem, outcome, non-goals)
  spec <name>             Create a new change with proposal + spec
  design <name>           Add design.md to existing change
  plan <name>             Add tasks.md to existing change
  show [name]             Show change details (all changes if no name)
  verify [name]           Execute local Vitest for required assertion mappings
                          --coverage-only: historical bookkeeping, never execution proof
                          --base <commit> [--harness tests/helper.ts,vitest.config.ts]
                          Replay identical regression tests at base and current source
  record-red <name>       Record genuine assertion-failure RED with input bindings
  property-probe <name>   Record isolated mutation outcome (--property, --mutation)
                          --equivalence <review.json>: operator-signed equivalence review
  check-outcomes <name>   Check outcome evidence [--local-review | --online]
  review-outcome <name>   Sign local review (--stage, --digest, --reviewer, --key)
  archive <name>          Archive verified change

Harness commands:
  loop <name>            Drive an approved plan through bounded Pilotfish, gates and verify
                          --config <json> --max-tasks --max-attempts --wall-ms
                          --token-budget --max-tokens (driver-enforced per-attempt cap)
  loop-watch             Poll local ready files (--once | --max-polls, --interval-ms)
                          --max-changes defaults to 1; same loop options apply
  self-check <name>       Scaffold self-check.md (claims, evidence, limitations)
  gate-plan <name>        Run SEAL plan review with criteria locked from the approved intent [--llm [provider]]
  gate-code <name>        Run SEAL gate on current diff [--skip-state-check] [--llm [provider]]
  craft <name>            Show craft review verdict (maintainability)
  gate-pipeline           Aggregate all change verdicts → SHIP/HOLD/ESCALATE
  learn <name>            Extract lessons from gate history
  plan-json <action> <name> [options]
                          Weak-model task list, nested inside phase.json's apply phase
                          (init|add|start|red|complete|finish|show)
                          init:     --trace <INTENT-ID> --resolved-by <name>
                          add:      --id --behavior --acceptance --files --test [--assertion] [--consumes]
                          start/red:<task-id> [--skip-state-check] (requires executed assertion RED)
                          complete: <task-id> [--debug-session --debug-cycle --root-cause] [--escalated]
                          finish:   closes phase.json's "apply" phase once all tasks are complete
                          show:     (no options)

Optional GitHub issue commands (local intent.md works without GitHub):
  issue classify <n>      Check an issue's sections against its bug/enhancement shape
  issue draft <n> [--post]  Draft missing sections as tagged lines (needs drafting.provider)
  issue open <n> --name <change>
                          Create the change folder from an approved issue
  issue create --from-change <name> --shape <bug|enhancement> [--title <t>] [--dry-run]
                          Create one issue from a change's intent.md (once; never approved)
  issue init --reviewer <login> [--agent <login>] [--force]
                          Set up a repo: orca labels, workflow, openspec/actors.yaml
  gha run                 GitHub Action entry point (reads the event payload; sets labels/comments)

PR commands (GitHub App as the authoring identity):
  pr create --repo owner/name --head branch --title <t> [--body <b>] [--base <branch>] [--issue <n>]
                          Create a pull request as the github-app App installation
  pr token [--repo owner/name]
                          Print a short-lived installation token (for gh/GIT_AUTH)

Other:
  publish [--dry-run]     Publish current version to npm
  status                  Show current changes + coverage
  adapt <tool>            Show adapter instructions (claude-code | codex)
  help                    Show this help
`);
}

function argumentValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

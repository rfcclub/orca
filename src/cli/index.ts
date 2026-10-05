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

const command = process.argv[2];
const args = process.argv.slice(3);

async function main() {
switch (command) {
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
    cmdVerify(args[0] || undefined, { skip: process.argv.includes('--skip-state-check') });
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
  verify [name]           Run coverage gate (all changes if no name)
  archive <name>          Archive verified change

Harness commands:
  self-check <name>       Scaffold self-check.md (claims, evidence, limitations)
  gate-plan <name>        Run SEAL plan review with criteria locked from the approved intent [--llm [provider]]
  gate-code <name>        Run SEAL gate on current diff [--skip-state-check] [--llm [provider]]
  craft <name>            Show craft review verdict (maintainability)
  gate-pipeline           Aggregate all change verdicts → SHIP/HOLD/ESCALATE
  learn <name>            Extract lessons from gate history
  plan-json <action> <name> [options]
                          Weak-model task list, nested inside phase.json's apply phase
                          (init|add|start|complete|finish|show)
                          init:     --trace <INTENT-ID> --resolved-by <name>
                          add:      --id --behavior --acceptance --files --test [--consumes]
                          start:    <task-id> [--skip-state-check]
                          complete: <task-id> --test-cmd "<cmd>" [--debug-session --debug-cycle --root-cause] [--escalated]
                          finish:   closes phase.json's "apply" phase once all tasks are complete
                          show:     (no options)

Issue commands (GitHub issue as the intent of record):
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

# Local family runtime candidate

Orca beta.8 bundles the reviewed Seal 0.5.1, Pilotfish 0.2.0-beta.4 and Hammerhead 0.5.0-beta.1 local tarballs and their SHA256 files. This dependency configuration update removes the old Pilotfish→LoomKit runtime chain. No runtime policy code changes. GitHub PRs are optional review delivery, not prerequisites to normal local file commands.

Pilotfish imports Orca's public reader/types through a runtime-required peer; optional npm auto-install metadata prevents recursive package installation. The enclosing Orca package satisfies that peer. Seal retains mandatory Property hard blocking; Hammerhead remains a manual handoff. No provider commands/model identifiers or user loop config are changed.

To select bundled Pilotfish in loop config on this machine, use /opt/homebrew/lib/node_modules/@gotako/orca/node_modules/@gotako/pilotfish/dist/index.js for pilotfishModule, preserving the existing driver/roles. Alternatively use the installed standalone /opt/homebrew/lib/node_modules/@gotako/pilotfish/dist/index.js. The loop requires an explicit trusted driver with bounded token reservations; this is not provider billing enforcement or an OS sandbox.

## Rollback plan

Before replacing Orca beta.7, preserve the complete installed package tree and registered launcher target in ~/.local/state/orca/deploy/20261006-family-runtime/. Restore those exact predecessor bytes if isolated/default loop, Property gates or debug CLI checks fail. Standalone family installations have their own receipts and rollback instructions. No npm publication, approval or merge is performed.

Acceptance requires a completed build/full tests, a fresh offline package installed in isolation, no LoomKit package in its runtime tree, actual default loop task/gate/verify behavior, blocking Property cases and the bundled Hammerhead CLI checks. Historical gate verdicts remain scoped to their recorded precommit bindings.

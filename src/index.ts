export { parseSpec, validateSpec, parseAssertion, parseDeltaSpec, mergeSpecs } from './spec/index.js';
export type { SpecTree, Requirement, Scenario, Assertion, DeltaSpec, ValidationResult } from './spec/index.js';

export { validatePlan } from './plan/validator.js';

export { loadConfig } from './config/loader.js';
export type { OrcaConfig } from './config/loader.js';

export { TraceabilityMap, calculateCoverage } from './tdd/traceability.js';
export type { ScenarioMapping, CoverageResult } from './tdd/traceability.js';

export { verify } from './verify/verify.js';
export type { VerifyInput, VerifyResult } from './verify/verify.js';

export { canArchive, createArchiveMetadata } from './archive/archive.js';
export type { ArchiveMetadata, ForceOptions } from './archive/archive.js';

export { parseBrainstorm, validateBrainstorm } from './brainstorm/parser.js';
export type { BrainstormOutput, BrainstormValidation } from './brainstorm/parser.js';

export { loadSchema } from './schema/loader.js';
export type { WorkflowSchema, ArtifactDef } from './schema/loader.js';

// Harness — plan.json (weak-model task list) read access for external consumers
// (e.g. pilotfish), so they read the same file orca itself writes rather than
// re-parsing plan.json independently.
export { readPlanJson, findProducerTask } from './harness/plan-json.js';
export type {
  PlanJson,
  PlanTask,
  PlanTraceRef,
  PlanEscalation,
  TaskArtifact,
  TaskStatus,
  DebugRef,
  DebugRefCost,
} from './harness/types.js';

// Issue-as-intent — pure logic over an injected GitHubPort (see openspec/changes/issue-as-intent)
export { classifyIssue } from './issue/classify.js';
export type { Classification, Shape } from './issue/classify.js';
export { decideApproval, parseActors, kindOf } from './issue/approval.js';
export type { ApprovalDecision } from './issue/approval.js';
export { findUnacceptedProposed } from './issue/proposed.js';
export { resolveStatus, remotePhase, parseIssueRef } from './issue/status.js';
export type { Remote, ResolvedStatus } from './issue/status.js';
export { localPhase } from './issue/phase.js';
export type { OrcaPhase } from './issue/phase.js';
export type { GitHubPort } from './issue/github.js';
export type { Actors, Issue, Comment } from './issue/types.js';
export { checkOutcomes, readOutcomeContract, contractDigest } from './harness/outcomes.js';
export { localOutcomeReview, signLocalOutcomeReview, localReviewersPath } from './harness/local-review.js';
export type { OutcomeContract, OutcomeReport, OutcomeAssessment, OutcomeState, OutcomeReview } from './harness/outcomes.js';

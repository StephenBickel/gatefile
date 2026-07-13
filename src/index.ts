export * from "./types";
export * from "./planner";
export * from "./applier";
export * from "./apply-format";
export * from "./adapter";
export * from "./risk";
export * from "./preconditions";
export * from "./hash";
export * from "./verify";
export * from "./validation";
export * from "./inspect";
export * from "./pr-review";
export * from "./pipeline";
export * from "./audit";
export { reviewPlan } from "./review";
export { fireOnPlanCreated, fireOnApprovalNeeded, loadHooksConfig } from "./hooks";
export type { HookAction, HooksConfig } from "./hooks";
export type { GatefileConfig } from "./types";
export {
  createPlan,
  inspectPlan,
  approvePlan as approvePlanFile,
  verifyPlan as verifyPlanFile,
  applyPlan as applyPlanFile,
  rollbackApply as rollbackApplyFile
} from "./sdk";
export type {
  SdkEngineOptions,
  CreateOptions,
  InspectOptions,
  ApproveOptions,
  ApplyOptions,
  VerifyOptions,
  RollbackContext,
  SdkApplyReport,
  ApprovalResult,
  InspectResult,
  VerifyResult
} from "./sdk";
export { generateApprovalAttestationKeyPair, createApprovalAttestation, verifyApprovalAttestation } from "./attestation";
export { normalizeGatefileConfig } from "./config";
export { startMcpServer } from "./mcp";
export { GatefileEngine } from "./engine";
export type {
  GatefileEngineOptions,
  GatefileEngineContext,
  EnginePlanOptions,
  EngineApproveOptions
} from "./engine";
export {
  createPlanFromDraft,
  approvePlan,
  verifyPlan,
  buildInspectReport,
  previewPlan,
  applyPlan,
  rollbackApply
} from "./engine-api";

import { repositoryIdForRoot as resolveRepositoryIdForRoot } from "./state";

/** Stable, non-secret identity for binding a plan to its intended repository. */
export function repositoryIdForRoot(repoRoot?: string): string {
  return resolveRepositoryIdForRoot(repoRoot);
}

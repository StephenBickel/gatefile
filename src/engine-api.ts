import { GatefileEngine, type GatefileEngineOptions } from "./engine";
import type { PlanRuntimeOptions } from "./applier";
import type { InspectOptions, InspectReport } from "./inspect";
import type {
  ApprovePlanOptions,
  CreatePlanOptions,
  PlanDraft
} from "./planner";
import type {
  ApplyReport,
  DryRunReport,
  PlanFile,
  RollbackReport,
  VerifyPlanReport
} from "./types";
import { validatePlanFile } from "./validation";
import type { VerifyPlanOptions } from "./verify";

export interface ApprovePlanApiOptions extends ApprovePlanOptions,
  Pick<GatefileEngineOptions, "repoRoot" | "repositoryId" | "config"> {}

export function createPlanFromDraft(
  draft: PlanDraft,
  options: CreatePlanOptions = {}
): PlanFile {
  return new GatefileEngine({
    repoRoot: options.repoRoot,
    repositoryId: options.context?.repositoryId
  }).createPlan(draft);
}

export function approvePlan(
  plan: PlanFile,
  approvedBy: string,
  options: ApprovePlanApiOptions = {}
): PlanFile {
  validatePlanFile(plan);
  const { repoRoot, repositoryId, config, ...approveOptions } = options;
  return new GatefileEngine({
    repoRoot,
    repositoryId,
    config
  }).approvePlan(plan, approvedBy, approveOptions);
}

export function verifyPlan(
  plan: PlanFile,
  options: VerifyPlanOptions = {}
): VerifyPlanReport {
  return new GatefileEngine({
    repoRoot: options.repoRoot,
    repositoryId: options.repositoryId,
    config: options.config
  }).verifyPlan(plan);
}

export function buildInspectReport(
  plan: PlanFile,
  options: InspectOptions = {}
): InspectReport {
  return new GatefileEngine({
    repoRoot: options.repoRoot,
    repositoryId: options.repositoryId,
    stateHome: options.stateHome,
    config: options.config
  }).inspectPlan(plan);
}

export function previewPlan(
  plan: PlanFile,
  options: PlanRuntimeOptions = {}
): DryRunReport {
  return new GatefileEngine({
    repoRoot: options.repoRoot,
    repositoryId: options.repositoryId,
    stateHome: options.stateHome,
    config: options.config
  }).previewPlan(plan, { planPath: options.planPath });
}

export function applyPlan(
  plan: PlanFile,
  options: PlanRuntimeOptions = {}
): ApplyReport {
  return new GatefileEngine({
    repoRoot: options.repoRoot,
    repositoryId: options.repositoryId,
    stateHome: options.stateHome,
    config: options.config
  }).applyPlan(plan, { planPath: options.planPath });
}

export function rollbackApply(
  receiptId: string,
  options: PlanRuntimeOptions = {}
): RollbackReport {
  return new GatefileEngine({
    repoRoot: options.repoRoot,
    repositoryId: options.repositoryId,
    stateHome: options.stateHome,
    config: options.config
  }).rollbackApply(receiptId);
}

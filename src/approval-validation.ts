import { scoreRisk } from "./risk";
import { PlanFile } from "./types";
import { riskProfilesEqual, validatePlanFile } from "./validation";

/** Shared pre-hook validation for every approval path. */
export function validatePlanForApproval(plan: PlanFile): void {
  validatePlanFile(plan);
  const recomputedRisk = scoreRisk(plan.operations);
  if (!riskProfilesEqual(plan.risk, recomputedRisk)) {
    throw new Error("Cannot approve plan: stored risk does not match risk recomputed from operations");
  }
}

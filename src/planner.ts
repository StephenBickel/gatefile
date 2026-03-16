import { randomUUID } from "node:crypto";
import { PlanFile } from "./types";
import { scoreRisk } from "./risk";
import { computePlanHash, withComputedIntegrity } from "./hash";

export type PlanDraft = Omit<
  PlanFile,
  "id" | "createdAt" | "risk" | "approval" | "version" | "integrity"
> & {
  version?: string;
};

export function createPlanFromDraft(draft: PlanDraft): PlanFile {
  if (!draft.operations || draft.operations.length === 0) {
    throw new Error("Plan draft must include at least one operation");
  }

  const risk = scoreRisk(draft.operations);

  const planWithoutIntegrity: Omit<PlanFile, "integrity"> = {
    version: draft.version ?? "0.1",
    id: `plan_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    source: draft.source,
    summary: draft.summary,
    operations: draft.operations,
    preconditions: draft.preconditions ?? [],
    risk,
    approval: {
      status: "pending"
    }
  };

  if (draft.execution) {
    planWithoutIntegrity.execution = draft.execution;
  }

  return withComputedIntegrity(planWithoutIntegrity);
}

export function approvePlan(plan: PlanFile, approvedBy: string): PlanFile {
  const currentHash = computePlanHash(plan);
  if (
    plan.approval.status === "approved" &&
    plan.approval.approvedPlanHash === currentHash
  ) {
    return plan;
  }

  return withComputedIntegrity({
    ...plan,
    approval: {
      status: "approved",
      approvedBy,
      approvedAt: new Date().toISOString(),
      approvedPlanHash: currentHash
    }
  });
}

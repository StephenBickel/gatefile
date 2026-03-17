import { randomUUID } from "node:crypto";
import { PlanFile } from "./types";
import { scoreRisk } from "./risk";
import { computePlanHash, withComputedIntegrity } from "./hash";
import { createApprovalAttestation } from "./attestation";

export type PlanDraft = Omit<
  PlanFile,
  "id" | "createdAt" | "risk" | "approval" | "version" | "integrity"
> & {
  version?: string;
};

export interface ApprovePlanOptions {
  signingPrivateKeyPem?: string;
  signingKeyId?: string;
}

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
    ...(draft.dependsOn ? { dependsOn: draft.dependsOn } : {}),
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

export function approvePlan(
  plan: PlanFile,
  approvedBy: string,
  options: ApprovePlanOptions = {}
): PlanFile {
  const currentHash = computePlanHash(plan);
  const shouldSign = Boolean(options.signingPrivateKeyPem);
  if (
    plan.approval.status === "approved" &&
    plan.approval.approvedPlanHash === currentHash &&
    !shouldSign
  ) {
    return plan;
  }

  const approvedAt = new Date().toISOString();
  const attestation = options.signingPrivateKeyPem
    ? createApprovalAttestation(
        {
          planId: plan.id,
          approvedBy,
          approvedAt,
          approvedPlanHash: currentHash
        },
        options.signingPrivateKeyPem,
        { keyId: options.signingKeyId }
      )
    : undefined;

  return withComputedIntegrity({
    ...plan,
    approval: {
      status: "approved",
      approvedBy,
      approvedAt,
      approvedPlanHash: currentHash,
      ...(attestation ? { attestation } : {})
    }
  });
}

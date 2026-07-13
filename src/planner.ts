import { randomUUID } from "node:crypto";
import { PLAN_VERSION, PlanContext, PlanFile } from "./types";
import { scoreRisk } from "./risk";
import { computePlanHash, withComputedIntegrity } from "./hash";
import { createApprovalAttestation } from "./attestation";
import { validatePlanDraft, validatePlanFile } from "./validation";
import { repositoryIdForRoot } from "./state";
import { validatePlanForApproval } from "./approval-validation";

export type PlanDraft = Omit<
  PlanFile,
  | "id"
  | "createdAt"
  | "context"
  | "risk"
  | "approval"
  | "version"
  | "integrity"
  | "preconditions"
> & {
  version?: typeof PLAN_VERSION;
  preconditions?: PlanFile["preconditions"];
};

export interface CreatePlanOptions {
  context?: PlanContext;
  repoRoot?: string;
}

export interface ApprovePlanOptions {
  signingPrivateKeyPem?: string;
  /** Optional key ID assertion; it must equal the ID derived from the signing key. */
  signingKeyId?: string;
}

export function createPlanFromDraft(draft: PlanDraft, options: CreatePlanOptions = {}): PlanFile {
  validatePlanDraft(draft);

  const risk = scoreRisk(draft.operations);
  const context = options.context ?? { repositoryId: repositoryIdForRoot(options.repoRoot) };

  const planWithoutIntegrity: Omit<PlanFile, "integrity"> = {
    version: PLAN_VERSION,
    id: `plan_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    source: draft.source,
    summary: draft.summary,
    context,
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

  return validatePlanFile(withComputedIntegrity(planWithoutIntegrity));
}

export function approvePlan(
  plan: PlanFile,
  approvedBy: string,
  options: ApprovePlanOptions = {}
): PlanFile {
  validatePlanForApproval(plan, approvedBy, options);
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

  return validatePlanFile(withComputedIntegrity({
    ...plan,
    approval: {
      status: "approved",
      approvedBy,
      approvedAt,
      approvedPlanHash: currentHash,
      ...(attestation ? { attestation } : {})
    }
  }));
}

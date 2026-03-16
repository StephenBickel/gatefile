import { computePlanHash } from "./hash";
import { PlanFile } from "./types";
import { verifyPlan } from "./verify";
import { dependencyStatus } from "./state";

interface InspectOptions {
  repoRoot?: string;
}

export interface InspectReport {
  id: string;
  summary: string;
  source: string;
  operationCount: number;
  risk: PlanFile["risk"];
  integrity: {
    algorithm?: PlanFile["integrity"]["algorithm"];
    canonicalizer?: PlanFile["integrity"]["canonicalizer"];
    planHash: string | null;
    currentPlanHash: string;
    integrityMatches: boolean;
  };
  approval: PlanFile["approval"] & {
    boundToCurrentPlan: boolean;
  };
  dependencies: {
    requiredPlanIds: string[];
    missingPlanIds: string[];
    allSatisfied: boolean;
  };
}

export function buildInspectReport(plan: PlanFile, options: InspectOptions = {}): InspectReport {
  const currentHash = computePlanHash(plan);
  const recordedPlanHash = plan.integrity?.planHash;
  const integrityMatches = recordedPlanHash === currentHash;
  const approvalBound =
    plan.approval.status === "approved" &&
    plan.approval.approvedPlanHash === currentHash;
  const dependencies = dependencyStatus(plan, options.repoRoot);

  return {
    id: plan.id,
    summary: plan.summary,
    source: plan.source,
    operationCount: plan.operations.length,
    risk: plan.risk,
    integrity: {
      ...plan.integrity,
      planHash: recordedPlanHash ?? null,
      currentPlanHash: currentHash,
      integrityMatches
    },
    approval: {
      ...plan.approval,
      boundToCurrentPlan: approvalBound
    },
    dependencies
  };
}

export function formatInspectSummary(plan: PlanFile, report: InspectReport): string {
  const verify = verifyPlan(plan);
  const lines = [
    `Plan: ${report.id}`,
    `Summary: ${report.summary}`,
    `Source: ${report.source}`,
    `Operations: ${report.operationCount}`,
    `Risk: ${report.risk.level} (score: ${report.risk.score})`,
    `Integrity: ${report.integrity.integrityMatches ? "match" : "mismatch"}`,
    `Approval: ${report.approval.status}${report.approval.status === "approved" ? ` (bound: ${report.approval.boundToCurrentPlan ? "yes" : "no"})` : ""}`,
    `Ready To Apply: ${verify.status === "ready" ? "yes" : "no"}`
  ];
  if (report.dependencies.requiredPlanIds.length > 0) {
    lines.push(
      `Dependencies: ${report.dependencies.allSatisfied ? "satisfied" : "missing"} [${report.dependencies.requiredPlanIds.join(", ")}]`
    );
    if (!report.dependencies.allSatisfied) {
      lines.push(`Missing Dependencies: ${report.dependencies.missingPlanIds.join(", ")}`);
    }
  }

  if (verify.blockers.length > 0) {
    lines.push("Blockers:");
    lines.push(...verify.blockers.map((blocker) => `- ${blocker}`));
  }

  lines.push("Tip: Use inspect-plan --json for machine-readable output.");
  return lines.join("\n");
}

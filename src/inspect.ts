import { GatefileConfig, PlanFile, VerifyPlanReport } from "./types";
import { verifyPlan } from "./verify";
import { dependencyStatus } from "./state";
import { inheritPinnedRepoRoot } from "./pinned-runtime";

export interface InspectOptions {
  repoRoot?: string;
  repositoryId?: string;
  stateHome?: string;
  config?: GatefileConfig;
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
  /** Complete verification evidence captured in the same inspection operation. */
  verification: VerifyPlanReport;
}

export function buildInspectReport(plan: PlanFile, options: InspectOptions = {}): InspectReport {
  const verification = verifyPlan(plan, inheritPinnedRepoRoot(options, {
    repoRoot: options.repoRoot,
    repositoryId: options.repositoryId,
    config: options.config
  }));
  const dependencies = dependencyStatus(plan, inheritPinnedRepoRoot(options, {
    repoRoot: options.repoRoot,
    repositoryId: options.repositoryId,
    stateHome: options.stateHome
  }));

  return {
    id: plan.id,
    summary: plan.summary,
    source: plan.source,
    operationCount: plan.operations.length,
    risk: plan.risk,
    integrity: {
      ...plan.integrity,
      planHash: verification.hashes.recordedPlanHash,
      currentPlanHash: verification.hashes.currentPlanHash,
      integrityMatches: verification.checks.recordedHashMatchesCurrent
    },
    approval: {
      ...plan.approval,
      boundToCurrentPlan: verification.checks.approvalBoundToCurrentHash
    },
    dependencies,
    verification
  };
}

export function formatInspectSummary(
  plan: PlanFile,
  report: InspectReport,
  /** @deprecated Explicit options retain PR6 verification-formatting semantics. */
  _options: {
    config?: GatefileConfig;
    repoRoot?: string;
    repositoryId?: string;
  } = {}
): string {
  const hasLegacyOptions =
    _options.config !== undefined ||
    _options.repoRoot !== undefined ||
    _options.repositoryId !== undefined;
  const effectiveReport = report;
  const verify = hasLegacyOptions
    ? verifyPlan(plan, _options)
    : effectiveReport.verification;
  const trustSuffix = verify.signerTrust.policyConfigured
    ? `, trust: ${verify.signerTrust.status}`
    : "";
  const lines = [
    `Plan: ${effectiveReport.id}`,
    `Summary: ${effectiveReport.summary}`,
    `Source: ${effectiveReport.source}`,
    `Operations: ${effectiveReport.operationCount}`,
    `Risk: ${effectiveReport.risk.level} (score: ${effectiveReport.risk.score})`,
    `Integrity: ${effectiveReport.integrity.integrityMatches ? "match" : "mismatch"}`,
    `Approval: ${effectiveReport.approval.status}${effectiveReport.approval.status === "approved" ? ` (bound: ${effectiveReport.approval.boundToCurrentPlan ? "yes" : "no"}, identity: ${verify.approvalIdentity}${trustSuffix})` : ""}`,
    `Integrity + Approval Ready: ${verify.status === "ready" ? "yes" : "no"}`,
    "Static Apply Gate: not evaluated (run a dry-run)",
    "Ready To Attempt Apply: not evaluated (runtime preconditions are also unchecked)"
  ];
  if (effectiveReport.dependencies.requiredPlanIds.length > 0) {
    lines.push(
      `Dependencies: ${effectiveReport.dependencies.allSatisfied ? "satisfied" : "missing"} [${effectiveReport.dependencies.requiredPlanIds.join(", ")}]`
    );
    if (!effectiveReport.dependencies.allSatisfied) {
      lines.push(`Missing Dependencies: ${effectiveReport.dependencies.missingPlanIds.join(", ")}`);
    }
  }

  if (verify.blockers.length > 0) {
    lines.push("Blockers:");
    lines.push(...verify.blockers.map((blocker) => `- ${blocker}`));
  }

  lines.push("Tip: Use inspect-plan --json for machine-readable output.");
  return lines.join("\n");
}

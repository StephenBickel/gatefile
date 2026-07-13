import { isDeepStrictEqual } from "node:util";
import { GatefileEngine } from "./engine";
import type { InspectReport } from "./inspect";
import type { DryRunReport, GatefileConfig, PlanFile, VerifyPlanReport } from "./types";

export interface PRReviewCommentInputs {
  plan: PlanFile;
  inspectReport?: InspectReport;
  verifyReport?: VerifyPlanReport;
  dryRunReport?: DryRunReport;
  config?: GatefileConfig;
  engine?: GatefileEngine;
  repoRoot?: string;
  repositoryId?: string;
  stateHome?: string;
}

function trunc(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function integrityStatus(report: InspectReport): string {
  if (!report.integrity.planHash) return "missing integrity metadata";
  return report.integrity.integrityMatches ? "match" : "mismatch";
}

function approvalStatus(verify: VerifyPlanReport): string {
  if (verify.approvalStatus !== "approved") return `${verify.approvalStatus} (${verify.approvalIdentity})`;
  if (!verify.checks.approvalBoundToCurrentHash) return `approved (not bound, ${verify.approvalIdentity})`;
  return `approved (bound, ${verify.approvalIdentity})`;
}

function signerTrustStatus(verify: VerifyPlanReport): string {
  const by = verify.signerTrust.matchedBy ? ` via ${verify.signerTrust.matchedBy}` : "";
  const key = verify.signerTrust.keyId ? ` (keyId=${verify.signerTrust.keyId})` : "";
  return `${verify.signerTrust.status}${by}${key}`;
}

function inconsistentReports(detail: string): never {
  throw new Error(`Inconsistent supplied reports: ${detail}`);
}

function assertInspectSnapshot(plan: PlanFile, inspect: InspectReport): void {
  const verify = inspect.verification;
  if (!verify) {
    inconsistentReports("inspect report does not contain a verification snapshot");
  }
  if (inspect.id !== plan.id || verify.planId !== plan.id) {
    inconsistentReports("inspect report and verification snapshot do not match the plan ID");
  }
  if (
    inspect.summary !== plan.summary ||
    inspect.source !== plan.source ||
    inspect.operationCount !== plan.operations.length ||
    !isDeepStrictEqual(inspect.risk, plan.risk)
  ) {
    inconsistentReports("inspect report does not describe the supplied plan");
  }

  const { boundToCurrentPlan, ...inspectApproval } = inspect.approval;
  if (!isDeepStrictEqual(inspectApproval, plan.approval)) {
    inconsistentReports("inspect approval does not match the supplied plan");
  }
  if (
    inspect.integrity.planHash !== verify.hashes.recordedPlanHash ||
    inspect.integrity.currentPlanHash !== verify.hashes.currentPlanHash ||
    inspect.integrity.integrityMatches !== verify.checks.recordedHashMatchesCurrent ||
    boundToCurrentPlan !== verify.checks.approvalBoundToCurrentHash ||
    inspect.approval.status !== verify.approvalStatus ||
    inspect.summary !== verify.summary
  ) {
    inconsistentReports("inspect fields disagree with its verification snapshot");
  }
}

function assertDryRunSnapshot(
  plan: PlanFile,
  verify: VerifyPlanReport,
  dryRun: DryRunReport
): void {
  if (dryRun.planId !== plan.id) {
    inconsistentReports("dry-run report does not match the plan ID");
  }
  const expectedVerification: DryRunReport["verification"] = {
    status: verify.status,
    approvalStatus: verify.approvalStatus,
    signerTrustStatus: verify.signerTrust.status,
    readyToApplyFromIntegrityApproval: verify.readyToApplyFromIntegrityApproval,
    blockers: verify.blockers
  };
  if (!isDeepStrictEqual(dryRun.verification, expectedVerification)) {
    inconsistentReports("dry-run verification disagrees with the inspect verification snapshot");
  }

  const operationIds = dryRun.results.map((result) => result.operationId);
  if (!isDeepStrictEqual(operationIds, plan.operations.map((operation) => operation.id))) {
    inconsistentReports("dry-run operations do not match the supplied plan");
  }
  const verificationReady = verify.status === "ready";
  const dependenciesSatisfied = dryRun.dependencies.allSatisfied;
  const operationsAllowed = dryRun.results.every((result) => result.allowed);
  if (
    dryRun.preconditionsChecked !== false ||
    dryRun.staticGate.preconditionsChecked !== false ||
    dryRun.staticGate.verificationReady !== verificationReady ||
    dryRun.staticGate.dependenciesSatisfied !== dependenciesSatisfied ||
    dryRun.staticGate.operationsAllowed !== operationsAllowed ||
    dryRun.staticGate.passed !== (
      verificationReady && dependenciesSatisfied && operationsAllowed
    )
  ) {
    inconsistentReports("dry-run static gate disagrees with its report facts");
  }
}

function renderDryRunHighlights(dryRun: DryRunReport): string[] {
  const denied = dryRun.results.filter((result) => !result.allowed);
  const notable = dryRun.results
    .filter((result) => {
      if (!result.allowed) return false;
      const message = result.message.toLowerCase();
      const details = (result.details ?? "").toLowerCase();
      return (
        message.includes("denied") ||
        details.includes("denied") ||
        details.includes("allowfailure") ||
        details.includes("policy:")
      );
    })
    .slice(0, 5);

  const lines = [
    "### Dry-Run Highlights",
    `- Preview status: ${dryRun.verification.status}`,
    `- Ready to apply from integrity+approval: ${dryRun.verification.readyToApplyFromIntegrityApproval ? "yes" : "no"}`,
    `- Static gate: ${dryRun.staticGate.passed ? "passed" : "failed"}`,
    `- Verification gate: ${dryRun.staticGate.verificationReady ? "ready" : "not-ready"}`,
    `- Dependencies: ${dryRun.staticGate.dependenciesSatisfied ? "satisfied" : "missing"}`,
    `- Operation policy: ${dryRun.staticGate.operationsAllowed ? "allowed" : "denied"}`,
    `- Preconditions checked: ${dryRun.staticGate.preconditionsChecked ? "yes" : "no"}`,
    `- Previewed operations: ${dryRun.results.length}`
  ];

  if (denied.length === 0) {
    lines.push("- Denied operations: none");
  } else {
    lines.push("- Denied operations:");
    for (const result of denied.slice(0, 5)) {
      const detail = result.details ? ` (${trunc(result.details, 180)})` : "";
      lines.push(`  - ${result.operationId}: ${trunc(result.message, 140)}${detail}`);
    }
  }

  if (notable.length === 0) {
    lines.push("- Notable signals: none");
    return lines;
  }

  lines.push("- Notable signals:");
  for (const result of notable) {
    const detail = result.details ? ` (${trunc(result.details, 180)})` : "";
    lines.push(`  - ${result.operationId}: ${trunc(result.message, 140)}${detail}`);
  }

  return lines;
}

export function renderPRReviewComment(inputs: PRReviewCommentInputs): string {
  let engine = inputs.engine;
  if (!inputs.inspectReport) {
    engine ??= new GatefileEngine({
      repoRoot: inputs.repoRoot,
      repositoryId: inputs.repositoryId,
      stateHome: inputs.stateHome,
      config: inputs.config
    });
  }

  const inspect = inputs.inspectReport ?? engine!.inspectPlan(inputs.plan);
  assertInspectSnapshot(inputs.plan, inspect);
  const verify = inspect.verification;
  if (inputs.verifyReport && !isDeepStrictEqual(inputs.verifyReport, verify)) {
    inconsistentReports("verify report disagrees with the inspect verification snapshot");
  }
  const dryRun = inputs.dryRunReport;
  if (dryRun) assertDryRunSnapshot(inputs.plan, verify, dryRun);
  const applyReady = dryRun
    ? dryRun.staticGate.passed
    : verify.readyToApplyFromIntegrityApproval;
  const blockers = [...verify.blockers];
  if (dryRun && !dryRun.staticGate.passed) {
    const failedFacts: string[] = [];
    if (!dryRun.staticGate.verificationReady) failedFacts.push("verification not ready");
    if (!dryRun.staticGate.dependenciesSatisfied) failedFacts.push("dependencies missing");
    if (!dryRun.staticGate.operationsAllowed) {
      const deniedIds = dryRun.results
        .filter((result) => !result.allowed)
        .map((result) => result.operationId);
      failedFacts.push(`operation policy denied: ${deniedIds.join(", ")}`);
    }
    blockers.push(`Dry-run static gate failed (${failedFacts.join("; ")})`);
  }

  const lines = [
    "<!-- gatefile-review-comment -->",
    "## gatefile PR Review",
    "",
    "| Signal | Status |",
    "| --- | --- |",
    `| Plan | \`${inspect.id}\` |`,
    `| Summary | ${trunc(inspect.summary, 240)} |`,
    `| Risk | ${inspect.risk.level} (score: ${inspect.risk.score}) |`,
    `| Approval | ${approvalStatus(verify)} |`,
    `| Signer trust | ${signerTrustStatus(verify)} |`,
    `| Integrity | ${integrityStatus(inspect)} |`,
    `| Verify status | ${verify.status} |`,
    `| Apply ready | ${applyReady ? "yes" : "no"} |`,
    `| Operations | ${inspect.operationCount} |`
  ];

  if (blockers.length > 0) {
    lines.push("", "### Blockers");
    for (const blocker of blockers) {
      lines.push(`- ${blocker}`);
    }
  } else {
    lines.push("", "### Blockers", "- none");
  }

  if (dryRun) {
    lines.push("", ...renderDryRunHighlights(dryRun));
  }

  lines.push(
    "",
    "### Integrity Details",
    `- Recorded hash: \`${inspect.integrity.planHash ?? "missing"}\``,
    `- Current hash: \`${inspect.integrity.currentPlanHash}\``,
    `- Approved hash: \`${verify.hashes.approvedPlanHash ?? "missing"}\``
  );

  return lines.join("\n");
}

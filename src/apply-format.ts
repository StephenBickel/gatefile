import { ApplyReport, DryRunReport, RecoveryOperationGuidance, RollbackReport } from "./types";

function formatStep(step: RecoveryOperationGuidance): string {
  const target = step.path ? ` (${step.path})` : "";
  const mutation = step.mutationStatus && step.mutationStatus !== "none"
    ? `/${step.mutationStatus}`
    : "";
  return `  - [${step.status}${mutation}] ${step.operationId}${target}: ${step.guidance}`;
}

export function formatDryRunSummary(report: DryRunReport): string {
  const deniedOperations = report.results.filter((result) => !result.allowed);
  const lines = [
    `Plan: ${report.planId}`,
    `Mode: dry-run preview`,
    `Verification: ${report.verification.status} (approval=${report.verification.approvalStatus})`,
    `Signer Trust: ${report.verification.signerTrustStatus}`,
    `Ready To Attempt Apply: ${report.staticGate.passed ? "yes" : "no"}`,
    `Static Gate: ${report.staticGate.passed ? "passed" : "failed"}`,
    `Verification Gate: ${report.staticGate.verificationReady ? "ready" : "not-ready"}`,
    `Dependency Gate: ${report.staticGate.dependenciesSatisfied ? "satisfied" : "missing"}`,
    `Operation Policy: ${report.staticGate.operationsAllowed ? "allowed" : "denied"}`,
    `Preconditions Checked: ${report.staticGate.preconditionsChecked ? "yes" : "no"}`
  ];

  if (report.verification.blockers.length > 0) {
    lines.push(`Blockers: ${report.verification.blockers.join("; ")}`);
  }
  if (report.dependencies.requiredPlanIds.length > 0) {
    lines.push(
      `Dependencies: ${report.dependencies.allSatisfied ? "satisfied" : "missing"} [${report.dependencies.requiredPlanIds.join(", ")}]`
    );
    if (!report.dependencies.allSatisfied) {
      lines.push(`Missing Dependencies: ${report.dependencies.missingPlanIds.join(", ")}`);
    }
  }

  lines.push(`Operations Previewed: ${report.results.length}`);
  lines.push(`Denied Operations: ${deniedOperations.length}`);
  for (const result of deniedOperations) {
    lines.push(`  - [denied] ${result.operationId}: ${result.message}`);
  }
  if (report.recovery.affectedPaths.length > 0) {
    lines.push(`Affected Paths: ${report.recovery.affectedPaths.join(", ")}`);
  }
  lines.push("Rollback Guidance:");
  for (const step of report.recovery.steps) {
    lines.push(formatStep(step));
  }
  lines.push(`Notes: ${report.recovery.notes.join(" ")}`);
  lines.push("Tip: Omit --human to get machine-readable JSON output.");

  return lines.join("\n");
}

export function formatApplySummary(report: ApplyReport): string {
  const failedCount = report.results.filter((result) => !result.success).length;
  const lines = [
    `Plan: ${report.planId}`,
    `Mode: apply`,
    `Result: ${report.success ? "success" : "failed"}`,
    `Operations Attempted: ${report.recovery.attemptedOperationIds.length}/${report.recovery.attemptedOperationIds.length + report.recovery.pendingOperationIds.length}`,
    `Failures: ${failedCount}`
  ];
  if (report.dependencies.requiredPlanIds.length > 0) {
    lines.push(
      `Dependencies: ${report.dependencies.allSatisfied ? "satisfied" : "missing"} [${report.dependencies.requiredPlanIds.join(", ")}]`
    );
  }
  lines.push(`Snapshot: ${report.snapshot.id} (${report.snapshot.fileCount} files)`);
  lines.push(`Receipt: ${report.receipt.id}`);

  if (report.recovery.failedOperationId) {
    lines.push(`Failed Operation: ${report.recovery.failedOperationId}`);
  }

  if (report.recovery.affectedPaths.length > 0) {
    lines.push(`Affected Paths: ${report.recovery.affectedPaths.join(", ")}`);
  }

  lines.push("Rollback Guidance:");
  for (const step of report.recovery.steps) {
    lines.push(formatStep(step));
  }
  lines.push(`Notes: ${report.recovery.notes.join(" ")}`);
  if (report.warnings && report.warnings.length > 0) {
    lines.push(`Warnings: ${report.warnings.join(" ")}`);
  }
  lines.push(`Rollback: ${report.rollbackCommand}`);
  lines.push("Tip: Omit --human to get machine-readable JSON output.");

  return lines.join("\n");
}

export function formatRollbackSummary(report: RollbackReport): string {
  const lines = [
    `Mode: rollback`,
    `Receipt: ${report.receiptId}`,
    `Snapshot: ${report.snapshotId}`,
    `Result: ${report.success ? "success" : "failed"}`,
    `Files Processed: ${report.fileResults.length}`
  ];

  for (const result of report.fileResults) {
    const status = result.durabilityConfirmed === false
      ? "undurable"
      : result.restored
        ? "ok"
        : "failed";
    lines.push(`  - [${status}] ${result.path}: ${result.message}`);
  }

  lines.push(`Notes: ${report.notes.join(" ")}`);
  lines.push("Tip: Omit --human to get machine-readable JSON output.");
  return lines.join("\n");
}

import { buildInspectReport, InspectReport } from "./inspect";
import { DryRunReport, GatefileConfig, PlanFile, VerifyPlanReport } from "./types";
import { verifyPlan } from "./verify";

export interface PRReviewCommentInputs {
  plan: PlanFile;
  inspectReport?: InspectReport;
  verifyReport?: VerifyPlanReport;
  dryRunReport?: DryRunReport;
  config?: GatefileConfig;
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

function renderDryRunHighlights(dryRun: DryRunReport): string[] {
  const risky = dryRun.results
    .filter((result) => {
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
    `- Previewed operations: ${dryRun.results.length}`
  ];

  if (risky.length === 0) {
    lines.push("- Notable signals: none");
    return lines;
  }

  lines.push("- Notable signals:");
  for (const result of risky) {
    const detail = result.details ? ` (${trunc(result.details, 180)})` : "";
    lines.push(`  - ${result.operationId}: ${trunc(result.message, 140)}${detail}`);
  }

  return lines;
}

export function renderPRReviewComment(inputs: PRReviewCommentInputs): string {
  const inspect = inputs.inspectReport ?? buildInspectReport(inputs.plan);
  const verify = inputs.verifyReport ?? verifyPlan(inputs.plan, { config: inputs.config });
  const dryRun = inputs.dryRunReport;

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
    `| Apply ready | ${verify.readyToApplyFromIntegrityApproval ? "yes" : "no"} |`,
    `| Operations | ${inspect.operationCount} |`
  ];

  if (verify.blockers.length > 0) {
    lines.push("", "### Blockers");
    for (const blocker of verify.blockers) {
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

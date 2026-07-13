import type { PlanFile } from "./types";
import {
  listAuthenticatedReceipts,
  type StateRuntimeOptions
} from "./state";

/** `created` and `approved` remain only for source compatibility; audit emits apply events. */
export type AuditEventType = "created" | "approved" | "applied" | "apply-failed";

export interface AuditEvent {
  type: AuditEventType;
  planId: string;
  planHash: string;
  receiptId: string;
  summary: string;
  source: string;
  timestamp: string;
  actor?: string;
  approvalIdentity?: "signed" | "unsigned";
  signerKeyId: string | null;
  authenticated: true;
  file: string;
  details?: string;
}

export interface AuditOptions extends StateRuntimeOptions {
  since?: string;
  planId?: string;
  json?: boolean;
}

export interface AuditResult {
  events: AuditEvent[];
}

/** @deprecated Unauthenticated repository-local audit writes were removed. */
export function writeApprovalReceipt(_plan: PlanFile): never {
  throw new Error(
    "Deprecated unauthenticated audit writer removed; audit is derived from authenticated apply receipts"
  );
}

/** @deprecated Unauthenticated repository-local audit writes were removed. */
export function writeApplyReceipt(
  _plan: PlanFile,
  _success: boolean,
  _appliedAt: string
): never {
  throw new Error(
    "Deprecated unauthenticated audit writer removed; audit is derived from authenticated apply receipts"
  );
}

function parseSinceDuration(since: string): Date {
  const match = since.match(/^(\d+)([dhms])$/);
  if (!match) {
    const date = new Date(since);
    if (Number.isNaN(date.getTime())) {
      throw new Error(
        `Invalid --since value: ${since}. Use e.g. "7d", "24h", "30m", or an ISO date.`
      );
    }
    return date;
  }

  const amount = Number.parseInt(match[1], 10);
  const milliseconds = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000
  }[match[2]]!;
  return new Date(Date.now() - amount * milliseconds);
}

export function audit(options: AuditOptions = {}): AuditResult {
  const receipts = listAuthenticatedReceipts({
    repoRoot: options.repoRoot,
    repositoryId: options.repositoryId,
    stateHome: options.stateHome
  });
  let events: AuditEvent[] = receipts.map((receipt) => ({
    type: receipt.success ? "applied" : "apply-failed",
    planId: receipt.plan.id,
    planHash: receipt.plan.hash,
    receiptId: receipt.id,
    summary: receipt.audit?.summary ?? "",
    source: receipt.audit?.source ?? "",
    timestamp: receipt.appliedAt,
    ...(receipt.audit?.approvedBy ? { actor: receipt.audit.approvedBy } : {}),
    ...(receipt.audit?.approvalIdentity
      ? { approvalIdentity: receipt.audit.approvalIdentity }
      : {}),
    signerKeyId: receipt.audit?.signerKeyId ?? null,
    authenticated: true,
    file: `${receipt.id}.json`,
    ...(!receipt.success ? { details: "failed" } : {})
  }));

  if (options.since) {
    const cutoff = parseSinceDuration(options.since).getTime();
    events = events.filter((event) => Date.parse(event.timestamp) >= cutoff);
  }
  if (options.planId) {
    events = events.filter((event) => event.planId === options.planId);
  }
  return { events };
}

export function formatAuditTable(result: AuditResult): string {
  if (result.events.length === 0) return "No audit events found.";

  const lines: string[] = [];
  const cols = { time: 24, type: 14, plan: 40, actor: 16 };
  lines.push(
    "TIME".padEnd(cols.time) +
    "EVENT".padEnd(cols.type) +
    "PLAN ID".padEnd(cols.plan) +
    "ACTOR"
  );
  lines.push("-".repeat(cols.time + cols.type + cols.plan + cols.actor));

  for (const event of result.events) {
    lines.push(
      event.timestamp.substring(0, 23).padEnd(cols.time) +
      event.type.padEnd(cols.type) +
      event.planId.padEnd(cols.plan) +
      (event.actor ?? "-")
    );
  }
  lines.push("");
  lines.push(`${result.events.length} event(s)`);
  return lines.join("\n");
}

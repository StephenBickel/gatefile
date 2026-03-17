import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PlanFile } from "./types";

// ── State directory constants ─────────────────────────────────

const GATEFILE_DIR = ".gatefile";
const STATE_DIR = join(GATEFILE_DIR, "state");
const APPROVALS_DIR = join(GATEFILE_DIR, "approvals");

// ── Receipt types ─────────────────────────────────────────────

export type AuditEventType = "created" | "approved" | "applied" | "apply-failed";

export interface AuditEvent {
  type: AuditEventType;
  planId: string;
  summary: string;
  timestamp: string;
  actor?: string;
  file: string;
  details?: string;
}

export interface AuditOptions {
  since?: string;
  planId?: string;
  json?: boolean;
}

export interface AuditResult {
  events: AuditEvent[];
}

// ── Persistence helpers ───────────────────────────────────────

function ensureDir(dir: string): void {
  const abs = resolve(dir);
  if (!existsSync(abs)) {
    mkdirSync(abs, { recursive: true });
  }
}

export function writeApprovalReceipt(plan: PlanFile): void {
  ensureDir(APPROVALS_DIR);
  const receipt = {
    type: "approved",
    planId: plan.id,
    summary: plan.summary,
    timestamp: plan.approval.approvedAt ?? new Date().toISOString(),
    actor: plan.approval.approvedBy,
    approvedPlanHash: plan.approval.approvedPlanHash
  };
  const filename = `${plan.id}-${Date.now()}.json`;
  writeFileSync(join(APPROVALS_DIR, filename), JSON.stringify(receipt, null, 2) + "\n", "utf-8");
}

export function writeApplyReceipt(
  plan: PlanFile,
  success: boolean,
  appliedAt: string
): void {
  ensureDir(STATE_DIR);
  const receipt = {
    type: success ? "applied" : "apply-failed",
    planId: plan.id,
    summary: plan.summary,
    timestamp: appliedAt,
    success
  };
  const filename = `${plan.id}-${Date.now()}.json`;
  writeFileSync(join(STATE_DIR, filename), JSON.stringify(receipt, null, 2) + "\n", "utf-8");
}

// ── Time parsing ──────────────────────────────────────────────

function parseSinceDuration(since: string): Date {
  const match = since.match(/^(\d+)([dhms])$/);
  if (!match) {
    // Try parsing as ISO date
    const date = new Date(since);
    if (isNaN(date.getTime())) {
      throw new Error(`Invalid --since value: ${since}. Use e.g. "7d", "24h", "30m", or an ISO date.`);
    }
    return date;
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const now = Date.now();
  const ms = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000
  }[unit]!;

  return new Date(now - amount * ms);
}

// ── Audit reader ──────────────────────────────────────────────

function readReceiptsFromDir(dir: string, type: AuditEventType | AuditEventType[]): AuditEvent[] {
  const absDir = resolve(dir);
  if (!existsSync(absDir)) return [];

  const types = Array.isArray(type) ? type : [type];
  const events: AuditEvent[] = [];

  for (const file of readdirSync(absDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(absDir, file), "utf-8"));
      if (raw.planId && raw.timestamp && types.includes(raw.type)) {
        events.push({
          type: raw.type,
          planId: raw.planId,
          summary: raw.summary ?? "",
          timestamp: raw.timestamp,
          actor: raw.actor,
          file,
          details: raw.success === false ? "failed" : undefined
        });
      }
    } catch {
      // skip invalid files
    }
  }

  return events;
}

export function audit(options?: AuditOptions): AuditResult {
  const events: AuditEvent[] = [
    ...readReceiptsFromDir(APPROVALS_DIR, "approved"),
    ...readReceiptsFromDir(STATE_DIR, ["applied", "apply-failed"])
  ];

  // Sort by timestamp
  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Filter by --since
  let filtered = events;
  if (options?.since) {
    const cutoff = parseSinceDuration(options.since);
    filtered = filtered.filter((e) => new Date(e.timestamp).getTime() >= cutoff.getTime());
  }

  // Filter by --plan
  if (options?.planId) {
    filtered = filtered.filter((e) => e.planId === options.planId);
  }

  return { events: filtered };
}

export function formatAuditTable(result: AuditResult): string {
  if (result.events.length === 0) {
    return "No audit events found.";
  }

  const lines: string[] = [];

  // Header
  const cols = { time: 24, type: 14, plan: 40, actor: 16 };
  lines.push(
    "TIME".padEnd(cols.time) +
    "EVENT".padEnd(cols.type) +
    "PLAN ID".padEnd(cols.plan) +
    "ACTOR"
  );
  lines.push("-".repeat(cols.time + cols.type + cols.plan + cols.actor));

  for (const e of result.events) {
    const time = e.timestamp.substring(0, 23);
    const actor = e.actor ?? "-";
    lines.push(
      time.padEnd(cols.time) +
      e.type.padEnd(cols.type) +
      e.planId.padEnd(cols.plan) +
      actor
    );
  }

  lines.push("");
  lines.push(`${result.events.length} event(s)`);

  return lines.join("\n");
}

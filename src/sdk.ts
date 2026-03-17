import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPlanFromDraft, approvePlan as approveInMemory, PlanDraft } from "./planner";
import { applyPlan as applyInMemory, previewPlan } from "./applier";
import { verifyPlan as verifyInMemory } from "./verify";
import { buildInspectReport, InspectReport } from "./inspect";
import { PlanFile, ApplyReport, DryRunReport, VerifyPlanReport } from "./types";

// ── Option types ──────────────────────────────────────────────

export interface CreateOptions {
  /** Output path for the plan JSON. If omitted the plan is returned but not written. */
  outPath?: string;
}

export interface InspectOptions {
  /** Unused today — reserved for future filtering. */
}

export interface ApproveOptions {
  /** Who is approving (defaults to "sdk"). */
  approvedBy?: string;
}

export interface ApplyOptions {
  /** If true, preview only — no side effects (default: false). */
  dryRun?: boolean;
}

// ── Result types ──────────────────────────────────────────────

export interface ApprovalResult {
  plan: PlanFile;
  approvedPlanHash: string;
}

export type InspectResult = InspectReport;
export type VerifyResult = VerifyPlanReport;
export type { ApplyReport, DryRunReport };

// ── Helpers ───────────────────────────────────────────────────

function readPlan(planPath: string): PlanFile {
  const full = resolve(planPath);
  return JSON.parse(readFileSync(full, "utf-8")) as PlanFile;
}

function writePlan(planPath: string, plan: PlanFile): void {
  const full = resolve(planPath);
  writeFileSync(full, JSON.stringify(plan, null, 2) + "\n", "utf-8");
}

// ── Public API ────────────────────────────────────────────────

/**
 * Create a plan from a draft. Optionally writes to disk.
 */
export async function createPlan(
  draft: PlanDraft,
  options?: CreateOptions
): Promise<PlanFile> {
  const plan = createPlanFromDraft(draft);
  if (options?.outPath) {
    writePlan(options.outPath, plan);
  }
  return plan;
}

/**
 * Inspect a plan file and return structured data.
 */
export async function inspectPlan(
  planPath: string,
  _options?: InspectOptions
): Promise<InspectResult> {
  const plan = readPlan(planPath);
  return buildInspectReport(plan);
}

/**
 * Approve a plan file. Writes the updated plan back to disk.
 */
export async function approvePlan(
  planPath: string,
  options?: ApproveOptions
): Promise<ApprovalResult> {
  const plan = readPlan(planPath);
  const approved = approveInMemory(plan, options?.approvedBy ?? "sdk");
  writePlan(planPath, approved);
  return {
    plan: approved,
    approvedPlanHash: approved.integrity.planHash
  };
}

/**
 * Verify plan integrity and approval binding.
 */
export async function verifyPlan(
  planPath: string
): Promise<VerifyResult> {
  const plan = readPlan(planPath);
  return verifyInMemory(plan);
}

/**
 * Apply a plan with guardrails, or preview via dry-run.
 */
export async function applyPlan(
  planPath: string,
  options?: ApplyOptions
): Promise<ApplyReport | DryRunReport> {
  const plan = readPlan(planPath);
  if (options?.dryRun) {
    return previewPlan(plan);
  }
  return applyInMemory(plan);
}

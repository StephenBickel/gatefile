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
  /** Repository root used to bind the plan to its intended repository. */
  repoRoot?: string;
}

export interface InspectOptions {
  /** Repository root used to resolve dependency state. */
  repoRoot?: string;
  /** Explicit repository identity override for non-filesystem integrations. */
  repositoryId?: string;
  /** Trusted operator override for external authenticated state. */
  stateHome?: string;
}

export interface ApproveOptions {
  /** Who is approving (defaults to "sdk"). */
  approvedBy?: string;
}

export interface ApplyOptions {
  /** If true, preview only — no side effects (default: false). */
  dryRun?: boolean;
  /** Repository root whose identity must match the plan context. */
  repoRoot?: string;
  /** Explicit repository identity override for non-filesystem integrations. */
  repositoryId?: string;
  /** Trusted operator override for external authenticated state. */
  stateHome?: string;
}

export interface VerifyOptions {
  /** Repository root whose identity must match the plan context. */
  repoRoot?: string;
  /** Explicit repository identity override for non-filesystem integrations. */
  repositoryId?: string;
}

/** Complete, reusable runtime binding for rolling back an SDK apply receipt. */
export interface RollbackContext {
  receiptId: string;
  repoRoot: string;
  repositoryId: string;
  stateHome: string;
}

// ── Result types ──────────────────────────────────────────────

export interface ApprovalResult {
  plan: PlanFile;
  approvedPlanHash: string;
}

export interface SdkApplyReport extends ApplyReport {
  rollbackContext: RollbackContext;
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
  const plan = createPlanFromDraft(draft, { repoRoot: options?.repoRoot });
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
  options?: InspectOptions
): Promise<InspectResult> {
  const plan = readPlan(planPath);
  return buildInspectReport(plan, {
    repoRoot: options?.repoRoot,
    repositoryId: options?.repositoryId,
    stateHome: options?.stateHome
  });
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
  planPath: string,
  options?: VerifyOptions
): Promise<VerifyResult> {
  const plan = readPlan(planPath);
  return verifyInMemory(plan, {
    repoRoot: options?.repoRoot,
    repositoryId: options?.repositoryId
  });
}

/**
 * Apply a plan with guardrails, or preview via dry-run.
 */
export async function applyPlan(
  planPath: string,
  options?: ApplyOptions
): Promise<SdkApplyReport | DryRunReport> {
  const plan = readPlan(planPath);
  if (options?.dryRun) {
    return previewPlan(plan, {
      repoRoot: options.repoRoot,
      repositoryId: options.repositoryId,
      stateHome: options.stateHome
    });
  }
  return applyInMemory(plan, {
    repoRoot: options?.repoRoot,
    repositoryId: options?.repositoryId,
    stateHome: options?.stateHome
  });
}

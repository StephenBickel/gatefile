import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GatefileEngine } from "./engine";
import type { InspectReport } from "./inspect";
import type { PlanDraft } from "./planner";
import { validatePlanFile } from "./validation";
import type {
  PlanFile,
  ApplyReport,
  DryRunReport,
  GatefileConfig,
  RollbackReport,
  VerifyPlanReport
} from "./types";

// ── Option types ──────────────────────────────────────────────

export interface SdkEngineOptions {
  /** Repository root used to bind plans and resolve repository policy. */
  repoRoot?: string;
  /** Explicit repository identity override for non-filesystem integrations. */
  repositoryId?: string;
  /** Trusted operator override for external authenticated state. */
  stateHome?: string;
  /** Explicit policy configuration instead of repository config discovery. */
  config?: GatefileConfig;
}

export interface CreateOptions
  extends Pick<SdkEngineOptions, "repoRoot" | "repositoryId" | "config"> {
  /** Output path for the plan JSON. If omitted the plan is returned but not written. */
  outPath?: string;
}

export interface InspectOptions extends SdkEngineOptions {}

export interface ApproveOptions
  extends Pick<SdkEngineOptions, "repoRoot" | "repositoryId" | "config"> {
  /** Who is approving (defaults to "sdk"). */
  approvedBy?: string;
  /** Optional Ed25519 private key used to attest the approval. */
  signingPrivateKeyPem?: string;
  /** Optional key ID assertion; it must equal the ID derived from the signing key. */
  signingKeyId?: string;
}

export interface ApplyOptions extends SdkEngineOptions {
  /** If true, preview only — no side effects (default: false). */
  dryRun?: boolean;
}

export interface VerifyOptions
  extends Pick<SdkEngineOptions, "repoRoot" | "repositoryId" | "config"> {}

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
  const engine = new GatefileEngine({
    repoRoot: options?.repoRoot,
    repositoryId: options?.repositoryId,
    config: options?.config
  });
  const plan = engine.createPlan(draft);
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
  const engine = new GatefileEngine({
    repoRoot: options?.repoRoot,
    repositoryId: options?.repositoryId,
    stateHome: options?.stateHome,
    config: options?.config
  });
  return engine.inspectPlan(plan);
}

/**
 * Approve a plan file. Writes the updated plan back to disk.
 */
export async function approvePlan(
  planPath: string,
  options?: ApproveOptions
): Promise<ApprovalResult> {
  const plan = readPlan(planPath);
  validatePlanFile(plan);
  const engine = new GatefileEngine({
    repoRoot: options?.repoRoot,
    repositoryId: options?.repositoryId,
    config: options?.config
  });
  const approved = engine.approvePlan(plan, options?.approvedBy ?? "sdk", {
    planPath: resolve(planPath),
    signingPrivateKeyPem: options?.signingPrivateKeyPem,
    signingKeyId: options?.signingKeyId
  });
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
  const engine = new GatefileEngine({
    repoRoot: options?.repoRoot,
    repositoryId: options?.repositoryId,
    config: options?.config
  });
  return engine.verifyPlan(plan);
}

/**
 * Apply a plan with guardrails, or preview via dry-run.
 */
export async function applyPlan(
  planPath: string,
  options?: ApplyOptions
): Promise<SdkApplyReport | DryRunReport> {
  const plan = readPlan(planPath);
  const engine = new GatefileEngine({
    repoRoot: options?.repoRoot,
    repositoryId: options?.repositoryId,
    stateHome: options?.stateHome,
    config: options?.config
  });
  if (options?.dryRun) {
    return engine.previewPlan(plan, { planPath: resolve(planPath) });
  }
  return engine.applyPlan(plan, { planPath: resolve(planPath) });
}

/**
 * Roll back an SDK apply using the complete runtime context returned by applyPlan.
 */
export async function rollbackApply(
  receiptId: string,
  options: SdkEngineOptions
): Promise<RollbackReport> {
  const engine = new GatefileEngine(options);
  return engine.rollbackApply(receiptId);
}

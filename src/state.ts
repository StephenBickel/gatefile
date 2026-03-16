import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ApplyReceipt, DependencyStatus, PlanFile, RollbackFileResult, RollbackReport, SnapshotFile } from "./types";

interface StateLayout {
  repoRoot: string;
  gatefileRoot: string;
  stateRoot: string;
  receiptsDir: string;
  snapshotsDir: string;
  plansDir: string;
}

interface PlanStateRecord {
  planId: string;
  lastApplyReceiptId: string;
  lastAppliedAt: string;
  lastApplySuccess: boolean;
  lastSuccessfulReceiptId?: string;
  lastSuccessfulAppliedAt?: string;
}

function safePlanId(planId: string): string {
  return Buffer.from(planId, "utf8").toString("base64url");
}

function safeTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function getRepoRoot(repoRoot?: string): string {
  return resolve(repoRoot ?? process.cwd());
}

export function getStateLayout(repoRoot?: string): StateLayout {
  const resolvedRepoRoot = getRepoRoot(repoRoot);
  const gatefileRoot = resolve(resolvedRepoRoot, ".gatefile");
  const stateRoot = resolve(gatefileRoot, "state");

  return {
    repoRoot: resolvedRepoRoot,
    gatefileRoot,
    stateRoot,
    receiptsDir: resolve(stateRoot, "receipts"),
    snapshotsDir: resolve(stateRoot, "snapshots"),
    plansDir: resolve(stateRoot, "plans")
  };
}

export function ensureStateLayout(repoRoot?: string): StateLayout {
  const layout = getStateLayout(repoRoot);
  mkdirSync(layout.receiptsDir, { recursive: true });
  mkdirSync(layout.snapshotsDir, { recursive: true });
  mkdirSync(layout.plansDir, { recursive: true });
  return layout;
}

export function makeReceiptId(planId: string, appliedAt: string): string {
  return `apply_${safeTimestamp(appliedAt)}_${safePlanId(planId)}`;
}

export function snapshotPath(repoRoot: string | undefined, snapshotId: string): string {
  return resolve(getStateLayout(repoRoot).snapshotsDir, `${snapshotId}.json`);
}

export function receiptPath(repoRoot: string | undefined, receiptId: string): string {
  return resolve(getStateLayout(repoRoot).receiptsDir, `${receiptId}.json`);
}

function planStatePath(repoRoot: string | undefined, planId: string): string {
  return resolve(getStateLayout(repoRoot).plansDir, `${safePlanId(planId)}.json`);
}

export function writeSnapshot(repoRoot: string | undefined, snapshot: SnapshotFile): string {
  const layout = ensureStateLayout(repoRoot);
  const path = resolve(layout.snapshotsDir, `${snapshot.id}.json`);
  writeJson(path, snapshot);
  return path;
}

export function writeReceipt(repoRoot: string | undefined, receipt: ApplyReceipt): string {
  const layout = ensureStateLayout(repoRoot);
  const path = resolve(layout.receiptsDir, `${receipt.id}.json`);
  writeJson(path, receipt);

  const statePath = planStatePath(layout.repoRoot, receipt.planId);
  const current = existsSync(statePath) ? readJson<PlanStateRecord>(statePath) : undefined;
  const next: PlanStateRecord = {
    planId: receipt.planId,
    lastApplyReceiptId: receipt.id,
    lastAppliedAt: receipt.appliedAt,
    lastApplySuccess: receipt.success,
    lastSuccessfulReceiptId: receipt.success
      ? receipt.id
      : current?.lastSuccessfulReceiptId,
    lastSuccessfulAppliedAt: receipt.success
      ? receipt.appliedAt
      : current?.lastSuccessfulAppliedAt
  };

  writeJson(statePath, next);
  return path;
}

export function readReceipt(repoRoot: string | undefined, receiptId: string): ApplyReceipt {
  const path = receiptPath(repoRoot, receiptId);
  if (!existsSync(path)) {
    throw new Error(`Unknown receipt: ${receiptId} (expected ${path})`);
  }

  return readJson<ApplyReceipt>(path);
}

export function readSnapshot(repoRoot: string | undefined, snapshotId: string): SnapshotFile {
  const path = snapshotPath(repoRoot, snapshotId);
  if (!existsSync(path)) {
    throw new Error(`Missing snapshot: ${snapshotId} (expected ${path})`);
  }

  return readJson<SnapshotFile>(path);
}

function successfulPlans(repoRoot?: string): Set<string> {
  const layout = getStateLayout(repoRoot);
  if (!existsSync(layout.plansDir)) {
    return new Set<string>();
  }

  const entries = readdirSync(layout.plansDir, { withFileTypes: true }).filter((entry) =>
    entry.isFile() && entry.name.endsWith(".json")
  );

  const out = new Set<string>();
  for (const entry of entries) {
    const state = readJson<PlanStateRecord>(resolve(layout.plansDir, entry.name));
    if (state.lastApplySuccess || state.lastSuccessfulReceiptId) {
      out.add(state.planId);
    }
  }

  return out;
}

export function dependencyStatus(plan: PlanFile, repoRoot?: string): DependencyStatus {
  const requiredPlanIds = [...new Set((plan.dependsOn ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
  const success = successfulPlans(repoRoot);
  const missingPlanIds = requiredPlanIds.filter((planId) => !success.has(planId));

  return {
    requiredPlanIds,
    missingPlanIds,
    allSatisfied: missingPlanIds.length === 0
  };
}

function restoreFile(path: string, existedBefore: boolean, contentBefore: string | undefined): RollbackFileResult {
  try {
    if (existedBefore) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contentBefore ?? "", "utf8");
      return {
        path,
        restored: true,
        action: "rewritten",
        message: "restored previous file content"
      };
    }

    if (existsSync(path)) {
      rmSync(path, { force: true, recursive: false });
      return {
        path,
        restored: true,
        action: "deleted",
        message: "removed file that did not exist before apply"
      };
    }

    return {
      path,
      restored: true,
      action: "unchanged",
      message: "no file existed before or after apply"
    };
  } catch (error) {
    return {
      path,
      restored: false,
      action: existedBefore ? "rewritten" : "deleted",
      message: `rollback failed: ${(error as Error).message}`
    };
  }
}

export function rollbackByReceipt(repoRoot: string | undefined, receiptId: string): RollbackReport {
  const receipt = readReceipt(repoRoot, receiptId);
  const snapshot = readSnapshot(repoRoot, receipt.snapshotId);

  const fileResults = snapshot.files.map((file) =>
    restoreFile(file.resolvedPath, file.existedBefore, file.contentBefore)
  );
  const success = fileResults.every((result) => result.restored);

  return {
    receiptId: receipt.id,
    snapshotId: snapshot.id,
    rolledBackAt: new Date().toISOString(),
    success,
    fileResults,
    notes: [
      "Rollback restores Gatefile-managed file operations from the pre-apply snapshot.",
      "Command side effects are not automatically rollbackable in this MVP."
    ]
  };
}

export function clearStateForTesting(repoRoot: string | undefined): void {
  const layout = getStateLayout(repoRoot);
  if (existsSync(layout.gatefileRoot)) {
    rmSync(layout.gatefileRoot, { recursive: true, force: true });
  }
}

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  ApplyOperationResult,
  ApplyReceipt,
  ApplyReport,
  DryRunOperationPreview,
  DryRunReport,
  GatefileConfig,
  PlanFile,
  RollbackReport,
  SnapshotFile
} from "./types";
import { checkPreconditions } from "./preconditions";
import { verifyPlan } from "./verify";
import {
  dependencyStatus,
  getRepoRoot,
  makeReceiptId,
  rollbackByReceipt,
  snapshotPath,
  writeReceipt,
  writeSnapshot,
  receiptPath
} from "./state";
import { runPolicyHook } from "./hooks";

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

interface FilePathSafetyResult {
  allowed: boolean;
  resolvedPath: string;
  allowedRoots: string[];
  reason?: string;
}

export interface PlanRuntimeOptions {
  repoRoot?: string;
  planPath?: string;
  config?: GatefileConfig;
}

function effectiveAllowedRoots(plan: PlanFile): string[] {
  const rawRoots = plan.execution?.filePolicy?.allowedRoots
    ?.map((root) => root.trim())
    .filter((root) => root.length > 0);

  const roots = rawRoots && rawRoots.length > 0 ? rawRoots : [process.cwd()];
  const deduped = new Set<string>();
  for (const root of roots) {
    deduped.add(resolve(root));
  }
  return [...deduped];
}

function isPathWithinRoot(resolvedPath: string, root: string): boolean {
  const rel = relative(root, resolvedPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function evaluateFilePathSafety(plan: PlanFile, rawPath: string): FilePathSafetyResult {
  if (rawPath.trim().length === 0) {
    const allowedRoots = effectiveAllowedRoots(plan);
    return {
      allowed: false,
      resolvedPath: resolve(rawPath),
      allowedRoots,
      reason: "path is empty"
    };
  }

  const resolvedPath = resolve(rawPath);
  const allowedRoots = effectiveAllowedRoots(plan);
  const allowed = allowedRoots.some((root) => isPathWithinRoot(resolvedPath, root));
  if (allowed) {
    return { allowed: true, resolvedPath, allowedRoots };
  }

  return {
    allowed: false,
    resolvedPath,
    allowedRoots,
    reason: `resolved path is outside allowed roots [${allowedRoots.join(", ")}]`
  };
}

function applyFileOperation(
  plan: PlanFile,
  op: Extract<PlanFile["operations"][number], { type: "file" }>
): ApplyOperationResult {
  const pathSafety = evaluateFilePathSafety(plan, op.path);
  if (!pathSafety.allowed) {
    return {
      operationId: op.id,
      success: false,
      message: `file path denied by policy: ${op.path} -> ${pathSafety.resolvedPath} (${pathSafety.reason})`
    };
  }

  try {
    if (op.action === "create" || op.action === "update") {
      mkdirSync(dirname(pathSafety.resolvedPath), { recursive: true });
      writeFileSync(pathSafety.resolvedPath, op.after ?? "", "utf-8");
      return { operationId: op.id, success: true, message: `${op.action} ${op.path}` };
    }

    if (op.action === "delete") {
      readFileSync(pathSafety.resolvedPath, "utf-8");
      rmSync(pathSafety.resolvedPath);
      return { operationId: op.id, success: true, message: `delete ${op.path}` };
    }

    return { operationId: op.id, success: false, message: "Unsupported file action" };
  } catch (error) {
    return {
      operationId: op.id,
      success: false,
      message: `File op failed: ${(error as Error).message}`
    };
  }
}

function commandTimeoutMs(
  plan: PlanFile,
  op: Extract<PlanFile["operations"][number], { type: "command" }>
): number {
  const rawTimeout = op.timeoutMs ?? plan.execution?.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
  return Math.floor(rawTimeout);
}

function checkCommandPolicy(
  plan: PlanFile,
  command: string
): { allowed: true } | { allowed: false; message: string } {
  const policy = plan.execution?.commandPolicy;
  if (!policy) return { allowed: true };

  const patterns = policy.patterns.filter((pattern) => pattern.length > 0);
  if (patterns.length === 0) return { allowed: true };

  const matches = patterns.filter((pattern) => command.includes(pattern));
  if (policy.mode === "allow" && matches.length === 0) {
    return {
      allowed: false,
      message: `command denied by policy (allow mode): command must include one of [${patterns.join(", ")}]`
    };
  }

  if (policy.mode === "deny" && matches.length > 0) {
    return {
      allowed: false,
      message: `command denied by policy (deny mode): matched [${matches.join(", ")}]`
    };
  }

  return { allowed: true };
}

function formatCommandFailureMessage(error: unknown, timeoutMs: number): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error != null ? (error as { code?: string }).code : undefined;

  if (code === "ETIMEDOUT" || message.includes("ETIMEDOUT")) {
    return `command timed out after ${timeoutMs}ms: ${message}`;
  }

  return `command failed: ${message}`;
}

function applyCommandOperation(
  plan: PlanFile,
  op: Extract<PlanFile["operations"][number], { type: "command" }>
): ApplyOperationResult {
  const timeoutMs = commandTimeoutMs(plan, op);
  const policyResult = checkCommandPolicy(plan, op.command);
  if (!policyResult.allowed) {
    if (op.allowFailure) {
      return {
        operationId: op.id,
        success: true,
        message: `command denied but allowed: ${policyResult.message}`
      };
    }

    return {
      operationId: op.id,
      success: false,
      message: policyResult.message
    };
  }

  try {
    execSync(op.command, {
      cwd: op.cwd,
      stdio: "inherit",
      timeout: timeoutMs
    });
    return {
      operationId: op.id,
      success: true,
      message: `command ok: ${op.command} (timeout ${timeoutMs}ms)`
    };
  } catch (error) {
    const failureMessage = formatCommandFailureMessage(error, timeoutMs);
    if (op.allowFailure) {
      return {
        operationId: op.id,
        success: true,
        message: `${failureMessage} (allowFailure=true)`
      };
    }

    return {
      operationId: op.id,
      success: false,
      message: failureMessage
    };
  }
}

function lineCount(value: string): number {
  if (value.length === 0) return 0;
  return value.split("\n").length;
}

function pathSafetyDetails(pathSafety: FilePathSafetyResult): string {
  const status = pathSafety.allowed ? "allowed" : "denied";
  const reason = pathSafety.reason ? `, reason: ${pathSafety.reason}` : "";
  return `path safety: ${status}, resolved: ${pathSafety.resolvedPath}, allowedRoots: [${pathSafety.allowedRoots.join(", ")}]${reason}`;
}

function describeFilePreview(
  plan: PlanFile,
  op: Extract<PlanFile["operations"][number], { type: "file" }>
): DryRunOperationPreview {
  const pathSafety = evaluateFilePathSafety(plan, op.path);
  const deniedSuffix = pathSafety.allowed ? "" : " [DENIED by file policy]";

  if (op.action === "create") {
    const after = op.after ?? "";
    return {
      operationId: op.id,
      message: `would create ${op.path}${deniedSuffix}`,
      details: `${pathSafetyDetails(pathSafety)}; after: ${after.length} chars, ${lineCount(after)} lines`
    };
  }

  if (op.action === "update") {
    const before = op.before ?? "";
    const after = op.after ?? "";
    const delta = after.length - before.length;
    const deltaPrefix = delta >= 0 ? "+" : "";
    return {
      operationId: op.id,
      message: `would update ${op.path}${deniedSuffix}`,
      details: `${pathSafetyDetails(pathSafety)}; before: ${before.length} chars, after: ${after.length} chars, delta: ${deltaPrefix}${delta}, lines: ${lineCount(before)} -> ${lineCount(after)}`
    };
  }

  const before = op.before;
  return {
    operationId: op.id,
    message: `would delete ${op.path}${deniedSuffix}`,
    details:
      `${pathSafetyDetails(pathSafety)}; ` +
      (before == null ? "before content: not provided" : `before: ${before.length} chars, ${lineCount(before)} lines`)
  };
}

function describeCommandPreview(
  plan: PlanFile,
  op: Extract<PlanFile["operations"][number], { type: "command" }>
): DryRunOperationPreview {
  const cwd = op.cwd ?? process.cwd();
  const allowFailure = op.allowFailure === true ? "yes" : "no";
  const timeoutMs = commandTimeoutMs(plan, op);
  const policy = plan.execution?.commandPolicy;
  const policyDetails = policy ? `, policy: ${policy.mode} [${policy.patterns.join(", ")}]` : "";
  return {
    operationId: op.id,
    message: `would run command: ${op.command}`,
    details: `cwd: ${cwd}, allowFailure: ${allowFailure}, timeoutMs: ${timeoutMs}${policyDetails}`
  };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function operationGuidance(op: PlanFile["operations"][number]): string {
  if (op.type === "file") {
    if (op.action === "create") {
      return `If applied, remove ${op.path} to undo the created file.`;
    }
    if (op.action === "update") {
      return op.before == null
        ? `If applied, restore ${op.path} from git/history; no inline before content was provided.`
        : `If applied, restore ${op.path} using the operation's before content.`;
    }
    return op.before == null
      ? `If applied, recreate ${op.path} from git/history; no inline before content was provided.`
      : `If applied, recreate ${op.path} using the operation's before content.`;
  }

  return "Command effects are not auto-reverted; run explicit inverse commands or restore from snapshots.";
}

function buildDryRunRecovery(plan: PlanFile): DryRunReport["recovery"] {
  const affectedPaths = unique(
    plan.operations.filter((op) => op.type === "file").map((op) => op.path)
  );

  return {
    transactionalRollback: false,
    affectedPaths,
    attemptedOperationIds: [],
    succeededOperationIds: [],
    pendingOperationIds: plan.operations.map((op) => op.id),
    steps: plan.operations.map((op) => ({
      operationId: op.id,
      type: op.type,
      status: "planned",
      path: op.type === "file" ? op.path : undefined,
      guidance: operationGuidance(op)
    })),
    notes: [
      "Dry-run executes nothing; use this preview to prepare manual rollback before real apply.",
      "Real apply creates a pre-apply file snapshot under .gatefile/state.",
      "gatefile does not provide transactional rollback."
    ]
  };
}

function buildApplyRecovery(plan: PlanFile, results: ApplyOperationResult[]): ApplyReport["recovery"] {
  const resultById = new Map(results.map((result) => [result.operationId, result]));
  const attemptedOperationIds = results.map((result) => result.operationId);
  const succeededOperationIds = results.filter((result) => result.success).map((result) => result.operationId);
  const failedOperationId = results.find((result) => !result.success)?.operationId;
  const pendingOperationIds = plan.operations
    .map((op) => op.id)
    .filter((operationId) => !resultById.has(operationId));

  const attemptedFilePaths = unique(
    plan.operations
      .filter((op): op is Extract<PlanFile["operations"][number], { type: "file" }> => op.type === "file")
      .filter((op) => attemptedOperationIds.includes(op.id))
      .map((op) => op.path)
  );

  return {
    transactionalRollback: false,
    affectedPaths: attemptedFilePaths,
    attemptedOperationIds,
    succeededOperationIds,
    failedOperationId,
    pendingOperationIds,
    steps: plan.operations.map((op) => {
      const result = resultById.get(op.id);
      const status = !result ? "not-run" : result.success ? "succeeded" : "failed";
      return {
        operationId: op.id,
        type: op.type,
        status,
        path: op.type === "file" ? op.path : undefined,
        guidance: operationGuidance(op)
      };
    }),
    notes: [
      failedOperationId
        ? `Apply stopped at operation ${failedOperationId}; later operations were not run.`
        : "Apply completed all operations in order.",
      "Rollback restores Gatefile-managed file operations from .gatefile/state snapshots.",
      "Command side effects are not automatically rollbackable in this MVP.",
      "gatefile does not provide transactional rollback."
    ]
  };
}

function createPreApplySnapshot(plan: PlanFile, repoRoot: string, snapshotId: string): SnapshotFile {
  const seen = new Set<string>();
  const files: SnapshotFile["files"] = [];

  for (const op of plan.operations) {
    if (op.type !== "file") continue;

    const pathSafety = evaluateFilePathSafety(plan, op.path);
    if (!pathSafety.allowed) {
      continue;
    }

    if (seen.has(pathSafety.resolvedPath)) {
      continue;
    }

    seen.add(pathSafety.resolvedPath);
    const existedBefore = existsSync(pathSafety.resolvedPath);
    const contentBefore = existedBefore ? readFileSync(pathSafety.resolvedPath, "utf8") : undefined;
    files.push({
      operationId: op.id,
      path: op.path,
      resolvedPath: pathSafety.resolvedPath,
      existedBefore,
      contentBefore
    });
  }

  return {
    id: snapshotId,
    planId: plan.id,
    createdAt: new Date().toISOString(),
    repoRoot,
    files
  };
}

function applyCore(plan: PlanFile, options: PlanRuntimeOptions): ApplyReport {
  const repoRoot = getRepoRoot(options.repoRoot);
  const dependencies = dependencyStatus(plan, repoRoot);
  if (!dependencies.allSatisfied) {
    throw new Error(
      `Plan dependencies are not satisfied: missing successful apply for [${dependencies.missingPlanIds.join(", ")}]`
    );
  }

  if (options.config) {
    runPolicyHook(options.config, "beforeApply", plan, {
      repoRoot,
      planPath: options.planPath
    });
  }

  const appliedAt = new Date().toISOString();
  const receiptId = makeReceiptId(plan.id, appliedAt);
  const snapshot = createPreApplySnapshot(plan, repoRoot, receiptId);
  const snapshotFilePath = writeSnapshot(repoRoot, snapshot);
  const results: ApplyOperationResult[] = [];

  for (const op of plan.operations) {
    const result = op.type === "file" ? applyFileOperation(plan, op) : applyCommandOperation(plan, op);
    results.push(result);

    if (!result.success) {
      const report: ApplyReport = {
        planId: plan.id,
        appliedAt,
        success: false,
        results,
        recovery: buildApplyRecovery(plan, results),
        dependencies,
        snapshot: {
          id: snapshot.id,
          path: snapshotFilePath,
          fileCount: snapshot.files.length
        },
        receipt: {
          id: receiptId,
          path: receiptPath(repoRoot, receiptId)
        },
        rollbackCommand: `gatefile rollback-apply ${receiptId} --yes`
      };

      const receipt: ApplyReceipt = {
        id: receiptId,
        planId: plan.id,
        planHash: plan.integrity.planHash,
        appliedAt,
        success: false,
        snapshotId: snapshot.id,
        operationResults: results,
        dependencies
      };
      writeReceipt(repoRoot, receipt);
      return report;
    }
  }

  const report: ApplyReport = {
    planId: plan.id,
    appliedAt,
    success: true,
    results,
    recovery: buildApplyRecovery(plan, results),
    dependencies,
    snapshot: {
      id: snapshot.id,
      path: snapshotFilePath,
      fileCount: snapshot.files.length
    },
    receipt: {
      id: receiptId,
      path: receiptPath(repoRoot, receiptId)
    },
    rollbackCommand: `gatefile rollback-apply ${receiptId} --yes`
  };

  const receipt: ApplyReceipt = {
    id: receiptId,
    planId: plan.id,
    planHash: plan.integrity.planHash,
    appliedAt,
    success: true,
    snapshotId: snapshot.id,
    operationResults: results,
    dependencies
  };
  writeReceipt(repoRoot, receipt);

  return report;
}

export function previewPlan(plan: PlanFile, options: PlanRuntimeOptions = {}): DryRunReport {
  const verification = verifyPlan(plan, { config: options.config });
  const dependencies = dependencyStatus(plan, options.repoRoot);

  const results = plan.operations.map((op) =>
    op.type === "file" ? describeFilePreview(plan, op) : describeCommandPreview(plan, op)
  );

  return {
    planId: plan.id,
    previewedAt: new Date().toISOString(),
    success: true,
    preconditionsChecked: false,
    verification: {
      status: verification.status,
      approvalStatus: verification.approvalStatus,
      signerTrustStatus: verification.signerTrust.status,
      readyToApplyFromIntegrityApproval: verification.readyToApplyFromIntegrityApproval,
      blockers: verification.blockers
    },
    dependencies,
    results,
    recovery: buildDryRunRecovery(plan)
  };
}

export function applyPlan(plan: PlanFile, options: PlanRuntimeOptions = {}): ApplyReport {
  const verification = verifyPlan(plan, { config: options.config });
  if (!verification.readyToApplyFromIntegrityApproval) {
    throw new Error(`Plan failed verification: ${verification.blockers.join("; ")}`);
  }

  const preflight = checkPreconditions(plan.preconditions);
  if (!preflight.ok) {
    throw new Error(`Preconditions failed: ${preflight.message}`);
  }

  return applyCore(plan, options);
}

export function rollbackApply(receiptId: string, options: PlanRuntimeOptions = {}): RollbackReport {
  return rollbackByReceipt(options.repoRoot, receiptId);
}

export function snapshotFilePathForReceipt(receiptId: string, options: PlanRuntimeOptions = {}): string {
  return snapshotPath(options.repoRoot, receiptId);
}

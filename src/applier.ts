import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  ApplyOperationResult,
  ApplyReport,
  DryRunOperationPreview,
  DryRunReport,
  GatefileConfig,
  PlanFile,
  RollbackReport
} from "./types";
import { checkPreconditions } from "./preconditions";
import { verifyPlan } from "./verify";
import {
  dependencyStatus,
  getStateLayout,
  getRepoRoot,
  getPinnedRepoRoot,
  makeReceiptId,
  preflightStateForApply,
  prepareStateForApply,
  replaceReceipt,
  rollbackByReceipt,
  snapshotPath,
  writeReceipt,
  writeSnapshot
} from "./state";
import { runPolicyHook } from "./hooks";
import {
  commandRuleMatches,
  formatCommandInvocation,
  validatePlanCommandContract
} from "./command";
import {
  APPLY_RECEIPT_WORST_CASE_BUDGET_BYTES,
  STATE_RECORD_TEXT_MAX_LENGTH,
  validatePlanFile
} from "./validation";
import {
  createSafeFsContext,
  preflightFileOperations,
  resolveSafeTarget,
  safeCreate,
  safeDelete,
  safeUpdate,
  SafeFsPostCommitError
} from "./safe-fs";
import type {
  BeforeFileCommit,
  CompactFileState,
  PreparedFileOperation,
  SafeFileMutationResult,
  SafeFsContext
} from "./safe-fs";
import { exactFileStateToStored } from "./state-records";
import type {
  ReceiptAuditMetadata,
  ReceiptRecordBody,
  RollbackRecordEntry,
  SnapshotRecordBody
} from "./state-records";
import {
  inheritPinnedRepoRoot,
  isRuntimeRepoRootPinned,
  pinnedRepoRootState
} from "./pinned-runtime";

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

type PendingApplyOperationResult = Omit<ApplyOperationResult, "mutationStatus"> & {
  mutationStatus?: ApplyOperationResult["mutationStatus"];
};

interface FilePathSafetyResult {
  allowed: boolean;
  resolvedPath: string;
  allowedRoots: string[];
  reason?: string;
}

export interface PlanRuntimeOptions {
  repoRoot?: string;
  repositoryId?: string;
  /** Trusted operator override for external authenticated state. */
  stateHome?: string;
  planPath?: string;
  config?: GatefileConfig;
  commandOutput?:
    | { mode: "inherit" }
    | { mode: "capture"; maxBytes: number };
}

const MAX_COMMAND_CAPTURE_BYTES = 65_536;
const MAX_COMMAND_SPAWN_BUFFER_BYTES = 1_048_576;

function normalizeCommandOutput(
  value: PlanRuntimeOptions["commandOutput"]
): NonNullable<PlanRuntimeOptions["commandOutput"]> {
  if (value === undefined || value.mode === "inherit") return { mode: "inherit" };
  if (
    value.mode !== "capture" ||
    !Number.isSafeInteger(value.maxBytes) ||
    value.maxBytes < 1 ||
    value.maxBytes > MAX_COMMAND_CAPTURE_BYTES
  ) {
    throw new Error(
      `commandOutput capture maxBytes must be an integer from 1 to ${MAX_COMMAND_CAPTURE_BYTES}`
    );
  }
  return { mode: "capture", maxBytes: value.maxBytes };
}

function runtimeRepoRoot(options: PlanRuntimeOptions): string {
  if (isRuntimeRepoRootPinned(options)) {
    if (options.repoRoot === undefined) {
      throw new Error("A canonical repository root must be provided explicitly");
    }
    return getPinnedRepoRoot(options.repoRoot);
  }
  return getRepoRoot(options.repoRoot);
}

function effectiveAllowedRoots(plan: PlanFile, repoRoot: string): string[] {
  const rawRoots = plan.execution?.filePolicy?.allowedRoots
    ?.map((root) => root.trim())
    .filter((root) => root.length > 0);
  return rawRoots && rawRoots.length > 0 ? [...new Set(rawRoots)] : [repoRoot];
}

function evaluateFilePathSafety(
  plan: PlanFile,
  op: Extract<PlanFile["operations"][number], { type: "file" }>,
  repoRoot: string,
  reservedRoots: readonly string[] = []
): FilePathSafetyResult {
  const configuredRoots = effectiveAllowedRoots(plan, repoRoot);
  const fallbackPath = resolve(repoRoot, op.path);
  try {
    const context = createSafeFsContext(repoRoot, configuredRoots, reservedRoots);
    const target = resolveSafeTarget(context, op.path, op.action);
    return {
      allowed: true,
      resolvedPath: target.targetPath,
      allowedRoots: context.allowedRoots
    };
  } catch (error) {
    return {
      allowed: false,
      resolvedPath: fallbackPath,
      allowedRoots: configuredRoots,
      reason: (error as Error).message
    };
  }
}

function applyFileOperation(
  context: SafeFsContext,
  prepared: PreparedFileOperation,
  beforeCommit?: BeforeFileCommit
): { result: PendingApplyOperationResult; mutation?: SafeFileMutationResult } {
  const op = prepared.operation;
  try {
    if (op.action === "create") {
      const mutation = safeCreate(
        context,
        prepared.target,
        prepared.beforeState,
        op.after,
        0o600,
        beforeCommit
      );
      return {
        result: {
          operationId: op.id,
          success: true,
          message: `create ${op.path}`,
          mutationStatus: "committed"
        },
        mutation
      };
    }

    if (op.action === "update") {
      const mutation = safeUpdate(
        context,
        prepared.target,
        prepared.beforeState,
        op.after,
        beforeCommit
      );
      return {
        result: {
          operationId: op.id,
          success: true,
          message: `update ${op.path}`,
          mutationStatus: "committed"
        },
        mutation
      };
    }

    if (op.action === "delete") {
      const mutation = safeDelete(context, prepared.target, prepared.beforeState, beforeCommit);
      return {
        result: {
          operationId: op.id,
          success: true,
          message: `delete ${op.path}`,
          mutationStatus: "committed"
        },
        mutation
      };
    }

    const unsupported = op as unknown as { id?: unknown; action?: unknown };
    return {
      result: {
        operationId: typeof unsupported.id === "string" ? unsupported.id : "unknown-operation",
        success: false,
        message: `Unsupported file action: ${String(unsupported.action)}`
      }
    };
  } catch (error) {
    if (error instanceof SafeFsPostCommitError) {
      return {
        result: {
          operationId: op.id,
          success: false,
          message: `File op committed but finalization failed; authenticated rollback is required: ${error.message}`,
          mutationStatus: "committed"
        },
        mutation: error.committed
      };
    }
    return {
      result: {
        operationId: op.id,
        success: false,
        message: `File op failed: ${(error as Error).message}`
      }
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
  operation: Extract<PlanFile["operations"][number], { type: "command" }>
): { allowed: true } | { allowed: false; message: string } {
  const policy = plan.execution?.commandPolicy;
  if (!policy) return { allowed: true };

  const matches = policy.rules.filter((rule) => commandRuleMatches(operation, rule));
  if (policy.mode === "allow" && matches.length === 0) {
    return {
      allowed: false,
      message: "command denied by policy (allow mode): executable and arguments must exactly match a rule"
    };
  }

  if (policy.mode === "deny" && matches.length > 0) {
    return {
      allowed: false,
      message: "command denied by policy (deny mode): executable and arguments exactly matched a rule"
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
  op: Extract<PlanFile["operations"][number], { type: "command" }>,
  repoRoot: string,
  commandOutput: NonNullable<PlanRuntimeOptions["commandOutput"]>
): PendingApplyOperationResult {
  const timeoutMs = commandTimeoutMs(plan, op);
  const invocation = formatCommandInvocation(op);
  const policyResult = checkCommandPolicy(plan, op);
  if (!policyResult.allowed) {
    return {
      operationId: op.id,
      success: false,
      message: policyResult.message
    };
  }

  try {
    const result = commandOutput.mode === "capture"
      ? spawnSync(op.executable, op.args, {
          cwd: resolve(repoRoot, op.cwd ?? "."),
          stdio: "pipe",
          timeout: timeoutMs,
          shell: false,
          maxBuffer: MAX_COMMAND_SPAWN_BUFFER_BYTES
        })
      : spawnSync(op.executable, op.args, {
          cwd: resolve(repoRoot, op.cwd ?? "."),
          stdio: "inherit",
          timeout: timeoutMs,
          shell: false
        });
    const captured = commandOutput.mode === "capture"
      ? formatCapturedCommandOutput(result.stdout, result.stderr, commandOutput.maxBytes)
      : "";
    if (result.error) {
      throw new Error(`${result.error.message}${captured}`);
    }
    if (result.status !== 0) {
      const signal = result.signal ? `, signal ${result.signal}` : "";
      throw new Error(
        `process exited with status ${result.status ?? "unknown"}${signal}${captured}`
      );
    }
    return {
      operationId: op.id,
      success: true,
      message: `command ok: ${invocation} (timeout ${timeoutMs}ms)${captured}`
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

function formatCapturedStream(
  label: "stdout" | "stderr",
  value: Buffer | null,
  maxBytes: number
): string | undefined {
  if (!value || value.length === 0) return undefined;
  const truncated = value.length > maxBytes;
  const visible = value.subarray(0, maxBytes).toString("utf8");
  return `${label}=${JSON.stringify(visible)}${truncated ? ` [truncated at ${maxBytes} bytes]` : ""}`;
}

function formatCapturedCommandOutput(
  stdout: Buffer | null,
  stderr: Buffer | null,
  maxBytes: number
): string {
  const streams = [
    formatCapturedStream("stdout", stdout, maxBytes),
    formatCapturedStream("stderr", stderr, maxBytes)
  ].filter((value): value is string => value !== undefined);
  return streams.length === 0 ? "" : `; captured ${streams.join(", ")}`;
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
  op: Extract<PlanFile["operations"][number], { type: "file" }>,
  repoRoot: string,
  reservedRoots: readonly string[]
): DryRunOperationPreview {
  const pathSafety = evaluateFilePathSafety(plan, op, repoRoot, reservedRoots);
  const deniedSuffix = pathSafety.allowed ? "" : " [DENIED by file policy]";

  if (op.action === "create") {
    const after = op.after ?? "";
    return {
      operationId: op.id,
      allowed: pathSafety.allowed,
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
      allowed: pathSafety.allowed,
      message: `would update ${op.path}${deniedSuffix}`,
      details: `${pathSafetyDetails(pathSafety)}; before: ${before.length} chars, after: ${after.length} chars, delta: ${deltaPrefix}${delta}, lines: ${lineCount(before)} -> ${lineCount(after)}`
    };
  }

  const before = op.before;
  return {
    operationId: op.id,
    allowed: pathSafety.allowed,
    message: `would delete ${op.path}${deniedSuffix}`,
    details:
      `${pathSafetyDetails(pathSafety)}; ` +
      (before == null ? "before content: not provided" : `before: ${before.length} chars, ${lineCount(before)} lines`)
  };
}

function describeCommandPreview(
  plan: PlanFile,
  op: Extract<PlanFile["operations"][number], { type: "command" }>,
  repoRoot: string
): DryRunOperationPreview {
  const cwd = resolve(repoRoot, op.cwd ?? ".");
  const allowFailure = op.allowFailure === true ? "yes" : "no";
  const timeoutMs = commandTimeoutMs(plan, op);
  const policy = plan.execution?.commandPolicy;
  const policyDetails = policy ? `, policy: ${policy.mode} (${policy.rules.length} exact rules)` : "";
  const policyResult = checkCommandPolicy(plan, op);
  const deniedSuffix = policyResult.allowed ? "" : " [DENIED by command policy]";
  const denialDetails = policyResult.allowed ? "" : `, reason: ${policyResult.message}`;
  return {
    operationId: op.id,
    allowed: policyResult.allowed,
    message: `would run command: ${formatCommandInvocation(op)}${deniedSuffix}`,
    details: `cwd: ${cwd}, allowFailure: ${allowFailure}, timeoutMs: ${timeoutMs}${policyDetails}${denialDetails}`
  };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function quotePosixCliArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function rollbackCommand(context: ApplyReport["rollbackContext"]): string {
  return [
    "gatefile",
    "rollback-apply",
    quotePosixCliArg(context.receiptId),
    "--yes",
    "--repo-root",
    quotePosixCliArg(context.repoRoot),
    "--repository-id",
    quotePosixCliArg(context.repositoryId),
    "--state-home",
    quotePosixCliArg(context.stateHome)
  ].join(" ");
}

function operationGuidance(op: PlanFile["operations"][number]): string {
  if (op.type === "file") {
    if (op.action === "create") {
      return `If applied, remove ${op.path} to undo the created file.`;
    }
    if (op.action === "update") {
      return `If applied, restore ${op.path} using the operation's before content.`;
    }
    return `If applied, recreate ${op.path} using the operation's before content.`;
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
      "Real apply creates an authenticated pre-apply snapshot in the external Gatefile state home.",
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
        ...(result?.mutationStatus ? { mutationStatus: result.mutationStatus } : {}),
        path: op.type === "file" ? op.path : undefined,
        guidance: operationGuidance(op)
      };
    }),
    notes: [
      failedOperationId
        ? `Apply stopped at operation ${failedOperationId}; later operations were not run.`
        : "Apply completed all operations in order.",
      "Rollback restores Gatefile-managed file operations from authenticated external snapshots.",
      "Command side effects are not automatically rollbackable in this alpha.",
      "gatefile does not provide transactional rollback."
    ]
  };
}

function snapshotEntryId(prepared: PreparedFileOperation, index: number): string {
  const suffix = createHash("sha256")
    .update(`${prepared.operation.id}\0${prepared.target.allowedRoot}\0${prepared.target.relativePath}`)
    .digest("hex")
    .slice(0, 16);
  return `entry_${index + 1}_${suffix}`;
}

function createPreApplySnapshot(
  plan: PlanFile,
  snapshotId: string,
  repository: ReturnType<typeof getStateLayout>["repository"],
  prepared: PreparedFileOperation[],
  createdAt: string
): SnapshotRecordBody {
  return {
    type: "gatefile-rollback-snapshot",
    stateVersion: 1,
    id: snapshotId,
    repository,
    plan: {
      id: plan.id,
      hash: plan.integrity.planHash
    },
    createdAt,
    entries: prepared.map((entry, index) => ({
      id: snapshotEntryId(entry, index),
      operationId: entry.operation.id,
      action: entry.operation.action,
      // Persist the canonical target spelling. The approved plan still retains
      // the review-facing path, while rollback is independent of platform
      // prefix aliases such as macOS /var -> /private/var.
      requestedPath: entry.target.targetPath,
      allowedRoot: entry.target.allowedRoot,
      relativePath: entry.target.relativePath,
      directoryChain: entry.target.directoryChain,
      before: exactFileStateToStored(entry.beforeState)
    }))
  };
}

function stateOptionsForPlan(
  plan: PlanFile,
  options: PlanRuntimeOptions,
  repoRoot: string
): {
  repoRoot: string;
  repositoryId: string;
  stateHome?: string;
} {
  return inheritPinnedRepoRoot(options, {
    repoRoot,
    repositoryId: plan.context.repositoryId,
    stateHome: options.stateHome
  });
}

function rollbackEntriesForApply(
  snapshot: ReturnType<typeof writeSnapshot>["record"],
  mutationByOperation: Map<string, SafeFileMutationResult>
): RollbackRecordEntry[] {
  const entries: RollbackRecordEntry[] = [];
  for (const snapshotEntry of snapshot.entries) {
    const mutation = mutationByOperation.get(snapshotEntry.operationId);
    if (!mutation) continue;
    entries.push({
      snapshotEntryId: snapshotEntry.id,
      operationId: snapshotEntry.operationId,
      action: snapshotEntry.action,
      requestedPath: snapshotEntry.requestedPath,
      allowedRoot: mutation.target.allowedRoot,
      relativePath: mutation.target.relativePath,
      directoryChain: mutation.target.directoryChain,
      after: mutation.afterState,
      cleanupResidues: mutation.cleanupResidues
    });
  }
  return entries;
}

function boundOperationResult(result: PendingApplyOperationResult): ApplyOperationResult {
  const normalized = {
    ...result,
    mutationStatus: result.mutationStatus ?? "none" as const
  };
  if (normalized.message.length <= STATE_RECORD_TEXT_MAX_LENGTH) return normalized;
  const suffix = "…[truncated for authenticated receipt]";
  return {
    ...normalized,
    message: `${normalized.message.slice(0, STATE_RECORD_TEXT_MAX_LENGTH - suffix.length)}${suffix}`
  };
}

function assertPreparedReceiptFits(
  plan: PlanFile,
  receiptId: string,
  layout: ReturnType<typeof getStateLayout>,
  snapshot: SnapshotRecordBody,
  dependencies: ApplyReport["dependencies"],
  preparedFiles: PreparedFileOperation[],
  appliedAt: string
): void {
  const preparedById = new Map(preparedFiles.map((entry) => [entry.operation.id, entry]));
  const pessimisticMessage = "\u0001".repeat(STATE_RECORD_TEXT_MAX_LENGTH);
  const pessimisticResults = plan.operations.map((operation) => ({
    operationId: operation.id,
    success: false,
    message: pessimisticMessage,
    mutationStatus: operation.type === "file" ? "intended" : "none"
  }));
  const pessimisticRollbackEntries = snapshot.entries.map((snapshotEntry) => {
    const prepared = preparedById.get(snapshotEntry.operationId);
    if (!prepared) throw new Error(`Missing prepared file operation ${snapshotEntry.operationId}`);
    const after: CompactFileState = prepared.operation.action === "delete"
      ? { kind: "absent" }
      : {
          kind: "regular",
          sha256: "f".repeat(64),
          byteLength: Buffer.byteLength(prepared.operation.after ?? "", "utf8"),
          mode: 0o7777,
          uid: "9".repeat(40),
          gid: "9".repeat(40),
          identity: { device: "9".repeat(40), inode: "9".repeat(40) }
        };
    return {
      snapshotEntryId: snapshotEntry.id,
      operationId: snapshotEntry.operationId,
      action: snapshotEntry.action,
      requestedPath: snapshotEntry.requestedPath,
      allowedRoot: prepared.target.allowedRoot,
      relativePath: prepared.target.relativePath,
      directoryChain: prepared.target.directoryChain,
      after,
      cleanupResidues: prepared.operation.action === "create" || prepared.operation.action === "update"
        ? [{
            path: resolve(
              prepared.target.parentPath,
              `.${prepared.target.basename}.gatefile-${"f".repeat(32)}.tmp`
            ),
            identity: after.kind === "regular"
              ? { ...after.identity }
              : { device: "9".repeat(40), inode: "9".repeat(40) }
          }]
        : []
    };
  });
  const pessimisticRecord = {
    type: "gatefile-apply-receipt",
    stateVersion: 1,
    id: receiptId,
    repository: layout.repository,
    plan: { id: plan.id, hash: plan.integrity.planHash },
    appliedAt,
    snapshotId: snapshot.id,
    snapshotDigest: "d".repeat(64),
    success: false,
    results: pessimisticResults,
    dependencies,
    rollbackEntries: pessimisticRollbackEntries,
    audit: receiptAuditMetadata(plan),
    authentication: {
      scheme: "hmac-sha256",
      envelopeVersion: 1,
      keyId: "k".repeat(43),
      tag: "t".repeat(43)
    }
  };
  const byteLength = Buffer.byteLength(`${JSON.stringify(pessimisticRecord, null, 2)}\n`, "utf8");
  if (byteLength > APPLY_RECEIPT_WORST_CASE_BUDGET_BYTES) {
    throw new Error(
      `Prepared authenticated receipt could require ${byteLength} bytes, exceeding the pre-mutation budget ${APPLY_RECEIPT_WORST_CASE_BUDGET_BYTES}`
    );
  }
}

function receiptAuditMetadata(plan: PlanFile): ReceiptAuditMetadata {
  if (
    plan.approval.status !== "approved" ||
    !plan.approval.approvedBy ||
    !plan.approval.approvedAt
  ) {
    throw new Error("An authenticated apply receipt requires complete approval metadata");
  }
  const signerKeyId = plan.approval.attestation?.keyId ?? null;
  const audit = {
    summary: plan.summary,
    source: plan.source,
    approvedBy: plan.approval.approvedBy,
    approvedAt: plan.approval.approvedAt
  };
  return signerKeyId === null
    ? { ...audit, approvalIdentity: "unsigned", signerKeyId: null }
    : { ...audit, approvalIdentity: "signed", signerKeyId };
}

function receiptBodyForApply(
  plan: PlanFile,
  receiptId: string,
  layout: ReturnType<typeof getStateLayout>,
  snapshot: ReturnType<typeof writeSnapshot>,
  appliedAt: string,
  success: boolean,
  results: ApplyOperationResult[],
  dependencies: ApplyReport["dependencies"],
  mutations: Map<string, SafeFileMutationResult>
): ReceiptRecordBody {
  return {
    type: "gatefile-apply-receipt",
    stateVersion: 1,
    id: receiptId,
    repository: layout.repository,
    plan: { id: plan.id, hash: plan.integrity.planHash },
    appliedAt,
    snapshotId: snapshot.record.id,
    snapshotDigest: snapshot.digest,
    success,
    results: results.map((result) => ({
      ...result,
      mutationStatus: result.mutationStatus ?? "none"
    })),
    dependencies,
    rollbackEntries: rollbackEntriesForApply(snapshot.record, mutations),
    audit: receiptAuditMetadata(plan)
  };
}

function applyCore(plan: PlanFile, options: PlanRuntimeOptions): ApplyReport {
  const commandOutput = normalizeCommandOutput(options.commandOutput);
  const repoRoot = runtimeRepoRoot(options);
  const stateOptions = stateOptionsForPlan(plan, options, repoRoot);
  const layout = getStateLayout(stateOptions);
  const dependencies = dependencyStatus(plan, stateOptions);
  if (!dependencies.allSatisfied) {
    throw new Error(
      `Plan dependencies are not satisfied: missing successful apply for [${dependencies.missingPlanIds.join(", ")}]`
    );
  }

  const appliedAt = new Date().toISOString();
  const receiptId = makeReceiptId(plan.id, appliedAt);
  const fileOperations = plan.operations.filter(
    (op): op is Extract<PlanFile["operations"][number], { type: "file" }> => op.type === "file"
  );
  let fileContext: SafeFsContext | undefined;
  let preparedFiles: PreparedFileOperation[] = [];
  let preflightFailure: { operationId: string; message: string } | undefined;
  const deniedCommand = plan.operations
    .filter((op): op is Extract<PlanFile["operations"][number], { type: "command" }> =>
      op.type === "command"
    )
    .map((operation) => ({ operation, policy: checkCommandPolicy(plan, operation) }))
    .find(({ policy }) => !policy.allowed);
  if (deniedCommand && !deniedCommand.policy.allowed) {
    preflightFailure = {
      operationId: deniedCommand.operation.id,
      message: deniedCommand.policy.message
    };
  }
  if (!preflightFailure && fileOperations.length > 0) {
    try {
      fileContext = createSafeFsContext(
        repoRoot,
        effectiveAllowedRoots(plan, repoRoot),
        [layout.stateHome]
      );
      preparedFiles = preflightFileOperations(fileContext, fileOperations);
    } catch (error) {
      const message = (error as Error).message;
      const failedOperation = fileOperations.find(
        (operation) => message.includes(operation.id) || message.includes(operation.path)
      ) ?? fileOperations[0];
      preflightFailure = {
        operationId: failedOperation.id,
        message: `file path denied by policy or secure preflight: ${message}`
      };
    }
  }

  const snapshotBody = createPreApplySnapshot(
    plan,
    receiptId,
    layout.repository,
    preparedFiles,
    appliedAt
  );
  assertPreparedReceiptFits(
    plan,
    receiptId,
    layout,
    snapshotBody,
    dependencies,
    preparedFiles,
    appliedAt
  );
  preflightStateForApply(stateOptions, plan.id, receiptId);

  if (!preflightFailure && options.config) {
    const pinned = pinnedRepoRootState(options);
    runPolicyHook(options.config, "beforeApply", plan, {
      repoRoot,
      planPath: options.planPath,
      gitExecutable: pinned?.gitExecutable,
      pathEnvironment: pinned?.pathEnvironment
    });
  }

  prepareStateForApply(stateOptions, plan.id, receiptId);
  const persistedSnapshot = writeSnapshot(stateOptions, snapshotBody);
  let persistedReceipt = writeReceipt(
    stateOptions,
    receiptBodyForApply(
      plan,
      receiptId,
      layout,
      persistedSnapshot,
      appliedAt,
      false,
      [],
      dependencies,
      new Map()
    ),
    persistedSnapshot.record
  );
  const results: ApplyOperationResult[] = [];
  const mutationByOperation = new Map<string, SafeFileMutationResult>();
  const preparedByOperation = new Map(
    preparedFiles.map((prepared) => [prepared.operation.id, prepared])
  );

  if (preflightFailure) {
    results.push(boundOperationResult({
      operationId: preflightFailure.operationId,
      success: false,
      message: preflightFailure.message
    }));
  } else {
    for (const op of plan.operations) {
      let result: PendingApplyOperationResult;
      if (op.type === "file") {
        const prepared = preparedByOperation.get(op.id);
        if (!fileContext || !prepared) {
          result = {
            operationId: op.id,
            success: false,
            message: "File op failed: secure preflight result is missing"
          };
        } else {
          let intendedMutation: SafeFileMutationResult | undefined;
          const applied = applyFileOperation(fileContext, prepared, (intent) => {
            const intendedMutations = new Map(mutationByOperation);
            intendedMutations.set(op.id, intent);
            const intentResult = boundOperationResult({
              operationId: op.id,
              success: false,
              message: "Authenticated write-ahead file mutation intent; commit outcome requires filesystem verification",
              mutationStatus: "intended"
            });
            persistedReceipt = replaceReceipt(
              stateOptions,
              receiptBodyForApply(
                plan,
                receiptId,
                layout,
                persistedSnapshot,
                appliedAt,
                false,
                [...results, intentResult],
                dependencies,
                intendedMutations
              ),
              persistedSnapshot.record
            );
            mutationByOperation.set(op.id, intent);
            intendedMutation = intent;
          });
          result = applied.result;
          if (applied.mutation) {
            mutationByOperation.set(op.id, applied.mutation);
          } else if (intendedMutation) {
            result = { ...result, mutationStatus: "intended" };
          }
        }
      } else if (op.type === "command") {
        result = applyCommandOperation(plan, op, repoRoot, commandOutput);
      } else {
        const unsupported = op as unknown as { id?: unknown; type?: unknown };
        result = {
          operationId: typeof unsupported.id === "string" ? unsupported.id : "unknown-operation",
          success: false,
          message: `Unsupported operation type: ${String(unsupported.type)}`
        };
      }
      const normalizedResult = boundOperationResult(result);
      results.push(normalizedResult);
      if (!normalizedResult.success) break;
    }
  }

  const success =
    results.length === plan.operations.length && results.every((result) => result.success);
  let receiptPersistenceError: string | undefined;
  try {
    persistedReceipt = replaceReceipt(
      stateOptions,
      receiptBodyForApply(
        plan,
        receiptId,
        layout,
        persistedSnapshot,
        appliedAt,
        success,
        results,
        dependencies,
        mutationByOperation
      ),
      persistedSnapshot.record
    );
  } catch (error) {
    receiptPersistenceError =
      `Final receipt publication failed; the authenticated write-ahead receipt remains the rollback authority: ${(error as Error).message}`;
  }
  const warnings = [persistedReceipt.warning, receiptPersistenceError].filter(
    (warning): warning is string => Boolean(warning)
  );
  const reportSuccess =
    success &&
    receiptPersistenceError === undefined &&
    persistedReceipt.planStateUpdated;
  const rollbackContext: ApplyReport["rollbackContext"] = {
    receiptId,
    repoRoot: layout.repoRoot,
    repositoryId: layout.repository.repositoryId,
    stateHome: layout.stateHome
  };

  return {
    planId: plan.id,
    appliedAt,
    success: reportSuccess,
    results,
    recovery: buildApplyRecovery(plan, results),
    dependencies,
    snapshot: {
      id: persistedSnapshot.record.id,
      path: persistedSnapshot.path,
      fileCount: persistedSnapshot.record.entries.length
    },
    receipt: {
      id: persistedReceipt.record.id,
      path: persistedReceipt.path
    },
    rollbackContext,
    ...(warnings.length > 0 ? { warnings } : {}),
    rollbackCommand: rollbackCommand(rollbackContext)
  };
}

export function previewPlan(plan: PlanFile, options: PlanRuntimeOptions = {}): DryRunReport {
  validatePlanCommandContract(plan);
  const verification = verifyPlan(plan, {
    config: options.config,
    repositoryId: options.repositoryId,
    repoRoot: options.repoRoot
  });
  const repoRoot = runtimeRepoRoot(options);
  const stateOptions = stateOptionsForPlan(plan, options, repoRoot);
  const layout = getStateLayout(stateOptions);
  const dependencies = dependencyStatus(
    plan,
    stateOptions
  );

  const results = plan.operations.map((op) =>
    op.type === "file"
      ? describeFilePreview(plan, op, repoRoot, [layout.stateHome])
      : describeCommandPreview(plan, op, repoRoot)
  );
  const verificationReady = verification.status === "ready";
  const dependenciesSatisfied = dependencies.allSatisfied;
  const operationsAllowed = results.every((result) => result.allowed);

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
    staticGate: {
      passed: verificationReady && dependenciesSatisfied && operationsAllowed,
      verificationReady,
      dependenciesSatisfied,
      operationsAllowed,
      preconditionsChecked: false
    },
    recovery: buildDryRunRecovery(plan)
  };
}

export function applyPlan(plan: PlanFile, options: PlanRuntimeOptions = {}): ApplyReport {
  validatePlanFile(plan);
  const verification = verifyPlan(plan, {
    config: options.config,
    repositoryId: options.repositoryId,
    repoRoot: options.repoRoot
  });
  if (!verification.readyToApplyFromIntegrityApproval) {
    throw new Error(`Plan failed verification: ${verification.blockers.join("; ")}`);
  }

  const repoRoot = runtimeRepoRoot(options);
  const preflight = checkPreconditions(
    plan.preconditions,
    inheritPinnedRepoRoot(options, { cwd: repoRoot })
  );
  if (!preflight.ok) {
    throw new Error(`Preconditions failed: ${preflight.message}`);
  }

  return applyCore(plan, inheritPinnedRepoRoot(options, { ...options, repoRoot }));
}

export function rollbackApply(receiptId: string, options: PlanRuntimeOptions = {}): RollbackReport {
  return rollbackByReceipt(
    inheritPinnedRepoRoot(options, {
      repoRoot: options.repoRoot,
      repositoryId: options.repositoryId,
      stateHome: options.stateHome
    }),
    receiptId
  );
}

export function snapshotFilePathForReceipt(receiptId: string, options: PlanRuntimeOptions = {}): string {
  return snapshotPath(
    inheritPinnedRepoRoot(options, {
      repoRoot: options.repoRoot,
      repositoryId: options.repositoryId,
      stateHome: options.stateHome
    }),
    receiptId
  );
}

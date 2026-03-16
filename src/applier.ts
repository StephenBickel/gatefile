import { execSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { ApplyOperationResult, ApplyReport, DryRunOperationPreview, DryRunReport, PlanFile } from "./types";
import { checkPreconditions } from "./preconditions";
import { verifyPlan } from "./verify";

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

function applyFileOperation(op: Extract<PlanFile["operations"][number], { type: "file" }>): ApplyOperationResult {
  try {
    if (op.action === "create" || op.action === "update") {
      mkdirSync(dirname(op.path), { recursive: true });
      writeFileSync(op.path, op.after ?? "", "utf-8");
      return { operationId: op.id, success: true, message: `${op.action} ${op.path}` };
    }

    if (op.action === "delete") {
      // Safe-ish MVP: verify file exists before delete for clearer reporting.
      readFileSync(op.path, "utf-8");
      rmSync(op.path);
      return { operationId: op.id, success: true, message: `delete ${op.path}` };
    }

    return { operationId: op.id, success: false, message: `Unsupported file action` };
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

function describeFilePreview(op: Extract<PlanFile["operations"][number], { type: "file" }>): DryRunOperationPreview {
  if (op.action === "create") {
    const after = op.after ?? "";
    return {
      operationId: op.id,
      message: `would create ${op.path}`,
      details: `after: ${after.length} chars, ${lineCount(after)} lines`
    };
  }

  if (op.action === "update") {
    const before = op.before ?? "";
    const after = op.after ?? "";
    const delta = after.length - before.length;
    const deltaPrefix = delta >= 0 ? "+" : "";
    return {
      operationId: op.id,
      message: `would update ${op.path}`,
      details: `before: ${before.length} chars, after: ${after.length} chars, delta: ${deltaPrefix}${delta}, lines: ${lineCount(before)} -> ${lineCount(after)}`
    };
  }

  const before = op.before;
  return {
    operationId: op.id,
    message: `would delete ${op.path}`,
    details: before == null ? "before content: not provided" : `before: ${before.length} chars, ${lineCount(before)} lines`
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

export function previewPlan(plan: PlanFile): DryRunReport {
  const verification = verifyPlan(plan);

  const results = plan.operations.map((op) =>
    op.type === "file" ? describeFilePreview(op) : describeCommandPreview(plan, op)
  );

  return {
    planId: plan.id,
    previewedAt: new Date().toISOString(),
    success: true,
    preconditionsChecked: false,
    verification: {
      status: verification.status,
      approvalStatus: verification.approvalStatus,
      readyToApplyFromIntegrityApproval: verification.readyToApplyFromIntegrityApproval,
      blockers: verification.blockers
    },
    results
  };
}

export function applyPlan(plan: PlanFile): ApplyReport {
  const verification = verifyPlan(plan);
  if (!verification.readyToApplyFromIntegrityApproval) {
    throw new Error(`Plan failed verification: ${verification.blockers.join("; ")}`);
  }

  const preflight = checkPreconditions(plan.preconditions);
  if (!preflight.ok) {
    throw new Error(`Preconditions failed: ${preflight.message}`);
  }

  const results: ApplyOperationResult[] = [];

  for (const op of plan.operations) {
    const result = op.type === "file" ? applyFileOperation(op) : applyCommandOperation(plan, op);
    results.push(result);

    if (!result.success) {
      return {
        planId: plan.id,
        appliedAt: new Date().toISOString(),
        success: false,
        results
      };
    }
  }

  return {
    planId: plan.id,
    appliedAt: new Date().toISOString(),
    success: true,
    results
  };
}

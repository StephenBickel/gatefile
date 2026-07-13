import { exec } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { dirname, resolve } from "node:path";
import { URL } from "node:url";
import type {
  GatefileConfig,
  NotificationActionConfig,
  PlanFile
} from "./types";
import { sanitizedGitEnvironment } from "./git-environment";
import {
  loadGatefileConfigFromPinnedRoot,
  normalizeGatefileConfig
} from "./config";
import { getPinnedRepoRoot, getRepoRoot } from "./state";

// ── Config types ──────────────────────────────────────────────

export type HookAction = NotificationActionConfig;

export interface HooksConfig {
  onPlanCreated?: HookAction;
  onPlanApproved?: HookAction;
  /** @deprecated Use onPlanApproved. */
  onApprovalNeeded?: HookAction;
}

export interface NotificationDispatchContext {
  /** Canonical repository root used for config loading and notification shell cwd. */
  repoRoot?: string;
  /** Explicit normalized snapshot source. When omitted, config is loaded from repoRoot. */
  config?: GatefileConfig;
}

interface ResolvedNotificationContext {
  repoRoot: string;
  hooks?: HooksConfig;
}

function resolveNotificationContext(
  context: NotificationDispatchContext = {}
): ResolvedNotificationContext {
  const repoRoot = context.repoRoot === undefined
    ? getRepoRoot()
    : getPinnedRepoRoot(context.repoRoot);
  const config = context.config === undefined
    ? loadGatefileConfigFromPinnedRoot(repoRoot)
    : normalizeGatefileConfig(context.config);
  const onPlanCreated = config.notifications?.onPlanCreated;
  const onPlanApproved = config.notifications?.onPlanApproved;
  if (!onPlanCreated && !onPlanApproved) return { repoRoot };
  return {
    repoRoot,
    hooks: {
      ...(onPlanCreated ? { onPlanCreated } : {}),
      ...(onPlanApproved
        ? {
            onPlanApproved,
            // Retain the read API used by the legacy notification name.
            onApprovalNeeded: onPlanApproved
          }
        : {})
    }
  };
}

/** Load canonical lifecycle notifications from an explicit or repository-pinned config. */
export function loadHooksConfig(
  context: NotificationDispatchContext = {}
): HooksConfig | undefined {
  return resolveNotificationContext(context).hooks;
}

// ── Hook execution ────────────────────────────────────────────

function buildPlanSummaryPayload(plan: PlanFile, event: string): string {
  return JSON.stringify({
    event,
    planId: plan.id,
    summary: plan.summary,
    source: plan.source,
    operationCount: plan.operations.length,
    risk: plan.risk,
    approval: {
      status: plan.approval.status,
      approvedBy: plan.approval.approvedBy
    },
    timestamp: new Date().toISOString()
  });
}

function fireWebhook(url: string, payload: string): Promise<void> {
  return new Promise((resolvePromise) => {
    try {
      const parsed = new URL(url);
      const requestFn = parsed.protocol === "https:" ? httpsRequest : httpRequest;

      const req = requestFn(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
          },
          timeout: 10_000
        },
        (res) => {
          res.resume();
          resolvePromise();
        }
      );

      req.on("error", (err) => {
        console.warn(`[gatefile hooks] webhook error for ${url}: ${err.message}`);
        resolvePromise();
      });

      req.on("timeout", () => {
        console.warn(`[gatefile hooks] webhook timeout for ${url}`);
        req.destroy();
        resolvePromise();
      });

      req.write(payload);
      req.end();
    } catch (err) {
      console.warn(`[gatefile hooks] webhook error: ${(err as Error).message}`);
      resolvePromise();
    }
  });
}

// Note: exec() is used intentionally here — the shell string comes from the user's
// own gatefile.config.json, not from untrusted input. This is analogous to npm scripts
// or git hooks where the user defines the command to run.
function fireShell(command: string, repoRoot: string): Promise<void> {
  return new Promise((resolvePromise) => {
    exec(command, {
      cwd: repoRoot,
      env: sanitizedGitEnvironment(process.env, {
        ceilingDirectory: dirname(repoRoot)
      }),
      timeout: 30_000
    }, (err, _stdout, stderr) => {
      if (err) {
        console.warn(`[gatefile hooks] shell error: ${err.message}`);
        if (stderr) console.warn(`[gatefile hooks] stderr: ${stderr}`);
      }
      resolvePromise();
    });
  });
}

async function executeHookAction(
  action: HookAction | undefined,
  plan: PlanFile,
  event: string,
  repoRoot: string
): Promise<void> {
  if (!action) return;

  const promises: Promise<void>[] = [];

  if (action.webhook) {
    const payload = buildPlanSummaryPayload(plan, event);
    promises.push(fireWebhook(action.webhook, payload));
  }

  if (action.shell) {
    promises.push(fireShell(action.shell, repoRoot));
  }

  await Promise.all(promises);
}

// ── Public API ────────────────────────────────────────────────

/**
 * Fire onPlanCreated hooks. Called after a plan is successfully created.
 * Errors are warned but never thrown.
 */
export async function fireOnPlanCreated(
  plan: PlanFile,
  context: NotificationDispatchContext = {}
): Promise<void> {
  try {
    const resolved = resolveNotificationContext(context);
    if (!resolved.hooks?.onPlanCreated) return;
    await executeHookAction(
      resolved.hooks.onPlanCreated,
      plan,
      "plan_created",
      resolved.repoRoot
    );
  } catch (err) {
    console.warn(`[gatefile hooks] onPlanCreated error: ${(err as Error).message}`);
  }
}

/**
 * Fire the canonical onPlanApproved notification after the approved plan is durable.
 * Errors are warned but never thrown.
 */
export async function fireOnPlanApproved(
  plan: PlanFile,
  context: NotificationDispatchContext = {}
): Promise<void> {
  try {
    const resolved = resolveNotificationContext(context);
    if (!resolved.hooks?.onPlanApproved) return;
    await executeHookAction(
      resolved.hooks.onPlanApproved,
      plan,
      "plan_approved",
      resolved.repoRoot
    );
  } catch (err) {
    console.warn(`[gatefile hooks] onPlanApproved error: ${(err as Error).message}`);
  }
}

/** @deprecated Use fireOnPlanApproved. */
export async function fireOnApprovalNeeded(
  plan: PlanFile,
  context: NotificationDispatchContext = {}
): Promise<void> {
  return fireOnPlanApproved(plan, context);
}

// Policy hook runner — called by applier/cli for beforeApply / beforeApprove hooks.
// Runs the hook's command synchronously; throws if it exits non-zero (blocking the operation).
export function runPolicyHook(
  config: GatefileConfig | undefined,
  event: "beforeApply" | "beforeApprove",
  plan: PlanFile,
  context: {
    repoRoot: string;
    planPath?: string;
    gitExecutable?: string;
    pathEnvironment?: string;
  }
): void {
  const hookConfig = config?.hooks?.[event];
  if (!hookConfig?.command) return;

  const cwd = hookConfig.cwd
    ? resolve(context.repoRoot, hookConfig.cwd)
    : context.repoRoot;
  const environment = sanitizedGitEnvironment(process.env, {
    ceilingDirectory: dirname(context.repoRoot),
    gitExecutable: context.gitExecutable,
    pathEnvironment: context.pathEnvironment
  });
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  try {
    execSync(hookConfig.command, {
      cwd,
      env: environment,
      stdio: "pipe"
    });
  } catch {
    throw new Error(`Policy hook ${event} blocked execution`);
  }
}

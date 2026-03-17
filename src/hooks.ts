import { exec } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { URL } from "node:url";
import { PlanFile } from "./types";

// ── Config types ──────────────────────────────────────────────

export interface HookAction {
  webhook?: string;
  shell?: string;
}

export interface HooksConfig {
  onPlanCreated?: HookAction;
  onApprovalNeeded?: HookAction;
}

export interface GatefileConfig {
  hooks?: HooksConfig;
}

// ── Config loading ────────────────────────────────────────────

const CONFIG_FILENAME = "gatefile.config.json";

export function loadHooksConfig(): HooksConfig | undefined {
  const configPath = resolve(CONFIG_FILENAME);
  if (!existsSync(configPath)) return undefined;

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as GatefileConfig;
    return raw.hooks;
  } catch {
    return undefined;
  }
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
function fireShell(command: string): Promise<void> {
  return new Promise((resolvePromise) => {
    exec(command, { timeout: 30_000 }, (err, _stdout, stderr) => {
      if (err) {
        console.warn(`[gatefile hooks] shell error: ${err.message}`);
        if (stderr) console.warn(`[gatefile hooks] stderr: ${stderr}`);
      }
      resolvePromise();
    });
  });
}

async function executeHookAction(action: HookAction | undefined, plan: PlanFile, event: string): Promise<void> {
  if (!action) return;

  const promises: Promise<void>[] = [];

  if (action.webhook) {
    const payload = buildPlanSummaryPayload(plan, event);
    promises.push(fireWebhook(action.webhook, payload));
  }

  if (action.shell) {
    promises.push(fireShell(action.shell));
  }

  await Promise.all(promises);
}

// ── Public API ────────────────────────────────────────────────

/**
 * Fire onPlanCreated hooks. Called after a plan is successfully created.
 * Errors are warned but never thrown.
 */
export async function fireOnPlanCreated(plan: PlanFile): Promise<void> {
  try {
    const hooks = loadHooksConfig();
    if (!hooks?.onPlanCreated) return;
    await executeHookAction(hooks.onPlanCreated, plan, "plan_created");
  } catch (err) {
    console.warn(`[gatefile hooks] onPlanCreated error: ${(err as Error).message}`);
  }
}

/**
 * Fire onApprovalNeeded hooks. Called after a plan is approved
 * (the approval is written first, then the hook fires).
 * Errors are warned but never thrown.
 */
export async function fireOnApprovalNeeded(plan: PlanFile): Promise<void> {
  try {
    const hooks = loadHooksConfig();
    if (!hooks?.onApprovalNeeded) return;
    await executeHookAction(hooks.onApprovalNeeded, plan, "approval_needed");
  } catch (err) {
    console.warn(`[gatefile hooks] onApprovalNeeded error: ${(err as Error).message}`);
  }
}

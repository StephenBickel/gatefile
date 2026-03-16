import { execSync } from "node:child_process";
import { computePlanHash } from "./hash";
import { GatefileConfig, HookContext, HookCommandConfig, PlanFile } from "./types";

interface HookRunOptions {
  repoRoot: string;
  planPath?: string;
}

function hookForEvent(config: GatefileConfig, event: HookContext["event"]): HookCommandConfig | undefined {
  return event === "beforeApprove" ? config.hooks?.beforeApprove : config.hooks?.beforeApply;
}

function trimMessage(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "(no hook output)";
}

export function runPolicyHook(
  config: GatefileConfig,
  event: HookContext["event"],
  plan: PlanFile,
  options: HookRunOptions
): void {
  const hook = hookForEvent(config, event);
  if (!hook || hook.command.trim().length === 0) {
    return;
  }

  const context: HookContext = {
    event,
    planId: plan.id,
    planHash: computePlanHash(plan),
    summary: plan.summary,
    source: plan.source,
    approvalStatus: plan.approval.status,
    dependsOn: plan.dependsOn ?? [],
    timestamp: new Date().toISOString(),
    repoRoot: options.repoRoot,
    planPath: options.planPath
  };

  const env = {
    ...process.env,
    GATEFILE_HOOK_EVENT: context.event,
    GATEFILE_PLAN_ID: context.planId,
    GATEFILE_PLAN_HASH: context.planHash,
    GATEFILE_PLAN_APPROVAL_STATUS: context.approvalStatus,
    GATEFILE_PLAN_DEPENDS_ON: context.dependsOn.join(","),
    GATEFILE_REPO_ROOT: context.repoRoot,
    ...(context.planPath ? { GATEFILE_PLAN_PATH: context.planPath } : {})
  };

  try {
    execSync(hook.command, {
      cwd: hook.cwd,
      env,
      stdio: "pipe",
      encoding: "utf8",
      input: `${JSON.stringify(context, null, 2)}\n`
    });
  } catch (error) {
    const stderr =
      typeof error === "object" && error != null && "stderr" in error
        ? String((error as { stderr?: string | Buffer }).stderr ?? "")
        : "";
    const stdout =
      typeof error === "object" && error != null && "stdout" in error
        ? String((error as { stdout?: string | Buffer }).stdout ?? "")
        : "";
    const message = stderr || stdout || (error as Error).message;

    throw new Error(
      `Policy hook ${event} blocked execution: ${trimMessage(message)} (command: ${hook.command})`
    );
  }
}

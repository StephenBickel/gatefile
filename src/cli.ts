#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyPlan, previewPlan } from "./applier";
import { formatApplySummary, formatDryRunSummary } from "./apply-format";
import { approvePlan, createPlanFromDraft, PlanDraft } from "./planner";
import { DryRunReport, PlanFile, VerifyPlanReport } from "./types";
import { buildInspectReport, formatInspectSummary, InspectReport } from "./inspect";
import { verifyPlan } from "./verify";
import { renderPRReviewComment } from "./pr-review";
import { reviewPlan } from "./review";
import { runPipeline, formatPipelineSummary } from "./pipeline";
import { audit, formatAuditTable } from "./audit";
import { fireOnPlanCreated, fireOnApprovalNeeded } from "./hooks";

function readJson<T>(path: string): T {
  const full = resolve(path);
  return JSON.parse(readFileSync(full, "utf-8")) as T;
}

function writeJson(path: string, value: unknown): void {
  const full = resolve(path);
  writeFileSync(full, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function arg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function positionalPath(args: string[], flagsWithValues: string[] = []): string | undefined {
  const valueFlags = new Set(flagsWithValues);

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token.startsWith("--")) {
      if (valueFlags.has(token)) i += 1;
      continue;
    }
    return token;
  }

  return undefined;
}

function usage(): void {
  console.log(`gatefile commands:
  create-plan --from <draft.json> --out <plan.json>
  inspect-plan <plan.json> [--json]
  verify-plan <plan.json>
  approve-plan <plan.json> --by <name>
  review <plan.json>
  apply-plan <plan.json> [--yes] [--dry-run] [--human]
  audit [--since <duration>] [--plan <planId>] [--json]
  run-pipeline <dir> [--dry-run] [--continue-on-error] [--json]
  render-pr-comment <plan.json> [--inspect <inspect.json>] [--verify <verify.json>] [--dry-run <dry-run.json>] [--out <comment.md>]`);
}

function inspect(plan: PlanFile, jsonMode: boolean): void {
  const report = buildInspectReport(plan);
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatInspectSummary(plan, report));
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (!cmd) {
    usage();
    process.exit(1);
  }

  if (cmd === "create-plan") {
    const args = process.argv.slice(3);
    const from = arg(args, "--from");
    const out = arg(args, "--out");
    if (!from || !out) throw new Error("create-plan requires --from and --out");

    const draft = readJson<PlanDraft>(from);
    const plan = createPlanFromDraft(draft);
    writeJson(out, plan);
    console.log(`Plan created: ${out}`);
    await fireOnPlanCreated(plan);
    return;
  }

  if (cmd === "review") {
    const args = process.argv.slice(3);
    const planPath = positionalPath(args);
    if (!planPath) throw new Error("review requires a plan path");
    await reviewPlan(planPath);
    return;
  }

  if (cmd === "inspect-plan") {
    const args = process.argv.slice(3);
    const planPath = positionalPath(args);
    if (!planPath) throw new Error("inspect-plan requires a plan path");
    const plan = readJson<PlanFile>(planPath);
    inspect(plan, hasFlag(args, "--json"));
    return;
  }

  if (cmd === "approve-plan") {
    const args = process.argv.slice(3);
    const planPath = positionalPath(args, ["--by"]);
    const by = arg(args, "--by") ?? "unknown";
    if (!planPath) throw new Error("approve-plan requires a plan path");

    const plan = readJson<PlanFile>(planPath);
    const next = approvePlan(plan, by);
    writeJson(planPath, next);
    console.log(`Plan approved by ${by}: ${planPath}`);
    await fireOnApprovalNeeded(next);
    return;
  }

  if (cmd === "verify-plan") {
    const args = process.argv.slice(3);
    const planPath = positionalPath(args);
    if (!planPath) throw new Error("verify-plan requires a plan path");
    const plan = readJson<PlanFile>(planPath);
    console.log(JSON.stringify(verifyPlan(plan), null, 2));
    return;
  }

  if (cmd === "apply-plan") {
    const args = process.argv.slice(3);
    const planPath = positionalPath(args);
    const yes = hasFlag(args, "--yes");
    const dryRun = hasFlag(args, "--dry-run");
    const human = hasFlag(args, "--human");
    if (!planPath) throw new Error("apply-plan requires a plan path");

    const plan = readJson<PlanFile>(planPath);
    if (dryRun) {
      const preview = previewPlan(plan);
      console.log(human ? formatDryRunSummary(preview) : JSON.stringify(preview, null, 2));
      return;
    }

    if (!yes) throw new Error("Refusing to apply without --yes");

    const report = applyPlan(plan);
    console.log(human ? formatApplySummary(report) : JSON.stringify(report, null, 2));
    return;
  }

  if (cmd === "render-pr-comment") {
    const args = process.argv.slice(3);
    const planPath = positionalPath(args, ["--inspect", "--verify", "--dry-run", "--out"]);
    if (!planPath) throw new Error("render-pr-comment requires a plan path");

    const plan = readJson<PlanFile>(planPath);
    const inspectPath = arg(args, "--inspect");
    const verifyPath = arg(args, "--verify");
    const dryRunPath = arg(args, "--dry-run");
    const outPath = arg(args, "--out");

    const markdown = renderPRReviewComment({
      plan,
      inspectReport: inspectPath ? readJson<InspectReport>(inspectPath) : undefined,
      verifyReport: verifyPath ? readJson<VerifyPlanReport>(verifyPath) : undefined,
      dryRunReport: dryRunPath ? readJson<DryRunReport>(dryRunPath) : undefined
    });

    if (outPath) {
      writeFileSync(resolve(outPath), `${markdown}\n`, "utf-8");
      console.log(`PR comment markdown written: ${outPath}`);
      return;
    }

    console.log(markdown);
    return;
  }

  if (cmd === "audit") {
    const args = process.argv.slice(3);
    const since = arg(args, "--since");
    const planId = arg(args, "--plan");
    const jsonMode = hasFlag(args, "--json");

    const result = audit({ since: since ?? undefined, planId: planId ?? undefined });

    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatAuditTable(result));
    }
    return;
  }

  if (cmd === "run-pipeline") {
    const args = process.argv.slice(3);
    const dir = positionalPath(args);
    if (!dir) throw new Error("run-pipeline requires a directory path");

    const result = runPipeline(dir, {
      dryRun: hasFlag(args, "--dry-run"),
      continueOnError: hasFlag(args, "--continue-on-error")
    });

    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatPipelineSummary(result));
    }

    process.exit(result.success ? 0 : 1);
  }

  usage();
  process.exit(1);
}

main().catch((error) => {
  console.error(`Error: ${(error as Error).message}`);
  process.exit(1);
});

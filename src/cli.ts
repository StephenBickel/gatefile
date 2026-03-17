#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyPlan, previewPlan, rollbackApply } from "./applier";
import { formatApplySummary, formatDryRunSummary, formatRollbackSummary } from "./apply-format";
import { adaptAgentInputToDraft, AgentAdapterInput } from "./adapter";
import { approvePlan, createPlanFromDraft, PlanDraft } from "./planner";
import { DryRunReport, PlanFile, VerifyPlanReport } from "./types";
import { buildInspectReport, formatInspectSummary, InspectReport } from "./inspect";
import { verifyPlan } from "./verify";
import { renderPRReviewComment } from "./pr-review";
import { reviewPlan } from "./review";
import { runPipeline, formatPipelineSummary } from "./pipeline";
import { audit, formatAuditTable } from "./audit";
import { fireOnPlanCreated, fireOnApprovalNeeded, runPolicyHook } from "./hooks";
import { configPath, loadGatefileConfig } from "./config";
import { getRepoRoot } from "./state";
import { generateApprovalAttestationKeyPair } from "./attestation";

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
  adapt-agent --from <agent-input.json> --out <draft.json>
  create-plan --from <draft.json> --out <plan.json>
  inspect-plan <plan.json> [--json]
  lint-config [--config <path>]
  verify-plan <plan.json>
  approve-plan <plan.json> --by <name>
  review <plan.json>
  apply-plan <plan.json> [--yes] [--dry-run] [--human]
  audit [--since <duration>] [--plan <planId>] [--json]
  run-pipeline <dir> [--dry-run] [--continue-on-error] [--json]
  render-pr-comment <plan.json> [--inspect <inspect.json>] [--verify <verify.json>] [--dry-run <dry-run.json>] [--out <comment.md>]`);
}

function inspect(plan: PlanFile, jsonMode: boolean, config = loadGatefileConfig(getRepoRoot())): void {
  const report = buildInspectReport(plan, { repoRoot: getRepoRoot() });
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatInspectSummary(plan, report, { config }));
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

  if (cmd === "adapt-agent") {
    const args = process.argv.slice(3);
    const from = arg(args, "--from");
    const out = arg(args, "--out");
    if (!from || !out) throw new Error("adapt-agent requires --from and --out");

    const input = readJson<AgentAdapterInput>(from);
    const draft = adaptAgentInputToDraft(input);
    writeJson(out, draft);
    console.log(`Adapter draft created: ${out}`);
    return;
  }

  if (cmd === "inspect-plan") {
    const args = process.argv.slice(3);
    const planPath = positionalPath(args);
    if (!planPath) throw new Error("inspect-plan requires a plan path");
    const plan = readJson<PlanFile>(planPath);
    inspect(plan, hasFlag(args, "--json"), loadGatefileConfig(getRepoRoot()));
    return;
  }

  if (cmd === "lint-config") {
    const args = process.argv.slice(3);
    const explicitPath = arg(args, "--config");
    const repoRoot = getRepoRoot();
    const path = configPath(repoRoot, explicitPath);
    const config = loadGatefileConfig(repoRoot, explicitPath);
    const trustedKeyIds = config.signers?.trustedKeyIds?.length ?? 0;
    const trustedPublicKeys = config.signers?.trustedPublicKeys?.length ?? 0;
    const trustSummary =
      trustedKeyIds > 0 || trustedPublicKeys > 0
        ? `trust policy configured (${trustedKeyIds} keyIds, ${trustedPublicKeys} publicKeys)`
        : "no signer trust policy configured";
    console.log(`Gatefile config valid: ${path} (${trustSummary})`);
    return;
  }

  if (cmd === "approve-plan") {
    const args = process.argv.slice(3);
    const planPath = positionalPath(args, ["--by", "--signing-key", "--key-id"]);
    const by = arg(args, "--by") ?? "unknown";
    const signingKeyPath = arg(args, "--signing-key");
    const signingKeyId = arg(args, "--key-id");
    if (!planPath) throw new Error("approve-plan requires a plan path");
    if (signingKeyId && !signingKeyPath) {
      throw new Error("--key-id requires --signing-key");
    }

    const plan = readJson<PlanFile>(planPath);
    const config = loadGatefileConfig(getRepoRoot());
    runPolicyHook(config, "beforeApprove", plan, {
      repoRoot: getRepoRoot(),
      planPath: resolve(planPath)
    });
    const signingPrivateKeyPem = signingKeyPath
      ? readFileSync(resolve(signingKeyPath), "utf-8")
      : undefined;
    const next = approvePlan(plan, by, { signingPrivateKeyPem, signingKeyId });
    writeJson(planPath, next);
    console.log(`Plan approved by ${by}: ${planPath}`);
    await fireOnApprovalNeeded(next);
    return;
  }

  if (cmd === "generate-attestation-key") {
    const args = process.argv.slice(3);
    const outPrivate = arg(args, "--out-private");
    const outPublic = arg(args, "--out-public");
    const force = hasFlag(args, "--force");
    if (!outPrivate) throw new Error("generate-attestation-key requires --out-private");
    if (!force && (existsSync(resolve(outPrivate)) || (outPublic && existsSync(resolve(outPublic))))) {
      throw new Error("Refusing to overwrite key files without --force");
    }

    const keys = generateApprovalAttestationKeyPair();
    writeFileSync(resolve(outPrivate), keys.privateKeyPem, "utf-8");
    if (outPublic) {
      writeFileSync(resolve(outPublic), keys.publicKeyPem, "utf-8");
    }
    console.log(
      `Attestation key generated: keyId=${keys.keyId}, private=${outPrivate}${outPublic ? `, public=${outPublic}` : ""}`
    );
    return;
  }

  if (cmd === "verify-plan") {
    const args = process.argv.slice(3);
    const planPath = positionalPath(args);
    if (!planPath) throw new Error("verify-plan requires a plan path");
    const plan = readJson<PlanFile>(planPath);
    const config = loadGatefileConfig(getRepoRoot());
    console.log(JSON.stringify(verifyPlan(plan, { config }), null, 2));
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
    const repoRoot = getRepoRoot();
    const config = loadGatefileConfig(repoRoot);
    if (dryRun) {
      const preview = previewPlan(plan, { repoRoot, planPath: resolve(planPath), config });
      console.log(human ? formatDryRunSummary(preview) : JSON.stringify(preview, null, 2));
      return;
    }

    if (!yes) throw new Error("Refusing to apply without --yes");

    const report = applyPlan(plan, { repoRoot, planPath: resolve(planPath), config });
    console.log(human ? formatApplySummary(report) : JSON.stringify(report, null, 2));
    return;
  }

  if (cmd === "rollback-apply") {
    const args = process.argv.slice(3);
    const receiptId = positionalPath(args);
    const yes = hasFlag(args, "--yes");
    const human = hasFlag(args, "--human");
    if (!receiptId) throw new Error("rollback-apply requires a receipt id");
    if (!yes) throw new Error("Refusing to rollback without --yes");

    const report = rollbackApply(receiptId, { repoRoot: getRepoRoot() });
    console.log(human ? formatRollbackSummary(report) : JSON.stringify(report, null, 2));
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
      dryRunReport: dryRunPath ? readJson<DryRunReport>(dryRunPath) : undefined,
      config: loadGatefileConfig(getRepoRoot())
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

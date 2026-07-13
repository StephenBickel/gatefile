#!/usr/bin/env node
import { resolve } from "node:path";
import { formatApplySummary, formatDryRunSummary, formatRollbackSummary } from "./apply-format";
import { adaptAgentInputToDraft } from "./adapter";
import type { AgentAdapterInput } from "./adapter";
import type { PlanDraft } from "./planner";
import type { DryRunReport, PlanFile, VerifyPlanReport } from "./types";
import type { InspectReport } from "./inspect";
import { GatefileEngine } from "./engine";
import { renderPRReviewComment } from "./pr-review";
import { reviewPlan } from "./review";
import { runPipeline, formatPipelineSummary } from "./pipeline";
import { audit, formatAuditTable } from "./audit";
import { fireOnPlanApproved, fireOnPlanCreated } from "./hooks";
import { configPath, loadGatefileConfig } from "./config";
import { getRepoRoot } from "./state";
import { generateApprovalAttestationKeyPair } from "./attestation";
import { startMcpServer } from "./mcp";
import { validatePlanFile } from "./validation";
import {
  assertDistinctKeyOutputPaths,
  prepareKeyOutputPath,
  writeKeyOutputFile
} from "./key-output";
import {
  MAX_PRIVATE_KEY_BYTES,
  readJsonArtifact,
  readUtf8Artifact,
  writeJsonArtifactAtomic,
  writeUtf8ArtifactAtomic
} from "./artifact-io";
import type { ArtifactRevision } from "./artifact-io";

function readJson<T>(path: string): T {
  return readJsonArtifact<T>(path, { label: "JSON input" }).value;
}

function writeJson(path: string, value: unknown): void {
  writeJsonArtifactAtomic(path, value, { label: "JSON output" });
}

function replaceJson(
  path: string,
  value: unknown,
  expectedRevision: ArtifactRevision
): void {
  writeJsonArtifactAtomic(path, value, {
    expectedRevision,
    label: "Plan file"
  });
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
  generate-attestation-key --out-private <key.pem> [--out-public <key.pub.pem>] [--force]
  review <plan.json>
  apply-plan <plan.json> [--yes] [--dry-run] [--human]
  rollback-apply <receipt-id> [--yes] [--human] [--repo-root <path>] [--repository-id <id>] [--state-home <path>]
  audit [--since <duration>] [--plan <planId>] [--json] [--repo-root <path>] [--repository-id <id>] [--state-home <path>]
  run-pipeline <dir> [--dry-run] [--continue-on-error] [--json] [--repo-root <path>] [--repository-id <id>] [--state-home <path>]
  render-pr-comment <plan.json> [--inspect <inspect.json>] [--verify <verify.json>] [--dry-run <dry-run.json>] [--out <comment.md>]
  mcp                                Start MCP server (stdio transport)`);

}

function inspect(plan: PlanFile, jsonMode: boolean, engine: GatefileEngine): void {
  const report = engine.inspectPlan(plan);
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(engine.formatInspectPlan(plan, report));
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
    const repoRoot = getRepoRoot();
    const config = loadGatefileConfig(repoRoot);
    const engine = new GatefileEngine({ repoRoot, config });
    const plan = engine.createPlan(draft);
    writeJson(out, plan);
    console.log(`Plan created: ${out}`);
    await fireOnPlanCreated(plan, {
      repoRoot: engine.context.repoRoot,
      config
    });
    return;
  }

  if (cmd === "review") {
    const args = process.argv.slice(3);
    const planPath = positionalPath(args);
    if (!planPath) throw new Error("review requires a plan path");
    const engine = new GatefileEngine({ repoRoot: getRepoRoot() });
    await reviewPlan(planPath, { engine });
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
    const engine = new GatefileEngine({ repoRoot: getRepoRoot() });
    inspect(plan, hasFlag(args, "--json"), engine);
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

    const planRead = readJsonArtifact<PlanFile>(planPath, { label: "Plan file" });
    const plan = planRead.value;
    validatePlanFile(plan);
    const repoRoot = getRepoRoot();
    const config = loadGatefileConfig(repoRoot);
    const engine = new GatefileEngine({ repoRoot, config });
    const signingPrivateKeyPem = signingKeyPath
      ? readUtf8Artifact(signingKeyPath, {
          label: "Signing private key",
          maxBytes: MAX_PRIVATE_KEY_BYTES
        }).contents
      : undefined;
    const next = engine.approvePlan(plan, by, {
      planPath: resolve(planPath),
      signingPrivateKeyPem,
      signingKeyId
    });
    replaceJson(planPath, next, planRead.revision);
    console.log(`Plan approved by ${by}: ${planPath}`);
    await fireOnPlanApproved(next, {
      repoRoot: engine.context.repoRoot,
      config
    });
    return;
  }

  if (cmd === "generate-attestation-key") {
    const args = process.argv.slice(3);
    const outPrivate = arg(args, "--out-private");
    const outPublic = arg(args, "--out-public");
    const force = hasFlag(args, "--force");
    if (!outPrivate) throw new Error("generate-attestation-key requires --out-private");
    const privatePath = prepareKeyOutputPath(outPrivate, "private key output", force);
    const publicPath = outPublic
      ? prepareKeyOutputPath(outPublic, "public key output", force)
      : undefined;
    if (publicPath) assertDistinctKeyOutputPaths(privatePath, publicPath);

    const keys = generateApprovalAttestationKeyPair();
    writeKeyOutputFile(privatePath, keys.privateKeyPem, 0o600, "private key output", force);
    if (publicPath) {
      writeKeyOutputFile(publicPath, keys.publicKeyPem, 0o644, "public key output", force);
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
    const engine = new GatefileEngine({ repoRoot: getRepoRoot() });
    console.log(JSON.stringify(engine.verifyPlan(plan), null, 2));
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
    const engine = new GatefileEngine({ repoRoot });
    if (dryRun) {
      const preview = engine.previewPlan(plan, { planPath: resolve(planPath) });
      console.log(human ? formatDryRunSummary(preview) : JSON.stringify(preview, null, 2));
      return;
    }

    if (!yes) throw new Error("Refusing to apply without --yes");

    const report = engine.applyPlan(plan, { planPath: resolve(planPath) });
    console.log(human ? formatApplySummary(report) : JSON.stringify(report, null, 2));
    if (!report.success) process.exitCode = 1;
    return;
  }

  if (cmd === "rollback-apply") {
    const args = process.argv.slice(3);
    const receiptId = positionalPath(args, ["--repo-root", "--repository-id", "--state-home"]);
    const yes = hasFlag(args, "--yes");
    const human = hasFlag(args, "--human");
    if (!receiptId) throw new Error("rollback-apply requires a receipt id");
    if (!yes) throw new Error("Refusing to rollback without --yes");

    const engine = new GatefileEngine({
      repoRoot: getRepoRoot(arg(args, "--repo-root")),
      repositoryId: arg(args, "--repository-id"),
      stateHome: arg(args, "--state-home")
    });
    const report = engine.rollbackApply(receiptId);
    console.log(human ? formatRollbackSummary(report) : JSON.stringify(report, null, 2));
    if (!report.success) process.exitCode = 1;
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
      repoRoot: getRepoRoot()
    });

    if (outPath) {
      writeUtf8ArtifactAtomic(outPath, `${markdown}\n`, {
        label: "PR comment output"
      });
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

    const result = audit({
      since: since ?? undefined,
      planId: planId ?? undefined,
      repoRoot: getRepoRoot(arg(args, "--repo-root")),
      repositoryId: arg(args, "--repository-id"),
      stateHome: arg(args, "--state-home")
    });

    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatAuditTable(result));
    }
    return;
  }

  if (cmd === "run-pipeline") {
    const args = process.argv.slice(3);
    const dir = positionalPath(args, ["--repo-root", "--repository-id", "--state-home"]);
    if (!dir) throw new Error("run-pipeline requires a directory path");

    const result = runPipeline(dir, {
      dryRun: hasFlag(args, "--dry-run"),
      continueOnError: hasFlag(args, "--continue-on-error"),
      repoRoot: getRepoRoot(arg(args, "--repo-root")),
      repositoryId: arg(args, "--repository-id"),
      stateHome: arg(args, "--state-home")
    });

    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatPipelineSummary(result));
    }

    process.exit(result.success ? 0 : 1);
  }

  if (cmd === "mcp") {
    startMcpServer();
    return;
  }


  usage();
  process.exit(1);
}

main().catch((error) => {
  console.error(`Error: ${(error as Error).message}`);
  process.exit(1);
});

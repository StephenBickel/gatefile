import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { PLAN_VERSION, type ApplyReport, type DryRunReport, type PlanFile } from "./types";
import { GatefileEngine, type GatefileEngineOptions } from "./engine";
import { validatePlanFile } from "./validation";

// ── Types ─────────────────────────────────────────────────────

export interface PipelineOptions extends GatefileEngineOptions {
  dryRun?: boolean;
  continueOnError?: boolean;
}

export type PipelinePlanStatus = "passed" | "failed" | "skipped";

export interface PipelinePlanResult {
  planId: string;
  file: string;
  status: PipelinePlanStatus;
  message: string;
  /** Complete apply outcome, including authenticated rollback authority. */
  applyReport?: ApplyReport;
  /** Complete non-mutating evidence when the pipeline is run in dry-run mode. */
  previewReport?: DryRunReport;
}

export type PipelineInputErrorCode =
  | "invalid-json"
  | "invalid-plan"
  | "unsafe-entry"
  | "duplicate-plan-id"
  | "dependency-cycle";

export interface PipelineInputError {
  file: string;
  code: PipelineInputErrorCode;
  message: string;
}

export interface PipelineResult {
  success: boolean;
  order: string[];
  results: PipelinePlanResult[];
  inputErrors: PipelineInputError[];
}

// ── Helpers ───────────────────────────────────────────────────

interface PlanEntry {
  file: string;
  plan: PlanFile;
  dependsOn: string[];
}

const PLAN_MARKERS = new Set([
  "id",
  "context",
  "operations",
  "integrity",
  "approval"
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanLike(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && (
    value.version === PLAN_VERSION ||
    Object.keys(value).some((key) => PLAN_MARKERS.has(key))
  );
}

function readPlanEntries(dir: string): { entries: PlanEntry[]; inputErrors: PipelineInputError[] } {
  const absDir = resolve(dir);
  const files = readdirSync(absDir).filter((f) => f.endsWith(".json")).sort();
  const entries: PlanEntry[] = [];
  const inputErrors: PipelineInputError[] = [];

  for (const file of files) {
    const fullPath = join(absDir, file);
    const stat = lstatSync(fullPath);
    if (!stat.isFile()) {
      inputErrors.push({
        file,
        code: "unsafe-entry",
        message: `Pipeline JSON entry must be a regular file, not a symlink or special file: ${file}`
      });
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(fullPath, "utf-8")) as unknown;
    } catch (error) {
      inputErrors.push({
        file,
        code: "invalid-json",
        message: `Invalid JSON in ${file}: ${(error as Error).message}`
      });
      continue;
    }

    if (!isPlanLike(raw)) continue;
    try {
      const plan = validatePlanFile(raw) as PlanFile;
      entries.push({ file, plan, dependsOn: plan.dependsOn ?? [] });
    } catch (error) {
      inputErrors.push({
        file,
        code: "invalid-plan",
        message: `Invalid plan in ${file}: ${(error as Error).message}`
      });
    }
  }

  const entriesById = new Map<string, PlanEntry[]>();
  for (const entry of entries) {
    const matches = entriesById.get(entry.plan.id) ?? [];
    matches.push(entry);
    entriesById.set(entry.plan.id, matches);
  }
  for (const [planId, matches] of entriesById) {
    if (matches.length < 2) continue;
    const filenames = matches.map((entry) => entry.file).join(", ");
    for (const entry of matches) {
      inputErrors.push({
        file: entry.file,
        code: "duplicate-plan-id",
        message: `Duplicate plan ID ${planId} appears in: ${filenames}`
      });
    }
  }

  return { entries, inputErrors };
}

class PipelineDependencyCycleError extends Error {
  constructor(readonly file: string, planId: string) {
    super(`Circular dependency detected involving plan ${planId}`);
    this.name = "PipelineDependencyCycleError";
  }
}

function topologicalSort(entries: PlanEntry[]): PlanEntry[] {
  const byId = new Map<string, PlanEntry>();
  for (const entry of entries) {
    byId.set(entry.plan.id, entry);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: PlanEntry[] = [];

  function visit(entry: PlanEntry): void {
    if (visited.has(entry.plan.id)) return;
    if (visiting.has(entry.plan.id)) {
      throw new PipelineDependencyCycleError(entry.file, entry.plan.id);
    }

    visiting.add(entry.plan.id);

    for (const depId of entry.dependsOn) {
      const dep = byId.get(depId);
      if (dep) {
        visit(dep);
      }
      // silently skip unknown deps — they may be from a previous run
    }

    visiting.delete(entry.plan.id);
    visited.add(entry.plan.id);
    sorted.push(entry);
  }

  for (const entry of entries) {
    visit(entry);
  }

  return sorted;
}

// ── Public API ────────────────────────────────────────────────

export function runPipeline(dir: string, options?: PipelineOptions): PipelineResult {
  const discovered = readPlanEntries(dir);
  const { entries, inputErrors } = discovered;

  if (inputErrors.length > 0) {
    return { success: false, order: [], results: [], inputErrors };
  }

  if (entries.length === 0) {
    return { success: true, order: [], results: [], inputErrors: [] };
  }

  let sorted: PlanEntry[];
  try {
    sorted = topologicalSort(entries);
  } catch (error) {
    if (error instanceof PipelineDependencyCycleError) {
      return {
        success: false,
        order: [],
        results: [],
        inputErrors: [{
          file: error.file,
          code: "dependency-cycle",
          message: error.message
        }]
      };
    }
    throw error;
  }
  const order = sorted.map((e) => e.plan.id);
  let engine: GatefileEngine;
  try {
    engine = new GatefileEngine({
      repoRoot: options?.repoRoot,
      repositoryId: options?.repositoryId,
      stateHome: options?.stateHome,
      config: options?.config
    });
  } catch (err) {
    const message = options?.dryRun
      ? `Dry-run failed: ${(err as Error).message}`
      : (err as Error).message;
    const results = sorted.map((entry, index): PipelinePlanResult => {
      if (index > 0 && !options?.continueOnError) {
        return {
          planId: entry.plan.id,
          file: entry.file,
          status: "skipped",
          message: "Skipped due to previous failure"
        };
      }
      return {
        planId: entry.plan.id,
        file: entry.file,
        status: "failed",
        message
      };
    });
    return { success: false, order, results, inputErrors: [] };
  }
  const results: PipelinePlanResult[] = [];
  let failed = false;

  for (const entry of sorted) {
    if (failed && !options?.continueOnError) {
      results.push({
        planId: entry.plan.id,
        file: entry.file,
        status: "skipped",
        message: "Skipped due to previous failure"
      });
      continue;
    }

    if (options?.dryRun) {
      try {
        const previewReport = engine.previewPlan(entry.plan, {
          planPath: join(resolve(dir), entry.file)
        });
        if (previewReport.staticGate.passed) {
          results.push({
            planId: entry.plan.id,
            file: entry.file,
            status: "passed",
            message: "Dry-run static gate passed (runtime preconditions not checked)",
            previewReport
          });
        } else {
          failed = true;
          const blockers = [
            ...previewReport.verification.blockers,
            ...(previewReport.dependencies.allSatisfied
              ? []
              : [`missing dependencies: ${previewReport.dependencies.missingPlanIds.join(", ")}`]),
            ...previewReport.results
              .filter((result) => !result.allowed)
              .map((result) => `operation ${result.operationId} denied by static policy`)
          ];
          results.push({
            planId: entry.plan.id,
            file: entry.file,
            status: "failed",
            message: `Dry-run static gate blocked: ${blockers.join("; ") || "unknown blocker"}`,
            previewReport
          });
        }
      } catch (err) {
        failed = true;
        results.push({
          planId: entry.plan.id,
          file: entry.file,
          status: "failed",
          message: `Dry-run failed: ${(err as Error).message}`
        });
      }
      continue;
    }

    // Real execution
    try {
      const report = engine.applyPlan(entry.plan, {
        planPath: join(resolve(dir), entry.file)
      });
      if (report.success) {
        results.push({
          planId: entry.plan.id,
          file: entry.file,
          status: "passed",
          message: "Applied successfully",
          applyReport: report
        });
      } else {
        failed = true;
        const failedOp = report.results.find((r) => !r.success);
        const failureDetail = failedOp?.message
          ?? report.warnings?.join("; ")
          ?? "Apply returned a failed report; use applyReport for recovery details";
        results.push({
          planId: entry.plan.id,
          file: entry.file,
          status: "failed",
          message: `Apply failed: ${failureDetail}`,
          applyReport: report
        });
      }
    } catch (err) {
      failed = true;
      results.push({
        planId: entry.plan.id,
        file: entry.file,
        status: "failed",
        message: (err as Error).message
      });
    }
  }

  return {
    success: !results.some((r) => r.status === "failed"),
    order,
    results,
    inputErrors: []
  };
}

export function formatPipelineSummary(result: PipelineResult): string {
  const lines: string[] = ["Pipeline Summary", ""];

  if (result.inputErrors.length > 0) {
    lines.push(`Input errors: ${result.inputErrors.length}`);
    for (const error of result.inputErrors) {
      lines.push(`[INPUT FAIL] ${error.file}: ${error.message}`);
    }
    return lines.join("\n");
  }

  if (result.results.length === 0) {
    lines.push("No plan files found.");
    return lines.join("\n");
  }

  lines.push(`Execution order: ${result.order.length} plan(s)`);
  lines.push("");

  for (const r of result.results) {
    const icon = r.status === "passed" ? "[PASS]" : r.status === "failed" ? "[FAIL]" : "[SKIP]";
    lines.push(`${icon} ${r.file} (${r.planId})`);
    lines.push(`      ${r.message}`);
  }

  lines.push("");
  const passed = result.results.filter((r) => r.status === "passed").length;
  const failed = result.results.filter((r) => r.status === "failed").length;
  const skipped = result.results.filter((r) => r.status === "skipped").length;
  lines.push(`Result: ${passed} passed, ${failed} failed, ${skipped} skipped`);

  return lines.join("\n");
}

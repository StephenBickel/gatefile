import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ApplyReport, PlanFile } from "./types";
import { GatefileEngine, type GatefileEngineOptions } from "./engine";

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
}

export interface PipelineResult {
  success: boolean;
  order: string[];
  results: PipelinePlanResult[];
}

// ── Helpers ───────────────────────────────────────────────────

interface PlanEntry {
  file: string;
  plan: PlanFile;
  dependsOn: string[];
}

function readPlanEntries(dir: string): PlanEntry[] {
  const absDir = resolve(dir);
  const files = readdirSync(absDir).filter((f) => f.endsWith(".json"));
  const entries: PlanEntry[] = [];

  for (const file of files) {
    const fullPath = join(absDir, file);
    try {
      const raw = JSON.parse(readFileSync(fullPath, "utf-8"));
      if (!raw.id || !raw.operations) continue; // skip non-plan JSON
      const plan = raw as PlanFile;
      const dependsOn: string[] = Array.isArray((raw as Record<string, unknown>).dependsOn)
        ? ((raw as Record<string, unknown>).dependsOn as string[])
        : [];
      entries.push({ file, plan, dependsOn });
    } catch {
      // skip files that aren't valid JSON
    }
  }

  return entries;
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
      throw new Error(`Circular dependency detected involving plan ${entry.plan.id}`);
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
  const entries = readPlanEntries(dir);

  if (entries.length === 0) {
    return { success: true, order: [], results: [] };
  }

  const sorted = topologicalSort(entries);
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
    return { success: false, order, results };
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
        engine.previewPlan(entry.plan, {
          planPath: join(resolve(dir), entry.file)
        });
        results.push({
          planId: entry.plan.id,
          file: entry.file,
          status: "passed",
          message: "Dry-run preview completed"
        });
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
    results
  };
}

export function formatPipelineSummary(result: PipelineResult): string {
  const lines: string[] = ["Pipeline Summary", ""];

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

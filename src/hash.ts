import { createHash } from "node:crypto";
import { PlanFile } from "./types";

type HashablePlan = Omit<PlanFile, "id" | "createdAt" | "risk" | "integrity" | "approval"> & {
  version: string;
};

interface NormalizedPlan {
  version: string;
  source: string;
  summary: string;
  operations: PlanFile["operations"];
  preconditions: PlanFile["preconditions"];
  execution?: PlanFile["execution"];
}

export function normalizePlanForHash(plan: HashablePlan): NormalizedPlan {
  return {
    version: plan.version,
    source: plan.source,
    summary: plan.summary,
    operations: plan.operations,
    preconditions: plan.preconditions,
    execution: plan.execution
  };
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot canonicalize non-finite numbers");
    }
    return JSON.stringify(value);
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue)}`);

    return `{${entries.join(",")}}`;
  }

  throw new Error(`Unsupported value for canonicalization: ${typeof value}`);
}

export function computePlanHash(plan: HashablePlan): string {
  const normalized = normalizePlanForHash(plan);
  const payload = canonicalize(normalized);
  return createHash("sha256").update(payload, "utf-8").digest("hex");
}

export function withComputedIntegrity(plan: Omit<PlanFile, "integrity">): PlanFile {
  const withoutIntegrity = { ...plan };
  const planHash = computePlanHash(withoutIntegrity);

  return {
    ...withoutIntegrity,
    integrity: {
      algorithm: "sha256",
      canonicalizer: "planfile-v1",
      planHash
    }
  };
}

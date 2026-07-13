import { createHash } from "node:crypto";
import { scoreRisk } from "./risk";
import {
  HASH_CANONICALIZER,
  HASH_ENVELOPE_VERSION,
  HashEnvelopeV2,
  HashablePlanV2,
  PLAN_VERSION,
  PlanFile
} from "./types";

type JsonObject = Record<string, unknown>;

const V2_PLAN_KEYS = new Set([
  "version",
  "id",
  "createdAt",
  "source",
  "summary",
  "context",
  "dependsOn",
  "operations",
  "preconditions",
  "execution",
  "risk",
  "integrity",
  "approval"
]);

function rejectUnknownV2Fields(plan: JsonObject): void {
  const unknown = Object.keys(plan).filter((key) => !V2_PLAN_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Cannot hash v2 plan with unknown fields: ${unknown.join(", ")}`);
  }
}

export function normalizePlanForHash(plan: HashablePlanV2): HashEnvelopeV2 {
  const value = plan as unknown as JsonObject;
  rejectUnknownV2Fields(value);
  if (value.version !== PLAN_VERSION) {
    throw new Error(`Cannot create v2 hash envelope for plan version ${String(value.version)}`);
  }

  return {
    type: "gatefile-plan-hash",
    envelopeVersion: HASH_ENVELOPE_VERSION,
    plan: {
      version: PLAN_VERSION,
      id: plan.id,
      createdAt: plan.createdAt,
      source: plan.source,
      summary: plan.summary,
      context: plan.context,
      dependsOn: plan.dependsOn ?? [],
      operations: plan.operations,
      preconditions: plan.preconditions,
      execution: plan.execution ?? {},
      risk: scoreRisk(plan.operations)
    }
  };
}

function canonicalizeV2(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot canonicalize non-finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeV2(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as JsonObject)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalizeV2(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error(`Unsupported value for canonicalization: ${typeof value}`);
}

function canonicalizeLegacy(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot canonicalize non-finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeLegacy(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as JsonObject)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalizeLegacy(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error(`Unsupported value for canonicalization: ${typeof value}`);
}

function computeLegacyPlanHash(plan: JsonObject): string {
  const normalized = {
    version: plan.version,
    source: plan.source,
    summary: plan.summary,
    operations: plan.operations,
    preconditions: plan.preconditions,
    execution: plan.execution
  };
  return createHash("sha256").update(canonicalizeLegacy(normalized), "utf8").digest("hex");
}

export function computePlanHash(plan: HashablePlanV2 | JsonObject): string {
  const value = plan as unknown as JsonObject;
  if (value.version !== PLAN_VERSION) return computeLegacyPlanHash(value);
  const envelope = normalizePlanForHash(plan as HashablePlanV2);
  return createHash("sha256").update(canonicalizeV2(envelope), "utf8").digest("hex");
}

export function withComputedIntegrity(plan: Omit<PlanFile, "integrity">): PlanFile {
  const withoutIntegrity = { ...plan };
  const planHash = computePlanHash(withoutIntegrity);
  return {
    ...withoutIntegrity,
    integrity: {
      algorithm: "sha256",
      canonicalizer: HASH_CANONICALIZER,
      envelopeVersion: HASH_ENVELOPE_VERSION,
      planHash
    }
  };
}

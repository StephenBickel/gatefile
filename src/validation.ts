import type { PlanDraft } from "./planner";
import { validateCommandOperationValue, validatePlanCommandContract } from "./command";
import {
  HASH_CANONICALIZER,
  HASH_ENVELOPE_VERSION,
  PLAN_VERSION,
  PlanFile,
  RiskProfile
} from "./types";

export interface ValidationIssue {
  path: string;
  message: string;
}

export class GatefileValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(label: string, issues: ValidationIssue[]) {
    super(`${label}:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`);
    this.name = "GatefileValidationError";
    this.issues = issues;
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(value: unknown, path: string, issues: ValidationIssue[]): JsonObject | undefined {
  if (!isObject(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  return value;
}

function rejectUnknownKeys(
  value: JsonObject,
  allowed: readonly string[],
  path: string,
  issues: ValidationIssue[]
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      issues.push({ path: path === "$" ? key : `${path}.${key}`, message: "unknown key" });
    }
  }
}

function requireNonEmptyString(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    issues.push({ path, message: "must be a non-empty string without NUL bytes" });
    return false;
  }
  return true;
}

function requireText(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  if (typeof value !== "string" || value.includes("\0")) {
    issues.push({ path, message: "must be a text string without NUL bytes" });
    return false;
  }
  return true;
}

function isRfc3339DateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
    value
  );
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function requireRfc3339DateTime(
  value: unknown,
  path: string,
  issues: ValidationIssue[]
): value is string {
  if (!isRfc3339DateTime(value)) {
    issues.push({ path, message: "must be an RFC3339 date-time" });
    return false;
  }
  return true;
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  options: { allowEmptyArray?: boolean; allowEmptyStrings?: boolean; unique?: boolean } = {}
): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return;
  }
  if (!options.allowEmptyArray && value.length === 0) {
    issues.push({ path, message: "must not be empty" });
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.includes("\0")) {
      issues.push({ path: `${path}[${index}]`, message: "must be a string without NUL bytes" });
      return;
    }
    if (!options.allowEmptyStrings && entry.trim().length === 0) {
      issues.push({ path: `${path}[${index}]`, message: "must not be empty" });
    }
    if (options.unique && seen.has(entry)) {
      issues.push({ path: `${path}[${index}]`, message: `duplicate value: ${entry}` });
    }
    seen.add(entry);
  });
}

function validateFileOperation(operation: JsonObject, path: string, issues: ValidationIssue[]): void {
  rejectUnknownKeys(operation, ["id", "type", "action", "path", "before", "after"], path, issues);
  requireNonEmptyString(operation.id, `${path}.id`, issues);
  requireNonEmptyString(operation.path, `${path}.path`, issues);

  const hasBefore = Object.prototype.hasOwnProperty.call(operation, "before");
  const hasAfter = Object.prototype.hasOwnProperty.call(operation, "after");
  if (operation.action === "create") {
    if (hasBefore) issues.push({ path: `${path}.before`, message: "is forbidden for create operations" });
    if (!hasAfter) issues.push({ path: `${path}.after`, message: "is required for create operations" });
  } else if (operation.action === "update") {
    if (!hasBefore) issues.push({ path: `${path}.before`, message: "is required for update operations" });
    if (!hasAfter) issues.push({ path: `${path}.after`, message: "is required for update operations" });
  } else if (operation.action === "delete") {
    if (!hasBefore) issues.push({ path: `${path}.before`, message: "is required for delete operations" });
    if (hasAfter) issues.push({ path: `${path}.after`, message: "is forbidden for delete operations" });
  } else {
    issues.push({ path: `${path}.action`, message: "must be create, update, or delete" });
  }

  if (hasBefore) requireText(operation.before, `${path}.before`, issues);
  if (hasAfter) requireText(operation.after, `${path}.after`, issues);
}

function validateOperations(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: "must be a non-empty array" });
    return;
  }
  const ids = new Set<string>();
  value.forEach((entry, index) => {
    const operationPath = `${path}[${index}]`;
    const operation = objectAt(entry, operationPath, issues);
    if (!operation) return;
    if (operation.type === "file") {
      validateFileOperation(operation, operationPath, issues);
    } else if (operation.type === "command") {
      try {
        validateCommandOperationValue(operation, operationPath);
      } catch (error) {
        issues.push({ path: operationPath, message: (error as Error).message });
      }
    } else {
      issues.push({
        path: `${operationPath}.type`,
        message: "unsupported operation type; must be file or command"
      });
    }
    if (typeof operation.id === "string" && operation.id.trim().length > 0) {
      if (ids.has(operation.id)) {
        issues.push({ path: `${operationPath}.id`, message: `duplicate operation ID: ${operation.id}` });
      }
      ids.add(operation.id);
    }
  });
}

function validatePreconditions(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const item = objectAt(entry, itemPath, issues);
    if (!item) return;
    rejectUnknownKeys(item, ["kind", "value", "description"], itemPath, issues);
    if (!["git_clean", "branch_is", "env_present"].includes(String(item.kind))) {
      issues.push({ path: `${itemPath}.kind`, message: "must be git_clean, branch_is, or env_present" });
    }
    if ((item.kind === "branch_is" || item.kind === "env_present") && item.value === undefined) {
      issues.push({ path: `${itemPath}.value`, message: `is required for ${String(item.kind)}` });
    }
    if (item.value !== undefined) requireNonEmptyString(item.value, `${itemPath}.value`, issues);
    if (item.description !== undefined) {
      requireNonEmptyString(item.description, `${itemPath}.description`, issues);
    }
  });
}

function validateExecution(value: unknown, path: string, issues: ValidationIssue[]): void {
  const execution = objectAt(value, path, issues);
  if (!execution) return;
  rejectUnknownKeys(execution, ["commandTimeoutMs", "commandPolicy", "filePolicy"], path, issues);
  try {
    validatePlanCommandContract({ operations: [], execution });
  } catch (error) {
    issues.push({ path, message: (error as Error).message });
  }
  if (execution.filePolicy !== undefined) {
    const policyPath = `${path}.filePolicy`;
    const policy = objectAt(execution.filePolicy, policyPath, issues);
    if (policy) {
      rejectUnknownKeys(policy, ["allowedRoots"], policyPath, issues);
      validateStringArray(policy.allowedRoots, `${policyPath}.allowedRoots`, issues, { unique: true });
    }
  }
}

function validateDraftFields(draft: JsonObject, issues: ValidationIssue[]): void {
  rejectUnknownKeys(
    draft,
    ["version", "source", "summary", "dependsOn", "operations", "preconditions", "execution"],
    "$",
    issues
  );
  if (draft.version !== undefined && draft.version !== PLAN_VERSION) {
    issues.push({ path: "version", message: `must be ${PLAN_VERSION}` });
  }
  requireNonEmptyString(draft.source, "source", issues);
  requireNonEmptyString(draft.summary, "summary", issues);
  if (draft.dependsOn !== undefined) {
    validateStringArray(draft.dependsOn, "dependsOn", issues, { unique: true });
  }
  validateOperations(draft.operations, "operations", issues);
  if (draft.preconditions !== undefined) validatePreconditions(draft.preconditions, "preconditions", issues);
  if (draft.execution !== undefined) validateExecution(draft.execution, "execution", issues);
}

export function validatePlanDraft(value: unknown): PlanDraft {
  const issues: ValidationIssue[] = [];
  const draft = objectAt(value, "$", issues);
  if (draft) validateDraftFields(draft, issues);
  if (issues.length > 0) throw new GatefileValidationError("Invalid plan draft", issues);
  return value as PlanDraft;
}

function validateContext(value: unknown, path: string, issues: ValidationIssue[]): void {
  const context = objectAt(value, path, issues);
  if (!context) return;
  rejectUnknownKeys(context, ["repositoryId"], path, issues);
  requireNonEmptyString(context.repositoryId, `${path}.repositoryId`, issues);
}

function validateRisk(value: unknown, path: string, issues: ValidationIssue[]): void {
  const risk = objectAt(value, path, issues);
  if (!risk) return;
  rejectUnknownKeys(risk, ["score", "level", "reasons"], path, issues);
  if (typeof risk.score !== "number" || !Number.isFinite(risk.score) || risk.score < 0) {
    issues.push({ path: `${path}.score`, message: "must be a finite non-negative number" });
  }
  if (risk.level !== "low" && risk.level !== "medium" && risk.level !== "high") {
    issues.push({ path: `${path}.level`, message: "must be low, medium, or high" });
  }
  validateStringArray(risk.reasons, `${path}.reasons`, issues, { allowEmptyArray: true });
}

function validateIntegrity(value: unknown, issues: ValidationIssue[]): void {
  const integrity = objectAt(value, "integrity", issues);
  if (!integrity) return;
  rejectUnknownKeys(
    integrity,
    ["algorithm", "canonicalizer", "envelopeVersion", "planHash"],
    "integrity",
    issues
  );
  if (integrity.algorithm !== "sha256") {
    issues.push({ path: "integrity.algorithm", message: "must be sha256" });
  }
  if (integrity.canonicalizer !== HASH_CANONICALIZER) {
    issues.push({ path: "integrity.canonicalizer", message: `must be ${HASH_CANONICALIZER}` });
  }
  if (integrity.envelopeVersion !== HASH_ENVELOPE_VERSION) {
    issues.push({ path: "integrity.envelopeVersion", message: `must be ${HASH_ENVELOPE_VERSION}` });
  }
  if (typeof integrity.planHash !== "string" || !/^[a-f0-9]{64}$/.test(integrity.planHash)) {
    issues.push({ path: "integrity.planHash", message: "must be a lowercase SHA-256 hex digest" });
  }
}

function validateAttestation(value: unknown, path: string, issues: ValidationIssue[]): void {
  const attestation = objectAt(value, path, issues);
  if (!attestation) return;
  rejectUnknownKeys(attestation, ["scheme", "keyId", "publicKeyPem", "payload", "signature"], path, issues);
  if (attestation.scheme !== "ed25519-sha256") {
    issues.push({ path: `${path}.scheme`, message: "must be ed25519-sha256" });
  }
  requireNonEmptyString(attestation.keyId, `${path}.keyId`, issues);
  requireNonEmptyString(attestation.publicKeyPem, `${path}.publicKeyPem`, issues);
  requireNonEmptyString(attestation.signature, `${path}.signature`, issues);
  const payloadPath = `${path}.payload`;
  const payload = objectAt(attestation.payload, payloadPath, issues);
  if (!payload) return;
  rejectUnknownKeys(
    payload,
    ["type", "planId", "approvedBy", "approvedAt", "approvedPlanHash"],
    payloadPath,
    issues
  );
  if (payload.type !== "gatefile-approval-v1") {
    issues.push({ path: `${payloadPath}.type`, message: "must be gatefile-approval-v1" });
  }
  requireNonEmptyString(payload.planId, `${payloadPath}.planId`, issues);
  requireNonEmptyString(payload.approvedBy, `${payloadPath}.approvedBy`, issues);
  requireRfc3339DateTime(payload.approvedAt, `${payloadPath}.approvedAt`, issues);
  if (typeof payload.approvedPlanHash !== "string" || !/^[a-f0-9]{64}$/.test(payload.approvedPlanHash)) {
    issues.push({ path: `${payloadPath}.approvedPlanHash`, message: "must be a SHA-256 hex digest" });
  }
}

function validateApproval(value: unknown, path: string, issues: ValidationIssue[]): void {
  const approval = objectAt(value, path, issues);
  if (!approval) return;
  rejectUnknownKeys(
    approval,
    ["status", "approvedBy", "approvedAt", "approvedPlanHash", "attestation"],
    path,
    issues
  );
  if (approval.status !== "pending" && approval.status !== "approved" && approval.status !== "rejected") {
    issues.push({ path: `${path}.status`, message: "must be pending, approved, or rejected" });
  }
  if (approval.approvedBy !== undefined) {
    requireNonEmptyString(approval.approvedBy, `${path}.approvedBy`, issues);
  }
  if (approval.approvedAt !== undefined) {
    requireRfc3339DateTime(approval.approvedAt, `${path}.approvedAt`, issues);
  }
  if (
    approval.approvedPlanHash !== undefined &&
    (typeof approval.approvedPlanHash !== "string" || !/^[a-f0-9]{64}$/.test(approval.approvedPlanHash))
  ) {
    issues.push({ path: `${path}.approvedPlanHash`, message: "must be a SHA-256 hex digest" });
  }
  if (approval.status === "approved") {
    if (approval.approvedBy === undefined) {
      issues.push({ path: `${path}.approvedBy`, message: "is required for approved plans" });
    }
    if (approval.approvedAt === undefined) {
      issues.push({ path: `${path}.approvedAt`, message: "is required for approved plans" });
    }
    if (approval.approvedPlanHash === undefined) {
      issues.push({ path: `${path}.approvedPlanHash`, message: "is required for approved plans" });
    }
  }
  if (approval.attestation !== undefined) {
    validateAttestation(approval.attestation, `${path}.attestation`, issues);
  }
}

export function validatePlanFile(value: unknown): PlanFile {
  const issues: ValidationIssue[] = [];
  const plan = objectAt(value, "$", issues);
  if (plan) {
    rejectUnknownKeys(
      plan,
      [
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
      ],
      "$",
      issues
    );
    if (plan.version !== PLAN_VERSION) {
      issues.push({ path: "version", message: `unsupported plan version; expected v2 (${PLAN_VERSION})` });
    }
    requireNonEmptyString(plan.id, "id", issues);
    requireRfc3339DateTime(plan.createdAt, "createdAt", issues);
    requireNonEmptyString(plan.source, "source", issues);
    requireNonEmptyString(plan.summary, "summary", issues);
    validateContext(plan.context, "context", issues);
    if (plan.dependsOn !== undefined) {
      validateStringArray(plan.dependsOn, "dependsOn", issues, { unique: true });
    }
    validateOperations(plan.operations, "operations", issues);
    validatePreconditions(plan.preconditions, "preconditions", issues);
    if (plan.execution !== undefined) validateExecution(plan.execution, "execution", issues);
    validateRisk(plan.risk, "risk", issues);
    validateIntegrity(plan.integrity, issues);
    validateApproval(plan.approval, "approval", issues);
  }
  if (issues.length > 0) throw new GatefileValidationError("Invalid v2 plan file", issues);
  return value as PlanFile;
}

export function riskProfilesEqual(left: RiskProfile, right: RiskProfile): boolean {
  return (
    left.score === right.score &&
    left.level === right.level &&
    left.reasons.length === right.reasons.length &&
    left.reasons.every((reason, index) => reason === right.reasons[index])
  );
}

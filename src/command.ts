import { basename } from "node:path";
import { CommandOperation, CommandPolicy, CommandPolicyRule, ExecutionConfig } from "./types";

const COMMAND_OPERATION_KEYS = new Set([
  "id",
  "type",
  "executable",
  "args",
  "cwd",
  "timeoutMs",
  "allowFailure"
]);
const COMMAND_POLICY_KEYS = new Set(["mode", "rules"]);
const COMMAND_RULE_KEYS = new Set(["executable", "args"]);
const MAX_COMMAND_TIMEOUT_MS = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`);
  }
}

function validateToken(value: unknown, label: string, allowEmpty: boolean): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  if ((!allowEmpty && value.trim().length === 0) || value.includes("\0")) {
    throw new Error(`${label} must be non-empty and contain no NUL bytes`);
  }
}

function validateArgs(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }
  value.forEach((arg, index) => validateToken(arg, `${label}[${index}]`, true));
}

export function validateCommandOperationValue(value: unknown, label = "command operation"): asserts value is CommandOperation {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  rejectUnknownKeys(value, COMMAND_OPERATION_KEYS, label);
  validateToken(value.id, `${label}.id`, false);
  if (value.type !== "command") throw new Error(`${label}.type must equal command`);
  if ("command" in value) throw new Error(`${label} uses forbidden legacy command string`);
  validateToken(value.executable, `${label}.executable`, false);
  validateArgs(value.args, `${label}.args`);
  if (value.cwd !== undefined) validateToken(value.cwd, `${label}.cwd`, false);
  if (
    value.timeoutMs !== undefined &&
    (typeof value.timeoutMs !== "number" ||
      !Number.isInteger(value.timeoutMs) ||
      value.timeoutMs < 1 ||
      value.timeoutMs > MAX_COMMAND_TIMEOUT_MS)
  ) {
    throw new Error(
      `${label}.timeoutMs must be an integer from 1 through ${MAX_COMMAND_TIMEOUT_MS} milliseconds`
    );
  }
  if (value.allowFailure !== undefined && typeof value.allowFailure !== "boolean") {
    throw new Error(`${label}.allowFailure must be a boolean`);
  }
}

function validateCommandPolicyRuleValue(value: unknown, label: string): asserts value is CommandPolicyRule {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  rejectUnknownKeys(value, COMMAND_RULE_KEYS, label);
  validateToken(value.executable, `${label}.executable`, false);
  validateArgs(value.args, `${label}.args`);
}

export function validateCommandPolicyValue(value: unknown, label = "command policy"): asserts value is CommandPolicy {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  rejectUnknownKeys(value, COMMAND_POLICY_KEYS, label);
  if (value.mode !== "allow" && value.mode !== "deny") {
    throw new Error(`${label}.mode must be allow or deny`);
  }
  if (!Array.isArray(value.rules) || value.rules.length === 0) {
    throw new Error(`${label}.rules must contain at least one exact rule`);
  }
  value.rules.forEach((rule, index) => validateCommandPolicyRuleValue(rule, `${label}.rules[${index}]`));
}

export function validatePlanCommandContract(value: {
  operations?: unknown;
  execution?: unknown;
}): void {
  if (!Array.isArray(value.operations)) return;
  value.operations.forEach((operation, index) => {
    if (!isRecord(operation)) {
      throw new Error(`operations[${index}] must be an object`);
    }
    if (operation.type === "command") {
      validateCommandOperationValue(operation, `operations[${index}]`);
      return;
    }
    if (operation.type !== "file") {
      throw new Error(`operations[${index}].type is unsupported: ${String(operation.type)}`);
    }
  });

  if (value.execution === undefined) return;
  if (!isRecord(value.execution)) throw new Error("execution must be an object");
  const execution = value.execution as unknown as ExecutionConfig;
  if (
    execution.commandTimeoutMs !== undefined &&
    (!Number.isInteger(execution.commandTimeoutMs) ||
      execution.commandTimeoutMs < 1 ||
      execution.commandTimeoutMs > MAX_COMMAND_TIMEOUT_MS)
  ) {
    throw new Error(
      `execution.commandTimeoutMs must be an integer from 1 through ${MAX_COMMAND_TIMEOUT_MS} milliseconds`
    );
  }
  if (execution.commandPolicy !== undefined) {
    validateCommandPolicyValue(execution.commandPolicy, "execution.commandPolicy");
  }
}

export function commandRuleMatches(
  operation: Pick<CommandOperation, "executable" | "args">,
  rule: CommandPolicyRule
): boolean {
  return (
    operation.executable === rule.executable &&
    operation.args.length === rule.args.length &&
    rule.args.every((arg, index) => arg === operation.args[index])
  );
}

export function formatCommandInvocation(
  operation: Pick<CommandOperation, "executable" | "args">
): string {
  return JSON.stringify({ executable: operation.executable, args: operation.args });
}

export function isPotentiallyDestructiveCommand(operation: CommandOperation): boolean {
  const executableName = basename(operation.executable).toLowerCase();
  if (executableName === "sudo" || executableName === "doas") return true;
  if (executableName !== "rm") return false;

  const shortFlags = operation.args
    .filter((arg) => /^-[^-]/.test(arg))
    .join("")
    .toLowerCase();
  const recursive = shortFlags.includes("r") || operation.args.includes("--recursive");
  const force = shortFlags.includes("f") || operation.args.includes("--force");
  return recursive && force;
}

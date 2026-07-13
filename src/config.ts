import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { URL } from "node:url";
import type {
  GatefileConfig,
  HookCommandConfig,
  NotificationActionConfig,
  NotificationsConfig,
  PolicyHooksConfig
} from "./types";
import { getPinnedRepoRoot, getRepoRoot } from "./state";
import {
  canonicalizeApprovalPublicKeyPem,
  isApprovalKeyId
} from "./approval-key";

export const DEFAULT_CONFIG_FILE = "gatefile.config.json";

const LEGACY_APPROVAL_NOTIFICATION_CONFIGS = new WeakSet<object>();
const HTTP_WEBHOOK_PATTERN = /^https?:\/\/[^\s/?#\\]+(?:[/?#][^\s\\]*)?$/;

interface ConfigValidationIssue {
  path: string;
  message: string;
}

export class GatefileConfigError extends Error {
  readonly issues: ConfigValidationIssue[];
  readonly configPath?: string;

  constructor(issues: ConfigValidationIssue[], configPath?: string) {
    const heading = configPath
      ? `Invalid Gatefile config at ${configPath}:`
      : "Invalid Gatefile config:";
    const details = issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
    super(`${heading}\n${details}`);
    this.name = "GatefileConfigError";
    this.issues = issues;
    this.configPath = configPath;
  }
}

export function configPath(repoRoot?: string, explicitPath?: string): string {
  if (explicitPath) return resolve(explicitPath);
  return resolve(getRepoRoot(repoRoot), DEFAULT_CONFIG_FILE);
}

export function canonicalizePublicKeyPem(value: string): string {
  return canonicalizeApprovalPublicKeyPem(value);
}

/** Preserve the legacy payload identifier without adding provenance to public config data. */
export function approvalNotificationEventName(
  config: GatefileConfig
): "plan_approved" | "approval_needed" {
  return LEGACY_APPROVAL_NOTIFICATION_CONFIGS.has(config as object)
    ? "approval_needed"
    : "plan_approved";
}

function normalizeStringArray(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
  options: { rejectSurroundingWhitespace?: boolean } = {}
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array of strings" });
    return [];
  }

  const out: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== "string") {
      issues.push({ path: `${path}[${i}]`, message: "must be a string" });
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      issues.push({ path: `${path}[${i}]`, message: "must not be empty" });
      continue;
    }
    if (options.rejectSurroundingWhitespace && entry !== trimmed) {
      issues.push({
        path: `${path}[${i}]`,
        message: "must not contain leading or trailing whitespace"
      });
      continue;
    }
    if (entry.includes("\0")) {
      issues.push({ path: `${path}[${i}]`, message: "must not contain NUL" });
      continue;
    }
    out.push(trimmed);
  }
  return out;
}

function objectValue(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[]
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ConfigValidationIssue[]
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push({
        path: path === "$" ? key : `${path}.${key}`,
        message: "unknown field"
      });
    }
  }
}

function normalizePolicyHook(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[]
): HookCommandConfig | undefined {
  const startIssueCount = issues.length;
  const hook = objectValue(value, path, issues);
  if (!hook) return undefined;
  rejectUnknownKeys(hook, ["command", "cwd"], path, issues);

  const command = hook.command;
  const cwd = hook.cwd;
  if (
    typeof command !== "string" ||
    command.trim().length === 0 ||
    command.includes("\0")
  ) {
    issues.push({ path: `${path}.command`, message: "must be a non-empty string" });
  }
  if (
    cwd !== undefined &&
    (typeof cwd !== "string" || cwd.trim().length === 0 || cwd.includes("\0"))
  ) {
    issues.push({ path: `${path}.cwd`, message: "must be a non-empty string when provided" });
  }
  if (issues.length !== startIssueCount) return undefined;

  return {
    command: (command as string).trim(),
    ...(cwd === undefined ? {} : { cwd: (cwd as string).trim() })
  };
}

function normalizeNotificationAction(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[]
): NotificationActionConfig | undefined {
  const startIssueCount = issues.length;
  const action = objectValue(value, path, issues);
  if (!action) return undefined;
  rejectUnknownKeys(action, ["webhook", "shell"], path, issues);

  let webhook: string | undefined;
  if (action.webhook !== undefined) {
    if (typeof action.webhook !== "string" || action.webhook.trim().length === 0) {
      issues.push({ path: `${path}.webhook`, message: "must be a non-empty HTTP(S) URL" });
    } else {
      const candidate = action.webhook.trim();
      if (candidate !== action.webhook) {
        issues.push({
          path: `${path}.webhook`,
          message: "must not contain leading or trailing whitespace"
        });
      }
      if (!HTTP_WEBHOOK_PATTERN.test(candidate)) {
        issues.push({
          path: `${path}.webhook`,
          message: "must be an absolute URL with a lowercase http or https scheme"
        });
      } else {
        try {
          const parsed = new URL(candidate);
          if (
            (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
            parsed.hostname.length === 0
          ) {
            throw new TypeError("invalid HTTP(S) authority");
          }
          webhook = candidate;
        } catch {
          issues.push({
            path: `${path}.webhook`,
            message: "must contain a valid HTTP(S) authority and port"
          });
        }
      }
    }
  }

  let shell: string | undefined;
  if (action.shell !== undefined) {
    if (
      typeof action.shell !== "string" ||
      action.shell.trim().length === 0 ||
      action.shell.includes("\0")
    ) {
      issues.push({ path: `${path}.shell`, message: "must be a non-empty string" });
    } else {
      shell = action.shell.trim();
    }
  }

  if (action.webhook === undefined && action.shell === undefined) {
    issues.push({ path, message: "must configure at least one of webhook or shell" });
  }
  if (issues.length !== startIssueCount) return undefined;
  if (webhook !== undefined && shell !== undefined) return { webhook, shell };
  if (webhook !== undefined) return { webhook };
  return { shell: shell! };
}

export function normalizeGatefileConfig(rawConfig: unknown, sourceLabel?: string): GatefileConfig {
  const issues: ConfigValidationIssue[] = [];
  if (rawConfig === undefined) return {};
  if (typeof rawConfig !== "object" || rawConfig === null || Array.isArray(rawConfig)) {
    throw new GatefileConfigError([{ path: "$", message: "must be a JSON object" }], sourceLabel);
  }

  const config = rawConfig as Record<string, unknown>;
  const inheritedLegacyApprovalEvent = LEGACY_APPROVAL_NOTIFICATION_CONFIGS.has(config);
  const normalized: GatefileConfig = {};
  rejectUnknownKeys(config, ["signers", "hooks", "notifications"], "$", issues);

  let legacyOnPlanCreated: NotificationActionConfig | undefined;
  let legacyOnPlanApproved: NotificationActionConfig | undefined;

  if (config.hooks !== undefined) {
    const hooksRaw = objectValue(config.hooks, "hooks", issues);
    if (hooksRaw) {
      rejectUnknownKeys(
        hooksRaw,
        ["beforeApprove", "beforeApply", "onPlanCreated", "onApprovalNeeded"],
        "hooks",
        issues
      );
      const hooks: PolicyHooksConfig = {};
      for (const hookName of ["beforeApprove", "beforeApply"] as const) {
        const hookRaw = hooksRaw[hookName];
        if (hookRaw === undefined) continue;
        const hook = normalizePolicyHook(hookRaw, `hooks.${hookName}`, issues);
        if (hook) hooks[hookName] = hook;
      }
      if (Object.keys(hooks).length > 0) {
        normalized.hooks = hooks;
      }

      if (hooksRaw.onPlanCreated !== undefined) {
        legacyOnPlanCreated = normalizeNotificationAction(
          hooksRaw.onPlanCreated,
          "hooks.onPlanCreated",
          issues
        );
      }
      if (hooksRaw.onApprovalNeeded !== undefined) {
        legacyOnPlanApproved = normalizeNotificationAction(
          hooksRaw.onApprovalNeeded,
          "hooks.onApprovalNeeded",
          issues
        );
      }
    }
  }

  let canonicalNotifications: NotificationsConfig | undefined;
  if (config.notifications !== undefined) {
    const notificationsRaw = objectValue(config.notifications, "notifications", issues);
    if (notificationsRaw) {
      rejectUnknownKeys(
        notificationsRaw,
        ["onPlanCreated", "onPlanApproved"],
        "notifications",
        issues
      );
      canonicalNotifications = {};
      for (const eventName of ["onPlanCreated", "onPlanApproved"] as const) {
        if (notificationsRaw[eventName] === undefined) continue;
        const action = normalizeNotificationAction(
          notificationsRaw[eventName],
          `notifications.${eventName}`,
          issues
        );
        if (action) canonicalNotifications[eventName] = action;
      }
    }
  }

  if (legacyOnPlanCreated && canonicalNotifications?.onPlanCreated) {
    issues.push({
      path: "notifications.onPlanCreated",
      message: "event is configured twice through canonical and deprecated keys"
    });
  }
  if (legacyOnPlanApproved && canonicalNotifications?.onPlanApproved) {
    issues.push({
      path: "notifications.onPlanApproved",
      message: "event is configured twice through canonical and deprecated keys"
    });
  }

  const notifications: NotificationsConfig = {
    onPlanCreated: canonicalNotifications?.onPlanCreated ?? legacyOnPlanCreated,
    onPlanApproved: canonicalNotifications?.onPlanApproved ?? legacyOnPlanApproved
  };
  if (notifications.onPlanCreated || notifications.onPlanApproved) {
    normalized.notifications = notifications;
  }

  if (config.signers !== undefined) {
    const signersRaw = objectValue(config.signers, "signers", issues);
    if (signersRaw) {
      rejectUnknownKeys(
        signersRaw,
        ["trustedKeyIds", "trustedPublicKeys"],
        "signers",
        issues
      );
      const trustedKeyIdsRaw = normalizeStringArray(
        signersRaw.trustedKeyIds,
        "signers.trustedKeyIds",
        issues,
        { rejectSurroundingWhitespace: true }
      );
      const trustedPublicKeysRaw = normalizeStringArray(
        signersRaw.trustedPublicKeys,
        "signers.trustedPublicKeys",
        issues
      );

      const trustedKeyIds: string[] = [];
      const seenKeyIds = new Set<string>();
      trustedKeyIdsRaw.forEach((value, i) => {
        if (!isApprovalKeyId(value)) {
          issues.push({
            path: `signers.trustedKeyIds[${i}]`,
            message: "must be a derived approval key ID (gfk1_ followed by 16 lowercase hex characters)"
          });
          return;
        }
        if (!seenKeyIds.has(value)) {
          seenKeyIds.add(value);
          trustedKeyIds.push(value);
        }
      });
      const trustedPublicKeys: string[] = [];
      const seenPublicKeys = new Set<string>();
      trustedPublicKeysRaw.forEach((value, i) => {
        try {
          const canonical = canonicalizePublicKeyPem(value);
          if (!seenPublicKeys.has(canonical)) {
            seenPublicKeys.add(canonical);
            trustedPublicKeys.push(canonical);
          }
        } catch {
          issues.push({
            path: `signers.trustedPublicKeys[${i}]`,
            message:
              "must be a valid PEM-encoded public key in canonical Ed25519 SPKI form"
          });
        }
      });

      if (trustedKeyIds.length === 0 && trustedPublicKeys.length === 0) {
        issues.push({
          path: "signers",
          message:
            "trust policy is empty; configure at least one of trustedKeyIds or trustedPublicKeys, or remove signers"
        });
      } else {
        normalized.signers = trustedKeyIds.length > 0
          ? {
              trustedKeyIds: trustedKeyIds as [string, ...string[]],
              ...(trustedPublicKeys.length > 0
                ? { trustedPublicKeys: trustedPublicKeys as [string, ...string[]] }
                : {})
            }
          : {
              trustedPublicKeys: trustedPublicKeys as [string, ...string[]]
            };
      }
    }
  }

  if (issues.length > 0) {
    throw new GatefileConfigError(issues, sourceLabel);
  }
  if (
    normalized.notifications?.onPlanApproved &&
    (inheritedLegacyApprovalEvent || legacyOnPlanApproved !== undefined)
  ) {
    LEGACY_APPROVAL_NOTIFICATION_CONFIGS.add(normalized as object);
  }
  return normalized;
}

export function loadGatefileConfig(repoRoot?: string, explicitPath?: string): GatefileConfig {
  const path = configPath(repoRoot, explicitPath);
  return loadGatefileConfigAtPath(path);
}

/** Load policy from an engine-pinned root without rediscovering Git topology. */
export function loadGatefileConfigFromPinnedRoot(repoRoot: string): GatefileConfig {
  return loadGatefileConfigAtPath(
    resolve(getPinnedRepoRoot(repoRoot), DEFAULT_CONFIG_FILE)
  );
}

function loadGatefileConfigAtPath(path: string): GatefileConfig {
  if (!existsSync(path)) {
    return {};
  }

  try {
    return normalizeGatefileConfig(JSON.parse(readFileSync(path, "utf8")), path);
  } catch (error) {
    if (error instanceof GatefileConfigError) throw error;
    throw new GatefileConfigError(
      [{ path: "$", message: `failed to parse JSON (${(error as Error).message})` }],
      path
    );
  }
}

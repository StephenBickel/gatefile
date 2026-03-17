import { existsSync, readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { resolve } from "node:path";
import { GatefileConfig } from "./types";
import { getRepoRoot } from "./state";

export const DEFAULT_CONFIG_FILE = "gatefile.config.json";

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
  const key = createPublicKey({ format: "pem", key: value });
  return key.export({ format: "pem", type: "spki" }).toString().trim();
}

function normalizeStringArray(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[]
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
    out.push(trimmed);
  }
  return out;
}

export function normalizeGatefileConfig(rawConfig: unknown, sourceLabel?: string): GatefileConfig {
  const issues: ConfigValidationIssue[] = [];
  if (rawConfig === undefined || rawConfig === null) return {};
  if (typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new GatefileConfigError([{ path: "$", message: "must be a JSON object" }], sourceLabel);
  }

  const config = rawConfig as Record<string, unknown>;
  const normalized: GatefileConfig = {};

  if (config.hooks !== undefined) {
    if (typeof config.hooks !== "object" || config.hooks === null || Array.isArray(config.hooks)) {
      issues.push({ path: "hooks", message: "must be an object" });
    } else {
      const hooksRaw = config.hooks as Record<string, unknown>;
      const hooks: NonNullable<GatefileConfig["hooks"]> = {};
      for (const hookName of ["beforeApprove", "beforeApply"] as const) {
        const hookRaw = hooksRaw[hookName];
        if (hookRaw === undefined) continue;
        if (typeof hookRaw !== "object" || hookRaw === null || Array.isArray(hookRaw)) {
          issues.push({ path: `hooks.${hookName}`, message: "must be an object with a command" });
          continue;
        }
        const command = (hookRaw as Record<string, unknown>).command;
        const cwd = (hookRaw as Record<string, unknown>).cwd;
        if (typeof command !== "string" || command.trim().length === 0) {
          issues.push({ path: `hooks.${hookName}.command`, message: "must be a non-empty string" });
          continue;
        }
        if (cwd !== undefined && (typeof cwd !== "string" || cwd.trim().length === 0)) {
          issues.push({ path: `hooks.${hookName}.cwd`, message: "must be a non-empty string when provided" });
          continue;
        }
        hooks[hookName] = { command: command.trim(), ...(cwd ? { cwd: cwd.trim() } : {}) };
      }
      if (Object.keys(hooks).length > 0) {
        normalized.hooks = hooks;
      }
    }
  }

  if (config.signers !== undefined) {
    if (typeof config.signers !== "object" || config.signers === null || Array.isArray(config.signers)) {
      issues.push({ path: "signers", message: "must be an object" });
    } else {
      const signersRaw = config.signers as Record<string, unknown>;
      const trustedKeyIdsRaw = normalizeStringArray(
        signersRaw.trustedKeyIds,
        "signers.trustedKeyIds",
        issues
      );
      const trustedPublicKeysRaw = normalizeStringArray(
        signersRaw.trustedPublicKeys,
        "signers.trustedPublicKeys",
        issues
      );

      const trustedKeyIds = [...new Set(trustedKeyIdsRaw)];
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
            message: "must be a valid PEM-encoded public key"
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
        normalized.signers = {};
        if (trustedKeyIds.length > 0) normalized.signers.trustedKeyIds = trustedKeyIds;
        if (trustedPublicKeys.length > 0) normalized.signers.trustedPublicKeys = trustedPublicKeys;
      }
    }
  }

  if (issues.length > 0) {
    throw new GatefileConfigError(issues, sourceLabel);
  }
  return normalized;
}

export function loadGatefileConfig(repoRoot?: string, explicitPath?: string): GatefileConfig {
  const path = configPath(repoRoot, explicitPath);
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

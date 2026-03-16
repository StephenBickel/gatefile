import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GatefileConfig } from "./types";
import { getRepoRoot } from "./state";

export const DEFAULT_CONFIG_FILE = "gatefile.config.json";

export function configPath(repoRoot?: string, explicitPath?: string): string {
  if (explicitPath) return resolve(explicitPath);
  return resolve(getRepoRoot(repoRoot), DEFAULT_CONFIG_FILE);
}

export function loadGatefileConfig(repoRoot?: string, explicitPath?: string): GatefileConfig {
  const path = configPath(repoRoot, explicitPath);
  if (!existsSync(path)) {
    return {};
  }

  return JSON.parse(readFileSync(path, "utf8")) as GatefileConfig;
}

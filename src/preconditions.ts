import { execSync } from "node:child_process";
import { Precondition } from "./types";

export interface PreconditionResult {
  ok: boolean;
  message: string;
  failed?: Precondition;
}

function getCurrentBranch(): string {
  return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
}

function isGitClean(): boolean {
  const out = execSync("git status --porcelain -- . ':(exclude).gatefile/state'", {
    encoding: "utf-8"
  }).trim();
  return out.length === 0;
}

export function checkPreconditions(preconditions: Precondition[]): PreconditionResult {
  for (const p of preconditions) {
    if (p.kind === "git_clean") {
      if (!isGitClean()) {
        return { ok: false, message: "Git working tree is not clean", failed: p };
      }
    }

    if (p.kind === "branch_is") {
      const expected = p.value ?? "";
      const actual = getCurrentBranch();
      if (actual !== expected) {
        return {
          ok: false,
          message: `Branch mismatch. Expected ${expected}, got ${actual}`,
          failed: p
        };
      }
    }

    if (p.kind === "env_present") {
      const key = p.value ?? "";
      if (!key || !process.env[key]) {
        return { ok: false, message: `Missing environment variable: ${key}`, failed: p };
      }
    }
  }

  return { ok: true, message: "All preconditions passed" };
}

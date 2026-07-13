import { execFileSync } from "node:child_process";
import { Precondition } from "./types";
import { sanitizedGitEnvironment } from "./git-environment";

export interface PreconditionResult {
  ok: boolean;
  message: string;
  failed?: Precondition;
}

export interface PreconditionOptions {
  cwd?: string;
}

function getCurrentBranch(cwd?: string): string {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    encoding: "utf8",
    env: sanitizedGitEnvironment(),
    shell: false
  }).trim();
}

function isGitClean(cwd?: string): boolean {
  const out = execFileSync("git", ["status", "--porcelain", "--", ".", ":(exclude).gatefile/state"], {
    cwd,
    encoding: "utf8",
    env: sanitizedGitEnvironment(),
    shell: false
  }).trim();
  return out.length === 0;
}

export function checkPreconditions(
  preconditions: Precondition[],
  options: PreconditionOptions = {}
): PreconditionResult {
  for (const p of preconditions) {
    if (p.kind === "git_clean") {
      if (!isGitClean(options.cwd)) {
        return { ok: false, message: "Git working tree is not clean", failed: p };
      }
    }

    if (p.kind === "branch_is") {
      const expected = p.value ?? "";
      const actual = getCurrentBranch(options.cwd);
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

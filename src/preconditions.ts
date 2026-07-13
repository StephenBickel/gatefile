import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { Precondition } from "./types";
import { sanitizedGitEnvironment } from "./git-environment";
import {
  isRuntimeRepoRootPinned,
  pinnedRepoRootState
} from "./pinned-runtime";

export interface PreconditionResult {
  ok: boolean;
  message: string;
  failed?: Precondition;
}

export interface PreconditionOptions {
  cwd?: string;
}

function gitEnvironment(options: PreconditionOptions): NodeJS.ProcessEnv {
  const pinned = pinnedRepoRootState(options);
  return sanitizedGitEnvironment(process.env, {
    gitExecutable: pinned?.gitExecutable,
    pathEnvironment: pinned?.pathEnvironment,
    ...(isRuntimeRepoRootPinned(options) && options.cwd !== undefined
      ? { ceilingDirectory: dirname(options.cwd) }
      : {})
  });
}

function gitExecutable(options: PreconditionOptions): string {
  return pinnedRepoRootState(options)?.gitExecutable ?? "git";
}

function getCurrentBranch(options: PreconditionOptions): string {
  return execFileSync(gitExecutable(options), ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: options.cwd,
    encoding: "utf8",
    env: gitEnvironment(options),
    shell: false
  }).trim();
}

function isGitClean(options: PreconditionOptions): boolean {
  const out = execFileSync(gitExecutable(options), ["status", "--porcelain", "--", ".", ":(exclude).gatefile/state"], {
    cwd: options.cwd,
    encoding: "utf8",
    env: gitEnvironment(options),
    shell: false
  }).trim();
  return out.length === 0;
}

export function checkPreconditions(
  preconditions: Precondition[],
  options: PreconditionOptions = {}
): PreconditionResult {
  for (const p of preconditions) {
    if (
      (p.kind === "git_clean" || p.kind === "branch_is") &&
      pinnedRepoRootState(options)?.gitRepositoryRoot === false
    ) {
      return {
        ok: false,
        message: "Pinned repository root was not a Git repository when the engine was constructed",
        failed: p
      };
    }

    if (p.kind === "git_clean") {
      if (!isGitClean(options)) {
        return { ok: false, message: "Git working tree is not clean", failed: p };
      }
    }

    if (p.kind === "branch_is") {
      const expected = p.value ?? "";
      const actual = getCurrentBranch(options);
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

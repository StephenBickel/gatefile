import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

export interface TrustedGitEnvironmentOptions {
  readonly ceilingDirectory?: string;
  readonly gitExecutable?: string;
  readonly pathEnvironment?: string;
}

export function processPath(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  return environment.PATH ?? environment.Path ?? environment.path;
}

/** Resolve the Git binary once so later PATH changes cannot substitute policy code. */
export function resolveGitExecutable(
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  const searchPath = processPath(environment);
  if (!searchPath) return undefined;
  const extensions = process.platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter((entry) => entry.length > 0)
    : [""];

  for (const entry of searchPath.split(delimiter)) {
    const directory = resolve(entry || process.cwd());
    for (const extension of extensions) {
      const candidate = join(directory, `git${extension}`);
      try {
        const stat = statSync(candidate);
        if (!stat.isFile()) continue;
        if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
        return realpathSync(candidate);
      } catch {
        // Keep searching the captured PATH.
      }
    }
  }
  return undefined;
}

function trustedPath(options: TrustedGitEnvironmentOptions): string | undefined {
  const gitDirectory = options.gitExecutable
    ? dirname(options.gitExecutable)
    : undefined;
  const entries = (options.pathEnvironment ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0);
  if (gitDirectory === undefined) {
    return options.pathEnvironment;
  }
  return [
    gitDirectory,
    ...entries.filter((entry) => resolve(entry) !== gitDirectory)
  ].join(delimiter);
}

/**
 * Local repository inspection must be derived from its explicit path, not
 * ambient Git process overrides or user/global Git configuration.
 */
export function sanitizedGitEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  options: TrustedGitEnvironmentOptions = {}
): NodeJS.ProcessEnv {
  const sanitized = Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))
  );
  sanitized.GIT_CONFIG_NOSYSTEM = "1";
  sanitized.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  sanitized.GIT_ATTR_NOSYSTEM = "1";
  if (options.ceilingDirectory !== undefined) {
    sanitized.GIT_CEILING_DIRECTORIES = options.ceilingDirectory;
  }
  const path = trustedPath(options);
  if (path !== undefined) sanitized.PATH = path;
  return sanitized;
}

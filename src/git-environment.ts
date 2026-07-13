/**
 * Local repository inspection must be derived from its explicit path, not
 * ambient Git process overrides such as GIT_DIR or GIT_WORK_TREE.
 */
export function sanitizedGitEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))
  );
}

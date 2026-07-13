const PINNED_REPO_ROOT = Symbol("gatefile.pinned-repo-root");

export interface PinnedRepoRootState {
  readonly gitRepositoryRoot: boolean;
  readonly gitExecutable?: string;
  readonly pathEnvironment?: string;
}

type PinnedRepoRoot = {
  readonly [PINNED_REPO_ROOT]: PinnedRepoRootState;
};

export function pinRuntimeRepoRoot<T extends object>(
  options: T,
  state: PinnedRepoRootState
): T & PinnedRepoRoot {
  Object.defineProperty(options, PINNED_REPO_ROOT, {
    value: Object.freeze({ ...state }),
    writable: false,
    enumerable: false,
    configurable: false
  });
  return options as T & PinnedRepoRoot;
}

export function isRuntimeRepoRootPinned(options: object): boolean {
  return pinnedRepoRootState(options) !== undefined;
}

export function pinnedRepoRootState(
  options: object
): PinnedRepoRootState | undefined {
  return (options as Partial<PinnedRepoRoot>)[PINNED_REPO_ROOT];
}

export function inheritPinnedRepoRoot<T extends object>(source: object, target: T): T {
  const state = pinnedRepoRootState(source);
  return state === undefined ? target : pinRuntimeRepoRoot(target, state);
}

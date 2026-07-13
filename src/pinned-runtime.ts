const PINNED_REPO_ROOT = Symbol("gatefile.pinned-repo-root");

type PinnedRepoRoot = {
  readonly [PINNED_REPO_ROOT]: true;
};

export function pinRuntimeRepoRoot<T extends object>(options: T): T & PinnedRepoRoot {
  Object.defineProperty(options, PINNED_REPO_ROOT, {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false
  });
  return options as T & PinnedRepoRoot;
}

export function isRuntimeRepoRootPinned(options: object): boolean {
  return (options as Partial<PinnedRepoRoot>)[PINNED_REPO_ROOT] === true;
}

export function inheritPinnedRepoRoot<T extends object>(source: object, target: T): T {
  return isRuntimeRepoRootPinned(source) ? pinRuntimeRepoRoot(target) : target;
}

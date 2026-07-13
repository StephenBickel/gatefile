import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchownSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { FileAction, FileOperation } from "./types";

export interface FileIdentity {
  device: string;
  inode: string;
}

export interface DirectoryIdentity {
  relativePath: string;
  identity: FileIdentity;
}

export interface SignedPathMetadata {
  allowedRoot: string;
  relativePath: string;
  requestedPath: string;
  directoryChain: DirectoryIdentity[];
}

export interface SafeAllowedRoot {
  declaredPath: string;
  canonicalPath: string;
  identity: FileIdentity;
}

export interface SafeFsContext {
  repoRoot: string;
  allowedRoots: string[];
  reservedStateRoot: string;
  reservedRoots: string[];
  reservedRootIdentities: FileIdentity[];
  roots: SafeAllowedRoot[];
}

export interface ResolvedSafeTarget extends SignedPathMetadata {
  targetPath: string;
  parentPath: string;
  basename: string;
  parentIdentity?: FileIdentity;
}

export interface AbsentFileState {
  kind: "absent";
}

export interface CompactRegularFileState {
  kind: "regular";
  sha256: string;
  byteLength: number;
  mode: number;
  uid: string;
  gid: string;
  identity: FileIdentity;
}

export interface ExactRegularFileState extends CompactRegularFileState {
  content: Buffer;
}

export type CompactFileState = AbsentFileState | CompactRegularFileState;
export type ExactFileState = AbsentFileState | ExactRegularFileState;

export interface PreparedFileOperation {
  operation: FileOperation;
  target: ResolvedSafeTarget;
  beforeState: ExactFileState;
}

export interface SafeFileMutationResult {
  afterState: CompactFileState;
  target: ResolvedSafeTarget;
  cleanupResidues: FileCleanupResidue[];
}

export interface FileCleanupResidue {
  path: string;
  identity: FileIdentity;
}

export type BeforeFileCommit = (mutation: SafeFileMutationResult) => void;

export class SafeFsPostCommitError extends Error {
  readonly committed: SafeFileMutationResult;
  readonly originalError: unknown;

  constructor(label: string, committed: SafeFileMutationResult, originalError: unknown) {
    super(`${label} committed, but post-commit finalization failed: ${(originalError as Error).message}`);
    this.name = "SafeFsPostCommitError";
    this.committed = committed;
    this.originalError = originalError;
  }
}

export interface ResolveSafeTargetOptions {
  /** Reserved for compatibility; missing target parents are always rejected. */
  createMissingParents?: boolean;
  /** Reserved for compatibility; missing target parents are always rejected. */
  allowMissingParents?: boolean;
}

interface CandidateTarget {
  root: SafeAllowedRoot;
  targetPath: string;
  relativePath: string;
  requestedPath: string;
}

const ABSENT_STATE: AbsentFileState = Object.freeze({ kind: "absent" });
const NO_FOLLOW = constants.O_NOFOLLOW;
const READ_NOFOLLOW = constants.O_RDONLY | NO_FOLLOW;
const DIRECTORY_NOFOLLOW = constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW;
const CREATE_TEMP_FLAGS =
  constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;
const METADATA_TOOL_MAX_OUTPUT = 1024 * 1024;
const ALLOWED_DARWIN_XATTRS = new Set(["com.apple.provenance"]);
export const MAX_SAFE_DIRECTORY_CHAIN_ENTRIES = 128;

/**
 * Pure Node.js has no descriptor-relative openat/renameat/unlinkat API. These
 * controls fail closed on every namespace change they can observe, but cannot
 * eliminate a race by a concurrent writer running as the same OS identity (or
 * root) between the final check and a path-based publish operation.
 */
export const SAFE_FS_CONCURRENT_NAMESPACE_LIMITATION =
  "Portable Node.js cannot eliminate every concurrent namespace race by a writer running as the same OS identity; strict mode rejects observable aliases, writable directories, and identity changes, and native descriptor-relative execution is required for that stronger threat model.";

export function assertSafeFsSupported(): void {
  if (
    process.platform === "win32" ||
    typeof NO_FOLLOW !== "number" ||
    NO_FOLLOW === 0 ||
    typeof constants.O_DIRECTORY !== "number"
  ) {
    throw new Error(
      "Safe file execution requires POSIX O_NOFOLLOW and O_DIRECTORY support; refusing file operations on this platform"
    );
  }
}

function runMetadataInspection(
  executable: string,
  args: string[],
  label: string
): string {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    maxBuffer: METADATA_TOOL_MAX_OUTPUT,
    env: { ...process.env, LC_ALL: "C", LANG: "C" }
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim() ?? `status ${result.status}`;
    throw new Error(`${label} metadata inspection failed closed: ${detail}`);
  }
  return result.stdout;
}

function assertNoExtendedAcl(path: string, label: string): void {
  if (process.platform === "darwin") {
    const output = runMetadataInspection("/bin/ls", ["-lde", path], label);
    if (/^\s*\d+:\s/m.test(output)) {
      throw new Error(`${label} has an extended ACL that secure file execution cannot preserve: ${path}`);
    }
    return;
  }

  if (process.platform === "linux") {
    const output = runMetadataInspection("/bin/ls", ["-ld", "--", path], label);
    const permissions = output.trimStart().split(/\s+/, 1)[0] ?? "";
    if (permissions.endsWith("+")) {
      throw new Error(`${label} has an extended ACL that secure file execution cannot preserve: ${path}`);
    }
    return;
  }

  throw new Error(
    `${label} ACL inspection is unsupported on ${process.platform}; secure file execution fails closed`
  );
}

function assertNoSecuritySensitiveExtendedAttributes(path: string): void {
  if (process.platform !== "darwin") return;
  const output = runMetadataInspection("/usr/bin/xattr", [path], "file target");
  const names = output
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const unsupported = names.filter((name) => !ALLOWED_DARWIN_XATTRS.has(name));
  if (unsupported.length > 0) {
    throw new Error(
      `file target has extended attributes that secure atomic replacement cannot preserve: ${unsupported.join(", ")}`
    );
  }
}

function identityOf(stats: { dev: bigint | number; ino: bigint | number }): FileIdentity {
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function identitiesEqual(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function modeOf(stats: { mode: bigint | number }): number {
  return typeof stats.mode === "bigint"
    ? Number(stats.mode & 0o7777n)
    : stats.mode & 0o7777;
}

function assertDirectoryHasNoNamespaceWriters(
  stats: { mode: bigint | number; uid: bigint | number },
  path: string,
  label: string
): void {
  if ((modeOf(stats) & 0o022) !== 0) {
    throw new Error(
      `${label} is group/world-writable and permits a concurrent namespace writer: ${path}. ${SAFE_FS_CONCURRENT_NAMESPACE_LIMITATION}`
    );
  }
  if (
    typeof process.geteuid === "function" &&
    stats.uid.toString() !== process.geteuid().toString()
  ) {
    throw new Error(
      `${label} must be owned by the current effective user: ${path}. ${SAFE_FS_CONCURRENT_NAMESPACE_LIMITATION}`
    );
  }
  assertNoExtendedAcl(path, label);
}

function assertRegularFileOwnedAndNotSharedWritable(
  stats: { mode: bigint | number; uid: bigint | number },
  path: string
): void {
  if (
    typeof process.geteuid === "function" &&
    stats.uid.toString() !== process.geteuid().toString()
  ) {
    throw new Error(`file target must be owned by the current effective user: ${path}`);
  }
  if ((modeOf(stats) & 0o022) !== 0) {
    throw new Error(
      `file target may not be group/world-writable during portable atomic replacement: ${path}`
    );
  }
  assertNoExtendedAcl(path, "file target");
  assertNoSecuritySensitiveExtendedAttributes(path);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function statPathNoFollow(path: string, label: string) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`${label} does not exist: ${path}`);
    throw error;
  }
}

function existingRealDirectory(path: string, label: string): { canonical: string; identity: FileIdentity } {
  const stat = statPathNoFollow(path, label);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} may not be a symbolic link: ${path}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  const canonical = realpathSync(path);
  const canonicalStat = statPathNoFollow(canonical, label);
  if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) {
    throw new Error(`${label} must resolve to a real directory: ${path}`);
  }
  assertDirectoryHasNoNamespaceWriters(canonicalStat, canonical, label);
  return { canonical, identity: identityOf(canonicalStat) };
}

export function createSafeFsContext(
  repoRoot: string,
  allowedRoots?: readonly string[],
  additionalReservedRoots: readonly string[] = []
): SafeFsContext {
  assertSafeFsSupported();
  if (typeof repoRoot !== "string" || repoRoot.trim().length === 0 || repoRoot.includes("\0")) {
    throw new Error("repo root must be a non-empty filesystem path");
  }

  const requestedRepoRoot = resolve(repoRoot);
  const repo = existingRealDirectory(requestedRepoRoot, "repo root");
  const requestedRoots = allowedRoots && allowedRoots.length > 0 ? allowedRoots : [requestedRepoRoot];
  const roots: SafeAllowedRoot[] = [];
  const seen = new Set<string>();

  for (const requestedRoot of requestedRoots) {
    if (
      typeof requestedRoot !== "string" ||
      requestedRoot.trim().length === 0 ||
      requestedRoot.includes("\0")
    ) {
      throw new Error("allowed root must be a non-empty filesystem path");
    }
    const declaredPath = isAbsolute(requestedRoot)
      ? resolve(requestedRoot)
      : resolve(repo.canonical, requestedRoot);
    const root = existingRealDirectory(declaredPath, "allowed root");
    if (seen.has(root.canonical)) continue;
    seen.add(root.canonical);
    roots.push({ declaredPath, canonicalPath: root.canonical, identity: root.identity });
  }

  roots.sort(
    (left, right) =>
      Math.max(right.declaredPath.length, right.canonicalPath.length) -
      Math.max(left.declaredPath.length, left.canonicalPath.length)
  );

  const reservedStateRoot = resolve(repo.canonical, ".gatefile", "state");
  const reservedRoots = [reservedStateRoot];
  for (const reservedRoot of additionalReservedRoots) {
    if (
      typeof reservedRoot !== "string" ||
      reservedRoot.trim().length === 0 ||
      reservedRoot.includes("\0")
    ) {
      throw new Error("reserved root must be a non-empty filesystem path");
    }
    const resolvedReserved = isAbsolute(reservedRoot)
      ? resolve(reservedRoot)
      : resolve(repo.canonical, reservedRoot);
    if (!reservedRoots.includes(resolvedReserved)) reservedRoots.push(resolvedReserved);
  }

  return {
    repoRoot: repo.canonical,
    allowedRoots: roots.map((root) => root.canonicalPath),
    reservedStateRoot,
    reservedRoots,
    reservedRootIdentities: reservedRoots.flatMap((reservedRoot) => {
      try {
        const stat = lstatSync(reservedRoot, { bigint: true });
        return !stat.isSymbolicLink() && stat.isDirectory() ? [identityOf(stat)] : [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    }),
    roots
  };
}

function candidateForRawPath(context: SafeFsContext, rawPath: string): CandidateTarget {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0 || rawPath.includes("\0")) {
    throw new Error("file path must be a non-empty path without NUL bytes");
  }

  const requestedAbsolute = isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(context.repoRoot, rawPath);

  for (const root of context.roots) {
    let relativePath: string | undefined;
    if (isWithin(root.declaredPath, requestedAbsolute)) {
      relativePath = relative(root.declaredPath, requestedAbsolute);
    } else if (isWithin(root.canonicalPath, requestedAbsolute)) {
      relativePath = relative(root.canonicalPath, requestedAbsolute);
    } else {
      relativePath = relativePathThroughRootIdentity(root, requestedAbsolute);
    }
    if (relativePath === undefined) continue;
    if (relativePath === "") {
      throw new Error(`file target may not be the allowed root itself: ${rawPath}`);
    }

    const targetPath = resolve(root.canonicalPath, relativePath);
    assertTargetOutsideReservedRoots(context, targetPath, rawPath);
    return { root, targetPath, relativePath, requestedPath: rawPath };
  }

  throw new Error(
    `file target is outside allowed roots [${context.allowedRoots.join(", ")}]: ${rawPath}`
  );
}

function relativePathThroughRootIdentity(
  root: SafeAllowedRoot,
  requestedAbsolute: string
): string | undefined {
  let current = dirname(requestedAbsolute);
  while (true) {
    try {
      const stat = lstatSync(current, { bigint: true });
      if (
        !stat.isSymbolicLink() &&
        stat.isDirectory() &&
        identitiesEqual(identityOf(stat), root.identity)
      ) {
        return relative(current, requestedAbsolute);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function portableLeafCollisionKey(name: string): string {
  return name.normalize("NFD").toLowerCase().normalize("NFD");
}

function assertTargetOutsideReservedRoots(
  context: SafeFsContext,
  targetPath: string,
  requestedPath: string,
  directoryChain: readonly DirectoryIdentity[] = []
): void {
  const reservedByPath = context.reservedRoots.some((reservedRoot) =>
    isWithin(reservedRoot, targetPath)
  );
  const reservedByIdentity = directoryChain.some((directory) =>
    context.reservedRootIdentities.some((reserved) =>
      identitiesEqual(directory.identity, reserved)
    )
  );
  if (reservedByPath || reservedByIdentity) {
    throw new Error(`file target is inside reserved Gatefile state storage: ${requestedPath}`);
  }
}

function revalidateDirectory(path: string, expected: FileIdentity, label: string): void {
  const stat = statPathNoFollow(path, label);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is no longer a real directory: ${path}`);
  }
  assertDirectoryHasNoNamespaceWriters(stat, path, label);
  if (!identitiesEqual(identityOf(stat), expected)) {
    throw new Error(`${label} identity changed during path resolution: ${path}`);
  }
}

function walkSafeParent(
  candidate: CandidateTarget
): {
  parentPath: string;
  parentIdentity: FileIdentity;
  targetPath: string;
  directoryChain: DirectoryIdentity[];
} {
  revalidateDirectory(candidate.root.canonicalPath, candidate.root.identity, "allowed root");
  const segments = candidate.relativePath.split(sep).filter((segment) => segment.length > 0);
  const basename = segments.pop();
  if (!basename) throw new Error(`file target must name a file: ${candidate.requestedPath}`);
  if (segments.length + 1 > MAX_SAFE_DIRECTORY_CHAIN_ENTRIES) {
    throw new Error(
      `file target directory chain exceeds ${MAX_SAFE_DIRECTORY_CHAIN_ENTRIES} entries: ${candidate.requestedPath}`
    );
  }

  let parentPath = candidate.root.canonicalPath;
  let parentIdentity = candidate.root.identity;
  const directoryChain: DirectoryIdentity[] = [
    { relativePath: "", identity: candidate.root.identity }
  ];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const next = resolve(parentPath, segment);
    let nextStat;
    try {
      nextStat = lstatSync(next, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(`file target parent does not exist: ${next}`);
    }

    if (nextStat.isSymbolicLink()) {
      throw new Error(`file target ancestor is a symbolic link: ${next}`);
    }
    if (!nextStat.isDirectory()) {
      throw new Error(`file target ancestor is not a directory: ${next}`);
    }
    assertDirectoryHasNoNamespaceWriters(nextStat, next, "file target ancestor");
    revalidateDirectory(parentPath, parentIdentity, "file target parent");
    const canonicalNext = realpathSync(next);
    if (!isWithin(candidate.root.canonicalPath, canonicalNext)) {
      throw new Error(`file target ancestor escaped the allowed root: ${next}`);
    }
    parentPath = canonicalNext;
    parentIdentity = identityOf(nextStat);
    directoryChain.push({
      relativePath: relative(candidate.root.canonicalPath, canonicalNext),
      identity: parentIdentity
    });
  }

  for (const entry of directoryChain) {
    const chainPath = entry.relativePath.length === 0
      ? candidate.root.canonicalPath
      : resolve(candidate.root.canonicalPath, entry.relativePath);
    revalidateDirectory(chainPath, entry.identity, "file target ancestor");
  }
  return {
    parentPath,
    parentIdentity,
    targetPath: resolve(parentPath, basename),
    directoryChain
  };
}

function inspectFinalTarget(targetPath: string, action: FileAction): void {
  let stat;
  try {
    stat = lstatSync(targetPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (action === "create") return;
    throw new Error(`${action} target does not exist: ${targetPath}`);
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`file target is a symbolic link: ${targetPath}`);
  }
  if (action === "create") {
    throw new Error(`create target already exists: ${targetPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${action} target is not a regular file: ${targetPath}`);
  }
}

export function resolveSafeTarget(
  context: SafeFsContext,
  rawPath: string,
  action: FileAction,
  options: ResolveSafeTargetOptions = {}
): ResolvedSafeTarget {
  assertSafeFsSupported();
  if (options.createMissingParents === true && action !== "create") {
    throw new Error("missing parents may only be created for an absent create target");
  }
  if (options.createMissingParents === true || options.allowMissingParents === true) {
    throw new Error("missing target parents are not supported by secure file execution");
  }
  const candidate = candidateForRawPath(context, rawPath);
  const walked = walkSafeParent(candidate);
  assertTargetOutsideReservedRoots(
    context,
    walked.targetPath,
    rawPath,
    walked.directoryChain
  );
  inspectFinalTarget(walked.targetPath, action);
  return {
    allowedRoot: candidate.root.canonicalPath,
    relativePath: relative(candidate.root.canonicalPath, walked.targetPath),
    requestedPath: rawPath,
    targetPath: walked.targetPath,
    parentPath: walked.parentPath,
    basename: basename(walked.targetPath),
    parentIdentity: walked.parentIdentity,
    directoryChain: walked.directoryChain
  };
}

function readExactRegularFile(path: string): ExactRegularFileState {
  const fd = openSync(path, READ_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error(`file target is not a regular file: ${path}`);
    assertRegularFileOwnedAndNotSharedWritable(before, path);
    const content = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error(`file changed while Gatefile was reading it: ${path}`);
    }
    assertRegularFileOwnedAndNotSharedWritable(after, path);
    return {
      kind: "regular",
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      byteLength: content.byteLength,
      mode: Number(after.mode & 0o7777n),
      uid: after.uid.toString(),
      gid: after.gid.toString(),
      identity: identityOf(after)
    };
  } finally {
    closeSync(fd);
  }
}

function assertSameSignedTarget(
  expected: SignedPathMetadata,
  current: ResolvedSafeTarget
): void {
  if (
    expected.allowedRoot !== current.allowedRoot ||
    expected.relativePath !== current.relativePath ||
    expected.requestedPath !== current.requestedPath
  ) {
    throw new Error(`file target binding changed: ${expected.requestedPath}`);
  }
  if (expected.directoryChain.length !== current.directoryChain.length) {
    throw new Error(`file target directory chain changed: ${expected.requestedPath}`);
  }
  for (let index = 0; index < expected.directoryChain.length; index += 1) {
    const expectedDirectory = expected.directoryChain[index];
    const currentDirectory = current.directoryChain[index];
    if (
      expectedDirectory.relativePath !== currentDirectory.relativePath ||
      !identitiesEqual(expectedDirectory.identity, currentDirectory.identity)
    ) {
      throw new Error(`file target directory identity changed: ${expected.requestedPath}`);
    }
  }
}

export function compactFileState(state: ExactFileState): CompactFileState {
  if (state.kind === "absent") return ABSENT_STATE;
  return {
    kind: "regular",
    sha256: state.sha256,
    byteLength: state.byteLength,
    mode: state.mode,
    uid: state.uid,
    gid: state.gid,
    identity: state.identity
  };
}

export function captureExactBeforeState(
  context: SafeFsContext,
  target: ResolvedSafeTarget,
  action: FileAction,
  reviewedBefore?: string | Buffer
): ExactFileState {
  const current = resolveSafeTarget(context, target.requestedPath, action, {
    allowMissingParents: false
  });
  assertSameSignedTarget(target, current);
  if (
    target.parentIdentity !== undefined &&
    current.parentIdentity !== undefined &&
    !identitiesEqual(target.parentIdentity, current.parentIdentity)
  ) {
    throw new Error(`file target parent identity changed: ${target.parentPath}`);
  }
  if (action === "create") return ABSENT_STATE;

  const exact = readExactRegularFile(current.targetPath);
  if (reviewedBefore !== undefined) {
    const reviewed = Buffer.isBuffer(reviewedBefore)
      ? reviewedBefore
      : Buffer.from(reviewedBefore, "utf8");
    if (!exact.content.equals(reviewed)) {
      throw new Error(`${action} target no longer matches reviewed before content`);
    }
  }
  return exact;
}

export function preflightFileOperations(
  context: SafeFsContext,
  operations: readonly FileOperation[]
): PreparedFileOperation[] {
  const candidates = operations.map((operation) => ({
    operation,
    candidate: candidateForRawPath(context, operation.path)
  }));
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex];
      if (left.candidate.targetPath === right.candidate.targetPath) {
        throw new Error(
          `duplicate canonical file target for operations ${left.operation.id} and ${right.operation.id}: ${left.candidate.targetPath}`
        );
      }
      if (
        isWithin(left.candidate.targetPath, right.candidate.targetPath) ||
        isWithin(right.candidate.targetPath, left.candidate.targetPath)
      ) {
        throw new Error(
          `overlapping file targets for operations ${left.operation.id} and ${right.operation.id}`
        );
      }
    }
  }

  const prepared = operations.map((operation) => {
    const target = resolveSafeTarget(context, operation.path, operation.action);
    const beforeState = captureExactBeforeState(
      context,
      target,
      operation.action,
      operation.action === "create" ? undefined : operation.before
    );
    return { operation, target, beforeState };
  });

  for (let leftIndex = 0; leftIndex < prepared.length; leftIndex += 1) {
    const left = prepared[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < prepared.length; rightIndex += 1) {
      const right = prepared[rightIndex];
      const sameExistingIdentity =
        left.beforeState.kind === "regular" &&
        right.beforeState.kind === "regular" &&
        identitiesEqual(left.beforeState.identity, right.beforeState.identity);
      const sameCaselessEntry =
        left.target.parentIdentity !== undefined &&
        right.target.parentIdentity !== undefined &&
        identitiesEqual(left.target.parentIdentity, right.target.parentIdentity) &&
        portableLeafCollisionKey(left.target.basename) ===
          portableLeafCollisionKey(right.target.basename);
      if (
        left.target.targetPath === right.target.targetPath ||
        sameExistingIdentity ||
        sameCaselessEntry
      ) {
        throw new Error(
          `duplicate canonical file target for operations ${left.operation.id} and ${right.operation.id}: ${left.target.targetPath}`
        );
      }
      if (
        isWithin(left.target.targetPath, right.target.targetPath) ||
        isWithin(right.target.targetPath, left.target.targetPath)
      ) {
        throw new Error(
          `overlapping file targets for operations ${left.operation.id} and ${right.operation.id}`
        );
      }
    }
  }

  return prepared;
}

export function captureCompactCurrentState(
  context: SafeFsContext,
  target: SignedPathMetadata
): CompactFileState {
  const candidate = candidateForRawPath(context, target.requestedPath);
  let exists = true;
  try {
    lstatSync(candidate.targetPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }

  if (!exists) {
    const resolved = resolveSafeTarget(context, target.requestedPath, "create");
    assertSameSignedTarget(target, resolved);
    return ABSENT_STATE;
  }

  const resolved = resolveSafeTarget(context, target.requestedPath, "update");
  assertSameSignedTarget(target, resolved);
  return compactFileState(readExactRegularFile(resolved.targetPath));
}

function contentBuffer(content: string | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
}

function compactStatesEqual(left: CompactFileState, right: CompactFileState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "absent" || right.kind === "absent") return true;
  return (
    left.sha256 === right.sha256 &&
    left.byteLength === right.byteLength &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    identitiesEqual(left.identity, right.identity)
  );
}

function exactStatesEqual(left: ExactFileState, right: ExactFileState): boolean {
  if (!compactStatesEqual(compactFileState(left), compactFileState(right))) return false;
  return left.kind === "absent" || (right.kind === "regular" && left.content.equals(right.content));
}

function assertExpectedExactState(
  actual: ExactFileState,
  expected: ExactFileState,
  label: string
): void {
  if (!exactStatesEqual(actual, expected)) {
    throw new Error(`${label} drift: target no longer matches the captured file state`);
  }
}

function assertExpectedCompactState(
  actual: CompactFileState,
  expected: CompactFileState,
  label: string
): void {
  if (!compactStatesEqual(actual, expected)) {
    throw new Error(`${label}: expected current state does not match the filesystem`);
  }
}

function resolveBoundTarget(
  context: SafeFsContext,
  target: SignedPathMetadata,
  action: FileAction,
  options: ResolveSafeTargetOptions = {},
  requireCapturedParent = false
): ResolvedSafeTarget {
  const resolved = resolveSafeTarget(context, target.requestedPath, action, options);
  assertSameSignedTarget(target, resolved);
  const capturedParent = (target as ResolvedSafeTarget).parentIdentity;
  if (requireCapturedParent && capturedParent !== undefined) {
    if (
      resolved.parentIdentity === undefined ||
      !identitiesEqual(capturedParent, resolved.parentIdentity)
    ) {
      throw new Error(`file target parent drift: ${resolved.parentPath}`);
    }
  }
  return resolved;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function verifyCleanupResidue(
  context: SafeFsContext,
  target: SignedPathMetadata,
  currentState: CompactFileState,
  residue: FileCleanupResidue,
  expectedResidueState: CompactFileState = currentState
): boolean {
  const resolved = resolveBoundTarget(
    context,
    target,
    currentState.kind === "absent" ? "create" : "update"
  );
  if (dirname(residue.path) !== resolved.parentPath) {
    throw new Error(`cleanup residue escaped the authenticated target parent: ${residue.path}`);
  }
  const residueNamePattern = new RegExp(
    `^\\.${escapeRegExp(resolved.basename)}\\.gatefile-[a-f0-9]{32}\\.tmp$`
  );
  if (!residueNamePattern.test(basename(residue.path))) {
    throw new Error(`cleanup residue name is not bound to the authenticated target: ${residue.path}`);
  }
  if (
    expectedResidueState.kind !== "regular" ||
    !identitiesEqual(expectedResidueState.identity, residue.identity)
  ) {
    throw new Error("cleanup residue identity is not bound to the expected post-apply file");
  }

  let stat;
  try {
    stat = lstatSync(residue.path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`cleanup residue is not a regular no-follow file: ${residue.path}`);
  }
  if (!identitiesEqual(identityOf(stat), residue.identity)) {
    throw new Error(`cleanup residue identity changed: ${residue.path}`);
  }
  assertRegularFileOwnedAndNotSharedWritable(stat, residue.path);
  if (Number(stat.size) !== expectedResidueState.byteLength) {
    throw new Error(`cleanup residue length changed: ${residue.path}`);
  }
  const fd = openSync(residue.path, READ_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      !identitiesEqual(identityOf(opened), residue.identity) ||
      Number(opened.size) !== expectedResidueState.byteLength ||
      digest(readAllAt(fd, expectedResidueState.byteLength)) !== expectedResidueState.sha256
    ) {
      throw new Error(`cleanup residue bytes or identity changed: ${residue.path}`);
    }
  } finally {
    closeSync(fd);
  }
  return true;
}

export function safeCleanupResidue(
  context: SafeFsContext,
  target: SignedPathMetadata,
  currentState: CompactFileState,
  residue: FileCleanupResidue,
  expectedResidueState: CompactFileState = currentState
): boolean {
  if (!verifyCleanupResidue(context, target, currentState, residue, expectedResidueState)) {
    return false;
  }
  const resolved = resolveBoundTarget(
    context,
    target,
    currentState.kind === "absent" ? "create" : "update"
  );
  const fileFd = openSync(residue.path, READ_NOFOLLOW);
  const parentFd = openVerifiedParent(resolved);
  let failure: unknown | undefined;
  try {
    const stat = fstatSync(fileFd, { bigint: true });
    if (!stat.isFile() || !identitiesEqual(identityOf(stat), residue.identity)) {
      throw new Error(`cleanup residue changed before removal: ${residue.path}`);
    }
    unlinkSync(residue.path);
    fsyncSync(parentFd);
  } catch (error) {
    failure = error;
  }
  for (const [fd, label] of [[fileFd, "cleanup residue"], [parentFd, "target parent"]] as const) {
    try {
      closeSync(fd);
    } catch (error) {
      failure = appendCleanupFailure(failure, error, `closing ${label}`);
    }
  }
  if (failure !== undefined) throw failure;
  return true;
}

function readExpectedRegular(
  context: SafeFsContext,
  target: ResolvedSafeTarget,
  expected: ExactRegularFileState,
  label: string
): { resolved: ResolvedSafeTarget; state: ExactRegularFileState } {
  const resolved = resolveBoundTarget(context, target, "update", {}, true);
  const state = readExactRegularFile(resolved.targetPath);
  assertExpectedExactState(state, expected, label);
  return { resolved, state };
}

function assertRegularState(state: ExactFileState, label: string): ExactRegularFileState {
  if (state.kind !== "regular") {
    throw new Error(`${label} requires a captured regular-file state`);
  }
  return state;
}

interface PreparedTempFile {
  fd: number;
  path: string;
  identity: FileIdentity;
  contentHash: string;
  byteLength: number;
  metadata: DesiredFileMetadata;
  state?: CompactRegularFileState;
  closed: boolean;
}

function writeAll(fd: number, content: Buffer): void {
  let offset = 0;
  while (offset < content.byteLength) {
    const written = writeSync(fd, content, offset, content.byteLength - offset, null);
    if (written <= 0) throw new Error("failed to make progress while writing a temporary file");
    offset += written;
  }
}

function readAllAt(fd: number, byteLength: number): Buffer {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error(`staged file has an unsupported byte length: ${byteLength}`);
  }
  const content = Buffer.allocUnsafe(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const read = readSync(fd, content, offset, byteLength - offset, offset);
    if (read <= 0) throw new Error("staged file ended before its recorded byte length");
    offset += read;
  }
  return content;
}

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function verifyOwnedPath(path: string, expected: FileIdentity, label: string): void {
  const stat = statPathNoFollow(path, label);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} is not the regular file Gatefile created: ${path}`);
  }
  if (!identitiesEqual(identityOf(stat), expected)) {
    throw new Error(`${label} identity changed before commit: ${path}`);
  }
}

function closeTemp(temp: PreparedTempFile): void {
  if (temp.closed) return;
  closeSync(temp.fd);
  temp.closed = true;
}

function cleanupTemp(temp: PreparedTempFile): void {
  try {
    closeTemp(temp);
  } finally {
    try {
      const stat = lstatSync(temp.path, { bigint: true });
      if (!stat.isSymbolicLink() && stat.isFile() && identitiesEqual(identityOf(stat), temp.identity)) {
        unlinkSync(temp.path);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

interface DesiredFileMetadata {
  mode: number;
  uid?: string;
  gid?: string;
}

function ownerIdNumber(value: string, label: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`invalid staged file metadata: ${label} must be a canonical uint32 owner ID`);
  }
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffffn) {
    throw new Error(`invalid staged file metadata: ${label} must be a uint32 owner ID`);
  }
  return Number(parsed);
}

function verifyPrivateStagedFile(temp: PreparedTempFile): void {
  const stat = fstatSync(temp.fd, { bigint: true });
  if (!stat.isFile() || !identitiesEqual(identityOf(stat), temp.identity)) {
    throw new Error("staged file identity changed before publish");
  }
  if (
    modeOf(stat) !== 0o600 ||
    Number(stat.size) !== temp.byteLength
  ) {
    throw new Error("private staged file metadata changed before finalization");
  }
  const stagedContent = readAllAt(temp.fd, temp.byteLength);
  if (digest(stagedContent) !== temp.contentHash) {
    throw new Error("staged file bytes changed before publish");
  }
  verifyOwnedPath(temp.path, temp.identity, "temporary file");
}

function stagedState(temp: PreparedTempFile): CompactRegularFileState {
  if (temp.state === undefined) {
    throw new Error("staged file metadata was not finalized before publish");
  }
  return temp.state;
}

function verifyStagedFile(temp: PreparedTempFile): void {
  const expected = stagedState(temp);
  const stat = fstatSync(temp.fd, { bigint: true });
  if (!stat.isFile() || !identitiesEqual(identityOf(stat), temp.identity)) {
    throw new Error("staged file identity changed before publish");
  }
  if (
    modeOf(stat) !== expected.mode ||
    stat.uid.toString() !== expected.uid ||
    stat.gid.toString() !== expected.gid ||
    Number(stat.size) !== expected.byteLength
  ) {
    throw new Error("staged file metadata changed before publish");
  }
  if (digest(readAllAt(temp.fd, expected.byteLength)) !== expected.sha256) {
    throw new Error("staged file bytes changed before publish");
  }
  verifyOwnedPath(temp.path, temp.identity, "temporary file");
}

function plannedStagedFileState(temp: PreparedTempFile): CompactRegularFileState {
  verifyPrivateStagedFile(temp);
  const privateStat = fstatSync(temp.fd, { bigint: true });
  const desiredUid = temp.metadata.uid ?? privateStat.uid.toString();
  const desiredGid = temp.metadata.gid ?? privateStat.gid.toString();
  ownerIdNumber(desiredUid, "uid");
  ownerIdNumber(desiredGid, "gid");
  return {
    kind: "regular",
    sha256: temp.contentHash,
    byteLength: temp.byteLength,
    mode: temp.metadata.mode,
    uid: desiredUid,
    gid: desiredGid,
    identity: temp.identity
  };
}

function finalizeStagedFile(
  temp: PreparedTempFile,
  planned: CompactRegularFileState
): CompactRegularFileState {
  verifyPrivateStagedFile(temp);
  const privateStat = fstatSync(temp.fd, { bigint: true });
  const desiredUidNumber = ownerIdNumber(planned.uid, "uid");
  const desiredGidNumber = ownerIdNumber(planned.gid, "gid");

  // Ownership first: POSIX chown can clear setuid/setgid. Apply exact mode
  // after ownership, then make metadata durable immediately before publish.
  if (privateStat.uid.toString() !== planned.uid || privateStat.gid.toString() !== planned.gid) {
    fchownSync(temp.fd, desiredUidNumber, desiredGidNumber);
  }
  fchmodSync(temp.fd, planned.mode);
  fsyncSync(temp.fd);
  temp.state = planned;
  verifyStagedFile(temp);
  return temp.state;
}

function prepareTempFile(
  target: ResolvedSafeTarget,
  content: Buffer,
  metadata: DesiredFileMetadata,
  metadataSourcePath?: string
): PreparedTempFile {
  if (target.parentIdentity === undefined) {
    throw new Error(`file target parent was not materialized: ${target.parentPath}`);
  }
  revalidateDirectory(target.parentPath, target.parentIdentity, "file target parent");
  if (!Number.isInteger(metadata.mode) || metadata.mode < 0 || metadata.mode > 0o7777) {
    throw new Error(`invalid staged file metadata: mode ${metadata.mode}`);
  }
  if ((metadata.uid === undefined) !== (metadata.gid === undefined)) {
    throw new Error("invalid staged file metadata: uid and gid must be supplied together");
  }
  if (metadata.uid !== undefined && metadata.gid !== undefined) {
    ownerIdNumber(metadata.uid, "uid");
    ownerIdNumber(metadata.gid, "gid");
  }

  let fd: number | undefined;
  let tempPath = "";
  for (let attempt = 0; attempt < 16; attempt += 1) {
    tempPath = resolve(
      target.parentPath,
      `.${target.basename}.gatefile-${randomBytes(16).toString("hex")}.tmp`
    );
    try {
      fd = openSync(tempPath, CREATE_TEMP_FLAGS, 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (fd === undefined) throw new Error("could not allocate an exclusive temporary file");

  let temp: PreparedTempFile | undefined;
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) throw new Error("temporary path is not a regular file");
    temp = {
      fd,
      path: tempPath,
      identity: identityOf(opened),
      contentHash: digest(content),
      byteLength: content.byteLength,
      metadata,
      closed: false
    };
    revalidateDirectory(target.parentPath, target.parentIdentity, "file target parent");
    verifyOwnedPath(temp.path, temp.identity, "temporary file");

    // Keep named staging files private until their complete bytes are durable.
    fchmodSync(fd, 0o600);
    writeAll(fd, content);
    fsyncSync(fd);
    if (process.platform === "linux" && metadataSourcePath) {
      const copied = spawnSync(
        "/bin/cp",
        [
          "--attributes-only",
          "--preserve=xattr",
          "--no-preserve=mode,ownership,timestamps",
          metadataSourcePath,
          temp.path
        ],
        {
          encoding: "utf8",
          shell: false,
          timeout: 5_000,
          maxBuffer: METADATA_TOOL_MAX_OUTPUT,
          env: { ...process.env, LC_ALL: "C", LANG: "C" }
        }
      );
      if (copied.error || copied.status !== 0) {
        const detail = copied.error?.message ?? copied.stderr.trim() ?? `status ${copied.status}`;
        throw new Error(`Linux extended-attribute preservation failed closed: ${detail}`);
      }
    }
    const privateStat = fstatSync(fd, { bigint: true });
    if (
      !privateStat.isFile() ||
      !identitiesEqual(temp.identity, identityOf(privateStat)) ||
      modeOf(privateStat) !== 0o600 ||
      Number(privateStat.size) !== content.byteLength ||
      digest(readAllAt(fd, content.byteLength)) !== temp.contentHash
    ) {
      throw new Error("private staged bytes did not verify before metadata application");
    }
    revalidateDirectory(target.parentPath, target.parentIdentity, "file target parent");
    verifyPrivateStagedFile(temp);
    return temp;
  } catch (error) {
    if (temp) {
      cleanupTemp(temp);
    } else {
      closeSync(fd);
    }
    throw error;
  }
}

function openVerifiedParent(target: ResolvedSafeTarget): number {
  if (target.parentIdentity === undefined) {
    throw new Error(`file target parent identity is unavailable: ${target.parentPath}`);
  }
  const fd = openSync(target.parentPath, DIRECTORY_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (
      !stat.isDirectory() ||
      !identitiesEqual(identityOf(stat), target.parentIdentity) ||
      (modeOf(stat) & 0o022) !== 0
    ) {
      throw new Error(`file target parent changed before publish: ${target.parentPath}`);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function appendCleanupFailure(
  failure: unknown | undefined,
  cleanupError: unknown,
  label: string
): unknown {
  if (failure === undefined) return cleanupError;
  return new Error(
    `${(failure as Error).message}; ${label}: ${(cleanupError as Error).message}`
  );
}

function atomicReplace(
  context: SafeFsContext,
  target: ResolvedSafeTarget,
  expected: ExactRegularFileState,
  content: Buffer,
  metadata: DesiredFileMetadata,
  label: string,
  beforeCommit?: BeforeFileCommit
): SafeFileMutationResult {
  const first = readExpectedRegular(context, target, expected, label);
  const temp = prepareTempFile(
    first.resolved,
    content,
    metadata,
    first.resolved.targetPath
  );
  let parentFd: number | undefined;
  let committed: SafeFileMutationResult | undefined;
  let failure: unknown | undefined;
  try {
    const second = readExpectedRegular(context, first.resolved, expected, label);
    if (
      second.resolved.parentIdentity === undefined ||
      first.resolved.parentIdentity === undefined ||
      !identitiesEqual(second.resolved.parentIdentity, first.resolved.parentIdentity)
    ) {
      throw new Error(`${label} drift: target parent changed before commit`);
    }
    parentFd = openVerifiedParent(second.resolved);
    const finalState = plannedStagedFileState(temp);
    const intended = {
      afterState: finalState,
      target: second.resolved,
      cleanupResidues: [{ path: temp.path, identity: temp.identity }]
    };
    beforeCommit?.(intended);
    finalizeStagedFile(temp, finalState);
    renameSync(temp.path, second.resolved.targetPath);
    committed = { ...intended, cleanupResidues: [] };
    fsyncSync(parentFd);
  } catch (error) {
    failure = error;
  }
  if (parentFd !== undefined) {
    try {
      closeSync(parentFd);
    } catch (error) {
      failure = appendCleanupFailure(failure, error, "closing target parent");
    }
  }
  try {
    cleanupTemp(temp);
  } catch (error) {
    failure = appendCleanupFailure(failure, error, "cleaning staged file");
  }
  if (failure !== undefined) {
    if (committed) throw new SafeFsPostCommitError(label, committed, failure);
    throw failure;
  }
  if (!committed) throw new Error(`${label} did not reach a committed state`);
  return committed;
}

function atomicCreate(
  context: SafeFsContext,
  target: ResolvedSafeTarget,
  beforeState: ExactFileState,
  content: Buffer,
  metadata: DesiredFileMetadata,
  beforeCommit?: BeforeFileCommit
): SafeFileMutationResult {
  if (beforeState.kind !== "absent") {
    throw new Error("create drift: captured before state was not absent");
  }
  const resolved = resolveBoundTarget(
    context,
    target,
    "create",
    {},
    true
  );
  const temp = prepareTempFile(resolved, content, metadata);
  let parentFd: number | undefined;
  let committed: SafeFileMutationResult | undefined;
  let failure: unknown | undefined;
  try {
    const current = resolveBoundTarget(context, resolved, "create", {}, true);
    parentFd = openVerifiedParent(current);
    const finalState = plannedStagedFileState(temp);
    const intended = {
      afterState: finalState,
      target: current,
      cleanupResidues: [{ path: temp.path, identity: temp.identity }]
    };
    beforeCommit?.(intended);
    finalizeStagedFile(temp, finalState);
    try {
      linkSync(temp.path, current.targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`create drift: target already exists: ${current.targetPath}`);
      }
      throw error;
    }
    committed = intended;
    unlinkSync(temp.path);
    committed = { ...intended, cleanupResidues: [] };
    fsyncSync(parentFd);
  } catch (error) {
    failure = error;
  }
  if (parentFd !== undefined) {
    try {
      closeSync(parentFd);
    } catch (error) {
      failure = appendCleanupFailure(failure, error, "closing target parent");
    }
  }
  try {
    cleanupTemp(temp);
  } catch (error) {
    failure = appendCleanupFailure(failure, error, "cleaning staged file");
  }
  if (failure !== undefined) {
    if (committed) throw new SafeFsPostCommitError("create", committed, failure);
    throw failure;
  }
  if (!committed) throw new Error("create did not reach a committed state");
  return committed;
}

export function safeCreate(
  context: SafeFsContext,
  target: ResolvedSafeTarget,
  beforeState: ExactFileState,
  content: string | Buffer,
  mode = 0o600,
  beforeCommit?: BeforeFileCommit
): SafeFileMutationResult {
  return atomicCreate(context, target, beforeState, contentBuffer(content), { mode }, beforeCommit);
}

export function safeUpdate(
  context: SafeFsContext,
  target: ResolvedSafeTarget,
  beforeState: ExactFileState,
  content: string | Buffer,
  beforeCommit?: BeforeFileCommit
): SafeFileMutationResult {
  const expected = assertRegularState(beforeState, "safe update");
  return atomicReplace(
    context,
    target,
    expected,
    contentBuffer(content),
    { mode: expected.mode, uid: expected.uid, gid: expected.gid },
    "update",
    beforeCommit
  );
}

export function safeDelete(
  context: SafeFsContext,
  target: ResolvedSafeTarget,
  beforeState: ExactFileState,
  beforeCommit?: BeforeFileCommit
): SafeFileMutationResult {
  const expected = assertRegularState(beforeState, "safe delete");
  const first = readExpectedRegular(context, target, expected, "delete");
  const second = readExpectedRegular(context, first.resolved, expected, "delete");
  const parentFd = openVerifiedParent(second.resolved);
  let committed: SafeFileMutationResult | undefined;
  let failure: unknown | undefined;
  try {
    const intended = { afterState: ABSENT_STATE, target: second.resolved, cleanupResidues: [] };
    beforeCommit?.(intended);
    unlinkSync(second.resolved.targetPath);
    committed = intended;
    fsyncSync(parentFd);
  } catch (error) {
    failure = error;
  }
  try {
    closeSync(parentFd);
  } catch (error) {
    failure = appendCleanupFailure(failure, error, "closing target parent");
  }
  if (failure !== undefined) {
    if (committed) throw new SafeFsPostCommitError("delete", committed, failure);
    throw failure;
  }
  if (!committed) throw new Error("delete did not reach a committed state");
  return committed;
}

export function safeRestore(
  context: SafeFsContext,
  target: SignedPathMetadata,
  expectedCurrent: CompactFileState,
  restoreState: ExactFileState
): CompactFileState {
  let resolved: ResolvedSafeTarget;
  let actualExact: ExactFileState;
  try {
    if (expectedCurrent.kind === "absent") {
      resolved = resolveBoundTarget(
        context,
        target,
        "create"
      );
      actualExact = ABSENT_STATE;
    } else {
      resolved = resolveBoundTarget(context, target, "update");
      actualExact = readExactRegularFile(resolved.targetPath);
    }
  } catch (error) {
    throw new Error(
      `rollback drift: expected current state could not be resolved: ${(error as Error).message}`
    );
  }

  assertExpectedCompactState(compactFileState(actualExact), expectedCurrent, "rollback drift");
  if (restoreState.kind === "absent") {
    if (actualExact.kind === "absent") return ABSENT_STATE;
    return safeDelete(context, resolved, actualExact).afterState;
  }
  if (actualExact.kind === "absent") {
    return atomicCreate(context, resolved, ABSENT_STATE, restoreState.content, {
      mode: restoreState.mode,
      uid: restoreState.uid,
      gid: restoreState.gid
    }).afterState;
  }
  return atomicReplace(
    context,
    resolved,
    actualExact,
    restoreState.content,
    { mode: restoreState.mode, uid: restoreState.uid, gid: restoreState.gid },
    "rollback"
  ).afterState;
}

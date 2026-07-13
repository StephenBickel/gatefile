import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import type { BigIntStats } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  win32
} from "node:path";

interface FileIdentity {
  readonly device: string;
  readonly inode: string;
}

const MAX_CONFINED_READ_BYTES = 16 * 1024 * 1024;

export interface ConfinedFileRevision extends FileIdentity {
  readonly size: string;
  readonly mtimeNs: string;
}

export interface ConfinedWriteOptions {
  readonly expectedRevision?: ConfinedFileRevision;
}

interface DirectorySnapshot {
  readonly path: string;
  readonly identity: FileIdentity;
}

interface ResolvedConfinedPath {
  readonly absolutePath: string;
  readonly parentPath: string;
  readonly basename: string;
  readonly directories: readonly DirectorySnapshot[];
  readonly targetRevision?: ConfinedFileRevision;
}

export interface ConfinedReadResult {
  readonly absolutePath: string;
  readonly contents: string;
  readonly revision: ConfinedFileRevision;
}

export class ConfinedPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfinedPathError";
  }
}

function identityOf(stats: { dev: bigint | number; ino: bigint | number }): FileIdentity {
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function identitiesEqual(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function revisionOf(stats: {
  dev: bigint | number;
  ino: bigint | number;
  size: bigint | number;
  mtimeNs: bigint;
}): ConfinedFileRevision {
  return {
    ...identityOf(stats),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString()
  };
}

function revisionsEqual(
  left: ConfinedFileRevision,
  right: ConfinedFileRevision
): boolean {
  return identitiesEqual(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs;
}

function lstatNoFollow(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function assertConfinedRelativePath(requestedPath: string): void {
  if (requestedPath.length === 0 || requestedPath.includes("\0")) {
    throw new ConfinedPathError("Confined path must be a non-empty relative path");
  }
  if (isAbsolute(requestedPath) || win32.isAbsolute(requestedPath)) {
    throw new ConfinedPathError("Absolute paths are not allowed at the MCP boundary");
  }

  const segments = requestedPath.split(/[\\/]/u);
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw new ConfinedPathError("Confined paths may not contain empty, '.' or '..' segments");
  }
}

function snapshotDirectory(path: string): DirectorySnapshot {
  const stats = lstatNoFollow(path);
  if (stats === undefined) {
    throw new ConfinedPathError(`Confined path parent does not exist: ${path}`);
  }
  if (stats.isSymbolicLink()) {
    throw new ConfinedPathError(`Confined path parent is a symbolic link: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new ConfinedPathError(`Confined path parent is not a directory: ${path}`);
  }
  return { path, identity: identityOf(stats) };
}

function assertDirectorySnapshots(directories: readonly DirectorySnapshot[]): void {
  for (const snapshot of directories) {
    const current = snapshotDirectory(snapshot.path);
    if (!identitiesEqual(current.identity, snapshot.identity)) {
      throw new ConfinedPathError(
        `Confined path directory changed during operation: ${snapshot.path}`
      );
    }
  }
}

function resolveConfinedPath(
  repoRoot: string,
  requestedPath: string,
  requireTarget: boolean
): ResolvedConfinedPath {
  assertConfinedRelativePath(requestedPath);
  const segments = requestedPath.split(/[\\/]/u);
  const directories: DirectorySnapshot[] = [snapshotDirectory(repoRoot)];
  let current = repoRoot;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    directories.push(snapshotDirectory(current));
  }

  const absolutePath = join(current, segments[segments.length - 1]);
  const target = lstatNoFollow(absolutePath);
  if (target === undefined) {
    if (requireTarget) {
      throw new ConfinedPathError(`Confined file does not exist: ${requestedPath}`);
    }
  } else {
    if (target.isSymbolicLink()) {
      throw new ConfinedPathError(`Confined file is a symbolic link: ${requestedPath}`);
    }
    if (!target.isFile()) {
      throw new ConfinedPathError(`Confined path is not a regular file: ${requestedPath}`);
    }
    if (target.nlink !== 1n) {
      throw new ConfinedPathError(`Confined file may not have multiple hard links: ${requestedPath}`);
    }
  }

  return {
    absolutePath,
    parentPath: current,
    basename: segments[segments.length - 1],
    directories,
    targetRevision: target === undefined ? undefined : revisionOf(target)
  };
}

function assertStableTarget(target: ResolvedConfinedPath): void {
  const current = lstatNoFollow(target.absolutePath);
  if (target.targetRevision === undefined) {
    if (current !== undefined) {
      throw new ConfinedPathError(
        `Confined file appeared during atomic write: ${target.absolutePath}`
      );
    }
    return;
  }
  if (
    current === undefined ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== 1n ||
    !revisionsEqual(revisionOf(current), target.targetRevision)
  ) {
    throw new ConfinedPathError(
      `Confined file changed during atomic write: ${target.absolutePath}`
    );
  }
}

function assertNoFollowSupported(): void {
  if (
    process.platform === "win32" ||
    typeof constants.O_NOFOLLOW !== "number" ||
    constants.O_NOFOLLOW === 0 ||
    typeof constants.O_DIRECTORY !== "number"
  ) {
    throw new ConfinedPathError(
      "Confined MCP file I/O requires POSIX O_NOFOLLOW and O_DIRECTORY support"
    );
  }
}

export function readConfinedUtf8(repoRoot: string, requestedPath: string): ConfinedReadResult {
  assertNoFollowSupported();
  const target = resolveConfinedPath(repoRoot, requestedPath, true);
  assertDirectorySnapshots(target.directories);
  const descriptor = openSync(
    target.absolutePath,
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      target.targetRevision === undefined ||
      !revisionsEqual(revisionOf(before), target.targetRevision)
    ) {
      throw new ConfinedPathError(
        `Confined file changed before no-follow read: ${requestedPath}`
      );
    }
    if (before.size > BigInt(MAX_CONFINED_READ_BYTES)) {
      throw new ConfinedPathError(
        `Confined file exceeds the ${MAX_CONFINED_READ_BYTES}-byte read limit: ${requestedPath}`
      );
    }
    const contents = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !identitiesEqual(identityOf(before), identityOf(after)) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new ConfinedPathError(`Confined file changed during read: ${requestedPath}`);
    }
    assertDirectorySnapshots(target.directories);
    return {
      absolutePath: target.absolutePath,
      contents,
      revision: revisionOf(after)
    };
  } finally {
    closeSync(descriptor);
  }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
  }
}

function fsyncDirectory(target: ResolvedConfinedPath): void {
  const descriptor = openSync(
    target.parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    const parentSnapshot = target.directories[target.directories.length - 1];
    if (!stats.isDirectory() || !identitiesEqual(identityOf(stats), parentSnapshot.identity)) {
      throw new ConfinedPathError(
        `Confined path parent changed during directory sync: ${target.parentPath}`
      );
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function writeConfinedUtf8Atomic(
  repoRoot: string,
  requestedPath: string,
  contents: string,
  options: ConfinedWriteOptions = {}
): string {
  assertNoFollowSupported();
  const target = resolveConfinedPath(repoRoot, requestedPath, false);
  if (options.expectedRevision === undefined && target.targetRevision !== undefined) {
    throw new ConfinedPathError(
      `Confined create-only destination already exists: ${requestedPath}`
    );
  }
  if (
    options.expectedRevision !== undefined &&
    (target.targetRevision === undefined ||
      !revisionsEqual(target.targetRevision, options.expectedRevision))
  ) {
    throw new ConfinedPathError(
      `Confined file changed since it was read: ${requestedPath}`
    );
  }
  assertDirectorySnapshots(target.directories);
  const temporaryPath = join(
    dirname(target.absolutePath),
    `.${basename(target.absolutePath)}.gatefile-${randomBytes(16).toString("hex")}.tmp`
  );
  let temporaryIdentity: FileIdentity | undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600
    );
    writeAll(descriptor, Buffer.from(contents, "utf8"));
    fsyncSync(descriptor);
    const temporaryStats = fstatSync(descriptor, { bigint: true });
    if (!temporaryStats.isFile() || temporaryStats.nlink !== 1n) {
      throw new ConfinedPathError("Atomic MCP output temporary is not a private regular file");
    }
    temporaryIdentity = identityOf(temporaryStats);
    closeSync(descriptor);
    descriptor = undefined;

    assertDirectorySnapshots(target.directories);
    assertStableTarget(target);
    renameSync(temporaryPath, target.absolutePath);
    const published = lstatNoFollow(target.absolutePath);
    if (
      published === undefined ||
      published.isSymbolicLink() ||
      !published.isFile() ||
      published.nlink !== 1n ||
      !identitiesEqual(identityOf(published), temporaryIdentity)
    ) {
      throw new ConfinedPathError(
        `Atomic MCP output publication could not be verified: ${requestedPath}`
      );
    }
    assertDirectorySnapshots(target.directories);
    fsyncDirectory(target);
    return target.absolutePath;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    const residue = lstatNoFollow(temporaryPath);
    if (
      residue !== undefined &&
      !residue.isSymbolicLink() &&
      residue.isFile() &&
      temporaryIdentity !== undefined &&
      identitiesEqual(identityOf(residue), temporaryIdentity)
    ) {
      unlinkSync(temporaryPath);
    }
  }
}

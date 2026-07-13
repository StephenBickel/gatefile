import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

export const MAX_JSON_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_PRIVATE_KEY_BYTES = 64 * 1024;

export interface ArtifactRevision {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly mode: string;
  readonly parentDevice: string;
  readonly parentInode: string;
}

export interface ArtifactReadOptions {
  readonly label?: string;
  readonly maxBytes?: number;
}

export interface ArtifactReadResult {
  readonly absolutePath: string;
  readonly contents: string;
  readonly revision: ArtifactRevision;
}

export interface JsonArtifactReadResult<T> extends ArtifactReadResult {
  readonly value: T;
}

export interface ArtifactWriteOptions {
  readonly label?: string;
  readonly maxBytes?: number;
  readonly mode?: number;
  readonly expectedRevision?: ArtifactRevision;
}

interface FileIdentity {
  readonly device: string;
  readonly inode: string;
}

interface ResolvedArtifactPath {
  readonly absolutePath: string;
  readonly parentPath: string;
  readonly parentIdentity: FileIdentity;
  readonly directories: readonly DirectorySnapshot[];
}

interface DirectorySnapshot {
  readonly path: string;
  readonly identity: FileIdentity;
}

export class ArtifactPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactPathError";
  }
}

export class ArtifactPostCommitError extends ArtifactPathError {
  readonly committed = true;
  readonly artifactPath: string;
  readonly originalError: unknown;

  constructor(label: string, artifactPath: string, originalError: unknown) {
    const detail = originalError instanceof Error ? originalError.message : String(originalError);
    super(
      `${label} was atomically published, but durability could not be confirmed: ${detail}`
    );
    this.name = "ArtifactPostCommitError";
    this.artifactPath = artifactPath;
    this.originalError = originalError;
  }
}

function identityOf(stats: { dev: bigint | number; ino: bigint | number }): FileIdentity {
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function identitiesEqual(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function snapshotDirectory(path: string, label: string): DirectorySnapshot {
  const current = lstatSync(path, { bigint: true });
  if (current.isSymbolicLink()) {
    throw new ArtifactPathError(`${label} parent contains a symbolic link: ${path}`);
  }
  if (!current.isDirectory()) {
    throw new ArtifactPathError(`${label} parent component is not a directory: ${path}`);
  }
  return { path, identity: identityOf(current) };
}

function snapshotCanonicalPath(parentPath: string, label: string): DirectorySnapshot[] {
  const root = parse(parentPath).root;
  const directories = [snapshotDirectory(root, label)];
  let current = root;
  const suffix = parentPath.slice(root.length);
  for (const segment of suffix.split(sep).filter((entry) => entry.length > 0)) {
    current = join(current, segment);
    directories.push(snapshotDirectory(current, label));
  }
  return directories;
}

/**
 * Return the one canonical target accepted for a platform-managed path alias.
 *
 * This is deliberately path-based rather than ownership-based. A checkout
 * owned by root (for example, inside a container) must not turn arbitrary
 * repository symlinks into trusted aliases.
 */
export function platformAliasTarget(
  pathname: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform !== "darwin") return undefined;
  return new Map<string, string>([
    ["/var", "/private/var"],
    ["/tmp", "/private/tmp"],
    ["/etc", "/private/etc"]
  ]).get(pathname);
}

function trustedPlatformAlias(pathname: string): boolean {
  const expected = platformAliasTarget(pathname);
  return expected !== undefined && realpathSync.native(pathname) === expected;
}

function snapshotParentPath(
  requestedParentPath: string,
  label: string
): { parentPath: string; directories: DirectorySnapshot[] } {
  const root = parse(requestedParentPath).root;
  let current = root;
  let directories = [snapshotDirectory(root, label)];
  const suffix = requestedParentPath.slice(root.length);
  for (const segment of suffix.split(sep).filter((entry) => entry.length > 0)) {
    const candidate = join(current, segment);
    const candidateStats = lstatSync(candidate, { bigint: true });
    if (candidateStats.isSymbolicLink()) {
      if (!trustedPlatformAlias(candidate)) {
        throw new ArtifactPathError(`${label} parent contains a symbolic link: ${candidate}`);
      }
      current = realpathSync.native(candidate);
      directories = snapshotCanonicalPath(current, label);
      continue;
    }
    if (!candidateStats.isDirectory()) {
      throw new ArtifactPathError(
        `${label} parent component is not a directory: ${candidate}`
      );
    }
    current = candidate;
    directories.push({ path: current, identity: identityOf(candidateStats) });
  }
  return { parentPath: current, directories };
}

function resolveArtifactPath(requestedPath: string, label: string): ResolvedArtifactPath {
  if (requestedPath.length === 0 || requestedPath.includes("\0")) {
    throw new ArtifactPathError(`${label} path must be a non-empty path without NUL bytes`);
  }
  const requestedAbsolutePath = resolve(requestedPath);
  const name = basename(requestedAbsolutePath);
  if (name.length === 0) {
    throw new ArtifactPathError(`${label} path must name a file`);
  }

  const resolvedParent = snapshotParentPath(dirname(requestedAbsolutePath), label);
  const { parentPath, directories } = resolvedParent;
  const parentIdentity = directories[directories.length - 1].identity;
  return {
    absolutePath: join(parentPath, name),
    parentPath,
    parentIdentity,
    directories
  };
}

function lstatNoFollow(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function revisionOf(stats: BigIntStats, parent: FileIdentity): ArtifactRevision {
  return {
    ...identityOf(stats),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
    mode: stats.mode.toString(),
    parentDevice: parent.device,
    parentInode: parent.inode
  };
}

function revisionsEqual(left: ArtifactRevision, right: ArtifactRevision): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.parentDevice === right.parentDevice &&
    left.parentInode === right.parentInode;
}

function assertDirectoriesStable(target: ResolvedArtifactPath, label: string): void {
  for (const snapshot of target.directories) {
    const current = snapshotDirectory(snapshot.path, label);
    if (!identitiesEqual(current.identity, snapshot.identity)) {
      throw new ArtifactPathError(
        `${label} parent directory changed during operation: ${snapshot.path}`
      );
    }
  }
}

function assertSafeRegularFile(
  stats: BigIntStats,
  targetPath: string,
  label: string
): void {
  if (stats.isSymbolicLink()) {
    throw new ArtifactPathError(`${label} is a symbolic link: ${targetPath}`);
  }
  if (!stats.isFile()) {
    throw new ArtifactPathError(`${label} is not a regular file: ${targetPath}`);
  }
  if (stats.nlink !== 1n) {
    throw new ArtifactPathError(`${label} may not have multiple hard links: ${targetPath}`);
  }
}

function noFollowFlag(): number {
  return process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0;
}

function maxBytesFrom(options: { maxBytes?: number }, label: string): number {
  const maxBytes = options.maxBytes ?? MAX_JSON_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new ArtifactPathError(`${label} maxBytes must be a positive safe integer`);
  }
  return maxBytes;
}

function readExactFileContents(
  descriptor: number,
  expectedSize: bigint,
  label: string
): string {
  const bytes = Buffer.alloc(Number(expectedSize));
  let offset = 0;
  while (offset < bytes.length) {
    const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (read < 1) {
      throw new ArtifactPathError(`${label} changed while it was being read`);
    }
    offset += read;
  }

  // Probe only one byte beyond the snapshotted size. This detects growth while
  // keeping allocation and I/O bounded even when another process races the read.
  const probe = Buffer.allocUnsafe(1);
  if (readSync(descriptor, probe, 0, 1, offset) !== 0) {
    throw new ArtifactPathError(`${label} changed while it was being read`);
  }
  return bytes.toString("utf8");
}

export function readUtf8Artifact(
  requestedPath: string,
  options: ArtifactReadOptions = {}
): ArtifactReadResult {
  const label = options.label ?? "Artifact";
  const maxBytes = maxBytesFrom(options, label);
  const target = resolveArtifactPath(requestedPath, label);
  const initial = lstatNoFollow(target.absolutePath);
  if (initial === undefined) {
    throw new ArtifactPathError(`${label} does not exist: ${target.absolutePath}`);
  }
  assertSafeRegularFile(initial, target.absolutePath, label);
  if (initial.size > BigInt(maxBytes)) {
    throw new ArtifactPathError(
      `${label} exceeds the ${maxBytes}-byte read limit: ${target.absolutePath}`
    );
  }
  const initialRevision = revisionOf(initial, target.parentIdentity);
  assertDirectoriesStable(target, label);

  const descriptor = openSync(target.absolutePath, constants.O_RDONLY | noFollowFlag());
  try {
    const before = fstatSync(descriptor, { bigint: true });
    assertSafeRegularFile(before, target.absolutePath, label);
    if (!revisionsEqual(revisionOf(before, target.parentIdentity), initialRevision)) {
      throw new ArtifactPathError(`${label} changed before it could be read`);
    }
    if (before.size > BigInt(maxBytes)) {
      throw new ArtifactPathError(
        `${label} exceeds the ${maxBytes}-byte read limit: ${target.absolutePath}`
      );
    }

    const contents = readExactFileContents(descriptor, before.size, label);
    const after = fstatSync(descriptor, { bigint: true });
    const afterRevision = revisionOf(after, target.parentIdentity);
    if (!revisionsEqual(afterRevision, initialRevision)) {
      throw new ArtifactPathError(`${label} changed while it was being read`);
    }
    assertDirectoriesStable(target, label);
    return {
      absolutePath: target.absolutePath,
      contents,
      revision: afterRevision
    };
  } finally {
    closeSync(descriptor);
  }
}

export function readJsonArtifact<T = unknown>(
  requestedPath: string,
  options: ArtifactReadOptions = {}
): JsonArtifactReadResult<T> {
  const read = readUtf8Artifact(requestedPath, options);
  try {
    return { ...read, value: JSON.parse(read.contents) as T };
  } catch (error) {
    const label = options.label ?? "Artifact";
    throw new ArtifactPathError(
      `${label} contains invalid JSON: ${(error as Error).message}`
    );
  }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written < 1) throw new ArtifactPathError("Atomic artifact write made no progress");
    offset += written;
  }
}

function assertExpectedTarget(
  target: ResolvedArtifactPath,
  expectedRevision: ArtifactRevision | undefined,
  label: string
): BigIntStats | undefined {
  const current = lstatNoFollow(target.absolutePath);
  if (expectedRevision === undefined) {
    if (current !== undefined) {
      if (current.isSymbolicLink()) {
        throw new ArtifactPathError(`${label} create-only destination is a symbolic link`);
      }
      throw new ArtifactPathError(`${label} create-only destination already exists`);
    }
    return undefined;
  }
  if (current === undefined) {
    throw new ArtifactPathError(`${label} changed since it was read`);
  }
  if (current.isSymbolicLink()) {
    throw new ArtifactPathError(`${label} changed to a symbolic link since it was read`);
  }
  assertSafeRegularFile(current, target.absolutePath, label);
  if (!revisionsEqual(revisionOf(current, target.parentIdentity), expectedRevision)) {
    throw new ArtifactPathError(`${label} changed since it was read`);
  }
  return current;
}

function fsyncParent(target: ResolvedArtifactPath, label: string): void {
  if (process.platform === "win32" || typeof constants.O_DIRECTORY !== "number") return;
  const descriptor = openSync(
    target.parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | noFollowFlag()
  );
  try {
    const current = fstatSync(descriptor, { bigint: true });
    if (!current.isDirectory() || !identitiesEqual(identityOf(current), target.parentIdentity)) {
      throw new ArtifactPathError(`${label} parent directory changed before sync`);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function writeUtf8ArtifactAtomic(
  requestedPath: string,
  contents: string,
  options: ArtifactWriteOptions = {}
): string {
  const label = options.label ?? "Artifact";
  const maxBytes = maxBytesFrom(options, label);
  const byteLength = Buffer.byteLength(contents, "utf8");
  if (byteLength > maxBytes) {
    throw new ArtifactPathError(`${label} exceeds the ${maxBytes}-byte write limit`);
  }
  const bytes = Buffer.from(contents, "utf8");

  const target = resolveArtifactPath(requestedPath, label);
  assertDirectoriesStable(target, label);
  assertExpectedTarget(target, options.expectedRevision, label);
  fsyncParent(target, label);
  const mode = options.expectedRevision === undefined
    ? (options.mode ?? 0o600)
    : Number(BigInt(options.expectedRevision.mode) & 0o777n);
  const temporaryPath = join(
    target.parentPath,
    `.${basename(target.absolutePath)}.gatefile-${randomBytes(16).toString("hex")}.tmp`
  );

  let descriptor: number | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  let committed = false;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600
    );
    fchmodSync(descriptor, mode);
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
    const temporary = fstatSync(descriptor, { bigint: true });
    if (!temporary.isFile() || temporary.nlink !== 1n) {
      throw new ArtifactPathError(`${label} atomic temporary is not a private regular file`);
    }
    temporaryIdentity = identityOf(temporary);
    closeSync(descriptor);
    descriptor = undefined;

    assertDirectoriesStable(target, label);
    assertExpectedTarget(target, options.expectedRevision, label);
    if (options.expectedRevision === undefined) {
      try {
        linkSync(temporaryPath, target.absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ArtifactPathError(`${label} create-only destination appeared during write`);
        }
        throw error;
      }
      committed = true;
      unlinkSync(temporaryPath);
    } else {
      renameSync(temporaryPath, target.absolutePath);
      committed = true;
    }

    try {
      const published = lstatNoFollow(target.absolutePath);
      if (
        published === undefined ||
        published.isSymbolicLink() ||
        !published.isFile() ||
        published.nlink !== 1n ||
        !identitiesEqual(identityOf(published), temporaryIdentity)
      ) {
        throw new ArtifactPathError(`${label} atomic publication could not be verified`);
      }
      assertDirectoriesStable(target, label);
      fsyncParent(target, label);
      return target.absolutePath;
    } catch (error) {
      throw new ArtifactPostCommitError(label, target.absolutePath, error);
    }
  } catch (error) {
    if (committed && !(error instanceof ArtifactPostCommitError)) {
      throw new ArtifactPostCommitError(label, target.absolutePath, error);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
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
    } catch {
      // Preserve the primary error, especially ArtifactPostCommitError. A
      // best-effort cleanup failure after publication must never erase
      // committed=true or disguise the visible target side effect.
    }
  }
}

export function writeJsonArtifactAtomic(
  requestedPath: string,
  value: unknown,
  options: ArtifactWriteOptions = {}
): string {
  return writeUtf8ArtifactAtomic(
    requestedPath,
    `${JSON.stringify(value, null, 2)}\n`,
    options
  );
}

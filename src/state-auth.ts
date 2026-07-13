import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export const STATE_AUTH_ENVELOPE_VERSION = 1 as const;
export const STATE_AUTH_SCHEME = "hmac-sha256" as const;
export const STATE_AUTH_KEY_BYTES = 32 as const;
export const DEFAULT_MAX_PRIVATE_STATE_FILE_BYTES = 16 * 1024 * 1024;

export type StateEnvelopeKind = "snapshot" | "receipt" | "plan-state" | "rollback-marker";

export interface StateRepositoryBinding {
  repositoryId: string;
  canonicalRepoRoot: string;
  repoInstanceId: string;
}

export interface StateAuthKey {
  keyId: string;
  keyBytes: Buffer;
  keyPath: string;
  stateHome: string;
  repoInstanceId: string;
}

export interface StateAuthTag {
  scheme: typeof STATE_AUTH_SCHEME;
  envelopeVersion: typeof STATE_AUTH_ENVELOPE_VERSION;
  keyId: string;
  tag: string;
}

export interface RollbackMarkerBody {
  type: "gatefile-rollback-marker";
  stateVersion: 1;
  repository: {
    repositoryId: string;
    repoInstanceId: string;
  };
  receiptId: string;
  receiptDigest: string;
  status: "claimed" | "complete";
  claimedAt: string;
  completedAt?: string;
}

export interface AuthenticatedRollbackMarker extends RollbackMarkerBody {
  auth: StateAuthTag;
}

export interface RollbackMarkerResult {
  path: string;
  marker: AuthenticatedRollbackMarker;
}

type JsonObject = Record<string, unknown>;

const SAFE_STATE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;
const STATE_KINDS = new Set<StateEnvelopeKind>([
  "snapshot",
  "receipt",
  "plan-state",
  "rollback-marker"
]);
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const DIRECTORY_FLAG = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
const METADATA_TOOL_MAX_OUTPUT = 64 * 1024;

export class StateAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateAuthenticationError";
  }
}

export class StateAuthenticationPostCommitError extends StateAuthenticationError {
  readonly committedPath: string;
  readonly originalError: unknown;

  constructor(pathname: string, originalError: unknown) {
    super(
      `Authenticated state replacement committed, but directory durability finalization failed for ${pathname}: ${(originalError as Error).message}`
    );
    this.name = "StateAuthenticationPostCommitError";
    this.committedPath = pathname;
    this.originalError = originalError;
  }
}

export function assertAuthenticatedStatePlatformSupported(
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === "win32") {
    throw new StateAuthenticationError(
      "Authenticated Gatefile state requires owner-private POSIX permissions; Windows execution fails closed in this alpha"
    );
  }
}

function isRecord(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new StateAuthenticationError("State canonical JSON cannot contain non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (value === undefined) {
    throw new StateAuthenticationError("State canonical JSON cannot contain undefined values");
  }
  if (typeof value !== "object") {
    throw new StateAuthenticationError(
      `State canonical JSON cannot contain ${typeof value} values`
    );
  }
  if (ancestors.has(value)) {
    throw new StateAuthenticationError("State canonical JSON cannot contain cyclic values");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new StateAuthenticationError("State canonical JSON cannot contain sparse arrays");
        }
        entries.push(canonicalize(value[index], ancestors));
      }
      return `[${entries.join(",")}]`;
    }

    if (!isRecord(value)) {
      throw new StateAuthenticationError("State canonical JSON accepts only plain JSON objects");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new StateAuthenticationError("State canonical JSON cannot contain symbol keys");
    }

    const entries = Object.keys(value)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new StateAuthenticationError("State canonical JSON cannot contain accessor properties");
        }
        return `${JSON.stringify(key)}:${canonicalize(descriptor.value, ancestors)}`;
      });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Deterministic canonical JSON used only by Gatefile's authenticated local state. */
export function canonicalizeStateJson(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

function sha256Bytes(...parts: Array<string | Buffer>): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function sha256Hex(...parts: Array<string | Buffer>): string {
  return sha256Bytes(...parts).toString("hex");
}

function assertNonEmptyNoNul(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new StateAuthenticationError(`${label} must be a non-empty string without NUL bytes`);
  }
}

function assertStateKind(kind: StateEnvelopeKind): void {
  if (!STATE_KINDS.has(kind)) {
    throw new StateAuthenticationError(`Unsupported state envelope kind: ${String(kind)}`);
  }
}

function domainMessage(prefix: string, kind: StateEnvelopeKind, body: unknown): Buffer {
  assertStateKind(kind);
  return Buffer.from(`${prefix}\0${kind}\0${canonicalizeStateJson(body)}`, "utf8");
}

export function createStateRepositoryBinding(
  repoRoot: string,
  repositoryId: string
): StateRepositoryBinding {
  assertNonEmptyNoNul(repoRoot, "Repository root");
  assertNonEmptyNoNul(repositoryId, "Repository ID");
  const canonicalRepoRoot = realpathSync(resolve(repoRoot));
  const rootStat = lstatSync(canonicalRepoRoot, { bigint: true });
  if (!rootStat.isDirectory()) {
    throw new StateAuthenticationError(`Repository root is not a directory: ${canonicalRepoRoot}`);
  }
  const repoInstanceId = sha256Hex(
    "gatefile-repo-instance-v1\0",
    repositoryId,
    "\0",
    canonicalRepoRoot,
    "\0",
    rootStat.dev.toString(),
    "\0",
    rootStat.ino.toString()
  );
  return { repositoryId, canonicalRepoRoot, repoInstanceId };
}

function defaultStateHome(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    const base = localAppData && isAbsolute(localAppData)
      ? localAppData
      : join(homedir(), "AppData", "Local");
    return join(base, "gatefile", "state-auth");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "gatefile", "state-auth");
  }
  const xdgStateHome = env.XDG_STATE_HOME;
  const base = xdgStateHome && isAbsolute(xdgStateHome)
    ? xdgStateHome
    : join(homedir(), ".local", "state");
  return join(base, "gatefile", "state-auth");
}

/** Resolve the external trust-anchor home. Relative operator-controlled paths are rejected. */
export function resolveStateHome(
  stateHome?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (process.platform === "win32") {
    throw new StateAuthenticationError(
      "Authenticated Gatefile state requires POSIX ownership and private-permission enforcement"
    );
  }
  const selected = stateHome ?? env.GATEFILE_STATE_HOME ?? defaultStateHome(env);
  assertNonEmptyNoNul(selected, "State home");
  if (!isAbsolute(selected)) {
    throw new StateAuthenticationError(
      "State home must be an absolute path (including GATEFILE_STATE_HOME)"
    );
  }
  return canonicalizeStateHomePath(resolve(selected));
}

function isTrustedPlatformAlias(pathname: string, stat: Stats): boolean {
  const expected = new Map<string, string>([
    ["/var", "/private/var"],
    ["/tmp", "/private/tmp"],
    ["/etc", "/private/etc"]
  ]).get(pathname);
  return (
    process.platform === "darwin" &&
    stat.uid === 0 &&
    expected !== undefined &&
    realpathSync(pathname) === expected
  );
}

function assertNoPermissiveAncestorAcl(pathname: string): void {
  if (process.platform === "darwin") {
    const output = runStateMetadataInspection(
      "/bin/ls",
      ["-lde", pathname],
      "home ancestor"
    );
    const aclEntries = output
      .split("\n")
      .filter((line) => /^\s*\d+:\s/.test(line));
    if (aclEntries.some((line) => /\ballow\b/i.test(line))) {
      throw new StateAuthenticationError(
        `State home ancestor has a permissive extended ACL: ${pathname}`
      );
    }
    return;
  }
  if (process.platform === "linux") {
    const output = runStateMetadataInspection(
      "/bin/ls",
      ["-ld", "--", pathname],
      "home ancestor"
    );
    const permissions = output.trimStart().split(/\s+/, 1)[0] ?? "";
    if (permissions.endsWith("+")) {
      throw new StateAuthenticationError(
        `State home ancestor has an extended ACL and is not trusted: ${pathname}`
      );
    }
    return;
  }
  throw new StateAuthenticationError(
    `State home ancestor ACL inspection is unsupported on ${process.platform}; authenticated state fails closed`
  );
}

function assertSafeStateHomeAncestor(pathname: string, stat: Stats): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new StateAuthenticationError(`State home ancestor is not a real directory: ${pathname}`);
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (stat.uid !== 0 && (currentUid === undefined || stat.uid !== currentUid)) {
    throw new StateAuthenticationError(
      `State home ancestor is owned by an untrusted user: ${pathname}`
    );
  }
  const sharedWritable = (stat.mode & 0o022) !== 0;
  const stickyDirectory = (stat.mode & 0o1000) !== 0;
  if (sharedWritable && !stickyDirectory) {
    throw new StateAuthenticationError(
      `State home ancestor is group/world-writable without sticky protection: ${pathname}`
    );
  }
  assertNoPermissiveAncestorAcl(pathname);
}

/**
 * Resolve trusted platform aliases in the existing prefix, while rejecting
 * user-controlled symlinks before any managed state directory is created.
 */
function canonicalizeStateHomePath(selected: string): string {
  const parsed = parse(selected);
  const components = selected
    .slice(parsed.root.length)
    .split(sep)
    .filter((component) => component.length > 0);
  let current = realpathSync(parsed.root);
  assertSafeStateHomeAncestor(current, lstatSync(current));

  for (let index = 0; index < components.length; index += 1) {
    const candidate = join(current, components[index]);
    let stat: Stats;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return join(current, ...components.slice(index));
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      if (!isTrustedPlatformAlias(candidate, stat)) {
        throw new StateAuthenticationError(
          `Refusing symbolic-link ancestor in state home: ${candidate}`
        );
      }
      current = realpathSync(candidate);
      assertSafeStateHomeAncestor(current, lstatSync(current));
      continue;
    }
    if (!stat.isDirectory()) {
      throw new StateAuthenticationError(`State home ancestor is not a directory: ${candidate}`);
    }
    assertSafeStateHomeAncestor(candidate, stat);
    current = realpathSync(candidate);
  }
  return current;
}

function assertOwnedPrivateMode(
  pathname: string,
  stat: Stats,
  kind: "file" | "directory"
): void {
  if (process.platform === "win32") return;
  const exposedBits = stat.mode & 0o077;
  if (exposedBits !== 0) {
    throw new StateAuthenticationError(
      `State ${kind} permissions are not private: ${pathname} (mode ${(stat.mode & 0o777).toString(8)})`
    );
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new StateAuthenticationError(`State ${kind} is not owned by the current user: ${pathname}`);
  }
  assertNoExtendedAcl(pathname, kind);
}

function runStateMetadataInspection(
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
    throw new StateAuthenticationError(
      `State ${label} ACL inspection failed closed: ${detail}`
    );
  }
  return result.stdout;
}

function assertNoExtendedAcl(pathname: string, kind: "file" | "directory"): void {
  if (process.platform === "darwin") {
    const output = runStateMetadataInspection("/bin/ls", ["-lde", pathname], kind);
    if (/^\s*\d+:\s/m.test(output)) {
      throw new StateAuthenticationError(
        `State ${kind} has an extended ACL and is not private: ${pathname}`
      );
    }
    return;
  }
  if (process.platform === "linux") {
    const output = runStateMetadataInspection("/bin/ls", ["-ld", "--", pathname], kind);
    const permissions = output.trimStart().split(/\s+/, 1)[0] ?? "";
    if (permissions.endsWith("+")) {
      throw new StateAuthenticationError(
        `State ${kind} has an extended ACL and is not private: ${pathname}`
      );
    }
    return;
  }
  throw new StateAuthenticationError(
    `State ${kind} ACL inspection is unsupported on ${process.platform}; authenticated state fails closed`
  );
}

function inspectPrivateDirectory(pathname: string): void {
  const stat = lstatSync(pathname);
  if (stat.isSymbolicLink()) {
    throw new StateAuthenticationError(`Refusing symbolic-link state directory: ${pathname}`);
  }
  if (!stat.isDirectory()) {
    throw new StateAuthenticationError(`State path is not a directory: ${pathname}`);
  }
  assertOwnedPrivateMode(pathname, stat, "directory");
}

function lstatIfPresent(pathname: string): Stats | undefined {
  try {
    return lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Read-only validation for a deterministic private-state directory. */
export function inspectPrivateStateDirectoryIfPresent(pathname: string): boolean {
  const stat = lstatIfPresent(pathname);
  if (!stat) return false;
  inspectPrivateDirectory(pathname);
  return true;
}

function ensurePrivateDirectory(pathname: string): void {
  if (!existsSync(pathname)) {
    mkdirSync(pathname, { mode: 0o700 });
  }
  inspectPrivateDirectory(pathname);
}

/** Create a canonical state home one component at a time without following links. */
function ensurePrivateStateHome(pathname: string): void {
  const parsed = parse(pathname);
  const components = pathname
    .slice(parsed.root.length)
    .split(sep)
    .filter((component) => component.length > 0);
  let current = realpathSync(parsed.root);
  assertSafeStateHomeAncestor(current, lstatSync(current));

  for (const component of components) {
    current = join(current, component);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new StateAuthenticationError(`Refusing symbolic-link state-home component: ${current}`);
      }
      if (!stat.isDirectory()) {
        throw new StateAuthenticationError(`State-home component is not a directory: ${current}`);
      }
      assertSafeStateHomeAncestor(current, stat);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
      inspectPrivateDirectory(current);
    }
  }
  inspectPrivateDirectory(pathname);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function recoverStalePublicationLinks(pathname: string, stat: Stats): Stats {
  if (stat.nlink === 1) return stat;
  const directory = dirname(pathname);
  const name = basename(pathname);
  const temporaryPattern = new RegExp(
    `^\\.${escapeRegularExpression(name)}\\.[0-9]+\\.[a-f0-9]{24}\\.tmp$`
  );
  const staleTemps: string[] = [];

  for (const entry of readdirSync(directory)) {
    if (!temporaryPattern.test(entry)) continue;
    const candidate = join(directory, entry);
    const candidateStat = lstatSync(candidate);
    if (
      candidateStat.isFile() &&
      !candidateStat.isSymbolicLink() &&
      candidateStat.dev === stat.dev &&
      candidateStat.ino === stat.ino
    ) {
      staleTemps.push(candidate);
    }
  }

  if (staleTemps.length === 0 || stat.nlink !== staleTemps.length + 1) {
    throw new StateAuthenticationError(`State file has an unexpected hard-link count: ${pathname}`);
  }
  for (const temporary of staleTemps) unlinkSync(temporary);
  fsyncDirectory(directory);
  const recovered = lstatSync(pathname);
  if (
    !recovered.isFile() ||
    recovered.isSymbolicLink() ||
    recovered.dev !== stat.dev ||
    recovered.ino !== stat.ino ||
    recovered.nlink !== 1
  ) {
    throw new StateAuthenticationError(`State file hard-link recovery failed: ${pathname}`);
  }
  return recovered;
}

function inspectPrivateRegularFile(pathname: string): Stats {
  let stat = lstatSync(pathname);
  if (stat.isSymbolicLink()) {
    throw new StateAuthenticationError(`Refusing symbolic-link state file: ${pathname}`);
  }
  if (!stat.isFile()) {
    throw new StateAuthenticationError(`State path is not a regular file: ${pathname}`);
  }
  if (stat.nlink !== 1) stat = recoverStalePublicationLinks(pathname, stat);
  assertOwnedPrivateMode(pathname, stat, "file");
  return stat;
}

export function readPrivateStateFile(
  pathname: string,
  maxBytes = DEFAULT_MAX_PRIVATE_STATE_FILE_BYTES
): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new StateAuthenticationError("Private state file size limit must be a positive integer");
  }
  let before: Stats;
  try {
    inspectPrivateDirectory(dirname(pathname));
    before = inspectPrivateRegularFile(pathname);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new StateAuthenticationError(`Missing authenticated state file: ${pathname}`);
    }
    throw error;
  }

  let fd: number | undefined;
  try {
    fd = openSync(pathname, constants.O_RDONLY | NO_FOLLOW);
    const after = fstatSync(fd);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new StateAuthenticationError(`State file changed while opening: ${pathname}`);
    }
    assertOwnedPrivateMode(pathname, after, "file");
    if (after.size > maxBytes) {
      throw new StateAuthenticationError(
        `Private state file exceeds size limit ${maxBytes}: ${pathname} (${after.size} bytes)`
      );
    }
    const bytes = readFileSync(fd);
    if (bytes.length > maxBytes) {
      throw new StateAuthenticationError(
        `Private state file exceeds size limit ${maxBytes}: ${pathname} (${bytes.length} bytes)`
      );
    }
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new StateAuthenticationError(`Refusing symbolic-link state file: ${pathname}`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Remove a validated private state file and persist the directory entry change. */
export function removePrivateStateFile(pathname: string): void {
  inspectPrivateDirectory(dirname(pathname));
  const before = inspectPrivateRegularFile(pathname);
  const current = lstatSync(pathname);
  if (!sameInode(before, current)) {
    throw new StateAuthenticationError(`State file changed before removal: ${pathname}`);
  }
  unlinkSync(pathname);
  try {
    fsyncDirectory(dirname(pathname));
  } catch (error) {
    throw new StateAuthenticationPostCommitError(pathname, error);
  }
}

function readPrivateFileNoFollow(pathname: string): Buffer {
  return readPrivateStateFile(pathname);
}

function fsyncDirectory(pathname: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(pathname, constants.O_RDONLY | DIRECTORY_FLAG);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeTempFile(destination: string, bytes: string | Buffer, mode: number): string {
  const directory = dirname(destination);
  const temporary = join(
    directory,
    `.${basename(destination)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      mode
    );
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    return temporary;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup of an unpublished private temporary file.
    }
    throw error;
  }
}

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unlinkMatchingPublicationPath(pathname: string, reference: Stats): void {
  let stat: Stats;
  try {
    stat = lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || !sameInode(stat, reference)) {
    throw new StateAuthenticationError(
      `Refusing to clean publication path whose inode changed: ${pathname}`
    );
  }
  unlinkSync(pathname);
}

function rollbackExclusivePublication(
  destination: string,
  temporary: string,
  reference: Stats,
  originalError: unknown
): never {
  const cleanupErrors: string[] = [];
  for (const pathname of [destination, temporary]) {
    try {
      unlinkMatchingPublicationPath(pathname, reference);
    } catch (error) {
      cleanupErrors.push(`${pathname}: ${(error as Error).message}`);
    }
  }
  try {
    fsyncDirectory(dirname(destination));
  } catch (error) {
    cleanupErrors.push(`directory fsync: ${(error as Error).message}`);
  }
  if (cleanupErrors.length > 0) {
    throw new StateAuthenticationError(
      `Exclusive state publication failed and could not be rolled back safely: ${(originalError as Error).message}; ${cleanupErrors.join("; ")}`
    );
  }
  throw originalError;
}

function writeExclusiveAtomic(destination: string, bytes: string | Buffer, mode = 0o600): void {
  const temporary = writeTempFile(destination, bytes, mode);
  const temporaryStat = lstatSync(temporary);
  try {
    linkSync(temporary, destination);
  } catch (error) {
    try {
      unlinkSync(temporary);
      fsyncDirectory(dirname(destination));
    } catch (cleanupError) {
      throw new StateAuthenticationError(
        `Exclusive state publication failed and its temporary file could not be cleaned safely: ${(error as Error).message}; ${(cleanupError as Error).message}`
      );
    }
    throw error;
  }

  try {
    fsyncDirectory(dirname(destination));
    unlinkSync(temporary);
    // Persist removal of the second hard-link name. A successful publication
    // always returns with exactly one durable link to the inode.
    fsyncDirectory(dirname(destination));
  } catch (error) {
    rollbackExclusivePublication(destination, temporary, temporaryStat, error);
  }
}

function replaceAtomic(destination: string, bytes: string | Buffer, mode = 0o600): void {
  const temporary = writeTempFile(destination, bytes, mode);
  let committed = false;
  try {
    renameSync(temporary, destination);
    committed = true;
    fsyncDirectory(dirname(destination));
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup of an unpublished private temporary file.
    }
    if (committed) throw new StateAuthenticationPostCommitError(destination, error);
    throw error;
  }
}

function assertAbsoluteStatePath(pathname: string, label: string): string {
  assertNonEmptyNoNul(pathname, label);
  if (!isAbsolute(pathname)) {
    throw new StateAuthenticationError(`${label} must be an absolute path`);
  }
  return resolve(pathname);
}

/**
 * Create a private directory at or below a trusted records root. Every managed
 * component is created one at a time and inspected with lstat before descending.
 */
export function ensurePrivateStateDirectory(recordsRoot: string, targetPath: string): string {
  const root = assertAbsoluteStatePath(recordsRoot, "State records root");
  const target = assertAbsoluteStatePath(targetPath, "Private state directory");
  const targetRelative = relative(root, target);
  if (targetRelative.startsWith(`..${sep}`) || targetRelative === ".." || isAbsolute(targetRelative)) {
    throw new StateAuthenticationError(
      `Private state directory is outside the repository records root: ${target}`
    );
  }

  inspectPrivateDirectory(dirname(root));
  ensurePrivateDirectory(root);
  let current = root;
  if (targetRelative.length > 0) {
    for (const segment of targetRelative.split(sep)) {
      if (segment.length === 0 || segment === "." || segment === "..") {
        throw new StateAuthenticationError("Invalid private state directory segment");
      }
      current = join(current, segment);
      ensurePrivateDirectory(current);
    }
  }
  return target;
}

/** Atomically publish a new private state file without replacing an existing entry. */
export function writeExclusivePrivateStateFile(
  pathname: string,
  bytes: string | Buffer
): void {
  assertPrivateStateWriteSize(bytes);
  const destination = assertAbsoluteStatePath(pathname, "Private state file");
  inspectPrivateDirectory(dirname(destination));
  writeExclusiveAtomic(destination, bytes, 0o600);
}

/** Atomically create or replace a private regular state file. */
export function replacePrivateStateFile(pathname: string, bytes: string | Buffer): void {
  assertPrivateStateWriteSize(bytes);
  const destination = assertAbsoluteStatePath(pathname, "Private state file");
  inspectPrivateDirectory(dirname(destination));
  try {
    inspectPrivateRegularFile(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  replaceAtomic(destination, bytes, 0o600);
}

function assertPrivateStateWriteSize(bytes: string | Buffer): void {
  const byteLength = typeof bytes === "string" ? Buffer.byteLength(bytes, "utf8") : bytes.length;
  if (byteLength > DEFAULT_MAX_PRIVATE_STATE_FILE_BYTES) {
    throw new StateAuthenticationError(
      `Private state write exceeds size limit ${DEFAULT_MAX_PRIVATE_STATE_FILE_BYTES}: ${byteLength} bytes`
    );
  }
}

interface KeyLayout {
  stateHome: string;
  repoDir: string;
  keysDir: string;
  activeKeyPath: string;
  rollbacksDir: string;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function directoryIdentityKey(pathname: string): string {
  const stat = lstatSync(pathname, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new StateAuthenticationError(`Expected a real directory while comparing state paths: ${pathname}`);
  }
  return `${stat.dev.toString()}:${stat.ino.toString()}`;
}

function nearestExistingDirectory(pathname: string): { path: string; exact: boolean } {
  let current = pathname;
  while (true) {
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new StateAuthenticationError(`State-home ancestor is not a real directory: ${current}`);
      }
      return { path: current, exact: current === pathname };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function ancestorChainContains(start: string, expectedIdentity: string): boolean {
  let current = start;
  while (true) {
    if (directoryIdentityKey(current) === expectedIdentity) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function stateHomeOverlapsRepository(
  canonicalRepoRoot: string,
  resolvedHome: string
): boolean {
  const repoIdentity = directoryIdentityKey(canonicalRepoRoot);
  const existingHome = nearestExistingDirectory(resolvedHome);
  if (ancestorChainContains(existingHome.path, repoIdentity)) return true;
  if (!existingHome.exact) return false;
  return ancestorChainContains(canonicalRepoRoot, directoryIdentityKey(existingHome.path));
}

function keyLayout(binding: StateRepositoryBinding, stateHome?: string): KeyLayout {
  if (!SHA256_HEX.test(binding.repoInstanceId)) {
    throw new StateAuthenticationError("Repository instance ID must be a SHA-256 digest");
  }
  const resolvedHome = resolveStateHome(stateHome);
  if (
    pathIsWithin(binding.canonicalRepoRoot, resolvedHome) ||
    pathIsWithin(resolvedHome, binding.canonicalRepoRoot) ||
    stateHomeOverlapsRepository(binding.canonicalRepoRoot, resolvedHome)
  ) {
    throw new StateAuthenticationError(
      `Authenticated state home must be disjoint from and outside the repository: ${resolvedHome}`
    );
  }
  const repoDir = join(resolvedHome, "repos", binding.repoInstanceId);
  return {
    stateHome: resolvedHome,
    repoDir,
    keysDir: join(repoDir, "keys"),
    activeKeyPath: join(repoDir, "active-key.json"),
    rollbacksDir: join(repoDir, "rollbacks")
  };
}

/** Root for authenticated receipts, snapshots, and plan-state records. */
export function stateRecordsRoot(
  binding: StateRepositoryBinding,
  stateHome?: string
): string {
  return join(keyLayout(binding, stateHome).repoDir, "records");
}

function ensureKeyLayout(binding: StateRepositoryBinding, stateHome?: string): KeyLayout {
  const layout = keyLayout(binding, stateHome);
  ensurePrivateStateHome(layout.stateHome);
  const reposDir = join(layout.stateHome, "repos");
  ensurePrivateDirectory(reposDir);
  ensurePrivateDirectory(layout.repoDir);
  ensurePrivateDirectory(layout.keysDir);
  return layout;
}

function inspectExistingKeyLayout(binding: StateRepositoryBinding, stateHome?: string): KeyLayout {
  const layout = keyLayout(binding, stateHome);
  try {
    inspectPrivateDirectory(layout.stateHome);
    inspectPrivateDirectory(join(layout.stateHome, "repos"));
    inspectPrivateDirectory(layout.repoDir);
    inspectPrivateDirectory(layout.keysDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StateAuthenticationError(
        `Missing external Gatefile state-auth key store for repository ${binding.repoInstanceId}`
      );
    }
    throw error;
  }
  return layout;
}

/**
 * Validate every existing key-store component without creating a directory,
 * key, or metadata file. This is used before operator hooks are allowed to run.
 */
export function preflightStateAuthForWrite(
  binding: StateRepositoryBinding,
  stateHome?: string
): void {
  assertAuthenticatedStatePlatformSupported();
  const layout = keyLayout(binding, stateHome);
  const directories = [
    layout.stateHome,
    join(layout.stateHome, "repos"),
    layout.repoDir,
    layout.keysDir
  ];
  for (const directory of directories) {
    if (!inspectPrivateStateDirectoryIfPresent(directory)) return;
  }

  if (!lstatIfPresent(layout.activeKeyPath)) return;
  const activeKeyId = parseActiveKey(readPrivateFileNoFollow(layout.activeKeyPath));
  loadStateAuthKey(binding, activeKeyId, layout.stateHome);
}

function keyPath(layout: KeyLayout, keyId: string): string {
  if (!SHA256_HEX.test(keyId)) {
    throw new StateAuthenticationError("State authentication key ID must be a SHA-256 digest");
  }
  return join(layout.keysDir, `${keyId}.key`);
}

function stateAuthKey(
  binding: StateRepositoryBinding,
  layout: KeyLayout,
  keyId: string,
  bytes: Buffer
): StateAuthKey {
  return {
    keyId,
    keyBytes: Buffer.from(bytes),
    keyPath: keyPath(layout, keyId),
    stateHome: layout.stateHome,
    repoInstanceId: binding.repoInstanceId
  };
}

function parseActiveKey(bytes: Buffer): string {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new StateAuthenticationError(`Invalid active state key metadata: ${(error as Error).message}`);
  }
  if (!isRecord(raw)) {
    throw new StateAuthenticationError("Invalid active state key metadata: expected object");
  }
  const keys = Object.keys(raw).sort();
  if (keys.join(",") !== "keyId,type,version") {
    throw new StateAuthenticationError("Invalid active state key metadata fields");
  }
  if (
    raw.type !== "gatefile-state-active-key" ||
    raw.version !== 1 ||
    typeof raw.keyId !== "string" ||
    !SHA256_HEX.test(raw.keyId)
  ) {
    throw new StateAuthenticationError("Invalid active state key metadata values");
  }
  return raw.keyId;
}

export function loadStateAuthKey(
  binding: StateRepositoryBinding,
  keyId: string,
  stateHome?: string
): StateAuthKey {
  assertAuthenticatedStatePlatformSupported();
  const layout = inspectExistingKeyLayout(binding, stateHome);
  const path = keyPath(layout, keyId);
  const bytes = readPrivateFileNoFollow(path);
  if (bytes.length !== STATE_AUTH_KEY_BYTES) {
    throw new StateAuthenticationError(
      `State authentication key must contain exactly ${STATE_AUTH_KEY_BYTES} bytes: ${path}`
    );
  }
  const computedKeyId = sha256Hex(bytes);
  if (computedKeyId !== keyId) {
    throw new StateAuthenticationError(`State authentication key ID mismatch: ${path}`);
  }
  return stateAuthKey(binding, layout, keyId, bytes);
}

export function getOrCreateStateAuthKey(
  binding: StateRepositoryBinding,
  stateHome?: string
): StateAuthKey {
  assertAuthenticatedStatePlatformSupported();
  const layout = ensureKeyLayout(binding, stateHome);
  if (existsSync(layout.activeKeyPath)) {
    const activeKeyId = parseActiveKey(readPrivateFileNoFollow(layout.activeKeyPath));
    return loadStateAuthKey(binding, activeKeyId, layout.stateHome);
  }

  const bytes = randomBytes(STATE_AUTH_KEY_BYTES);
  const keyId = sha256Hex(bytes);
  const path = keyPath(layout, keyId);
  writeExclusiveAtomic(path, bytes);
  const activeMetadata = `${JSON.stringify(
    { type: "gatefile-state-active-key", version: 1, keyId },
    null,
    2
  )}\n`;
  try {
    writeExclusiveAtomic(layout.activeKeyPath, activeMetadata);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const winner = parseActiveKey(readPrivateFileNoFollow(layout.activeKeyPath));
      return loadStateAuthKey(binding, winner, layout.stateHome);
    }
    throw error;
  }
  return stateAuthKey(binding, layout, keyId, bytes);
}

function assertUsableKey(key: StateAuthKey): void {
  assertAuthenticatedStatePlatformSupported();
  if (!SHA256_HEX.test(key.keyId) || key.keyBytes.length !== STATE_AUTH_KEY_BYTES) {
    throw new StateAuthenticationError("Invalid state authentication key material");
  }
  if (sha256Hex(key.keyBytes) !== key.keyId) {
    throw new StateAuthenticationError("State authentication key ID does not match key material");
  }
}

export function signStateEnvelope(
  kind: StateEnvelopeKind,
  body: unknown,
  key: StateAuthKey
): StateAuthTag {
  assertUsableKey(key);
  const message = domainMessage("gatefile-state-auth-v1", kind, body);
  const tag = createHmac("sha256", key.keyBytes).update(message).digest("base64url");
  return {
    scheme: STATE_AUTH_SCHEME,
    envelopeVersion: STATE_AUTH_ENVELOPE_VERSION,
    keyId: key.keyId,
    tag
  };
}

function assertAuthTag(auth: StateAuthTag): Buffer {
  if (!isRecord(auth)) {
    throw new StateAuthenticationError("Invalid state authentication metadata");
  }
  const fields = Object.keys(auth).sort();
  if (fields.join(",") !== "envelopeVersion,keyId,scheme,tag") {
    throw new StateAuthenticationError("Invalid state authentication metadata fields");
  }
  if (auth.scheme !== STATE_AUTH_SCHEME || auth.envelopeVersion !== STATE_AUTH_ENVELOPE_VERSION) {
    throw new StateAuthenticationError("Unsupported state authentication scheme or envelope version");
  }
  if (typeof auth.keyId !== "string" || !SHA256_HEX.test(auth.keyId)) {
    throw new StateAuthenticationError("Invalid state authentication key ID");
  }
  if (typeof auth.tag !== "string" || !BASE64URL_SHA256.test(auth.tag)) {
    throw new StateAuthenticationError("Invalid state authentication tag encoding");
  }
  const decoded = Buffer.from(auth.tag, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== auth.tag) {
    throw new StateAuthenticationError("Invalid state authentication tag encoding");
  }
  return decoded;
}

/** Verify an authenticated state envelope or throw before its contents are trusted. */
export function verifyStateEnvelope(
  kind: StateEnvelopeKind,
  body: unknown,
  auth: StateAuthTag,
  key: StateAuthKey
): void {
  assertUsableKey(key);
  const supplied = assertAuthTag(auth);
  if (auth.keyId !== key.keyId) {
    throw new StateAuthenticationError("State authentication key ID does not match loaded key");
  }
  const message = domainMessage("gatefile-state-auth-v1", kind, body);
  const expected = createHmac("sha256", key.keyBytes).update(message).digest();
  if (!timingSafeEqual(expected, supplied)) {
    throw new StateAuthenticationError("State HMAC authentication tag does not match");
  }
}

export function computeStateDigest(kind: StateEnvelopeKind, body: unknown): string {
  return sha256Hex(domainMessage("gatefile-state-digest-v1", kind, body));
}

export function assertSafeStateId(value: string): string {
  if (typeof value !== "string" || !SAFE_STATE_ID.test(value)) {
    throw new StateAuthenticationError(
      "Invalid state ID: expected a safe state ID containing 1-128 letters, digits, underscores, or hyphens"
    );
  }
  return value;
}

function assertReceiptDigest(value: string): void {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new StateAuthenticationError("Receipt digest must be a SHA-256 hex digest");
  }
}

function assertKeyForBinding(
  binding: StateRepositoryBinding,
  key: StateAuthKey,
  stateHome?: string
): KeyLayout {
  assertUsableKey(key);
  const layout = keyLayout(binding, stateHome);
  if (key.repoInstanceId !== binding.repoInstanceId) {
    throw new StateAuthenticationError("State authentication key belongs to a different repository");
  }
  if (key.stateHome !== layout.stateHome) {
    throw new StateAuthenticationError("State authentication key belongs to a different state home");
  }
  return layout;
}

function rollbackMarkerFilename(receiptId: string): string {
  assertSafeStateId(receiptId);
  return `${sha256Hex("gatefile-rollback-marker-path-v1\0", receiptId)}.json`;
}

export function rollbackMarkerPath(
  binding: StateRepositoryBinding,
  receiptId: string,
  stateHome?: string
): string {
  const layout = keyLayout(binding, stateHome);
  return join(layout.rollbacksDir, rollbackMarkerFilename(receiptId));
}

function markerBody(
  binding: StateRepositoryBinding,
  receiptId: string,
  receiptDigest: string,
  claimedAt: string,
  status: "claimed" | "complete",
  completedAt?: string
): RollbackMarkerBody {
  return {
    type: "gatefile-rollback-marker",
    stateVersion: 1,
    repository: {
      repositoryId: binding.repositoryId,
      repoInstanceId: binding.repoInstanceId
    },
    receiptId,
    receiptDigest,
    status,
    claimedAt,
    ...(completedAt ? { completedAt } : {})
  };
}

function authenticatedMarker(body: RollbackMarkerBody, key: StateAuthKey): AuthenticatedRollbackMarker {
  return { ...body, auth: signStateEnvelope("rollback-marker", body, key) };
}

function serializeMarker(marker: AuthenticatedRollbackMarker): string {
  return `${JSON.stringify(marker, null, 2)}\n`;
}

function assertExactObjectKeys(value: JsonObject, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new StateAuthenticationError(`Invalid ${label} fields`);
  }
}

function parseRollbackMarker(bytes: Buffer): AuthenticatedRollbackMarker {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new StateAuthenticationError(`Invalid rollback marker JSON: ${(error as Error).message}`);
  }
  if (!isRecord(raw)) throw new StateAuthenticationError("Invalid rollback marker: expected object");
  const expectedFields = [
    "type",
    "stateVersion",
    "repository",
    "receiptId",
    "receiptDigest",
    "status",
    "claimedAt",
    "auth",
    ...(raw.status === "complete" ? ["completedAt"] : [])
  ];
  assertExactObjectKeys(raw, expectedFields, "rollback marker");
  if (raw.type !== "gatefile-rollback-marker" || raw.stateVersion !== 1) {
    throw new StateAuthenticationError("Unsupported rollback marker type or state version");
  }
  if (!isRecord(raw.repository)) {
    throw new StateAuthenticationError("Invalid rollback marker repository binding");
  }
  assertExactObjectKeys(raw.repository, ["repositoryId", "repoInstanceId"], "repository binding");
  if (
    typeof raw.repository.repositoryId !== "string" ||
    typeof raw.repository.repoInstanceId !== "string" ||
    !SHA256_HEX.test(raw.repository.repoInstanceId)
  ) {
    throw new StateAuthenticationError("Invalid rollback marker repository binding");
  }
  if (typeof raw.receiptId !== "string") {
    throw new StateAuthenticationError("Invalid rollback marker receipt ID");
  }
  assertSafeStateId(raw.receiptId);
  if (typeof raw.receiptDigest !== "string") {
    throw new StateAuthenticationError("Invalid rollback marker receipt digest");
  }
  assertReceiptDigest(raw.receiptDigest);
  if (raw.status !== "claimed" && raw.status !== "complete") {
    throw new StateAuthenticationError("Invalid rollback marker status");
  }
  if (typeof raw.claimedAt !== "string" || !Number.isFinite(Date.parse(raw.claimedAt))) {
    throw new StateAuthenticationError("Invalid rollback marker claim timestamp");
  }
  if (
    raw.status === "complete" &&
    (typeof raw.completedAt !== "string" || !Number.isFinite(Date.parse(raw.completedAt)))
  ) {
    throw new StateAuthenticationError("Invalid rollback marker completion timestamp");
  }
  if (!isRecord(raw.auth)) {
    throw new StateAuthenticationError("Invalid rollback marker authentication metadata");
  }
  return raw as unknown as AuthenticatedRollbackMarker;
}

function markerBodyWithoutAuth(marker: AuthenticatedRollbackMarker): RollbackMarkerBody {
  const { auth: _auth, ...body } = marker;
  return body;
}

export function readRollbackMarker(
  binding: StateRepositoryBinding,
  receiptId: string,
  receiptDigest: string,
  key: StateAuthKey,
  stateHome?: string
): RollbackMarkerResult {
  assertSafeStateId(receiptId);
  assertReceiptDigest(receiptDigest);
  const layout = assertKeyForBinding(binding, key, stateHome);
  inspectPrivateDirectory(layout.rollbacksDir);
  const path = join(layout.rollbacksDir, rollbackMarkerFilename(receiptId));
  const marker = parseRollbackMarker(readPrivateFileNoFollow(path));
  verifyStateEnvelope("rollback-marker", markerBodyWithoutAuth(marker), marker.auth, key);
  if (
    marker.repository.repositoryId !== binding.repositoryId ||
    marker.repository.repoInstanceId !== binding.repoInstanceId ||
    marker.receiptId !== receiptId ||
    marker.receiptDigest !== receiptDigest
  ) {
    throw new StateAuthenticationError(
      "Rollback marker does not match repository or receipt binding"
    );
  }
  return { path, marker };
}

export function claimRollbackMarker(
  binding: StateRepositoryBinding,
  receiptId: string,
  receiptDigest: string,
  key: StateAuthKey,
  stateHome?: string
): RollbackMarkerResult {
  assertSafeStateId(receiptId);
  assertReceiptDigest(receiptDigest);
  const layout = assertKeyForBinding(binding, key, stateHome);
  ensurePrivateDirectory(layout.rollbacksDir);
  const path = join(layout.rollbacksDir, rollbackMarkerFilename(receiptId));
  const body = markerBody(
    binding,
    receiptId,
    receiptDigest,
    new Date().toISOString(),
    "claimed"
  );
  const marker = authenticatedMarker(body, key);
  try {
    writeExclusiveAtomic(path, serializeMarker(marker));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new StateAuthenticationError(
        `Rollback receipt ${receiptId} is already claimed; replay refused`
      );
    }
    throw error;
  }
  return { path, marker };
}

export function completeRollbackMarker(
  binding: StateRepositoryBinding,
  receiptId: string,
  receiptDigest: string,
  key: StateAuthKey,
  stateHome?: string
): RollbackMarkerResult {
  assertSafeStateId(receiptId);
  assertReceiptDigest(receiptDigest);
  const layout = assertKeyForBinding(binding, key, stateHome);
  const loaded = readRollbackMarker(binding, receiptId, receiptDigest, key, stateHome);
  const path = loaded.path;
  const existing = loaded.marker;
  if (existing.status !== "claimed") {
    throw new StateAuthenticationError(`Rollback marker is already complete for receipt ${receiptId}`);
  }

  const completedBody = markerBody(
    binding,
    receiptId,
    receiptDigest,
    existing.claimedAt,
    "complete",
    new Date().toISOString()
  );
  const marker = authenticatedMarker(completedBody, key);
  replaceAtomic(path, serializeMarker(marker));
  return { path, marker };
}

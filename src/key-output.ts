import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const DIRECTORY_FLAG = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
const EXCLUSIVE_WRITE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;

function canonicalOutputPath(inputPath: string): string {
  const absolute = resolve(inputPath);
  const parent = realpathSync(dirname(absolute));
  return join(parent, basename(absolute));
}

function existingEntry(path: string): Stats | undefined {
  return lstatSync(path, { throwIfNoEntry: false });
}

function assertReplaceable(path: string, label: string, force: boolean): Stats | undefined {
  const entry = existingEntry(path);
  if (!entry) return undefined;
  if (!force) {
    throw new Error(`Refusing to overwrite existing ${label} without --force: ${path}`);
  }
  if (entry.isSymbolicLink()) {
    throw new Error(`Refusing to follow or replace symbolic-link ${label}: ${path}`);
  }
  if (!entry.isFile()) {
    throw new Error(`Refusing to replace non-file ${label}: ${path}`);
  }
  return entry;
}

function sameEntry(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unlinkIfSame(path: string, expected: Stats): void {
  try {
    const current = existingEntry(path);
    if (current && sameEntry(current, expected)) unlinkSync(path);
  } catch {
    // Preserve the original write failure.
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | DIRECTORY_FLAG);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeExclusive(path: string, contents: string, mode: number): void {
  const fd = openSync(path, EXCLUSIVE_WRITE_FLAGS, mode);
  const opened = fstatSync(fd);
  let failure: unknown;
  try {
    if (!opened.isFile()) throw new Error(`Output is not a regular file: ${path}`);
    fchmodSync(fd, mode);
    writeFileSync(fd, contents, { encoding: "utf8" });
    fsyncSync(fd);
  } catch (error) {
    failure = error;
  } finally {
    closeSync(fd);
  }

  if (failure !== undefined) {
    unlinkIfSame(path, opened);
    fsyncDirectory(dirname(path));
    throw failure;
  }
  fsyncDirectory(dirname(path));
}

/** Resolve and validate a key destination before any member of a key pair is written. */
export function prepareKeyOutputPath(
  inputPath: string,
  label: string,
  force: boolean
): string {
  const path = canonicalOutputPath(inputPath);
  assertReplaceable(path, label, force);
  return path;
}

/** Reject two key outputs that resolve to one directory entry, including absent case aliases. */
export function assertDistinctKeyOutputPaths(
  preparedPrivatePath: string,
  preparedPublicPath: string
): void {
  const privatePath = canonicalOutputPath(preparedPrivatePath);
  const publicPath = canonicalOutputPath(preparedPublicPath);
  if (privatePath === publicPath) {
    throw new Error("Private and public key outputs must use different paths");
  }

  const privateEntry = existingEntry(privatePath);
  const publicEntry = existingEntry(publicPath);
  if (privateEntry && publicEntry) {
    if (sameEntry(privateEntry, publicEntry)) {
      throw new Error("Private and public key outputs resolve to the same filesystem entry");
    }
    return;
  }
  if (privateEntry || publicEntry) return;

  const privateParent = lstatSync(dirname(privatePath));
  const publicParent = lstatSync(dirname(publicPath));
  if (!sameEntry(privateParent, publicParent)) return;

  writeExclusive(privatePath, "", 0o600);
  const reservation = existingEntry(privatePath);
  if (!reservation) {
    throw new Error(`Private key output reservation disappeared: ${privatePath}`);
  }

  let aliasesReservation = false;
  try {
    const publicAfterReservation = existingEntry(publicPath);
    aliasesReservation = Boolean(
      publicAfterReservation && sameEntry(reservation, publicAfterReservation)
    );
  } finally {
    const current = existingEntry(privatePath);
    if (!current || !sameEntry(reservation, current)) {
      throw new Error(`Private key output reservation changed unexpectedly: ${privatePath}`);
    }
    unlinkSync(privatePath);
    fsyncDirectory(dirname(privatePath));
  }

  if (aliasesReservation) {
    throw new Error("Private and public key outputs alias the same filesystem entry");
  }
}

/** Write a key file without following the final path and with an exact POSIX mode. */
export function writeKeyOutputFile(
  preparedPath: string,
  contents: string,
  mode: number,
  label: string,
  force: boolean
): void {
  const path = canonicalOutputPath(preparedPath);
  const replaced = assertReplaceable(path, label, force);
  if (!replaced) {
    writeExclusive(path, contents, mode);
    return;
  }

  const tempPath = join(
    dirname(path),
    `.${basename(path)}.gatefile-${process.pid}-${randomBytes(8).toString("hex")}.tmp`
  );
  let tempExists = false;
  try {
    writeExclusive(tempPath, contents, mode);
    tempExists = true;
    const current = existingEntry(path);
    if (!current || !sameEntry(replaced, current)) {
      throw new Error(`${label} changed while it was being replaced: ${path}`);
    }
    renameSync(tempPath, path);
    tempExists = false;
    fsyncDirectory(dirname(path));
  } finally {
    if (tempExists) {
      try {
        unlinkSync(tempPath);
        fsyncDirectory(dirname(tempPath));
      } catch {
        // Preserve the replacement error.
      }
    }
  }
}

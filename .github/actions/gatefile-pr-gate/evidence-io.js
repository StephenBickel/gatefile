'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NO_FOLLOW = typeof fs.constants.O_NOFOLLOW === 'number'
  ? fs.constants.O_NOFOLLOW
  : 0;

function assertPlainRelativePath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\n') ||
    value.includes('\r') ||
    path.isAbsolute(value)
  ) {
    throw new Error(`${label} must be a non-empty repository-relative path`);
  }
  const components = value.split(/[\\/]/u);
  if (components.some((component) => component === '' || component === '.' || component === '..')) {
    throw new Error(`${label} must not contain empty, dot, or parent path components`);
  }
  if (components.some((component) => component.toLowerCase() === '.git')) {
    throw new Error(`${label} must not address Git metadata`);
  }
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolveRepoFile(repoRoot, relativePath, label) {
  assertPlainRelativePath(relativePath, label);
  const canonicalRoot = fs.realpathSync(repoRoot);
  const components = relativePath.split(/[\\/]/u);
  let parent = canonicalRoot;
  for (const component of components.slice(0, -1)) {
    parent = path.join(parent, component);
    const parentStat = fs.lstatSync(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new Error(`${label} parent must be a real directory without symlink components`);
    }
  }
  const target = path.join(parent, components[components.length - 1]);
  if (target === canonicalRoot || !isWithin(canonicalRoot, target)) {
    throw new Error(`${label} escapes the repository root`);
  }
  return { canonicalRoot, target };
}

function readRegularFile(filename, label, maximumBytes = 32 * 1024 * 1024) {
  let descriptor;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | NO_FOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`${label} must be a single-link regular file`);
    }
    if (stat.size > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte Action limit`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readJsonFile(filename, label, maximumBytes) {
  const bytes = readRegularFile(filename, label, maximumBytes);
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function writeRepoJson(repoRoot, relativePath, value, label) {
  const { canonicalRoot, target } = resolveRepoFile(repoRoot, relativePath, label);
  const parent = path.dirname(target);
  const canonicalParent = fs.realpathSync(parent);
  if (!isWithin(canonicalRoot, canonicalParent)) {
    throw new Error(`${label} parent resolves outside the repository root`);
  }

  let existing;
  try {
    existing = fs.lstatSync(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing) {
    throw new Error(`${label} destination already exists; evidence outputs are create-only`);
  }
  const parentStat = fs.lstatSync(canonicalParent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(`${label} parent must remain a non-symlink directory`);
  }
  const parentIdentity = { dev: parentStat.dev, ino: parentStat.ino };

  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const temporary = path.join(
    canonicalParent,
    `.${path.basename(target)}.gatefile-${process.pid}-${crypto.randomBytes(12).toString('hex')}`
  );
  let descriptor;
  let temporaryIdentity;
  let published = false;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600
    );
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    const temporaryStat = fs.fstatSync(descriptor);
    if (!temporaryStat.isFile() || temporaryStat.nlink !== 1) {
      throw new Error(`${label} temporary output is not a private regular file`);
    }
    temporaryIdentity = { dev: temporaryStat.dev, ino: temporaryStat.ino };
    fs.closeSync(descriptor);
    descriptor = undefined;
    const currentParentStat = fs.lstatSync(canonicalParent);
    if (
      currentParentStat.isSymbolicLink() ||
      !currentParentStat.isDirectory() ||
      currentParentStat.dev !== parentIdentity.dev ||
      currentParentStat.ino !== parentIdentity.ino
    ) {
      throw new Error(`${label} parent changed before create-only publication`);
    }
    fs.linkSync(temporary, target);
    published = true;
    fs.unlinkSync(temporary);
    const targetStat = fs.lstatSync(target);
    if (
      targetStat.isSymbolicLink() ||
      !targetStat.isFile() ||
      targetStat.nlink !== 1 ||
      targetStat.dev !== temporaryIdentity.dev ||
      targetStat.ino !== temporaryIdentity.ino
    ) {
      throw new Error(`${label} create-only publication could not be verified`);
    }
    const finalParentStat = fs.lstatSync(canonicalParent);
    if (
      finalParentStat.isSymbolicLink() ||
      !finalParentStat.isDirectory() ||
      finalParentStat.dev !== parentIdentity.dev ||
      finalParentStat.ino !== parentIdentity.ino
    ) {
      throw new Error(`${label} parent changed during create-only publication`);
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        error.message += `; temporary-file cleanup failed: ${cleanupError.message}`;
      }
    }
    if (published && temporaryIdentity) {
      try {
        const targetStat = fs.lstatSync(target);
        if (
          !targetStat.isSymbolicLink() &&
          targetStat.isFile() &&
          targetStat.dev === temporaryIdentity.dev &&
          targetStat.ino === temporaryIdentity.ino
        ) {
          fs.unlinkSync(target);
        }
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          error.message += `; published-file cleanup failed: ${cleanupError.message}`;
        }
      }
    }
    throw error;
  }
  return { bytes, target };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function parseNamedArguments(argv, allowed, required) {
  const result = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name)) throw new Error(`Unknown argument: ${String(name)}`);
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for argument: ${name}`);
    }
    if (Object.prototype.hasOwnProperty.call(result, name)) {
      throw new Error(`Duplicate argument: ${name}`);
    }
    result[name] = value;
  }
  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(result, name)) {
      throw new Error(`Missing required argument: ${name}`);
    }
  }
  return result;
}

module.exports = {
  parseNamedArguments,
  readJsonFile,
  readRegularFile,
  resolveRepoFile,
  sha256,
  writeRepoJson
};

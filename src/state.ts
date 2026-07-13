import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import {
  ApplyReceipt,
  DependencyStatus,
  PlanFile,
  RollbackFileResult,
  RollbackReport,
  SnapshotFile
} from "./types";
import {
  assertSafeStateId,
  claimRollbackMarker,
  completeRollbackMarker,
  createStateRepositoryBinding,
  ensurePrivateStateDirectory,
  getOrCreateStateAuthKey,
  inspectPrivateStateDirectoryIfPresent,
  loadStateAuthKey,
  preflightStateAuthForWrite,
  readPrivateStateFile,
  readRollbackMarker,
  removePrivateStateFile,
  replacePrivateStateFile,
  resolveStateHome,
  rollbackMarkerPath,
  StateAuthenticationPostCommitError,
  stateRecordsRoot,
  writeExclusivePrivateStateFile
} from "./state-auth";
import type { StateAuthKey, StateRepositoryBinding } from "./state-auth";
import {
  assertPlanStateReceiptLink,
  assertReceiptSnapshotLink,
  computeReceiptRecordDigest,
  computeSnapshotRecordDigest,
  createPlanStateRecord,
  createReceiptRecord,
  createSnapshotRecord,
  decodeStoredExactFileState,
  extractUntrustedStateRecordHeader,
  parseAndVerifyPlanStateRecord,
  parseAndVerifyReceiptRecord,
  parseAndVerifySnapshotRecord
} from "./state-records";
import type {
  AuthenticatedPlanStateRecord,
  AuthenticatedReceiptRecord,
  AuthenticatedSnapshotRecord,
  PlanStateRecordBody,
  ReceiptRecordBody,
  SnapshotRecordBody,
  StateRecordRepository,
  StoredCompactFileState
} from "./state-records";
import {
  captureCompactCurrentState,
  compactFileState,
  createSafeFsContext,
  safeCleanupResidue,
  SafeFsPostCommitError,
  safeRestore,
  verifyCleanupResidue
} from "./safe-fs";
import type {
  CompactFileState,
  SafeFsContext,
  SignedPathMetadata
} from "./safe-fs";
import { sanitizedGitEnvironment } from "./git-environment";
import { isRuntimeRepoRootPinned } from "./pinned-runtime";

export interface StateRuntimeOptions {
  repoRoot?: string;
  repositoryId?: string;
  stateHome?: string;
}

type StateRuntimeInput = StateRuntimeOptions | string | undefined;

export interface StateLayout {
  repoRoot: string;
  stateHome: string;
  repository: StateRecordRepository;
  binding: StateRepositoryBinding;
  recordsRoot: string;
  receiptsDir: string;
  snapshotsDir: string;
  plansDir: string;
}

export interface PersistedSnapshot {
  record: AuthenticatedSnapshotRecord;
  path: string;
  digest: string;
}

export interface PersistedReceipt {
  record: AuthenticatedReceiptRecord;
  path: string;
  digest: string;
  planStateUpdated: boolean;
  warning?: string;
}

interface LoadedReceiptChain {
  layout: StateLayout;
  receipt: AuthenticatedReceiptRecord;
  receiptKey: StateAuthKey;
  receiptDigest: string;
  snapshot: AuthenticatedSnapshotRecord;
}

function normalizeStateOptions(input: StateRuntimeInput): StateRuntimeOptions {
  if (typeof input === "string") return { repoRoot: input };
  return input ?? {};
}

export function getRepoRoot(repoRoot?: string): string {
  const requestedRoot = resolve(repoRoot ?? process.cwd());
  return stateRepositoryRoot(requestedRoot);
}

/** Preserve an already-selected repository root without rediscovering Git topology. */
export function getPinnedRepoRoot(repoRoot: string): string {
  return realpathSync(resolve(repoRoot));
}

function runtimeRepoRoot(options: StateRuntimeOptions): string {
  if (isRuntimeRepoRootPinned(options)) {
    if (options.repoRoot === undefined) {
      throw new Error("A canonical repository root must be provided explicitly");
    }
    return getPinnedRepoRoot(options.repoRoot);
  }
  return getRepoRoot(options.repoRoot);
}

function gitOutput(repoRoot: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    env: sanitizedGitEnvironment(),
    shell: false,
    timeout: 5_000
  });
  if (result.error || result.status !== 0) return undefined;
  const output = result.stdout.trim();
  return output.length > 0 ? output : undefined;
}

function normalizedRemoteIdentity(remote: string): string {
  const trimmed = remote.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
  if (scp && !trimmed.includes("://")) {
    return `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+/, "")}`;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol === "file:") return `file:${url.pathname.replace(/\/+$/, "")}`;
    const port = url.port ? `:${url.port}` : "";
    return `${url.hostname.toLowerCase()}${port}/${url.pathname.replace(/^\/+|\/+$/g, "")}`;
  } catch {
    return trimmed;
  }
}

/** Stable, non-secret identity for binding a plan to its intended repository. */
export function repositoryIdForRoot(repoRoot?: string): string {
  const requestedRoot = getRepoRoot(repoRoot);
  return repositoryIdForCanonicalRoot(requestedRoot);
}

/** Derive identity from an already-selected root without rediscovering Git topology. */
export function repositoryIdForPinnedRoot(repoRoot: string): string {
  return repositoryIdForCanonicalRoot(getPinnedRepoRoot(repoRoot));
}

function repositoryIdForCanonicalRoot(requestedRoot: string): string {
  const remote = gitOutput(requestedRoot, ["config", "--get", "remote.origin.url"]);
  return remote
    ? `git:${normalizedRemoteIdentity(remote)}`
    : `file:${requestedRoot}`;
}

function stateRepositoryRoot(requestedRoot: string): string {
  const gitRoot = gitOutput(requestedRoot, ["rev-parse", "--show-toplevel"]);
  return gitRoot ? realpathSync(gitRoot) : realpathSync(requestedRoot);
}

function recordRepository(binding: StateRepositoryBinding): StateRecordRepository {
  return {
    repositoryId: binding.repositoryId,
    repoInstanceId: binding.repoInstanceId
  };
}

export function getStateLayout(input: StateRuntimeInput = {}): StateLayout {
  const options = normalizeStateOptions(input);
  const requestedRoot = runtimeRepoRoot(options);
  const repositoryId = options.repositoryId ?? repositoryIdForCanonicalRoot(requestedRoot);
  const binding = createStateRepositoryBinding(requestedRoot, repositoryId);
  const stateHome = resolveStateHome(options.stateHome);
  const recordsRoot = stateRecordsRoot(binding, stateHome);
  return {
    repoRoot: binding.canonicalRepoRoot,
    stateHome,
    repository: recordRepository(binding),
    binding,
    recordsRoot,
    receiptsDir: join(recordsRoot, "receipts"),
    snapshotsDir: join(recordsRoot, "snapshots"),
    plansDir: join(recordsRoot, "plans")
  };
}

function ensureWritableState(input: StateRuntimeInput): { layout: StateLayout; key: StateAuthKey } {
  const options = normalizeStateOptions(input);
  const layout = getStateLayout(options);
  const key = getOrCreateStateAuthKey(layout.binding, options.stateHome);
  ensurePrivateStateDirectory(layout.recordsRoot, layout.recordsRoot);
  ensurePrivateStateDirectory(layout.recordsRoot, layout.receiptsDir);
  ensurePrivateStateDirectory(layout.recordsRoot, layout.snapshotsDir);
  ensurePrivateStateDirectory(layout.recordsRoot, layout.plansDir);
  return { layout, key };
}

export function ensureStateLayout(input: StateRuntimeInput = {}): StateLayout {
  return ensureWritableState(input).layout;
}

function safeTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

export function makeReceiptId(_planId: string, appliedAt: string): string {
  return assertSafeStateId(
    `apply_${safeTimestamp(appliedAt)}_${randomBytes(12).toString("base64url")}`
  );
}

function planStateFilename(planId: string): string {
  return `${createHash("sha256")
    .update("gatefile-plan-state-path-v1\0", "utf8")
    .update(planId, "utf8")
    .digest("hex")}.json`;
}

export function snapshotPath(input: StateRuntimeInput, snapshotId: string): string {
  return join(getStateLayout(input).snapshotsDir, `${assertSafeStateId(snapshotId)}.json`);
}

export function receiptPath(input: StateRuntimeInput, receiptId: string): string {
  return join(getStateLayout(input).receiptsDir, `${assertSafeStateId(receiptId)}.json`);
}

function planStatePath(input: StateRuntimeInput, planId: string): string {
  return join(getStateLayout(input).plansDir, planStateFilename(planId));
}

function planStatePendingFilename(planId: string): string {
  return planStateFilename(planId).replace(/\.json$/, ".pending");
}

function planStatePendingPath(layout: StateLayout, planId: string): string {
  return join(layout.plansDir, planStatePendingFilename(planId));
}

function clearMatchingPlanStatePendingMarker(
  layout: StateLayout,
  planId: string,
  receiptId: string,
  receiptDigest: string
): boolean {
  const path = planStatePendingPath(layout, planId);
  if (!stateDestinationExistsNoFollow(path)) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(readPrivateStateFile(path).toString("utf8"));
  } catch (error) {
    throw new Error(
      `Dependency-state invalidation marker is invalid and was not removed: ${(error as Error).message}`
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Dependency-state invalidation marker is invalid and was not removed");
  }
  const record = raw as Record<string, unknown>;
  const fields = Object.keys(record).sort().join(",");
  if (
    fields !== "planId,receiptDigest,receiptId,type,version" ||
    record.type !== "gatefile-plan-state-pending" ||
    record.version !== 1 ||
    record.planId !== planId ||
    record.receiptId !== receiptId ||
    typeof record.receiptDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.receiptDigest)
  ) {
    throw new Error(
      "Dependency-state invalidation marker does not match the authenticated rollback receipt"
    );
  }
  if (
    record.receiptDigest !== receiptDigest &&
    stateDestinationExistsNoFollow(join(layout.plansDir, planStateFilename(planId)))
  ) {
    throw new Error(
      "Dependency-state invalidation marker digest differs from the durable receipt and an older plan-state cache still exists"
    );
  }
  removePrivateStateFile(path);
  return true;
}

function serializeRecord(record: unknown): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function writeSnapshot(
  input: StateRuntimeInput,
  body: SnapshotRecordBody
): PersistedSnapshot {
  const { layout, key } = ensureWritableState(input);
  const record = createSnapshotRecord(body, key);
  const path = join(layout.snapshotsDir, `${record.id}.json`);
  writeExclusivePrivateStateFile(path, serializeRecord(record));
  return { record, path, digest: computeSnapshotRecordDigest(record) };
}

function publishReceipt(
  input: StateRuntimeInput,
  body: ReceiptRecordBody,
  snapshot: AuthenticatedSnapshotRecord,
  replaceExisting: boolean
): PersistedReceipt {
  const options = normalizeStateOptions(input);
  const { layout, key } = ensureWritableState(options);
  const record = createReceiptRecord(body, key, snapshot);
  const path = join(layout.receiptsDir, `${record.id}.json`);
  const digest = computeReceiptRecordDigest(record);
  const pendingPath = record.success
    ? planStatePendingPath(layout, record.plan.id)
    : undefined;
  if (pendingPath) {
    writeExclusivePrivateStateFile(
      pendingPath,
      serializeRecord({
        type: "gatefile-plan-state-pending",
        version: 1,
        planId: record.plan.id,
        receiptId: record.id,
        receiptDigest: digest
      })
    );
  }
  if (replaceExisting) {
    replacePrivateStateFile(path, serializeRecord(record));
  } else {
    writeExclusivePrivateStateFile(path, serializeRecord(record));
  }

  let planStateUpdated = !record.success;
  let warning: string | undefined;
  if (record.success) {
    const planStateBody: PlanStateRecordBody = {
      type: "gatefile-plan-state",
      stateVersion: 1,
      repository: layout.repository,
      plan: { ...record.plan },
      receiptId: record.id,
      receiptDigest: digest,
      appliedAt: record.appliedAt,
      success: true
    };
    const planState = createPlanStateRecord(planStateBody, key, record);
    try {
      replacePrivateStateFile(
        join(layout.plansDir, planStateFilename(record.plan.id)),
        serializeRecord(planState)
      );
      if (!pendingPath) throw new Error("Missing dependency-state invalidation marker");
      try {
        removePrivateStateFile(pendingPath);
        planStateUpdated = true;
      } catch (error) {
        if (error instanceof StateAuthenticationPostCommitError) {
          planStateUpdated = true;
          warning =
            `Dependency-state cache is durable, but invalidation-marker cleanup durability was not confirmed: ${error.message}`;
        } else {
          throw error;
        }
      }
    } catch (error) {
      if (!planStateUpdated) {
        warning =
          `Apply receipt is durable and rollbackable, but the dependency-state cache was not updated and remains fail-closed: ${(error as Error).message}`;
      }
    }
  }

  return {
    record,
    path,
    digest,
    planStateUpdated,
    ...(warning ? { warning } : {})
  };
}

export function writeReceipt(
  input: StateRuntimeInput,
  body: ReceiptRecordBody,
  snapshot: AuthenticatedSnapshotRecord
): PersistedReceipt {
  return publishReceipt(input, body, snapshot, false);
}

export function replaceReceipt(
  input: StateRuntimeInput,
  body: ReceiptRecordBody,
  snapshot: AuthenticatedSnapshotRecord
): PersistedReceipt {
  return publishReceipt(input, body, snapshot, true);
}

function assertStateDestinationAbsent(path: string, label: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} destination is already occupied: ${path}`);
}

function stateDestinationExistsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertHeaderBinding(
  layout: StateLayout,
  expectedKind: "snapshot" | "receipt" | "plan-state",
  expectedId: string,
  bytes: Buffer
): ReturnType<typeof extractUntrustedStateRecordHeader> {
  const header = extractUntrustedStateRecordHeader(bytes);
  if (header.kind !== expectedKind) {
    throw new Error(`Expected ${expectedKind} state, received ${header.kind}`);
  }
  if (header.id !== expectedId) {
    throw new Error(`${expectedKind} record ID does not match requested filename/ID`);
  }
  if (
    header.repository.repositoryId !== layout.repository.repositoryId ||
    header.repository.repoInstanceId !== layout.repository.repoInstanceId
  ) {
    throw new Error(`${expectedKind} repository binding does not match the current repository`);
  }
  return header;
}

function loadSnapshot(input: StateRuntimeInput, snapshotId: string): {
  record: AuthenticatedSnapshotRecord;
  key: StateAuthKey;
} {
  const options = normalizeStateOptions(input);
  const layout = getStateLayout(options);
  const safeId = assertSafeStateId(snapshotId);
  const bytes = readPrivateStateFile(join(layout.snapshotsDir, `${safeId}.json`));
  const header = assertHeaderBinding(layout, "snapshot", safeId, bytes);
  const key = loadStateAuthKey(layout.binding, header.authentication.keyId, options.stateHome);
  return {
    record: parseAndVerifySnapshotRecord(bytes, key, {
      repository: layout.repository,
      id: safeId
    }),
    key
  };
}

function loadReceipt(input: StateRuntimeInput, receiptId: string): {
  record: AuthenticatedReceiptRecord;
  key: StateAuthKey;
} {
  const options = normalizeStateOptions(input);
  const layout = getStateLayout(options);
  const safeId = assertSafeStateId(receiptId);
  const bytes = readPrivateStateFile(join(layout.receiptsDir, `${safeId}.json`));
  const header = assertHeaderBinding(layout, "receipt", safeId, bytes);
  const key = loadStateAuthKey(layout.binding, header.authentication.keyId, options.stateHome);
  return {
    record: parseAndVerifyReceiptRecord(bytes, key, {
      repository: layout.repository,
      id: safeId
    }),
    key
  };
}

function loadReceiptChain(input: StateRuntimeInput, receiptId: string): LoadedReceiptChain {
  const options = normalizeStateOptions(input);
  const layout = getStateLayout(options);
  const loadedReceipt = loadReceipt(options, receiptId);
  const loadedSnapshot = loadSnapshot(options, loadedReceipt.record.snapshotId);
  assertReceiptSnapshotLink(loadedReceipt.record, loadedSnapshot.record);
  return {
    layout,
    receipt: loadedReceipt.record,
    receiptKey: loadedReceipt.key,
    receiptDigest: computeReceiptRecordDigest(loadedReceipt.record),
    snapshot: loadedSnapshot.record
  };
}

/**
 * Materialize and verify every deterministic state destination before an apply
 * is allowed to mutate managed files. Existing plan state is a replaceable
 * cache, but it must already be a valid authenticated record rather than an
 * attacker-controlled directory, link, or corrupt file.
 */
export function prepareStateForApply(
  input: StateRuntimeInput,
  planId: string,
  receiptId: string
): StateLayout {
  const options = normalizeStateOptions(input);
  const { layout } = ensureWritableState(options);
  assertApplyStateDestinations(layout, options, planId, receiptId);
  return layout;
}

function assertApplyStateDestinations(
  layout: StateLayout,
  options: StateRuntimeOptions,
  planId: string,
  receiptId: string
): void {
  const safeReceiptId = assertSafeStateId(receiptId);
  assertStateDestinationAbsent(
    join(layout.snapshotsDir, `${safeReceiptId}.json`),
    "Snapshot"
  );
  assertStateDestinationAbsent(
    join(layout.receiptsDir, `${safeReceiptId}.json`),
    "Receipt"
  );

  const pendingPath = planStatePendingPath(layout, planId);
  if (stateDestinationExistsNoFollow(pendingPath)) {
    throw new Error(
      `Dependency-state invalidation marker is already occupied; apply remains fail-closed: ${pendingPath}`
    );
  }

  const existingPlanStatePath = join(layout.plansDir, planStateFilename(planId));
  if (stateDestinationExistsNoFollow(existingPlanStatePath)) {
    const bytes = readPrivateStateFile(existingPlanStatePath);
    const header = assertHeaderBinding(layout, "plan-state", planId, bytes);
    const key = loadStateAuthKey(
      layout.binding,
      header.authentication.keyId,
      options.stateHome
    );
    const state = parseAndVerifyPlanStateRecord(bytes, key, {
      repository: layout.repository
    });
    const chain = loadReceiptChain(options, state.receiptId);
    assertPlanStateReceiptLink(state, chain.receipt);
  }
}

/**
 * Read-only validation of key/state layout and every deterministic apply
 * destination. Absent components are allowed and are created only after hooks.
 */
export function preflightStateForApply(
  input: StateRuntimeInput,
  planId: string,
  receiptId: string
): StateLayout {
  const options = normalizeStateOptions(input);
  const layout = getStateLayout(options);
  preflightStateAuthForWrite(layout.binding, options.stateHome);
  for (const directory of [
    layout.recordsRoot,
    layout.receiptsDir,
    layout.snapshotsDir,
    layout.plansDir
  ]) {
    inspectPrivateStateDirectoryIfPresent(directory);
  }
  assertApplyStateDestinations(layout, options, planId, receiptId);
  return layout;
}

export function readReceipt(input: StateRuntimeInput, receiptId: string): ApplyReceipt {
  return loadReceipt(input, receiptId).record;
}

export function readSnapshot(input: StateRuntimeInput, snapshotId: string): SnapshotFile {
  return loadSnapshot(input, snapshotId).record;
}

function missingStateFile(error: unknown): boolean {
  return /Missing authenticated state file|Missing external Gatefile state-auth key store/.test(
    (error as Error).message
  );
}

function loadSuccessfulPlanState(
  input: StateRuntimeInput,
  planId: string,
  visiting: Set<string> = new Set()
): AuthenticatedPlanStateRecord | undefined {
  if (visiting.has(planId)) {
    throw new Error(`Dependency state contains a cycle at plan ${planId}`);
  }
  const nextVisiting = new Set(visiting);
  nextVisiting.add(planId);
  const options = normalizeStateOptions(input);
  const layout = getStateLayout(options);
  if (stateDestinationExistsNoFollow(planStatePendingPath(layout, planId))) {
    return undefined;
  }
  const path = join(layout.plansDir, planStateFilename(planId));
  let bytes: Buffer;
  try {
    bytes = readPrivateStateFile(path);
  } catch (error) {
    if (missingStateFile(error)) return undefined;
    throw error;
  }

  const header = assertHeaderBinding(layout, "plan-state", planId, bytes);
  const key = loadStateAuthKey(layout.binding, header.authentication.keyId, options.stateHome);
  const state = parseAndVerifyPlanStateRecord(bytes, key, {
    repository: layout.repository
  });
  if (state.plan.id !== planId || !state.success) return undefined;
  const chain = loadReceiptChain(options, state.receiptId);
  assertPlanStateReceiptLink(state, chain.receipt);
  if (!chain.receipt.success) return undefined;

  // A rollback claim is durable invalidation, even if restoration later fails.
  // This prevents a rolled-back (or partially rolled-back) plan from continuing
  // to satisfy direct or transitive dependencies.
  const markerPath = rollbackMarkerPath(
    chain.layout.binding,
    chain.receipt.id,
    options.stateHome
  );
  if (stateDestinationExistsNoFollow(markerPath)) {
    readRollbackMarker(
      chain.layout.binding,
      chain.receipt.id,
      chain.receiptDigest,
      chain.receiptKey,
      options.stateHome
    );
    return undefined;
  }

  for (const dependencyPlanId of chain.receipt.dependencies.requiredPlanIds) {
    if (!loadSuccessfulPlanState(options, dependencyPlanId, nextVisiting)) {
      return undefined;
    }
  }
  return state;
}

export function dependencyStatus(
  plan: PlanFile,
  input: StateRuntimeInput = {}
): DependencyStatus {
  const requiredPlanIds = [
    ...new Set(
      (plan.dependsOn ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  ];
  const missingPlanIds: string[] = [];

  for (const planId of requiredPlanIds) {
    try {
      if (!loadSuccessfulPlanState(input, planId)) missingPlanIds.push(planId);
    } catch (error) {
      throw new Error(
        `Dependency state integrity check failed for plan ${planId}: ${(error as Error).message}`
      );
    }
  }

  return {
    requiredPlanIds,
    missingPlanIds,
    allSatisfied: missingPlanIds.length === 0
  };
}

function compactStatesEqual(
  actual: CompactFileState,
  expected: StoredCompactFileState
): boolean {
  if (actual.kind !== expected.kind) return false;
  if (actual.kind === "absent" || expected.kind === "absent") return true;
  return (
    actual.sha256 === expected.sha256 &&
    actual.byteLength === expected.byteLength &&
    actual.mode === expected.mode &&
    actual.uid === expected.uid &&
    actual.gid === expected.gid &&
    actual.identity.device === expected.identity.device &&
    actual.identity.inode === expected.identity.inode
  );
}

function targetMetadata(entry: {
  requestedPath: string;
  allowedRoot: string;
  relativePath: string;
  directoryChain: SignedPathMetadata["directoryChain"];
}): SignedPathMetadata {
  return {
    requestedPath: entry.requestedPath,
    allowedRoot: entry.allowedRoot,
    relativePath: entry.relativePath,
    directoryChain: entry.directoryChain
  };
}

function preflightRollback(
  context: SafeFsContext,
  receipt: AuthenticatedReceiptRecord,
  snapshot: AuthenticatedSnapshotRecord
): Map<string, "restore" | "unchanged"> {
  const decisions = new Map<string, "restore" | "unchanged">();
  const resultByOperation = new Map(
    receipt.results.map((result) => [result.operationId, result])
  );
  const snapshotById = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  for (const entry of receipt.rollbackEntries) {
    const actual = captureCompactCurrentState(context, targetMetadata(entry));
    const snapshotEntry = snapshotById.get(entry.snapshotEntryId);
    if (!snapshotEntry) {
      throw new Error(
        `Rollback refused: authenticated snapshot entry is missing for ${entry.requestedPath}`
      );
    }
    const before = compactFileState(decodeStoredExactFileState(snapshotEntry.before));
    const result = resultByOperation.get(entry.operationId);
    const committed = compactStatesEqual(actual, entry.after);
    const unchanged =
      result?.success === false &&
      (result.mutationStatus === "intended" || result.mutationStatus === "committed") &&
      compactStatesEqual(actual, before);
    if (!committed && !unchanged) {
      throw new Error(
        `Rollback refused: post-apply state drift for ${entry.requestedPath}`
      );
    }
    for (const residue of entry.cleanupResidues) {
      verifyCleanupResidue(context, targetMetadata(entry), actual, residue, entry.after);
    }
    decisions.set(entry.operationId, unchanged ? "unchanged" : "restore");
  }
  return decisions;
}

function rollbackAction(beforeKind: "absent" | "regular"): RollbackFileResult["action"] {
  return beforeKind === "absent" ? "deleted" : "rewritten";
}

export function rollbackByReceipt(
  input: StateRuntimeInput,
  receiptId: string
): RollbackReport {
  const options = normalizeStateOptions(input);
  const safeReceiptId = assertSafeStateId(receiptId);
  const chain = loadReceiptChain(options, safeReceiptId);
  const markerPath = rollbackMarkerPath(
    chain.layout.binding,
    safeReceiptId,
    options.stateHome
  );
  if (stateDestinationExistsNoFollow(markerPath)) {
    readRollbackMarker(
      chain.layout.binding,
      safeReceiptId,
      chain.receiptDigest,
      chain.receiptKey,
      options.stateHome
    );
    throw new Error(`Rollback receipt ${safeReceiptId} was already rolled back or claimed; replay refused`);
  }

  const roots = [...new Set(chain.receipt.rollbackEntries.map((entry) => entry.allowedRoot))];
  const context = roots.length > 0
    ? createSafeFsContext(runtimeRepoRoot(options), roots, [chain.layout.stateHome])
    : undefined;

  const rollbackDecisions = context
    ? preflightRollback(context, chain.receipt, chain.snapshot)
    : new Map<string, "restore" | "unchanged">();
  claimRollbackMarker(
    chain.layout.binding,
    safeReceiptId,
    chain.receiptDigest,
    chain.receiptKey,
    options.stateHome
  );

  const snapshotById = new Map(chain.snapshot.entries.map((entry) => [entry.id, entry]));
  const fileResults: RollbackFileResult[] = [];
  if (context) {
    for (const entry of chain.receipt.rollbackEntries) {
      const snapshotEntry = snapshotById.get(entry.snapshotEntryId);
      if (!snapshotEntry) {
        fileResults.push({
          path: entry.requestedPath,
          restored: false,
          action: "unchanged",
          message: "rollback failed: authenticated snapshot entry is missing"
        });
        break;
      }
      try {
        const before = decodeStoredExactFileState(snapshotEntry.before);
        const beforeCompact = compactFileState(before);
        const decision = rollbackDecisions.get(entry.operationId) ?? "restore";
        const expectedCurrent = decision === "unchanged" ? beforeCompact : entry.after;
        const actual = captureCompactCurrentState(context, targetMetadata(entry));
        if (!compactStatesEqual(actual, expectedCurrent)) {
          throw new Error(`rollback drift: target changed after recovery preflight`);
        }
        for (const residue of entry.cleanupResidues) {
          safeCleanupResidue(
            context,
            targetMetadata(entry),
            actual,
            residue,
            entry.after
          );
        }
        if (decision === "unchanged") {
          const afterCleanup = captureCompactCurrentState(context, targetMetadata(entry));
          if (!compactStatesEqual(afterCleanup, beforeCompact)) {
            throw new Error(`rollback drift: unchanged target moved during residue cleanup`);
          }
          fileResults.push({
            path: entry.requestedPath,
            restored: true,
            action: "unchanged",
            message: "failed write-ahead outcome left the authenticated previous file state intact"
          });
          continue;
        }
        safeRestore(
          context,
          targetMetadata(entry),
          entry.after,
          before
        );
        fileResults.push({
          path: entry.requestedPath,
          restored: true,
          action: rollbackAction(snapshotEntry.before.kind),
          message: snapshotEntry.before.kind === "absent"
            ? "removed file created by apply"
            : "restored authenticated previous file content and metadata"
        });
      } catch (error) {
        if (error instanceof SafeFsPostCommitError) {
          fileResults.push({
            path: entry.requestedPath,
            restored: true,
            durabilityConfirmed: false,
            action: rollbackAction(snapshotEntry.before.kind),
            message:
              `rollback bytes/metadata committed, but durability finalization failed: ${error.message}`
          });
          break;
        }
        fileResults.push({
          path: entry.requestedPath,
          restored: false,
          action: rollbackAction(snapshotEntry.before.kind),
          message: `rollback failed: ${(error as Error).message}`
        });
        break;
      }
    }
  }

  let success = fileResults.every(
    (result) => result.restored && result.durabilityConfirmed !== false
  );
  let finalizationWarning: string | undefined;
  let pendingMarkerWarning: string | undefined;
  if (success) {
    try {
      completeRollbackMarker(
        chain.layout.binding,
        safeReceiptId,
        chain.receiptDigest,
        chain.receiptKey,
        options.stateHome
      );
    } catch (error) {
      success = false;
      finalizationWarning = error instanceof StateAuthenticationPostCommitError
        ? `Rollback marker replacement committed, but durability was not confirmed: ${error.message}`
        : `Rollback files were restored, but rollback-marker finalization failed: ${(error as Error).message}`;
    }
  }

  if (success) {
    try {
      clearMatchingPlanStatePendingMarker(
        chain.layout,
        chain.receipt.plan.id,
        chain.receipt.id,
        chain.receiptDigest
      );
    } catch (error) {
      if (error instanceof StateAuthenticationPostCommitError) {
        pendingMarkerWarning =
          `Rollback is durable, but dependency-state invalidation-marker cleanup durability was not confirmed; a restart may conservatively block re-apply: ${error.message}`;
      } else {
        success = false;
        pendingMarkerWarning =
          `Rollback is durable, but dependency-state invalidation-marker cleanup failed and re-apply remains blocked: ${(error as Error).message}`;
      }
    }
  }

  return {
    receiptId: chain.receipt.id,
    snapshotId: chain.snapshot.id,
    rolledBackAt: new Date().toISOString(),
    success,
    fileResults,
    notes: [
      "Rollback verified authenticated receipt/snapshot state and post-apply file state before mutation.",
      "Command side effects are not automatically rollbackable in this alpha.",
      ...(finalizationWarning ? [finalizationWarning] : []),
      ...(pendingMarkerWarning ? [pendingMarkerWarning] : [])
    ]
  };
}

export function clearStateForTesting(input: StateRuntimeInput = {}): void {
  const layout = getStateLayout(input);
  const repoStateRoot = dirname(layout.recordsRoot);
  if (existsSync(repoStateRoot)) {
    rmSync(repoStateRoot, { recursive: true, force: true });
  }
}

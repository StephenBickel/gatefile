import { createHash } from "node:crypto";
import { isAbsolute, sep } from "node:path";
import {
  assertSafeStateId,
  computeStateDigest,
  signStateEnvelope,
  verifyStateEnvelope
} from "./state-auth";
import type {
  StateAuthKey,
  StateAuthTag,
  StateEnvelopeKind,
  StateRepositoryBinding
} from "./state-auth";
import { unicodeScalarLength } from "./unicode";

export const STATE_RECORD_VERSION = 1 as const;

export type FileRecordAction = "create" | "update" | "delete";

export interface StateRecordRepository {
  repositoryId: string;
  repoInstanceId: string;
}

export interface StateRecordPlan {
  id: string;
  hash: string;
}

export interface StoredFileIdentity {
  device: string;
  inode: string;
}

export interface StoredDirectoryIdentity {
  relativePath: string;
  identity: StoredFileIdentity;
}

export interface StoredAbsentFileState {
  kind: "absent";
}

export interface StoredCompactRegularFileState {
  kind: "regular";
  sha256: string;
  byteLength: number;
  mode: number;
  uid: string;
  gid: string;
  identity: StoredFileIdentity;
}

export interface StoredExactRegularFileState extends StoredCompactRegularFileState {
  contentBase64: string;
}

export type StoredCompactFileState = StoredAbsentFileState | StoredCompactRegularFileState;
export type StoredExactFileState = StoredAbsentFileState | StoredExactRegularFileState;

export interface RuntimeAbsentFileState {
  kind: "absent";
}

export interface RuntimeExactRegularFileState extends StoredCompactRegularFileState {
  content: Buffer;
}

export type RuntimeExactFileState = RuntimeAbsentFileState | RuntimeExactRegularFileState;

export interface SnapshotRecordEntry {
  id: string;
  operationId: string;
  action: FileRecordAction;
  requestedPath: string;
  allowedRoot: string;
  relativePath: string;
  directoryChain: StoredDirectoryIdentity[];
  before: StoredExactFileState;
}

export interface SnapshotRecordBody {
  type: "gatefile-rollback-snapshot";
  stateVersion: typeof STATE_RECORD_VERSION;
  id: string;
  repository: StateRecordRepository;
  plan: StateRecordPlan;
  createdAt: string;
  entries: SnapshotRecordEntry[];
}

export interface AuthenticatedSnapshotRecord extends SnapshotRecordBody {
  authentication: StateAuthTag;
}

export interface StateOperationResult {
  operationId: string;
  success: boolean;
  message: string;
  mutationStatus: "none" | "intended" | "committed";
}

export interface StateDependencyStatus {
  requiredPlanIds: string[];
  missingPlanIds: string[];
  allSatisfied: boolean;
}

export interface ReceiptAuditMetadata {
  summary: string;
  source: string;
  approvedBy: string;
  approvedAt: string;
  approvalIdentity: "signed" | "unsigned";
  signerKeyId: string | null;
}

export interface RollbackRecordEntry {
  snapshotEntryId: string;
  operationId: string;
  action: FileRecordAction;
  requestedPath: string;
  allowedRoot: string;
  relativePath: string;
  directoryChain: StoredDirectoryIdentity[];
  after: StoredCompactFileState;
  cleanupResidues: StoredCleanupResidue[];
}

export interface StoredCleanupResidue {
  path: string;
  identity: StoredFileIdentity;
}

export interface ReceiptRecordBody {
  type: "gatefile-apply-receipt";
  stateVersion: typeof STATE_RECORD_VERSION;
  id: string;
  repository: StateRecordRepository;
  plan: StateRecordPlan;
  appliedAt: string;
  snapshotId: string;
  snapshotDigest: string;
  success: boolean;
  results: StateOperationResult[];
  dependencies: StateDependencyStatus;
  rollbackEntries: RollbackRecordEntry[];
  /** Added after state v1 launch; absent only on older authenticated receipts. */
  audit?: ReceiptAuditMetadata;
}

export interface AuthenticatedReceiptRecord extends ReceiptRecordBody {
  authentication: StateAuthTag;
}

export interface PlanStateRecordBody {
  type: "gatefile-plan-state";
  stateVersion: typeof STATE_RECORD_VERSION;
  repository: StateRecordRepository;
  plan: StateRecordPlan;
  receiptId: string;
  receiptDigest: string;
  appliedAt: string;
  success: boolean;
}

export interface AuthenticatedPlanStateRecord extends PlanStateRecordBody {
  authentication: StateAuthTag;
}

export type AuthenticatedStateRecord =
  | AuthenticatedSnapshotRecord
  | AuthenticatedReceiptRecord
  | AuthenticatedPlanStateRecord;

export interface UntrustedStateRecordHeader {
  kind: Exclude<StateEnvelopeKind, "rollback-marker">;
  type: AuthenticatedStateRecord["type"];
  stateVersion: number;
  id: string;
  repository: StateRecordRepository;
  authentication: StateAuthTag;
}

export interface SnapshotRecordExpectation {
  repository?: Pick<StateRepositoryBinding, "repositoryId" | "repoInstanceId">;
  id?: string;
  plan?: StateRecordPlan;
}

export interface ReceiptRecordExpectation extends SnapshotRecordExpectation {
  snapshot?: AuthenticatedSnapshotRecord;
}

export interface PlanStateRecordExpectation {
  repository?: Pick<StateRepositoryBinding, "repositoryId" | "repoInstanceId">;
  plan?: StateRecordPlan;
  receipt?: AuthenticatedReceiptRecord;
}

type JsonObject = Record<string, unknown>;
type RecordInput = string | Buffer | unknown;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;
const DECIMAL_IDENTITY = /^(?:0|[1-9][0-9]*)$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_BOUND_ID_LENGTH = 1024;
const ABSENT_FILE_STATE: StoredAbsentFileState = Object.freeze({ kind: "absent" });

export class StateRecordValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateRecordValidationError";
  }
}

function assertRecord(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StateRecordValidationError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new StateRecordValidationError(`${label} must be a plain JSON object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new StateRecordValidationError(`${label} may not contain symbol fields`);
  }
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new StateRecordValidationError(`${label} may not contain accessor fields`);
    }
  }
  return value as JsonObject;
}

function assertArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new StateRecordValidationError(`${label} must be an array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new StateRecordValidationError(`${label} may not be a sparse array`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) {
      throw new StateRecordValidationError(`${label} may not contain accessor entries`);
    }
  }
  const expectedKeys = new Set(Array.from({ length: value.length }, (_, index) => String(index)));
  for (const key of Object.keys(value)) {
    if (!expectedKeys.has(key)) {
      throw new StateRecordValidationError(`${label} contains an unknown array field: ${key}`);
    }
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new StateRecordValidationError(`${label} may not contain symbol fields`);
  }
  return value;
}

function assertExactFields(value: JsonObject, expected: readonly string[], label: string): void {
  const expectedSet = new Set(expected);
  const unknown = Object.keys(value).filter((key) => !expectedSet.has(key));
  if (unknown.length > 0) {
    throw new StateRecordValidationError(
      `${label} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`
    );
  }
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) {
    throw new StateRecordValidationError(
      `${label} is missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`
    );
  }
}

function assertText(value: unknown, label: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    (!allowEmpty && value.trim().length === 0) ||
    unicodeScalarLength(value) > MAX_BOUND_ID_LENGTH * 16
  ) {
    throw new StateRecordValidationError(
      `${label} must be ${allowEmpty ? "a" : "a non-empty"} bounded string without NUL bytes`
    );
  }
  return value;
}

function assertBoundId(value: unknown, label: string): string {
  const id = assertText(value, label);
  if (unicodeScalarLength(id) > MAX_BOUND_ID_LENGTH) {
    throw new StateRecordValidationError(`${label} exceeds ${MAX_BOUND_ID_LENGTH} characters`);
  }
  return id;
}

function assertSafeId(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new StateRecordValidationError(`${label} must be a safe state ID`);
  }
  try {
    return assertSafeStateId(value);
  } catch {
    throw new StateRecordValidationError(`${label} must be a safe state ID`);
  }
}

function assertSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new StateRecordValidationError(`${label} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function assertCanonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) {
    throw new StateRecordValidationError(`${label} must be a canonical RFC3339 UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new StateRecordValidationError(`${label} must be a valid canonical RFC3339 UTC timestamp`);
  }
  return value;
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new StateRecordValidationError(`${label} must be a boolean`);
  }
  return value;
}

function assertSafeInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new StateRecordValidationError(`${label} is outside its permitted integer range`);
  }
  return value as number;
}

function assertRepository(value: unknown, label = "state repository binding"): StateRecordRepository {
  const repository = assertRecord(value, label);
  assertExactFields(repository, ["repositoryId", "repoInstanceId"], label);
  return {
    repositoryId: assertText(repository.repositoryId, `${label}.repositoryId`),
    repoInstanceId: assertSha256(repository.repoInstanceId, `${label}.repoInstanceId`)
  };
}

function assertPlan(value: unknown, label = "state plan binding"): StateRecordPlan {
  const plan = assertRecord(value, label);
  assertExactFields(plan, ["id", "hash"], label);
  return {
    id: assertBoundId(plan.id, `${label}.id`),
    hash: assertSha256(plan.hash, `${label}.hash`)
  };
}

function assertAuthentication(value: unknown): StateAuthTag {
  const authentication = assertRecord(value, "state authentication metadata");
  assertExactFields(
    authentication,
    ["scheme", "envelopeVersion", "keyId", "tag"],
    "state authentication metadata"
  );
  if (authentication.scheme !== "hmac-sha256" || authentication.envelopeVersion !== 1) {
    throw new StateRecordValidationError(
      "Unsupported state authentication scheme or envelope version"
    );
  }
  const keyId = assertSha256(authentication.keyId, "state authentication key ID");
  if (typeof authentication.tag !== "string" || !BASE64URL_SHA256.test(authentication.tag)) {
    throw new StateRecordValidationError("State authentication tag must be canonical base64url");
  }
  const tagBytes = Buffer.from(authentication.tag, "base64url");
  if (tagBytes.length !== 32 || tagBytes.toString("base64url") !== authentication.tag) {
    throw new StateRecordValidationError("State authentication tag must be canonical base64url");
  }
  return {
    scheme: "hmac-sha256",
    envelopeVersion: 1,
    keyId,
    tag: authentication.tag
  };
}

function assertIdentity(value: unknown, label: string): StoredFileIdentity {
  const identity = assertRecord(value, label);
  assertExactFields(identity, ["device", "inode"], label);
  const device = assertText(identity.device, `${label}.device`);
  const inode = assertText(identity.inode, `${label}.inode`);
  if (
    !DECIMAL_IDENTITY.test(device) ||
    !DECIMAL_IDENTITY.test(inode) ||
    device.length > 40 ||
    inode.length > 40
  ) {
    throw new StateRecordValidationError(
      `${label} device and inode must be canonical non-negative decimal identities`
    );
  }
  return { device, inode };
}

function assertOwnershipId(value: unknown, label: string): string {
  const id = assertText(value, label);
  if (!DECIMAL_IDENTITY.test(id) || id.length > 40) {
    throw new StateRecordValidationError(
      `${label} must be a canonical non-negative decimal owner identifier`
    );
  }
  return id;
}

function decodeCanonicalBase64(value: unknown, label: string): Buffer {
  if (typeof value !== "string") {
    throw new StateRecordValidationError(`${label} must be a canonical base64 string`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new StateRecordValidationError(`${label} must be a canonical base64 string`);
  }
  return bytes;
}

function assertCompactFileState(value: unknown, label: string): StoredCompactFileState {
  const state = assertRecord(value, label);
  if (state.kind === "absent") {
    assertExactFields(state, ["kind"], label);
    return ABSENT_FILE_STATE;
  }
  if (state.kind !== "regular") {
    throw new StateRecordValidationError(`${label}.kind must be absent or regular`);
  }
  assertExactFields(
    state,
    ["kind", "sha256", "byteLength", "mode", "uid", "gid", "identity"],
    label
  );
  return {
    kind: "regular",
    sha256: assertSha256(state.sha256, `${label}.sha256`),
    byteLength: assertSafeInteger(state.byteLength, `${label}.byteLength`, Number.MAX_SAFE_INTEGER),
    mode: assertSafeInteger(state.mode, `${label}.mode`, 0o7777),
    uid: assertOwnershipId(state.uid, `${label}.uid`),
    gid: assertOwnershipId(state.gid, `${label}.gid`),
    identity: assertIdentity(state.identity, `${label}.identity`)
  };
}

function assertExactFileState(value: unknown, label: string): StoredExactFileState {
  const state = assertRecord(value, label);
  if (state.kind === "absent") {
    assertExactFields(state, ["kind"], label);
    return ABSENT_FILE_STATE;
  }
  if (state.kind !== "regular") {
    throw new StateRecordValidationError(`${label}.kind must be absent or regular`);
  }
  assertExactFields(
    state,
    ["kind", "contentBase64", "sha256", "byteLength", "mode", "uid", "gid", "identity"],
    label
  );
  const content = decodeCanonicalBase64(state.contentBase64, `${label}.contentBase64`);
  const sha256 = assertSha256(state.sha256, `${label}.sha256`);
  const byteLength = assertSafeInteger(
    state.byteLength,
    `${label}.byteLength`,
    Number.MAX_SAFE_INTEGER
  );
  if (content.byteLength !== byteLength) {
    throw new StateRecordValidationError(`${label} content size does not match byteLength`);
  }
  const actualDigest = createHash("sha256").update(content).digest("hex");
  if (actualDigest !== sha256) {
    throw new StateRecordValidationError(`${label} content does not match its SHA-256 digest`);
  }
  return {
    kind: "regular",
    contentBase64: state.contentBase64 as string,
    sha256,
    byteLength,
    mode: assertSafeInteger(state.mode, `${label}.mode`, 0o7777),
    uid: assertOwnershipId(state.uid, `${label}.uid`),
    gid: assertOwnershipId(state.gid, `${label}.gid`),
    identity: assertIdentity(state.identity, `${label}.identity`)
  };
}

function assertAction(value: unknown, label: string): FileRecordAction {
  if (value !== "create" && value !== "update" && value !== "delete") {
    throw new StateRecordValidationError(`${label} must be create, update, or delete`);
  }
  return value;
}

function assertTargetMetadata(
  value: JsonObject,
  label: string
): Pick<
  SnapshotRecordEntry,
  "requestedPath" | "allowedRoot" | "relativePath" | "directoryChain"
> {
  const requestedPath = assertText(value.requestedPath, `${label}.requestedPath`);
  const allowedRoot = assertText(value.allowedRoot, `${label}.allowedRoot`);
  if (!isAbsolute(allowedRoot)) {
    throw new StateRecordValidationError(`${label}.allowedRoot must be an absolute path`);
  }
  const relativePath = assertText(value.relativePath, `${label}.relativePath`);
  if (
    isAbsolute(relativePath) ||
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\") ||
    relativePath.split(/[\\/]/).some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new StateRecordValidationError(
      `${label}.relativePath must be a normalized relative path without traversal`
    );
  }
  const directoryValues = assertArray(value.directoryChain, `${label}.directoryChain`);
  const parentSegments = relativePath.split(/[\\/]/).slice(0, -1);
  const expectedRelativePaths = [""];
  let current = "";
  for (const segment of parentSegments) {
    current = current.length === 0 ? segment : `${current}${sep}${segment}`;
    expectedRelativePaths.push(current);
  }
  if (directoryValues.length !== expectedRelativePaths.length) {
    throw new StateRecordValidationError(
      `${label}.directoryChain must identify every directory from the allowed root through the target parent`
    );
  }
  const directoryChain = directoryValues.map((entryValue, index) => {
    const entryLabel = `${label}.directoryChain[${index}]`;
    const entry = assertRecord(entryValue, entryLabel);
    assertExactFields(entry, ["relativePath", "identity"], entryLabel);
    const entryRelativePath = assertText(entry.relativePath, `${entryLabel}.relativePath`, true);
    if (entryRelativePath !== expectedRelativePaths[index]) {
      throw new StateRecordValidationError(
        `${entryLabel}.relativePath does not match the canonical target parent chain`
      );
    }
    return {
      relativePath: entryRelativePath,
      identity: assertIdentity(entry.identity, `${entryLabel}.identity`)
    };
  });
  return { requestedPath, allowedRoot, relativePath, directoryChain };
}

function assertSnapshotEntry(value: unknown, index: number): SnapshotRecordEntry {
  const label = `snapshot.entries[${index}]`;
  const entry = assertRecord(value, label);
  assertExactFields(
    entry,
    [
      "id",
      "operationId",
      "action",
      "requestedPath",
      "allowedRoot",
      "relativePath",
      "directoryChain",
      "before"
    ],
    label
  );
  const action = assertAction(entry.action, `${label}.action`);
  const before = assertExactFileState(entry.before, `${label}.before`);
  if (action === "create" && before.kind !== "absent") {
    throw new StateRecordValidationError(`${label} create operation must have an absent before state`);
  }
  if (action !== "create" && before.kind !== "regular") {
    throw new StateRecordValidationError(`${label} ${action} operation must have a regular before state`);
  }
  return {
    id: assertSafeId(entry.id, `${label}.id`),
    operationId: assertBoundId(entry.operationId, `${label}.operationId`),
    action,
    ...assertTargetMetadata(entry, label),
    before
  };
}

function assertSnapshotBody(value: unknown): SnapshotRecordBody {
  const body = assertRecord(value, "snapshot record");
  assertExactFields(
    body,
    ["type", "stateVersion", "id", "repository", "plan", "createdAt", "entries"],
    "snapshot record"
  );
  if (body.type !== "gatefile-rollback-snapshot") {
    throw new StateRecordValidationError("Unsupported snapshot record type");
  }
  if (body.stateVersion !== STATE_RECORD_VERSION) {
    throw new StateRecordValidationError("Unsupported snapshot state record version");
  }
  const entries = assertArray(body.entries, "snapshot.entries").map(assertSnapshotEntry);
  const entryIds = new Set<string>();
  const operationIds = new Set<string>();
  for (const entry of entries) {
    if (entryIds.has(entry.id)) {
      throw new StateRecordValidationError(`Duplicate snapshot entry ID: ${entry.id}`);
    }
    if (operationIds.has(entry.operationId)) {
      throw new StateRecordValidationError(
        `Duplicate snapshot operation reference: ${entry.operationId}`
      );
    }
    entryIds.add(entry.id);
    operationIds.add(entry.operationId);
  }
  return {
    type: "gatefile-rollback-snapshot",
    stateVersion: STATE_RECORD_VERSION,
    id: assertSafeId(body.id, "snapshot.id"),
    repository: assertRepository(body.repository),
    plan: assertPlan(body.plan),
    createdAt: assertCanonicalTimestamp(body.createdAt, "snapshot.createdAt"),
    entries
  };
}

function assertOperationResult(value: unknown, index: number): StateOperationResult {
  const label = `receipt.results[${index}]`;
  const result = assertRecord(value, label);
  assertExactFields(result, ["operationId", "success", "message", "mutationStatus"], label);
  if (
    result.mutationStatus !== "none" &&
    result.mutationStatus !== "intended" &&
    result.mutationStatus !== "committed"
  ) {
    throw new StateRecordValidationError(`${label}.mutationStatus is invalid`);
  }
  const success = assertBoolean(result.success, `${label}.success`);
  if (success && result.mutationStatus === "intended") {
    throw new StateRecordValidationError(`${label} cannot be successful with an intended mutation`);
  }
  return {
    operationId: assertBoundId(result.operationId, `${label}.operationId`),
    success,
    message: assertText(result.message, `${label}.message`, true),
    mutationStatus: result.mutationStatus
  };
}

function assertUniqueBoundIdArray(value: unknown, label: string): string[] {
  const ids = assertArray(value, label).map((id, index) =>
    assertBoundId(id, `${label}[${index}]`)
  );
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new StateRecordValidationError(`Duplicate dependency ID in ${label}: ${id}`);
    seen.add(id);
  }
  return ids;
}

function assertDependencies(value: unknown): StateDependencyStatus {
  const dependencies = assertRecord(value, "receipt.dependencies");
  assertExactFields(
    dependencies,
    ["requiredPlanIds", "missingPlanIds", "allSatisfied"],
    "receipt.dependencies"
  );
  const requiredPlanIds = assertUniqueBoundIdArray(
    dependencies.requiredPlanIds,
    "receipt.dependencies.requiredPlanIds"
  );
  const missingPlanIds = assertUniqueBoundIdArray(
    dependencies.missingPlanIds,
    "receipt.dependencies.missingPlanIds"
  );
  const required = new Set(requiredPlanIds);
  for (const missing of missingPlanIds) {
    if (!required.has(missing)) {
      throw new StateRecordValidationError(
        `Missing dependency is not a required plan ID: ${missing}`
      );
    }
  }
  const allSatisfied = assertBoolean(dependencies.allSatisfied, "receipt.dependencies.allSatisfied");
  if (allSatisfied !== (missingPlanIds.length === 0)) {
    throw new StateRecordValidationError(
      "Dependency allSatisfied does not match the missing dependency list"
    );
  }
  return { requiredPlanIds, missingPlanIds, allSatisfied };
}

function assertRollbackEntry(value: unknown, index: number): RollbackRecordEntry {
  const label = `receipt.rollbackEntries[${index}]`;
  const entry = assertRecord(value, label);
  assertExactFields(
    entry,
    [
      "snapshotEntryId",
      "operationId",
      "action",
      "requestedPath",
      "allowedRoot",
      "relativePath",
      "directoryChain",
      "after",
      "cleanupResidues"
    ],
    label
  );
  const action = assertAction(entry.action, `${label}.action`);
  const after = assertCompactFileState(entry.after, `${label}.after`);
  if (action === "delete" && after.kind !== "absent") {
    throw new StateRecordValidationError(`${label} delete operation must have an absent after state`);
  }
  if (action !== "delete" && after.kind !== "regular") {
    throw new StateRecordValidationError(`${label} ${action} operation must have a regular after state`);
  }
  const cleanupResidues = assertArray(
    entry.cleanupResidues,
    `${label}.cleanupResidues`
  ).map((residue, residueIndex): StoredCleanupResidue => {
    const residueLabel = `${label}.cleanupResidues[${residueIndex}]`;
    const record = assertRecord(residue, residueLabel);
    assertExactFields(record, ["path", "identity"], residueLabel);
    const residuePath = assertText(record.path, `${residueLabel}.path`);
    if (!isAbsolute(residuePath)) {
      throw new StateRecordValidationError(`${residueLabel}.path must be absolute`);
    }
    return {
      path: residuePath,
      identity: assertIdentity(record.identity, `${residueLabel}.identity`)
    };
  });
  if (cleanupResidues.length > 1) {
    throw new StateRecordValidationError(`${label}.cleanupResidues may contain at most one entry`);
  }
  if (cleanupResidues.length > 0) {
    if (action === "delete" || after.kind !== "regular") {
      throw new StateRecordValidationError(
        `${label} cleanup residue is only valid for a create or update`
      );
    }
    const residue = cleanupResidues[0];
    if (
      residue.identity.device !== after.identity.device ||
      residue.identity.inode !== after.identity.inode
    ) {
      throw new StateRecordValidationError(`${label} cleanup residue identity must match after state`);
    }
  }
  return {
    snapshotEntryId: assertSafeId(entry.snapshotEntryId, `${label}.snapshotEntryId`),
    operationId: assertBoundId(entry.operationId, `${label}.operationId`),
    action,
    ...assertTargetMetadata(entry, label),
    after,
    cleanupResidues
  };
}

function assertReceiptBody(value: unknown): ReceiptRecordBody {
  const body = assertRecord(value, "receipt record");
  const hasAudit = Object.prototype.hasOwnProperty.call(body, "audit");
  assertExactFields(
    body,
    [
      "type",
      "stateVersion",
      "id",
      "repository",
      "plan",
      "appliedAt",
      "snapshotId",
      "snapshotDigest",
      "success",
      "results",
      "dependencies",
      "rollbackEntries",
      ...(hasAudit ? ["audit"] : [])
    ],
    "receipt record"
  );
  if (body.type !== "gatefile-apply-receipt") {
    throw new StateRecordValidationError("Unsupported receipt record type");
  }
  if (body.stateVersion !== STATE_RECORD_VERSION) {
    throw new StateRecordValidationError("Unsupported receipt state record version");
  }
  const success = assertBoolean(body.success, "receipt.success");
  const results = assertArray(body.results, "receipt.results").map(assertOperationResult);
  const resultByOperation = new Map<string, StateOperationResult>();
  for (const result of results) {
    if (resultByOperation.has(result.operationId)) {
      throw new StateRecordValidationError(
        `Duplicate receipt result operation reference: ${result.operationId}`
      );
    }
    resultByOperation.set(result.operationId, result);
  }
  if (success && results.some((result) => !result.success)) {
    throw new StateRecordValidationError("Successful receipt contains a failed operation result");
  }
  if (!success && results.length > 0 && results.every((result) => result.success)) {
    throw new StateRecordValidationError("Failed receipt contains only successful operation results");
  }

  const rollbackEntries = assertArray(body.rollbackEntries, "receipt.rollbackEntries").map(
    assertRollbackEntry
  );
  const snapshotEntryIds = new Set<string>();
  const rollbackOperations = new Set<string>();
  for (const entry of rollbackEntries) {
    if (snapshotEntryIds.has(entry.snapshotEntryId)) {
      throw new StateRecordValidationError(
        `Duplicate rollback snapshot entry reference: ${entry.snapshotEntryId}`
      );
    }
    if (rollbackOperations.has(entry.operationId)) {
      throw new StateRecordValidationError(
        `Duplicate rollback operation reference: ${entry.operationId}`
      );
    }
    const result = resultByOperation.get(entry.operationId);
    if (!result) {
      throw new StateRecordValidationError(
        `Rollback entry must reference an attempted file operation: ${entry.operationId}`
      );
    }
    if (result.mutationStatus !== "intended" && result.mutationStatus !== "committed") {
      throw new StateRecordValidationError(
        `Rollback entry requires an intended or committed file mutation: ${entry.operationId}`
      );
    }
    snapshotEntryIds.add(entry.snapshotEntryId);
    rollbackOperations.add(entry.operationId);
  }

  let audit: ReceiptAuditMetadata | undefined;
  if (hasAudit) {
    const metadata = assertRecord(body.audit, "receipt.audit");
    assertExactFields(
      metadata,
      [
        "summary",
        "source",
        "approvedBy",
        "approvedAt",
        "approvalIdentity",
        "signerKeyId"
      ],
      "receipt.audit"
    );
    if (metadata.approvalIdentity !== "signed" && metadata.approvalIdentity !== "unsigned") {
      throw new StateRecordValidationError(
        "receipt.audit.approvalIdentity must be signed or unsigned"
      );
    }
    const signerKeyId = metadata.signerKeyId === null
      ? null
      : assertBoundId(metadata.signerKeyId, "receipt.audit.signerKeyId");
    if (metadata.approvalIdentity === "signed" && signerKeyId === null) {
      throw new StateRecordValidationError(
        "receipt.audit signed approval must include signerKeyId"
      );
    }
    if (metadata.approvalIdentity === "unsigned" && signerKeyId !== null) {
      throw new StateRecordValidationError(
        "receipt.audit unsigned approval may not include signerKeyId"
      );
    }
    audit = {
      summary: assertText(metadata.summary, "receipt.audit.summary"),
      source: assertText(metadata.source, "receipt.audit.source"),
      approvedBy: assertText(metadata.approvedBy, "receipt.audit.approvedBy"),
      approvedAt: assertCanonicalTimestamp(metadata.approvedAt, "receipt.audit.approvedAt"),
      approvalIdentity: metadata.approvalIdentity,
      signerKeyId
    };
  }

  return {
    type: "gatefile-apply-receipt",
    stateVersion: STATE_RECORD_VERSION,
    id: assertSafeId(body.id, "receipt.id"),
    repository: assertRepository(body.repository),
    plan: assertPlan(body.plan),
    appliedAt: assertCanonicalTimestamp(body.appliedAt, "receipt.appliedAt"),
    snapshotId: assertSafeId(body.snapshotId, "receipt.snapshotId"),
    snapshotDigest: assertSha256(body.snapshotDigest, "receipt.snapshotDigest"),
    success,
    results,
    dependencies: assertDependencies(body.dependencies),
    rollbackEntries,
    ...(audit ? { audit } : {})
  };
}

function assertPlanStateBody(value: unknown): PlanStateRecordBody {
  const body = assertRecord(value, "plan-state record");
  assertExactFields(
    body,
    [
      "type",
      "stateVersion",
      "repository",
      "plan",
      "receiptId",
      "receiptDigest",
      "appliedAt",
      "success"
    ],
    "plan-state record"
  );
  if (body.type !== "gatefile-plan-state") {
    throw new StateRecordValidationError("Unsupported plan-state record type");
  }
  if (body.stateVersion !== STATE_RECORD_VERSION) {
    throw new StateRecordValidationError("Unsupported plan-state record version");
  }
  return {
    type: "gatefile-plan-state",
    stateVersion: STATE_RECORD_VERSION,
    repository: assertRepository(body.repository),
    plan: assertPlan(body.plan),
    receiptId: assertSafeId(body.receiptId, "plan-state.receiptId"),
    receiptDigest: assertSha256(body.receiptDigest, "plan-state.receiptDigest"),
    appliedAt: assertCanonicalTimestamp(body.appliedAt, "plan-state.appliedAt"),
    success: assertBoolean(body.success, "plan-state.success")
  };
}

function parseRecordInput(input: RecordInput): JsonObject {
  let raw: unknown = input;
  if (Buffer.isBuffer(input) || typeof input === "string") {
    try {
      raw = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
    } catch (error) {
      throw new StateRecordValidationError(
        `Invalid authenticated state record JSON: ${(error as Error).message}`
      );
    }
  }
  return assertRecord(raw, "authenticated state record");
}

function bodyWithoutAuthentication(raw: JsonObject): JsonObject {
  const body: JsonObject = {};
  for (const key of Object.keys(raw)) {
    if (key !== "authentication") body[key] = raw[key];
  }
  return body;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertRepositoryEquals(
  actual: StateRecordRepository,
  expected: Pick<StateRepositoryBinding, "repositoryId" | "repoInstanceId">,
  label: string
): void {
  if (
    actual.repositoryId !== expected.repositoryId ||
    actual.repoInstanceId !== expected.repoInstanceId
  ) {
    throw new StateRecordValidationError(`${label} repository binding does not match`);
  }
}

function assertPlanEquals(actual: StateRecordPlan, expected: StateRecordPlan, label: string): void {
  if (actual.id !== expected.id || actual.hash !== expected.hash) {
    throw new StateRecordValidationError(`${label} plan binding does not match`);
  }
}

function assertKeyRepository(repository: StateRecordRepository, key: StateAuthKey): void {
  if (repository.repoInstanceId !== key.repoInstanceId) {
    throw new StateRecordValidationError(
      "Authenticated state record belongs to a different repository instance"
    );
  }
}

function assertTargetEquals(
  actual: Pick<
    RollbackRecordEntry,
    "operationId" | "action" | "requestedPath" | "allowedRoot" | "relativePath" | "directoryChain"
  >,
  expected: Pick<
    SnapshotRecordEntry,
    "operationId" | "action" | "requestedPath" | "allowedRoot" | "relativePath" | "directoryChain"
  >
): boolean {
  return (
    actual.operationId === expected.operationId &&
    actual.action === expected.action &&
    actual.requestedPath === expected.requestedPath &&
    actual.allowedRoot === expected.allowedRoot &&
    actual.relativePath === expected.relativePath &&
    actual.directoryChain.length === expected.directoryChain.length &&
    actual.directoryChain.every((directory, index) => {
      const expectedDirectory = expected.directoryChain[index];
      return (
        directory.relativePath === expectedDirectory.relativePath &&
        directory.identity.device === expectedDirectory.identity.device &&
        directory.identity.inode === expectedDirectory.identity.inode
      );
    })
  );
}

export function assertReceiptSnapshotLink(
  receipt: ReceiptRecordBody,
  snapshot: SnapshotRecordBody
): void {
  assertRepositoryEquals(receipt.repository, snapshot.repository, "Receipt/snapshot");
  assertPlanEquals(receipt.plan, snapshot.plan, "Receipt/snapshot");
  if (receipt.snapshotId !== snapshot.id) {
    throw new StateRecordValidationError("Receipt snapshot ID reference does not match");
  }
  if (receipt.snapshotDigest !== computeSnapshotRecordDigest(snapshot)) {
    throw new StateRecordValidationError("Receipt snapshot digest reference does not match");
  }

  const snapshotById = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  const rollbackByOperation = new Map(
    receipt.rollbackEntries.map((entry) => [entry.operationId, entry])
  );
  const resultByOperation = new Map(receipt.results.map((result) => [result.operationId, result]));
  for (const rollbackEntry of receipt.rollbackEntries) {
    const snapshotEntry = snapshotById.get(rollbackEntry.snapshotEntryId);
    if (!snapshotEntry || !assertTargetEquals(rollbackEntry, snapshotEntry)) {
      throw new StateRecordValidationError(
        `Rollback entry snapshot metadata/reference mismatch: ${rollbackEntry.snapshotEntryId}`
      );
    }
  }
  for (const snapshotEntry of snapshot.entries) {
    const result = resultByOperation.get(snapshotEntry.operationId);
    const rollback = rollbackByOperation.get(snapshotEntry.operationId);
    if (
      result !== undefined &&
      (result.mutationStatus === "intended" || result.mutationStatus === "committed") &&
      rollback === undefined
    ) {
      throw new StateRecordValidationError(
        `Intended or committed file operation is missing a rollback entry: ${snapshotEntry.operationId}`
      );
    }
  }
}

export function assertPlanStateReceiptLink(
  planState: PlanStateRecordBody,
  receipt: ReceiptRecordBody
): void {
  assertRepositoryEquals(planState.repository, receipt.repository, "Plan-state/receipt");
  assertPlanEquals(planState.plan, receipt.plan, "Plan-state/receipt");
  if (planState.receiptId !== receipt.id) {
    throw new StateRecordValidationError("Plan-state receipt ID reference does not match");
  }
  if (planState.receiptDigest !== computeReceiptRecordDigest(receipt)) {
    throw new StateRecordValidationError("Plan-state receipt digest reference does not match");
  }
  if (planState.appliedAt !== receipt.appliedAt || planState.success !== receipt.success) {
    throw new StateRecordValidationError("Plan-state receipt result metadata does not match");
  }
}

/**
 * Extract only validated-but-untrusted routing data. The caller must load the referenced key and
 * run the matching parseAndVerify function before trusting any record contents.
 */
export function extractUntrustedStateRecordHeader(input: RecordInput): UntrustedStateRecordHeader {
  const raw = parseRecordInput(input);
  if (!Object.prototype.hasOwnProperty.call(raw, "authentication")) {
    throw new StateRecordValidationError(
      "Legacy unsigned state record is not accepted; authentication is required"
    );
  }
  const authentication = assertAuthentication(raw.authentication);
  const repository = assertRepository(raw.repository);
  if (!Number.isSafeInteger(raw.stateVersion) || (raw.stateVersion as number) < 1) {
    throw new StateRecordValidationError("State record version must be a positive integer");
  }

  if (raw.type === "gatefile-rollback-snapshot") {
    return {
      kind: "snapshot",
      type: raw.type,
      stateVersion: raw.stateVersion as number,
      id: assertSafeId(raw.id, "snapshot.id"),
      repository,
      authentication
    };
  }
  if (raw.type === "gatefile-apply-receipt") {
    return {
      kind: "receipt",
      type: raw.type,
      stateVersion: raw.stateVersion as number,
      id: assertSafeId(raw.id, "receipt.id"),
      repository,
      authentication
    };
  }
  if (raw.type === "gatefile-plan-state") {
    const plan = assertPlan(raw.plan);
    return {
      kind: "plan-state",
      type: raw.type,
      stateVersion: raw.stateVersion as number,
      id: plan.id,
      repository,
      authentication
    };
  }
  throw new StateRecordValidationError(`Unsupported authenticated state record type: ${String(raw.type)}`);
}

function verifiedBody(
  input: RecordInput,
  expectedKind: Exclude<StateEnvelopeKind, "rollback-marker">,
  key: StateAuthKey
): { raw: JsonObject; body: JsonObject } {
  const raw = parseRecordInput(input);
  const header = extractUntrustedStateRecordHeader(raw);
  if (header.kind !== expectedKind) {
    throw new StateRecordValidationError(
      `Expected a ${expectedKind} state record, received ${header.kind}`
    );
  }
  const body = bodyWithoutAuthentication(raw);
  verifyStateEnvelope(expectedKind, body, header.authentication, key);
  return { raw, body };
}

export function createSnapshotRecord(
  bodyInput: SnapshotRecordBody,
  key: StateAuthKey
): AuthenticatedSnapshotRecord {
  const body = assertSnapshotBody(bodyInput);
  assertKeyRepository(body.repository, key);
  const cloned = cloneJson(body);
  return {
    ...cloned,
    authentication: signStateEnvelope("snapshot", cloned, key)
  };
}

export function parseAndVerifySnapshotRecord(
  input: RecordInput,
  key: StateAuthKey,
  expected: SnapshotRecordExpectation = {}
): AuthenticatedSnapshotRecord {
  const { raw, body: rawBody } = verifiedBody(input, "snapshot", key);
  const body = assertSnapshotBody(rawBody);
  const authentication = assertAuthentication(raw.authentication);
  assertKeyRepository(body.repository, key);
  if (expected.repository) assertRepositoryEquals(body.repository, expected.repository, "Snapshot");
  if (expected.id !== undefined && body.id !== expected.id) {
    throw new StateRecordValidationError("Snapshot record ID does not match expected ID");
  }
  if (expected.plan) assertPlanEquals(body.plan, expected.plan, "Snapshot");
  return raw as unknown as AuthenticatedSnapshotRecord;
}

export function createReceiptRecord(
  bodyInput: ReceiptRecordBody,
  key: StateAuthKey,
  snapshotInput: AuthenticatedSnapshotRecord
): AuthenticatedReceiptRecord {
  const body = assertReceiptBody(bodyInput);
  assertKeyRepository(body.repository, key);
  const snapshot = parseAndVerifySnapshotRecord(snapshotInput, key, {
    repository: body.repository,
    id: body.snapshotId,
    plan: body.plan
  });
  assertReceiptSnapshotLink(body, snapshot);
  const cloned = cloneJson(body);
  return {
    ...cloned,
    authentication: signStateEnvelope("receipt", cloned, key)
  };
}

export function parseAndVerifyReceiptRecord(
  input: RecordInput,
  key: StateAuthKey,
  expected: ReceiptRecordExpectation = {}
): AuthenticatedReceiptRecord {
  const { raw, body: rawBody } = verifiedBody(input, "receipt", key);
  const body = assertReceiptBody(rawBody);
  const authentication = assertAuthentication(raw.authentication);
  assertKeyRepository(body.repository, key);
  if (expected.repository) assertRepositoryEquals(body.repository, expected.repository, "Receipt");
  if (expected.id !== undefined && body.id !== expected.id) {
    throw new StateRecordValidationError("Receipt record ID does not match expected ID");
  }
  if (expected.plan) assertPlanEquals(body.plan, expected.plan, "Receipt");
  if (expected.snapshot) assertReceiptSnapshotLink(body, expected.snapshot);
  return raw as unknown as AuthenticatedReceiptRecord;
}

export function createPlanStateRecord(
  bodyInput: PlanStateRecordBody,
  key: StateAuthKey,
  receiptInput: AuthenticatedReceiptRecord
): AuthenticatedPlanStateRecord {
  const body = assertPlanStateBody(bodyInput);
  assertKeyRepository(body.repository, key);
  const receipt = parseAndVerifyReceiptRecord(receiptInput, key, {
    repository: body.repository,
    plan: body.plan
  });
  assertPlanStateReceiptLink(body, receipt);
  const cloned = cloneJson(body);
  return {
    ...cloned,
    authentication: signStateEnvelope("plan-state", cloned, key)
  };
}

export function parseAndVerifyPlanStateRecord(
  input: RecordInput,
  key: StateAuthKey,
  expected: PlanStateRecordExpectation = {}
): AuthenticatedPlanStateRecord {
  const { raw, body: rawBody } = verifiedBody(input, "plan-state", key);
  const body = assertPlanStateBody(rawBody);
  const authentication = assertAuthentication(raw.authentication);
  assertKeyRepository(body.repository, key);
  if (expected.repository) assertRepositoryEquals(body.repository, expected.repository, "Plan-state");
  if (expected.plan) assertPlanEquals(body.plan, expected.plan, "Plan-state");
  if (expected.receipt) assertPlanStateReceiptLink(body, expected.receipt);
  return raw as unknown as AuthenticatedPlanStateRecord;
}

function snapshotBodyForDigest(
  value: SnapshotRecordBody | AuthenticatedSnapshotRecord
): SnapshotRecordBody {
  const raw = assertRecord(value, "snapshot record");
  const body = Object.prototype.hasOwnProperty.call(raw, "authentication")
    ? bodyWithoutAuthentication(raw)
    : raw;
  return assertSnapshotBody(body);
}

function receiptBodyForDigest(value: ReceiptRecordBody | AuthenticatedReceiptRecord): ReceiptRecordBody {
  const raw = assertRecord(value, "receipt record");
  const body = Object.prototype.hasOwnProperty.call(raw, "authentication")
    ? bodyWithoutAuthentication(raw)
    : raw;
  return assertReceiptBody(body);
}

export function computeSnapshotRecordDigest(
  value: SnapshotRecordBody | AuthenticatedSnapshotRecord
): string {
  return computeStateDigest("snapshot", snapshotBodyForDigest(value));
}

export function computeReceiptRecordDigest(
  value: ReceiptRecordBody | AuthenticatedReceiptRecord
): string {
  return computeStateDigest("receipt", receiptBodyForDigest(value));
}

export function exactFileStateToStored(stateInput: RuntimeExactFileState): StoredExactFileState {
  if (stateInput.kind === "absent") return ABSENT_FILE_STATE;
  if (!Buffer.isBuffer(stateInput.content)) {
    throw new StateRecordValidationError("Exact runtime file state content must be a Buffer");
  }
  const sha256 = createHash("sha256").update(stateInput.content).digest("hex");
  if (stateInput.sha256 !== sha256 || stateInput.byteLength !== stateInput.content.byteLength) {
    throw new StateRecordValidationError(
      "Exact runtime file state content does not match its digest or byte length"
    );
  }
  const stored: StoredExactRegularFileState = {
    kind: "regular",
    contentBase64: stateInput.content.toString("base64"),
    sha256,
    byteLength: stateInput.byteLength,
    mode: stateInput.mode,
    uid: stateInput.uid,
    gid: stateInput.gid,
    identity: { ...stateInput.identity }
  };
  return assertExactFileState(stored, "exact runtime file state");
}

export function decodeStoredExactFileState(stateInput: StoredExactFileState): RuntimeExactFileState {
  const state = assertExactFileState(stateInput, "stored exact file state");
  if (state.kind === "absent") return ABSENT_FILE_STATE;
  return {
    kind: "regular",
    content: Buffer.from(state.contentBase64, "base64"),
    sha256: state.sha256,
    byteLength: state.byteLength,
    mode: state.mode,
    uid: state.uid,
    gid: state.gid,
    identity: { ...state.identity }
  };
}

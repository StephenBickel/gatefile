export type RiskLevel = "low" | "medium" | "high";

export const PLAN_VERSION = "2" as const;
export const HASH_CANONICALIZER = "gatefile-v2" as const;
export const HASH_ENVELOPE_VERSION = 2 as const;

export type FileAction = "create" | "update" | "delete";

export interface FileCreateOperation {
  id: string;
  type: "file";
  action: "create";
  path: string;
  before?: never;
  after: string;
}

export interface FileUpdateOperation {
  id: string;
  type: "file";
  action: "update";
  path: string;
  before: string;
  after: string;
}

export interface FileDeleteOperation {
  id: string;
  type: "file";
  action: "delete";
  path: string;
  before: string;
  after?: never;
}

export type FileOperation = FileCreateOperation | FileUpdateOperation | FileDeleteOperation;

export interface CommandOperation {
  id: string;
  type: "command";
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  allowFailure?: boolean;
}

export type Operation = FileOperation | CommandOperation;

export type CommandPolicyMode = "allow" | "deny";

export interface CommandPolicyRule {
  executable: string;
  args: string[];
}

export interface CommandPolicy {
  mode: CommandPolicyMode;
  rules: CommandPolicyRule[];
}

export interface FilePolicy {
  allowedRoots: string[];
}

export interface ExecutionConfig {
  commandTimeoutMs?: number;
  commandPolicy?: CommandPolicy;
  filePolicy?: FilePolicy;
}

export type PreconditionKind = "git_clean" | "branch_is" | "env_present";

export interface Precondition {
  kind: PreconditionKind;
  value?: string;
  description?: string;
}

export interface RiskProfile {
  score: number;
  level: RiskLevel;
  reasons: string[];
}

export interface Approval {
  status: "pending" | "approved" | "rejected";
  approvedBy?: string;
  approvedAt?: string;
  approvedPlanHash?: string;
  attestation?: ApprovalAttestation;
}

export interface ApprovalAttestationPayload {
  type: "gatefile-approval-v1";
  planId: string;
  approvedBy: string;
  approvedAt: string;
  approvedPlanHash: string;
}

export interface ApprovalAttestation {
  scheme: "ed25519-sha256";
  keyId: string;
  publicKeyPem: string;
  payload: ApprovalAttestationPayload;
  signature: string;
}

export interface PlanIntegrity {
  algorithm: "sha256";
  canonicalizer: typeof HASH_CANONICALIZER;
  envelopeVersion: typeof HASH_ENVELOPE_VERSION;
  planHash: string;
}

export interface PlanContext {
  repositoryId: string;
}

export interface PlanFile {
  version: typeof PLAN_VERSION;
  id: string;
  createdAt: string;
  source: string;
  summary: string;
  context: PlanContext;
  dependsOn?: string[];
  operations: Operation[];
  preconditions: Precondition[];
  execution?: ExecutionConfig;
  risk: RiskProfile;
  integrity: PlanIntegrity;
  approval: Approval;
}

export type HashablePlanV2 = Omit<PlanFile, "integrity" | "approval">;

export interface HashEnvelopeV2 {
  type: "gatefile-plan-hash";
  envelopeVersion: typeof HASH_ENVELOPE_VERSION;
  plan: HashablePlanV2;
}

export interface ApplyOperationResult {
  operationId: string;
  success: boolean;
  message: string;
  mutationStatus: "none" | "intended" | "committed";
}

export type RecoveryOperationStatus = "planned" | "succeeded" | "failed" | "not-run";

export interface RecoveryOperationGuidance {
  operationId: string;
  type: Operation["type"];
  status: RecoveryOperationStatus;
  mutationStatus?: ApplyOperationResult["mutationStatus"];
  path?: string;
  guidance: string;
}

export interface RecoveryGuidance {
  transactionalRollback: false;
  affectedPaths: string[];
  attemptedOperationIds: string[];
  succeededOperationIds: string[];
  failedOperationId?: string;
  pendingOperationIds: string[];
  steps: RecoveryOperationGuidance[];
  notes: string[];
}

export interface DependencyStatus {
  requiredPlanIds: string[];
  missingPlanIds: string[];
  allSatisfied: boolean;
}

export interface SnapshotInfo {
  id: string;
  path: string;
  fileCount: number;
}

export interface ApplyReceiptInfo {
  id: string;
  path: string;
}

export interface ApplyRollbackContext {
  receiptId: string;
  repoRoot: string;
  repositoryId: string;
  stateHome: string;
}

export interface ApplyReport {
  planId: string;
  appliedAt: string;
  success: boolean;
  results: ApplyOperationResult[];
  recovery: RecoveryGuidance;
  dependencies: DependencyStatus;
  snapshot: SnapshotInfo;
  receipt: ApplyReceiptInfo;
  rollbackContext: ApplyRollbackContext;
  warnings?: string[];
  rollbackCommand: string;
}

export interface DryRunOperationPreview {
  operationId: string;
  /** Whether the operation passes static file/command policy checks. */
  allowed: boolean;
  message: string;
  details?: string;
}

export interface DryRunVerificationSummary {
  status: VerifyPlanReport["status"];
  approvalStatus: VerifyPlanReport["approvalStatus"];
  signerTrustStatus: VerifyPlanReport["signerTrust"]["status"];
  readyToApplyFromIntegrityApproval: VerifyPlanReport["readyToApplyFromIntegrityApproval"];
  blockers: string[];
}

export interface DryRunReport {
  planId: string;
  previewedAt: string;
  success: boolean;
  preconditionsChecked: false;
  verification: DryRunVerificationSummary;
  dependencies: DependencyStatus;
  results: DryRunOperationPreview[];
  staticGate: {
    passed: boolean;
    verificationReady: boolean;
    dependenciesSatisfied: boolean;
    operationsAllowed: boolean;
    preconditionsChecked: false;
  };
  recovery: RecoveryGuidance;
}

export interface HookCommandConfig {
  command: string;
  cwd?: string;
}

export type NotificationActionConfig =
  | { webhook: string; shell?: string }
  | { webhook?: string; shell: string };

export type NonEmptyStringArray = [string, ...string[]];

export type SignerTrustConfig =
  | {
      trustedKeyIds: NonEmptyStringArray;
      trustedPublicKeys?: string[];
    }
  | {
      trustedKeyIds?: string[];
      trustedPublicKeys: NonEmptyStringArray;
    };

export interface NotificationsConfig {
  onPlanCreated?: NotificationActionConfig;
  onPlanApproved?: NotificationActionConfig;
}

export interface GatefileConfig {
  signers?: SignerTrustConfig;
  hooks?: {
    beforeApprove?: HookCommandConfig;
    beforeApply?: HookCommandConfig;
    /** @deprecated Use notifications.onPlanCreated. */
    onPlanCreated?: NotificationActionConfig;
    /** @deprecated Use notifications.onPlanApproved. */
    onApprovalNeeded?: NotificationActionConfig;
  };
  notifications?: NotificationsConfig;
}

export interface HookContext {
  event: "beforeApprove" | "beforeApply";
  planId: string;
  planHash: string;
  summary: string;
  source: string;
  approvalStatus: Approval["status"];
  dependsOn: string[];
  timestamp: string;
  repoRoot: string;
  planPath?: string;
}

export interface StateFileIdentity {
  device: string;
  inode: string;
}

export interface StateDirectoryIdentity {
  relativePath: string;
  identity: StateFileIdentity;
}

export interface StateAbsentFile {
  kind: "absent";
}

export interface StateCompactRegularFile {
  kind: "regular";
  sha256: string;
  byteLength: number;
  mode: number;
  uid: string;
  gid: string;
  identity: StateFileIdentity;
}

export interface StateExactRegularFile extends StateCompactRegularFile {
  contentBase64: string;
}

export type SnapshotStoredFileState = StateAbsentFile | StateExactRegularFile;
export type ReceiptStoredFileState = StateAbsentFile | StateCompactRegularFile;

export interface StateAuthenticationTag {
  scheme: "hmac-sha256";
  envelopeVersion: 1;
  keyId: string;
  tag: string;
}

export interface StateRepositoryIdentity {
  repositoryId: string;
  repoInstanceId: string;
}

export interface StatePlanIdentity {
  id: string;
  hash: string;
}

export interface SnapshotFileEntry {
  id: string;
  operationId: string;
  action: FileAction;
  requestedPath: string;
  allowedRoot: string;
  relativePath: string;
  directoryChain: StateDirectoryIdentity[];
  before: SnapshotStoredFileState;
}

export interface SnapshotFile {
  type: "gatefile-rollback-snapshot";
  stateVersion: 1;
  id: string;
  repository: StateRepositoryIdentity;
  plan: StatePlanIdentity;
  createdAt: string;
  entries: SnapshotFileEntry[];
  authentication: StateAuthenticationTag;
}

export interface RollbackCleanupResidue {
  path: string;
  identity: StateFileIdentity;
}

export interface RollbackEntry {
  snapshotEntryId: string;
  operationId: string;
  action: FileAction;
  requestedPath: string;
  allowedRoot: string;
  relativePath: string;
  directoryChain: StateDirectoryIdentity[];
  after: ReceiptStoredFileState;
  cleanupResidues: RollbackCleanupResidue[];
}

export interface ApplyReceipt {
  type: "gatefile-apply-receipt";
  stateVersion: 1;
  id: string;
  repository: StateRepositoryIdentity;
  plan: StatePlanIdentity;
  appliedAt: string;
  snapshotId: string;
  snapshotDigest: string;
  success: boolean;
  results: Array<Required<ApplyOperationResult>>;
  dependencies: DependencyStatus;
  rollbackEntries: RollbackEntry[];
  authentication: StateAuthenticationTag;
}

export interface RollbackFileResult {
  path: string;
  restored: boolean;
  durabilityConfirmed?: boolean;
  action: "rewritten" | "deleted" | "unchanged";
  message: string;
}

export interface RollbackReport {
  receiptId: string;
  snapshotId: string;
  rolledBackAt: string;
  success: boolean;
  fileResults: RollbackFileResult[];
  notes: string[];
}

export interface VerifyPlanReport {
  planId: string;
  summary: string;
  approvalStatus: Approval["status"];
  approvalIdentity: "unsigned" | "signed" | "invalid-attestation";
  signerTrust: {
    policyConfigured: boolean;
    status: "not-configured" | "trusted" | "untrusted" | "unsigned" | "invalid-attestation";
    keyId: string | null;
    matchedBy: "keyId" | "publicKey" | null;
  };
  status: "ready" | "not-ready";
  hashes: {
    recordedPlanHash: string | null;
    currentPlanHash: string;
    approvedPlanHash: string | null;
  };
  checks: {
    planVersionSupported: boolean;
    integrityMetadataExists: boolean;
    recordedHashMatchesCurrent: boolean;
    approvalBoundToCurrentHash: boolean;
    riskMatchesRecomputed: boolean;
    repositoryContextMatches: boolean;
    approvalAttestationPresent: boolean;
    approvalAttestationValid: boolean | null;
    approvalAttestationKeyIdMatches: boolean | null;
    approvalAttestationPayloadMatchesApproval: boolean | null;
    signerTrustPolicyConfigured: boolean;
    signerTrusted: boolean | null;
    signerTrustedBy: "keyId" | "publicKey" | null;
  };
  readyToApplyFromIntegrityApproval: boolean;
  blockers: string[];
}

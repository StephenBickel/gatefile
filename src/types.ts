export type RiskLevel = "low" | "medium" | "high";

export type FileAction = "create" | "update" | "delete";

export interface FileOperation {
  id: string;
  type: "file";
  action: FileAction;
  path: string;
  before?: string;
  after?: string;
}

export interface CommandOperation {
  id: string;
  type: "command";
  command: string;
  cwd?: string;
  timeoutMs?: number;
  allowFailure?: boolean;
}

export type Operation = FileOperation | CommandOperation;

export type CommandPolicyMode = "allow" | "deny";

export interface CommandPolicy {
  mode: CommandPolicyMode;
  patterns: string[];
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
  canonicalizer: "gatefile-v1";
  planHash: string;
}

export interface PlanFile {
  version: string;
  id: string;
  createdAt: string;
  source: string;
  summary: string;
  dependsOn?: string[];
  operations: Operation[];
  preconditions: Precondition[];
  execution?: ExecutionConfig;
  risk: RiskProfile;
  integrity: PlanIntegrity;
  approval: Approval;
}

export interface ApplyOperationResult {
  operationId: string;
  success: boolean;
  message: string;
}

export type RecoveryOperationStatus = "planned" | "succeeded" | "failed" | "not-run";

export interface RecoveryOperationGuidance {
  operationId: string;
  type: Operation["type"];
  status: RecoveryOperationStatus;
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

export interface ApplyReport {
  planId: string;
  appliedAt: string;
  success: boolean;
  results: ApplyOperationResult[];
  recovery: RecoveryGuidance;
  dependencies: DependencyStatus;
  snapshot: SnapshotInfo;
  receipt: ApplyReceiptInfo;
  rollbackCommand: string;
}

export interface DryRunOperationPreview {
  operationId: string;
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
  recovery: RecoveryGuidance;
}

export interface HookCommandConfig {
  command: string;
  cwd?: string;
}

export interface GatefileConfig {
  signers?: {
    trustedKeyIds?: string[];
    trustedPublicKeys?: string[];
  };
  hooks?: {
    beforeApprove?: HookCommandConfig;
    beforeApply?: HookCommandConfig;
  };
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

export interface SnapshotFileEntry {
  operationId: string;
  path: string;
  resolvedPath: string;
  existedBefore: boolean;
  contentBefore?: string;
}

export interface SnapshotFile {
  id: string;
  planId: string;
  createdAt: string;
  repoRoot: string;
  files: SnapshotFileEntry[];
}

export interface ApplyReceipt {
  id: string;
  planId: string;
  planHash: string;
  appliedAt: string;
  success: boolean;
  snapshotId: string;
  operationResults: ApplyOperationResult[];
  dependencies: DependencyStatus;
}

export interface RollbackFileResult {
  path: string;
  restored: boolean;
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
    integrityMetadataExists: boolean;
    recordedHashMatchesCurrent: boolean;
    approvalBoundToCurrentHash: boolean;
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

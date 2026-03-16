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
}

export interface PlanIntegrity {
  algorithm: "sha256";
  canonicalizer: "planfile-v1";
  planHash: string;
}

export interface PlanFile {
  version: string;
  id: string;
  createdAt: string;
  source: string;
  summary: string;
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

export interface ApplyReport {
  planId: string;
  appliedAt: string;
  success: boolean;
  results: ApplyOperationResult[];
}

export interface DryRunOperationPreview {
  operationId: string;
  message: string;
  details?: string;
}

export interface DryRunVerificationSummary {
  status: VerifyPlanReport["status"];
  approvalStatus: VerifyPlanReport["approvalStatus"];
  readyToApplyFromIntegrityApproval: VerifyPlanReport["readyToApplyFromIntegrityApproval"];
  blockers: string[];
}

export interface DryRunReport {
  planId: string;
  previewedAt: string;
  success: boolean;
  preconditionsChecked: false;
  verification: DryRunVerificationSummary;
  results: DryRunOperationPreview[];
}

export interface VerifyPlanReport {
  planId: string;
  summary: string;
  approvalStatus: Approval["status"];
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
  };
  readyToApplyFromIntegrityApproval: boolean;
  blockers: string[];
}

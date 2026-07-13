/**
 * Reviewed package-root contract.
 *
 * Keep this file as an explicit allowlist. Internal planner, applier, state,
 * precondition, and audit-write kernels are deliberately unavailable through
 * package specifiers. The exports map is a compatibility boundary, not a
 * filesystem sandbox for code already running with access to the installation.
 */
export {
  PLAN_VERSION,
  HASH_CANONICALIZER,
  HASH_ENVELOPE_VERSION
} from "./types";
export {
  APPLY_RECEIPT_WORST_CASE_BUDGET_BYTES,
  AUTHENTICATED_STATE_FILE_MAX_BYTES,
  GatefileValidationError,
  MAX_COMMAND_ARGUMENTS,
  MAX_PLAN_DEPENDENCIES,
  MAX_PLAN_OPERATIONS,
  MAX_WORST_CASE_APPLY_RECEIPT_BYTES,
  PLAN_RECEIPT_TEXT_MAX_LENGTH,
  STATE_RECORD_BOUND_ID_MAX_LENGTH,
  STATE_RECORD_TEXT_MAX_LENGTH,
  validatePlanDraft,
  validatePlanFile
} from "./validation";
export { adaptAgentInputToDraft } from "./adapter";
export {
  formatApplySummary,
  formatDryRunSummary,
  formatRollbackSummary
} from "./apply-format";
export { scoreRisk } from "./risk";
export {
  computePlanHash,
  normalizePlanForHash,
  withComputedIntegrity
} from "./hash";
export { formatInspectSummary } from "./inspect";
export { renderPRReviewComment } from "./pr-review";
export { formatPipelineSummary, runPipeline } from "./pipeline";
export { reviewPlan } from "./review";
export {
  fireOnApprovalNeeded,
  fireOnPlanApproved,
  fireOnPlanCreated,
  loadHooksConfig
} from "./hooks";
export {
  createPlan,
  inspectPlan,
  approvePlan as approvePlanFile,
  verifyPlan as verifyPlanFile,
  applyPlan as applyPlanFile,
  rollbackApply as rollbackApplyFile
} from "./sdk";
export {
  createApprovalAttestation,
  generateApprovalAttestationKeyPair,
  verifyApprovalAttestation
} from "./attestation";
export { normalizeGatefileConfig } from "./config";
export { startMcpServer } from "./mcp";
export { GatefileEngine } from "./engine";
export {
  createPlanFromDraft,
  approvePlan,
  verifyPlan,
  buildInspectReport,
  previewPlan,
  applyPlan,
  rollbackApply
} from "./engine-api";

export type {
  Approval,
  ApprovalAttestation,
  ApprovalAttestationPayload,
  ApplyOperationResult,
  ApplyReceipt,
  ApplyReceiptAuditMetadata,
  ApplyReceiptInfo,
  ApplyReport,
  ApplyRollbackContext,
  CommandOperation,
  CommandPolicy,
  CommandPolicyMode,
  CommandPolicyRule,
  DependencyStatus,
  DryRunOperationPreview,
  DryRunReport,
  DryRunVerificationSummary,
  ExecutionConfig,
  FileAction,
  FileCreateOperation,
  FileDeleteOperation,
  FileOperation,
  FilePolicy,
  FileUpdateOperation,
  GatefileConfig,
  HashablePlanV2,
  HashEnvelopeV2,
  HookCommandConfig,
  HookContext,
  NonEmptyStringArray,
  NotificationActionConfig,
  NotificationsConfig,
  PolicyHooksConfig,
  Operation,
  PlanContext,
  PlanFile,
  PlanIntegrity,
  Precondition,
  PreconditionKind,
  ReceiptStoredFileState,
  RecoveryGuidance,
  RecoveryOperationGuidance,
  RecoveryOperationStatus,
  RiskLevel,
  RiskProfile,
  RollbackCleanupResidue,
  RollbackEntry,
  RollbackFileResult,
  RollbackReport,
  SignerTrustConfig,
  SnapshotFile,
  SnapshotFileEntry,
  SnapshotInfo,
  SnapshotStoredFileState,
  StateAbsentFile,
  StateAuthenticationTag,
  StateCompactRegularFile,
  StateDirectoryIdentity,
  StateExactRegularFile,
  StateFileIdentity,
  StatePlanIdentity,
  StateRepositoryIdentity,
  VerifyPlanReport
} from "./types";
export type {
  AdapterCommand,
  AdapterFileChange,
  AgentAdapterInput,
  AgentEnvelopeInput,
  AgentProposalInput
} from "./adapter";
export type {
  ApprovePlanOptions,
  CreatePlanOptions,
  PlanDraft
} from "./planner";
export type { PlanRuntimeOptions } from "./applier";
export type { InspectReport } from "./inspect";
export type { VerifyPlanOptions } from "./verify";
export type { PRReviewCommentInputs } from "./pr-review";
export type {
  PipelineInputError,
  PipelineInputErrorCode,
  PipelineOptions,
  PipelinePlanResult,
  PipelinePlanStatus,
  PipelineResult
} from "./pipeline";
export type { ReviewPlanOptions } from "./review";
export type {
  HookAction,
  HooksConfig,
  NotificationDispatchContext
} from "./hooks";
export type {
  ApplyOptions,
  ApprovalResult,
  ApproveOptions,
  CreateOptions,
  InspectOptions,
  InspectResult,
  RollbackContext,
  SdkApplyReport,
  SdkEngineOptions,
  VerifyOptions,
  VerifyResult
} from "./sdk";
export type {
  ApprovalAttestationVerificationResult,
  CreateApprovalAttestationOptions,
  GeneratedApprovalKeyPair
} from "./attestation";
export type {
  GatefileEngineContext,
  GatefileEngineOptions,
  EngineApproveOptions,
  EnginePlanOptions
} from "./engine";
export type { ApprovePlanApiOptions } from "./engine-api";
export type {
  McpApprovalOptions,
  McpDispatcher,
  McpServerCapabilities,
  McpServerHandle,
  McpServerOptions
} from "./mcp";
export type { ValidationIssue } from "./validation";

import { repositoryIdForRoot as resolveRepositoryIdForRoot } from "./state";
import {
  audit as readAuthenticatedAudit,
  formatAuditTable as renderAuthenticatedAuditTable
} from "./audit";

/** Authenticated apply-receipt event exposed by the package-root audit API. */
export type AuditEventType = "created" | "approved" | "applied" | "apply-failed";

export interface AuditEvent {
  type: AuditEventType;
  planId: string;
  planHash: string;
  receiptId: string;
  summary: string;
  source: string;
  timestamp: string;
  actor?: string;
  approvalIdentity?: "signed" | "unsigned";
  signerKeyId: string | null;
  authenticated: true;
  file: string;
  details?: string;
}

export interface AuditOptions {
  repoRoot?: string;
  repositoryId?: string;
  stateHome?: string;
  since?: string;
  planId?: string;
  json?: boolean;
}

export interface AuditResult {
  events: AuditEvent[];
}

/** Read audit history only from authenticated apply receipts. */
export function audit(options: AuditOptions = {}): AuditResult {
  return readAuthenticatedAudit(options);
}

export function formatAuditTable(result: AuditResult): string {
  return renderAuthenticatedAuditTable(result);
}

/** Stable, non-secret identity for binding a plan to its intended repository. */
export function repositoryIdForRoot(repoRoot?: string): string {
  return resolveRepositoryIdForRoot(repoRoot);
}

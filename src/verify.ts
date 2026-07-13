import { computePlanHash } from "./hash";
import { GatefileConfig, PLAN_VERSION, PlanFile, VerifyPlanReport } from "./types";
import { verifyApprovalAttestation } from "./attestation";
import { canonicalizePublicKeyPem, normalizeGatefileConfig } from "./config";
import { scoreRisk } from "./risk";
import { riskProfilesEqual, validatePlanFile } from "./validation";
import { repositoryIdForRoot } from "./state";

export interface VerifyPlanOptions {
  config?: GatefileConfig;
  repositoryId?: string;
  repoRoot?: string;
}

export function verifyPlan(plan: PlanFile, options: VerifyPlanOptions = {}): VerifyPlanReport {
  const config = normalizeGatefileConfig(options.config);
  const planVersionSupported = (plan as unknown as { version?: unknown }).version === PLAN_VERSION;
  if (planVersionSupported) validatePlanFile(plan);
  const recomputedRisk = planVersionSupported ? scoreRisk(plan.operations) : plan.risk;
  const riskMatchesRecomputed = planVersionSupported && riskProfilesEqual(plan.risk, recomputedRisk);
  const runtimeRepositoryId = options.repositoryId ?? repositoryIdForRoot(options.repoRoot);
  const repositoryContextMatches =
    planVersionSupported && runtimeRepositoryId === plan.context.repositoryId;
  const currentPlanHash = computePlanHash(plan);
  const recordedPlanHash = plan.integrity?.planHash ?? null;
  const approvedPlanHash = plan.approval.approvedPlanHash ?? null;
  const trustedKeyIds = new Set(config.signers?.trustedKeyIds ?? []);
  const trustedPublicKeys = new Set(config.signers?.trustedPublicKeys ?? []);
  const signerTrustPolicyConfigured = trustedKeyIds.size > 0 || trustedPublicKeys.size > 0;

  const integrityMetadataExists = Boolean(recordedPlanHash);
  const recordedHashMatchesCurrent =
    integrityMetadataExists && recordedPlanHash === currentPlanHash;
  const approvalBoundToCurrentHash =
    plan.approval.status === "approved" && approvedPlanHash === currentPlanHash;
  const approvalAttestationPresent = Boolean(plan.approval.attestation);

  let approvalAttestationValid: boolean | null = null;
  let approvalAttestationKeyIdMatches: boolean | null = null;
  let approvalAttestationPayloadMatchesApproval: boolean | null = null;
  let signerTrusted: boolean | null = null;
  let signerTrustedBy: "keyId" | "publicKey" | null = null;

  if (plan.approval.status === "approved" && plan.approval.attestation) {
    const approvedBy = plan.approval.approvedBy;
    const approvedAt = plan.approval.approvedAt;
    const approvedHash = plan.approval.approvedPlanHash;

    if (approvedBy && approvedAt && approvedHash) {
      const attestationResult = verifyApprovalAttestation(
        {
          planId: plan.id,
          approvedBy,
          approvedAt,
          approvedPlanHash: approvedHash
        },
        plan.approval.attestation
      );
      approvalAttestationValid = attestationResult.valid;
      approvalAttestationKeyIdMatches = attestationResult.keyIdMatchesPublicKey;
      approvalAttestationPayloadMatchesApproval = attestationResult.payloadMatchesApproval;
      if (attestationResult.valid && signerTrustPolicyConfigured) {
        const attestation = plan.approval.attestation;
        if (trustedKeyIds.has(attestation.keyId)) {
          signerTrusted = true;
          signerTrustedBy = "keyId";
        } else if (trustedPublicKeys.has(canonicalizePublicKeyPem(attestation.publicKeyPem))) {
          signerTrusted = true;
          signerTrustedBy = "publicKey";
        } else {
          signerTrusted = false;
        }
      }
    } else {
      approvalAttestationValid = false;
      approvalAttestationKeyIdMatches = false;
      approvalAttestationPayloadMatchesApproval = false;
      if (signerTrustPolicyConfigured) {
        signerTrusted = false;
      }
    }
  } else if (plan.approval.status === "approved" && signerTrustPolicyConfigured) {
    signerTrusted = false;
  }

  const blockers: string[] = [];
  if (!planVersionSupported) {
    blockers.push(
      `Legacy plan version ${String((plan as unknown as { version?: unknown }).version)} is inspectable but cannot be approved or applied; create and re-approve a v2 plan`
    );
  }
  if (planVersionSupported && !riskMatchesRecomputed) {
    blockers.push("Stored risk profile does not match risk recomputed from operations");
  }
  if (planVersionSupported && !repositoryContextMatches) {
    blockers.push("Plan repository context does not match the runtime repository context");
  }
  if (!integrityMetadataExists) {
    blockers.push("Missing integrity.planHash metadata");
  }
  if (!recordedHashMatchesCurrent) {
    blockers.push("Recorded integrity hash does not match current plan hash");
  }
  if (plan.approval.status !== "approved") {
    blockers.push("Plan is not approved");
  } else if (!approvalBoundToCurrentHash) {
    blockers.push("Approval is not bound to the current plan hash");
  }
  if (approvalAttestationPresent && approvalAttestationValid === false) {
    blockers.push("Approval attestation is invalid for current approval metadata");
  }
  if (signerTrustPolicyConfigured && plan.approval.status === "approved") {
    if (!approvalAttestationPresent) {
      blockers.push(
        "Signer trust policy is configured, but approval is unsigned (no attestation present)"
      );
    } else if (approvalAttestationValid === false) {
      blockers.push("Signer trust policy cannot be evaluated because attestation is invalid");
    } else if (signerTrusted === false) {
      const keyId = plan.approval.attestation?.keyId ?? "unknown";
      blockers.push(
        `Approval signer is not trusted by gatefile signer trust policy (keyId=${keyId}, checked=trustedKeyIds/trustedPublicKeys)`
      );
    }
  }

  const signerTrustStatus: VerifyPlanReport["signerTrust"]["status"] = !signerTrustPolicyConfigured
    ? "not-configured"
    : plan.approval.status !== "approved" || !approvalAttestationPresent
      ? "unsigned"
      : approvalAttestationValid === false
        ? "invalid-attestation"
        : signerTrusted
          ? "trusted"
          : "untrusted";

  const readyToApplyFromIntegrityApproval =
    planVersionSupported &&
    riskMatchesRecomputed &&
    repositoryContextMatches &&
    integrityMetadataExists &&
    recordedHashMatchesCurrent &&
    approvalBoundToCurrentHash &&
    approvalAttestationValid !== false &&
    (!signerTrustPolicyConfigured || signerTrusted === true);

  const approvalIdentity =
    plan.approval.status !== "approved" || !approvalAttestationPresent
      ? "unsigned"
      : approvalAttestationValid
        ? "signed"
        : "invalid-attestation";

  return {
    planId: plan.id,
    summary: plan.summary,
    approvalStatus: plan.approval.status,
    approvalIdentity,
    signerTrust: {
      policyConfigured: signerTrustPolicyConfigured,
      status: signerTrustStatus,
      keyId: plan.approval.attestation?.keyId ?? null,
      matchedBy: signerTrustedBy
    },
    status: readyToApplyFromIntegrityApproval ? "ready" : "not-ready",
    hashes: {
      recordedPlanHash,
      currentPlanHash,
      approvedPlanHash
    },
    checks: {
      planVersionSupported,
      integrityMetadataExists,
      recordedHashMatchesCurrent,
      approvalBoundToCurrentHash,
      riskMatchesRecomputed,
      repositoryContextMatches,
      approvalAttestationPresent,
      approvalAttestationValid,
      approvalAttestationKeyIdMatches,
      approvalAttestationPayloadMatchesApproval,
      signerTrustPolicyConfigured,
      signerTrusted,
      signerTrustedBy
    },
    readyToApplyFromIntegrityApproval,
    blockers
  };
}

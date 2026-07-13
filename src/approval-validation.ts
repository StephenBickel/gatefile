import { createPrivateKey } from "node:crypto";
import { scoreRisk } from "./risk";
import { PlanFile } from "./types";
import { riskProfilesEqual, validatePlanFile } from "./validation";

export interface ApprovalValidationOptions {
  readonly signingPrivateKeyPem?: string;
  readonly signingKeyId?: string;
}

/** Shared pre-hook validation for every approval path. */
export function validatePlanForApproval(
  plan: PlanFile,
  approvedBy: string,
  options: ApprovalValidationOptions = {}
): void {
  validatePlanFile(plan);
  const recomputedRisk = scoreRisk(plan.operations);
  if (!riskProfilesEqual(plan.risk, recomputedRisk)) {
    throw new Error("Cannot approve plan: stored risk does not match risk recomputed from operations");
  }
  if (
    typeof approvedBy !== "string" ||
    approvedBy.trim().length === 0 ||
    approvedBy.includes("\0")
  ) {
    throw new Error(
      "Cannot approve plan: approvedBy must be a non-empty string without NUL bytes"
    );
  }

  if (options.signingPrivateKeyPem === undefined) {
    if (options.signingKeyId !== undefined) {
      throw new Error("Cannot approve plan: signingKeyId requires signingPrivateKeyPem");
    }
    return;
  }
  if (
    typeof options.signingPrivateKeyPem !== "string" ||
    options.signingPrivateKeyPem.trim().length === 0 ||
    options.signingPrivateKeyPem.includes("\0")
  ) {
    throw new Error("Cannot approve plan: signingPrivateKeyPem must be a non-empty PEM key");
  }
  if (
    options.signingKeyId !== undefined &&
    (
      typeof options.signingKeyId !== "string" ||
      options.signingKeyId.trim().length === 0 ||
      options.signingKeyId.includes("\0")
    )
  ) {
    throw new Error("Cannot approve plan: signingKeyId must be a non-empty string without NUL bytes");
  }

  try {
    const privateKey = createPrivateKey({
      format: "pem",
      key: options.signingPrivateKeyPem
    });
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("not an Ed25519 key");
    }
  } catch {
    throw new Error("Cannot approve plan: signingPrivateKeyPem must contain a valid Ed25519 private key");
  }
}

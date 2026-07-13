import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject
} from "node:crypto";
import { ApprovalAttestation, ApprovalAttestationPayload } from "./types";
import {
  approvalKeyIdFromPublicKey,
  canonicalizeApprovalPublicKeyPem,
  isCanonicalApprovalSignature
} from "./approval-key";

export const APPROVAL_ATTESTATION_TYPE = "gatefile-approval-v1";

interface AttestableApprovalFields {
  planId: string;
  approvedBy: string;
  approvedAt: string;
  approvedPlanHash: string;
}

export interface GeneratedApprovalKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
}

function payloadToSigningMessage(payload: ApprovalAttestationPayload): string {
  return JSON.stringify([
    payload.type,
    payload.planId,
    payload.approvedBy,
    payload.approvedAt,
    payload.approvedPlanHash
  ]);
}

function createPayload(fields: AttestableApprovalFields): ApprovalAttestationPayload {
  return {
    type: APPROVAL_ATTESTATION_TYPE,
    planId: fields.planId,
    approvedBy: fields.approvedBy,
    approvedAt: fields.approvedAt,
    approvedPlanHash: fields.approvedPlanHash
  };
}

function parsePrivateKey(privateKeyPem: string): KeyObject {
  const key = createPrivateKey({ format: "pem", key: privateKeyPem });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("approval signing keys must use Ed25519");
  }
  return key;
}

function parsePublicKey(publicKeyPem: string): KeyObject {
  return createPublicKey({
    format: "pem",
    key: canonicalizeApprovalPublicKeyPem(publicKeyPem)
  });
}

export function generateApprovalAttestationKeyPair(): GeneratedApprovalKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();

  return {
    privateKeyPem,
    publicKeyPem,
    keyId: approvalKeyIdFromPublicKey(publicKey)
  };
}

export interface CreateApprovalAttestationOptions {
  /** Optional key ID assertion; it must equal the ID derived from the signing key. */
  keyId?: string;
}

export function createApprovalAttestation(
  fields: AttestableApprovalFields,
  signingPrivateKeyPem: string,
  options: CreateApprovalAttestationOptions = {}
): ApprovalAttestation {
  const privateKey = parsePrivateKey(signingPrivateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const derivedKeyId = approvalKeyIdFromPublicKey(publicKey);
  if (options.keyId !== undefined && options.keyId !== derivedKeyId) {
    throw new Error(
      `approval key ID must match the signing key (${derivedKeyId})`
    );
  }
  const payload = createPayload(fields);
  const message = payloadToSigningMessage(payload);
  const signature = sign(null, Buffer.from(message, "utf-8"), privateKey).toString("base64");

  return {
    scheme: "ed25519-sha256",
    keyId: derivedKeyId,
    publicKeyPem,
    payload,
    signature
  };
}

export interface ApprovalAttestationVerificationResult {
  schemeMatches: boolean;
  keyIdMatchesPublicKey: boolean;
  payloadMatchesApproval: boolean;
  signatureValid: boolean;
  valid: boolean;
}

export function verifyApprovalAttestation(
  fields: AttestableApprovalFields,
  attestation: ApprovalAttestation
): ApprovalAttestationVerificationResult {
  const schemeMatches = attestation.scheme === "ed25519-sha256";
  const expectedPayload = createPayload(fields);
  const payloadMatchesApproval =
    attestation.payload.type === expectedPayload.type &&
    attestation.payload.planId === expectedPayload.planId &&
    attestation.payload.approvedBy === expectedPayload.approvedBy &&
    attestation.payload.approvedAt === expectedPayload.approvedAt &&
    attestation.payload.approvedPlanHash === expectedPayload.approvedPlanHash;

  let keyIdMatchesPublicKey = false;
  let signatureValid = false;

  try {
    const publicKey = parsePublicKey(attestation.publicKeyPem);
    keyIdMatchesPublicKey = approvalKeyIdFromPublicKey(publicKey) === attestation.keyId;

    const message = payloadToSigningMessage(attestation.payload);
    signatureValid =
      isCanonicalApprovalSignature(attestation.signature) &&
      verify(
        null,
        Buffer.from(message, "utf-8"),
        publicKey,
        Buffer.from(attestation.signature, "base64")
      );
  } catch {
    keyIdMatchesPublicKey = false;
    signatureValid = false;
  }

  return {
    schemeMatches,
    keyIdMatchesPublicKey,
    payloadMatchesApproval,
    signatureValid,
    valid:
      schemeMatches &&
      keyIdMatchesPublicKey &&
      payloadMatchesApproval &&
      signatureValid
  };
}

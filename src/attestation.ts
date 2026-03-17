import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject
} from "node:crypto";
import { ApprovalAttestation, ApprovalAttestationPayload } from "./types";

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

function keyIdFromPublicKey(publicKey: KeyObject): string {
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  const digest = createHash("sha256").update(spkiDer).digest("hex");
  return `gfk1_${digest.slice(0, 16)}`;
}

function parsePrivateKey(privateKeyPem: string): KeyObject {
  return createPrivateKey({ format: "pem", key: privateKeyPem });
}

function parsePublicKey(publicKeyPem: string): KeyObject {
  return createPublicKey({ format: "pem", key: publicKeyPem });
}

export function generateApprovalAttestationKeyPair(): GeneratedApprovalKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();

  return {
    privateKeyPem,
    publicKeyPem,
    keyId: keyIdFromPublicKey(publicKey)
  };
}

export interface CreateApprovalAttestationOptions {
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
  const payload = createPayload(fields);
  const message = payloadToSigningMessage(payload);
  const signature = sign(null, Buffer.from(message, "utf-8"), privateKey).toString("base64");

  return {
    scheme: "ed25519-sha256",
    keyId: options.keyId ?? keyIdFromPublicKey(publicKey),
    publicKeyPem,
    payload,
    signature
  };
}

export interface ApprovalAttestationVerificationResult {
  keyIdMatchesPublicKey: boolean;
  payloadMatchesApproval: boolean;
  signatureValid: boolean;
  valid: boolean;
}

export function verifyApprovalAttestation(
  fields: AttestableApprovalFields,
  attestation: ApprovalAttestation
): ApprovalAttestationVerificationResult {
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
    keyIdMatchesPublicKey = keyIdFromPublicKey(publicKey) === attestation.keyId;

    const message = payloadToSigningMessage(attestation.payload);
    signatureValid = verify(
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
    keyIdMatchesPublicKey,
    payloadMatchesApproval,
    signatureValid,
    valid: keyIdMatchesPublicKey && payloadMatchesApproval && signatureValid
  };
}

import { createHash, createPublicKey, type KeyObject } from "node:crypto";

export const APPROVAL_KEY_ID_PATTERN = /^gfk1_[a-f0-9]{16}$/;
export const APPROVAL_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{85}[AQgw]==$/;

const ED25519_SPKI_PUBLIC_PEM =
  /^-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=\n-----END PUBLIC KEY-----$/;

export function isApprovalKeyId(value: string): boolean {
  return APPROVAL_KEY_ID_PATTERN.test(value);
}

export function isCanonicalApprovalSignature(value: string): boolean {
  if (!APPROVAL_SIGNATURE_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 64 && decoded.toString("base64") === value;
}

export function canonicalizeApprovalPublicKeyPem(value: string): string {
  const normalized = value.trim().replace(/\r\n/g, "\n");
  if (!ED25519_SPKI_PUBLIC_PEM.test(normalized)) {
    throw new Error("must contain one Ed25519 SPKI public PEM block");
  }
  const key = createPublicKey({ format: "pem", key: normalized });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("must contain an Ed25519 public key");
  }
  const canonical = key.export({ format: "pem", type: "spki" }).toString().trim();
  if (canonical !== normalized) {
    throw new Error("must use canonical SPKI public PEM encoding");
  }
  return canonical;
}

export function approvalKeyIdFromPublicKey(publicKey: KeyObject): string {
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("approval signing keys must use Ed25519");
  }
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  const digest = createHash("sha256").update(spkiDer).digest("hex");
  return `gfk1_${digest.slice(0, 16)}`;
}

# Signed Approvals + Signer Trust Policy

Gatefile supports Ed25519 approval attestations and a repo-local signer trust policy.

This lets Gatefile distinguish between:
- cryptographically valid signatures
- signatures from trusted signers for this repo

## Model

- `approval.attestation` is optional and signs `planId`, `approvedBy`, `approvedAt`, `approvedPlanHash`.
- `gatefile.config.json` can declare trusted signer identities:
  - `signers.trustedKeyIds`
  - `signers.trustedPublicKeys`

When trust policy is configured, Gatefile requires an approval attestation from a trusted signer for `verify-plan.status` to be `ready`.

## Verify Behavior

`verify-plan` includes:
- `approvalIdentity`: `unsigned` | `signed` | `invalid-attestation`
- `signerTrust.status`: `not-configured` | `trusted` | `untrusted` | `unsigned` | `invalid-attestation`

Enforcement:
- no trust policy configured: existing behavior remains (valid signed or unsigned approvals still work)
- trust policy configured:
  - unsigned approvals are `not-ready`
  - invalid attestations are `not-ready`
  - signed-but-untrusted approvals are `not-ready`
  - only trusted signed approvals are `ready`

## Operator Setup

1. Generate signer keypair:

```bash
gatefile generate-attestation-key \
  --out-private .gatefile/approver.pem \
  --out-public .gatefile/approver.pub.pem
```

2. Keep private key out of git and out of plaintext logs.
3. Distribute public identity to repo operators:
  - key ID printed by `generate-attestation-key`, and/or
  - public key PEM
4. Configure repo trust policy in `gatefile.config.json`:

```json
{
  "signers": {
    "trustedKeyIds": ["security-team-prod-1"],
    "trustedPublicKeys": [
      "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA3BpXovQEPSywMnUz4IdaCBTGcIH+6gRV9kt1SMjg7bE=\n-----END PUBLIC KEY-----"
    ]
  }
}
```

5. Lint config before rollout:

```bash
gatefile lint-config
```

`lint-config` fails fast on malformed PEMs, empty signer trust policy, and invalid config shapes.

6. Approve with signing key:

```bash
gatefile approve-plan .plan/plan.json \
  --by steve \
  --signing-key .gatefile/approver.pem
```

7. Verify trust state:

```bash
gatefile verify-plan .plan/plan.json
```

Look for:
- `approvalIdentity: "signed"`
- `signerTrust.status: "trusted"`
- `status: "ready"`

## GitHub-Native Signed Approval

Same-repo PR branch flow:
- `docs/examples/github-native-signed-approval.yml`

This workflow:
- checks out the PR branch
- writes private key from secret to a temp file with strict permissions
- signs plan approval in CI
- verifies `status === "ready"` and `signerTrust.status === "trusted"`
- commits the updated `.plan/plan.json` back to the PR branch

Fork-safe artifact handoff flow:
- `docs/examples/github-native-signed-approval-fork-request.yml`
- `docs/examples/github-native-signed-approval-fork-sign.yml`

This pattern avoids pushing to fork PR branches from the signing workflow.

Also see:
- `docs/github-pr-gate-example.md`

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
install -d -m 700 "$HOME/.config/gatefile"
gatefile generate-attestation-key \
  --out-private "$HOME/.config/gatefile/approver.pem" \
  --out-public .gatefile/approver.pub.pem
```

Each file publication is made crash-durable, but the private and public files
are published separately rather than as one cross-directory transaction. If
generation reports a failure, inspect and remove any newly created member of
the pair before retrying.

2. Keep the private key outside the repository, out of git, and out of
   plaintext logs. Restrict it to the signing user.
3. Distribute public identity to repo operators:
  - key ID printed by `generate-attestation-key`, and/or
  - Ed25519 public key encoded as SPKI PEM (`BEGIN PUBLIC KEY`)

Gatefile rejects private PEM blocks and non-Ed25519 keys in
`signers.trustedPublicKeys`; never place the private key in repository config.
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
  --signing-key "$HOME/.config/gatefile/approver.pem"
```

7. Verify trust state:

```bash
gatefile verify-plan .plan/plan.json
```

Look for:
- `approvalIdentity: "signed"`
- `signerTrust.status: "trusted"`
- `status: "ready"`

## Fork-Safe GitHub Signed Approval

Use the artifact handoff pair:
- `docs/examples/github-native-signed-approval-fork-request.yml`
- `docs/examples/github-native-signed-approval-fork-sign.yml`

The PR workflow has read-only repository permission and no signing secret. It may use PR code to produce an unsigned plan and context, then uploads only those files as inert artifacts.

The separate signing workflow must run trusted default-branch or immutable release code. It treats the downloaded JSON files as data, signs a copy, and never executes code or hooks from the PR. Any approval hook that the trusted Gatefile release invokes must also come from that trusted checkout. The workflow verifies that the signed artifact is trusted and ready, uploads it, and never pushes to the PR branch.

## Rotate a key used with the removed same-repository example

Anyone who copied or used the removed same-repository signing workflow should rotate its signing identity:

1. Generate a replacement keypair outside the repository. Keep the new private key out of git and retain the printed key ID and public key PEM.
2. Replace the GitHub Actions secret `GATEFILE_SIGNING_KEY_PEM` with the new private key at every repository, environment, or organization scope where the copied workflow used it. Do not keep the old value as a fallback.
3. Update every applicable `gatefile.config.json` trust policy with the replacement `signers.trustedPublicKeys` entry and/or `signers.trustedKeyIds` entry. Roll out the replacement identity before removing the old one if uninterrupted verification is required.
4. Revoke the old key after the replacement is deployed: remove its public key and key ID from every trust policy, delete remaining copies of its private key and GitHub secret value, and invalidate or re-approve outstanding artifacts according to local policy. In Gatefile, removing the old identity from the trust allowlist is what makes its later signatures untrusted.
5. Verify the replacement by signing a fresh inert artifact through the fork-safe flow and running `gatefile verify-plan`. Require `approvalIdentity: "signed"`, `signerTrust.status: "trusted"`, `status: "ready"`, and the expected replacement key ID before retiring the rotation change.

Repository status on 2026-07-12: The repository scan found no tracked private key, and the GitHub Actions repository-secret inventory returned no repository secrets. Therefore, no in-scope live key existed to rotate. This does not establish that copies outside this repository were rotated; operators who copied the removed workflow must complete the steps above in each affected scope.

Also see:
- `docs/github-pr-gate-example.md`

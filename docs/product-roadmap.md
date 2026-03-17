# gatefile Product Roadmap (2026)

Gatefile is being developed as a full product for governed agent execution, not a demo-only MVP.

## Current Baseline (shipped in 0.1.x)

- Hash-bound plan integrity and approvals (`create/inspect/verify/approve/apply`)
- File/command policy guardrails, timeouts, and precondition checks
- Dry-run previews and human-readable apply summaries
- Snapshot/receipt-backed rollback for Gatefile-managed file operations
- Policy hooks (`beforeApprove`, `beforeApply`)
- Plan dependency sequencing (`dependsOn`)
- GitHub PR review surfaces and adapter ingestion

## Phase 1: Provable Approvals + PR-Native Gating (now)

Rationale: trust bottleneck is approval identity, and GitHub PR is the dominant review venue.

- Signed approvals/attestations (Ed25519) with local key generation and verifier integration
- Signer trust policy (`gatefile.config.json`) for trusted key IDs/public keys
- Preserve existing hash-bound semantics while upgrading identity proof when signature is present
- Expand PR review output to surface approval identity state (`unsigned`, `signed`, `invalid-attestation`)
- Expand PR output and gate signals to include signer trust state (`trusted`, `untrusted`, `unsigned`)
- Publish operator guidance for key generation/distribution, trust config, and GitHub signing flow

## Phase 2: GitHub-Native Review/Approval UX

Rationale: reduce friction between plan review and repo review.

- Official GitHub Action + check-run package with first-party maintained status signals
- Structured PR comment renderer with re-run safe updates and blocker classification
- Optional required-status policy templates for branch protection
- Approval UX that can sign from CI-safe contexts without exposing raw secret material in logs
- First-party GitHub workflow example for CI-native signed approvals on PR branches

## Phase 3: Official Agent Adapters + SDKs

Rationale: product adoption depends on easy integration across agent ecosystems.

- Stable adapter contracts and versioned ingestion schema
- Official SDKs: TypeScript first, then Python
- Reference adapters for common agent frameworks with conformance tests
- Compatibility matrix and deprecation policy for adapter payload versions

## Phase 4: Integrity + Rollback Hardening

Rationale: production usage needs stronger tamper evidence and recoverability.

- Snapshot integrity chaining (hash-linked receipts/snapshots)
- Optional signed apply receipts for audit replay
- Better command-side recovery support (operator-defined compensating actions)
- Integrity and rollback diagnostics in inspect/verify outputs

## Phase 5: Policy Packs + Multi-Plan Orchestration

Rationale: enterprise teams need opinionated defaults and coordinated change sets.

- Curated policy packs (baseline, strict, regulated) with documented tradeoffs
- Policy inheritance/overrides at repo and plan scopes
- Multi-plan orchestration DAG with staged approvals and execution windows
- Cross-plan risk rollups and dependency failure impact reporting

## Phase 6: Commercial Packaging + Launch

Rationale: convert OSS utility into an adoptable, supportable product surface.

- Product packaging: OSS core + managed control-plane options
- Team features: signer management UX, audit export, policy lifecycle tooling
- Launch assets: migration guide, reference architectures, hardening checklist, pricing/packaging docs
- Security and compliance readiness workstream (threat model, key-handling posture, disclosure policy)

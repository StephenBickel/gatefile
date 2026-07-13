# gatefile Product Roadmap (2026)

**Status: Experimental alpha — not production-ready.**

Gatefile is being developed toward a full product for governed agent execution, but the current `0.3.0-alpha.0` package is for controlled evaluation only.

## Alpha stabilization freeze

Feature expansion is frozen while the existing surface is stabilized. Accepted work is limited to:

- Security fixes
- Correctness fixes
- Compatibility work
- Tests
- Documentation
- Release stabilization

New product surface and feature work are deferred until the stabilization freeze ends. The roadmap phases below describe deferred direction, not active feature commitments.

## Current implemented baseline

- Hash-bound plan integrity and approvals (`create/inspect/verify/approve/apply`)
- File/command policy guardrails, timeouts, and precondition checks
- Dry-run previews and human-readable apply summaries
- Snapshot/receipt-backed rollback for Gatefile-managed file operations
- Policy hooks (`beforeApprove`, `beforeApply`)
- Plan dependency sequencing (`dependsOn`)
- GitHub PR review surfaces and adapter ingestion
- `GatefileEngine` as the primary supported in-memory policy boundary, with an
  immutable pinned repository/state context and per-method policy snapshots
- Engine-backed package-root lifecycle compatibility functions
- Engine delegation across the CLI, SDK, pipeline, interactive review, PR review,
  and MCP first-party adapters
- Strict runtime/JSON Schema parity for signer trust, blocking policy hooks, and
  best-effort lifecycle notifications, including fail-closed unknown-key checks
- Complete inspect verification snapshots plus dry-run `staticGate` evidence for
  verification, dependencies, and per-operation policy decisions
- Deterministic, validate-before-mutate pipelines with structured malformed-input,
  duplicate-ID, and dependency-cycle errors
- Audit projected only from authenticated external receipt/snapshot chains;
  repository-local legacy audit files are not trusted
- An explicit installed-package export allowlist for the root API, both JSON
  schemas, and package metadata, with unsupported `dist/*` package specifiers
  blocked (a compatibility boundary, not a same-process filesystem sandbox)
- A startup-pinned MCP authority model with confined I/O, strict JSON-RPC
  validation, bounded command output capture, and capability-gated mutations
- A reusable GitHub Action that executes action-owned Gatefile code, requires a
  tracked plan plus trusted policy or an explicit unsigned opt-in, and preserves
  a runner-staged, manifest-bound evidence bundle before enforcing readiness

## Current stabilization boundary

When an engine is constructed without explicit config, it reloads the pinned
repository's `gatefile.config.json` once for each policy-sensitive method so
long-running processes observe policy changes. Supplying `config` instead pins a
normalized, defensively copied snapshot. Every policy check within one engine
method receives the same snapshot, canonical repository root, repository ID,
and state home. Rollback does not reload repository config, preserving
authenticated recovery when policy is malformed.

The machine-facing stabilization contracts are now explicit. The installed
package exposes only its allowlisted root API, both schemas, and package
metadata. Runtime config and the published schema share one strict shape;
canonical notifications are best-effort and cannot change authorization.
Audit reads only authenticated external receipts. Dry-run and pipeline reports
carry machine-readable gate and input-error evidence rather than relying on
process exit alone.

Long-running MCP authority is fixed at startup. Requests cannot substitute a
repository, state home, or signing key, and mutation tools do not exist unless
their startup capabilities are enabled. The reusable Action similarly runs its
own Gatefile checkout and produces commit-, policy-, and plan-bound evidence
before its final enforcement step. These are alpha contracts backed by
conformance tests, not a claim that arbitrary command side effects are sandboxed
or automatically reversible.

## Deferred feature roadmap

### Phase 1: Provable Approvals + PR-Native Gating

Rationale: trust bottleneck is approval identity, and GitHub PR is the dominant review venue.

- Signed approvals/attestations (Ed25519) with local key generation and verifier integration
- Signer trust policy (`gatefile.config.json`) for trusted key IDs/public keys
- Preserve existing hash-bound semantics while upgrading identity proof when signature is present
- Expand PR review output to surface approval identity state (`unsigned`, `signed`, `invalid-attestation`)
- Expand PR output and gate signals to include signer trust state (`trusted`, `untrusted`, `unsigned`)
- Publish operator guidance for key generation/distribution, trust config, and GitHub signing flow

### Phase 2: GitHub-Native Review/Approval UX

Rationale: reduce friction between plan review and repo review.

- Reusable first-party GitHub Action for trusted-policy verification and bound
  evidence artifacts (alpha implemented)
- First-party check-run integration with maintained status signals
- Structured PR comment renderer with re-run safe updates and blocker classification
- Optional required-status policy templates for branch protection
- Approval UX that can sign from CI-safe contexts without exposing raw secret material in logs
- First-party GitHub workflow example for fork-safe signed approvals using an artifact handoff

### Phase 3: Official Agent Adapters + SDKs

Rationale: product adoption depends on easy integration across agent ecosystems.

- Stable adapter contracts and versioned ingestion schema
- Official SDKs: TypeScript first, then Python
- Reference adapters for common agent frameworks with conformance tests
- Compatibility matrix and deprecation policy for adapter payload versions

### Phase 4: Integrity + Rollback Hardening

Rationale: production usage needs stronger tamper evidence and recoverability.

- Authenticated snapshot/receipt chaining with repository and plan binding (alpha implemented)
- Replay-resistant rollback receipts and post-apply drift checks (alpha implemented)
- Better command-side recovery support (operator-defined compensating actions)
- Integrity and rollback diagnostics in inspect/verify outputs

### Phase 5: Policy Packs + Multi-Plan Orchestration

Rationale: enterprise teams need opinionated defaults and coordinated change sets.

- Curated policy packs (baseline, strict, regulated) with documented tradeoffs
- Policy inheritance/overrides at repo and plan scopes
- Multi-plan orchestration DAG with staged approvals and execution windows
- Cross-plan risk rollups and dependency failure impact reporting

### Phase 6: Commercial Packaging + Launch

Rationale: convert OSS utility into an adoptable, supportable product surface.

- Product packaging: OSS core + managed control-plane options
- Team features: signer management UX, audit export, policy lifecycle tooling
- Launch assets: migration guide, reference architectures, hardening checklist, pricing/packaging docs
- Security and compliance readiness workstream (threat model, key-handling posture, disclosure policy)

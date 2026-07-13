# Stabilization Backlog

**Status: Experimental alpha — not production-ready.**

Feature expansion is frozen. Active work is limited to security fixes,
correctness fixes, compatibility work, tests, documentation, and release
stabilization.

## 0.3 Alpha Release Boundary

- Publish `0.3.0-alpha.0` under npm's `next` tag only after the clean package,
  test, typecheck, demo, audit, and installed-consumer checks pass.
- Create a matching immutable Git tag and GitHub prerelease with the changelog
  and migration guide.
- Enable GitHub private vulnerability reporting. Until then, use the
  detail-free contact-request process in `SECURITY.md`.
- Keep the prerelease warning and POSIX/Node.js support boundary prominent in
  every installation path.

The current alpha already includes strict v2 plans, structured commands,
external authenticated state, signed approvals and trust policy, a pinned MCP
authority model, explicit package exports, and an action-owned GitHub PR gate.
Those are stabilization surfaces, not deferred features.

## Deferred Post-Alpha Work

- Windows execution after equivalent owner-private DACL and filesystem checks
  exist.
- A native filesystem broker for stronger protection from concurrent namespace
  races by the same OS user.
- Resumable rollback after a receipt has been claimed.
- Operator-defined compensating actions for command side effects.
- Stable adapter and SDK contracts, compatibility matrices, and deprecation
  policy.
- Maintained GitHub check-run/comment delivery and protected required-workflow
  templates.
- Policy packs, inheritance, and richer multi-plan orchestration.

See `docs/product-roadmap.md` for status by roadmap phase.

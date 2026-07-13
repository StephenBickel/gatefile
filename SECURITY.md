# Security Policy

Gatefile is experimental alpha software and is not a complete sandbox. Do not
use it as the sole security boundary for production agent execution.

## Supported versions

| Version | Security-report status |
|---|---|
| `main` / `0.3.x` prereleases | Reports accepted; fixes target the current stabilization branch |
| `0.2.x` and earlier | No security backports; migrate to a supported 0.3 prerelease |

Gatefile 0.3 prereleases use npm's `next` tag. Confirm the available version with
`npm view gatefile@next version`; the unversioned `latest` tag follows a separate
stable-release policy.

## Report a vulnerability without public details

Use [GitHub private vulnerability reporting](https://github.com/StephenBickel/gatefile/security/advisories/new)
if that form is available. If it is unavailable, use this detail-free contact
handshake:

1. Open a [new public issue](https://github.com/StephenBickel/gatefile/issues/new)
   titled `Security contact request`.
2. Put only `Please provide a private channel for a Gatefile security report.`
   in the body. Your GitHub account is sufficient contact information.
3. Do **not** include the affected component, vulnerability class, reproduction,
   exploit code, logs, credentials, tokens, customer data, or any other
   sensitive detail in the issue.
4. Wait for a maintainer to arrange a private channel or enable GitHub private
   vulnerability reporting before sending technical details.

Never post a vulnerability proof of concept to a regular bug report, pull
request, discussion, or public chat. If you accidentally disclose sensitive
material, revoke exposed credentials first and remove the public content where
the platform permits.

## What to include privately

Once a private channel exists, include:

- the affected Gatefile version or commit;
- the operating system, filesystem, and Node.js version;
- the smallest safe reproduction;
- the security impact and required attacker capabilities;
- whether the issue is already public or actively exploited; and
- any suggested remediation, if known.

Redact secrets and personal or customer data. Use inert test repositories and
credentials wherever possible.

## Scope notes

Particularly useful reports cover authorization bypasses, plan/hash confusion,
signature or signer-trust failures, repository/state authority substitution,
filesystem confinement escapes, receipt or rollback authentication failures,
MCP protocol/authority violations, and GitHub Action evidence or policy bypasses.

Expected and documented alpha limitations include lack of a complete process
sandbox, inability to protect against an already-running hostile same-user
process, non-transactional multi-file rollback, and no automatic reversal of
arbitrary command side effects. A report showing that an implementation violates
its documented fail-closed boundary is still in scope.

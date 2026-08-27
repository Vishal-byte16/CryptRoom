# CryptRoom Critical and High Vulnerability Remediation Plan

## Objective and guardrails

Reduce the remaining `pnpm audit` critical and high findings while preserving CryptRoom’s two-person, browser-encrypted, single-process architecture. Each stage must run in its own checkpoint or branch, retain the current lockfile until its replacement passes verification, and finish with `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test`, `pnpm build`, and `pnpm audit`. Do not use blanket `pnpm up --latest`, suppress advisories, or lower security controls to obtain a green audit.

## Current high-priority findings

| Priority | Package and installed path | Fixed target | Production relevance | Remediation approach |
|---|---|---|---|---|
| P0 | `path-to-regexp` 0.1.12 via `express` 4.21.2 | 0.1.13+ | **Runtime**: Express route matching is loaded by the deployed server. | First test a constrained lockfile override to 0.1.13. If it changes routing behavior, use a controlled Express 5 migration instead. |
| P1 | `vitest` 2.1.9 direct | 3.2.6+ | **Test-only**: not bundled into the deployed server. | Upgrade the test runner in an isolated compatibility change; it should also refresh its Vite/Rollup/PostCSS/NanoID subtree. |
| P1 | `vite` 5.4.21, `rollup` 4.52.4, `postcss` 8.5.6, `nanoid` 3.3.11 via Vitest | Vite 6.4.3+, Rollup 4.59.0+, PostCSS 8.5.18+, NanoID 3.3.18+ | **Test-only subtree**. The production build uses direct Vite 7.3.6. | Resolve through the controlled Vitest upgrade; only use scoped overrides if the test runner cannot resolve patched compatible versions. |
| P1 | `tar` 7.5.1 via `@tailwindcss/vite` → `oxide` | 7.5.21+ covers every reported high advisory; 7.5.19+ covers critical | **Build-only**: no application route extracts user archives. | Test a narrow `pnpm.overrides.tar` update to 7.5.21 and verify Tailwind/Vite builds on a clean install. |

## Step 0 — Preserve the verified baseline

Create a checkpoint and record the current audit JSON, lockfile hash, test output, and production smoke results. Confirm that `dist/` is absent from the repository. This gives each subsequent stage an explicit rollback target if a dependency change alters the room, relay, or security-header behavior.

## Step 1 — Remediate the runtime Express route-matching finding

Add a temporary, explicit `pnpm.overrides` entry for `path-to-regexp: 0.1.13` rather than changing Express major versions immediately. Regenerate the lockfile with the project package manager, then inspect `pnpm why path-to-regexp` to prove only the intended resolution changed.

Run the server route, tRPC, health, cleanup-authentication, Socket.IO handshake, and production-header smoke tests. In particular, verify `/health`, `/api/trpc`, `/api/realtime`, cleanup routing, and the application fallback route. If all checks pass, retain the override and close the P0 runtime finding. If any routing regression appears, revert the override and open a controlled Express 5 migration workstream with an expanded HTTP/Sockets regression suite; do not force the migration into the same patch.

## Step 2 — Upgrade Vitest as one compatibility unit

Create a dedicated checkpoint/branch and upgrade direct Vitest first to the smallest patched compatible release (`>=3.2.6`), preferring the current stable release only after reviewing its peer requirements against direct Vite 7.3.6 and TypeScript 5.9.3. Do not manually pin Vite, Rollup, PostCSS, or NanoID before observing the new Vitest resolution.

Resolve test-runner migration errors rather than skipping tests. Review configuration, globals, fake timers, Socket.IO harness behavior, browser-crypto shims, and reporter output. Then run the full room, relay, rate-limit, and cryptography suite at least twice to detect database timing flakiness. Re-audit to confirm whether the Vitest transitive Vite/Rollup/PostCSS/NanoID advisories disappear.

If a current Vitest release requires changes incompatible with the existing stack, retain the current verified test runner, record the exact peer conflict, and use a scoped patch-level override only when its release notes and a clean test/build run show compatibility.

## Step 3 — Patch the Tailwind native-toolchain `tar` dependency

In a separate checkpoint, add the narrowest resolution that satisfies the complete advisory set: `pnpm.overrides.tar: "7.5.21"`. Perform a clean `pnpm install --frozen-lockfile` after deleting only disposable install artifacts, then run `pnpm build` twice. Confirm the Tailwind Vite plugin, native Oxide resolution, generated CSS, and production bundle remain functional.

Because this package is used in build tooling rather than the deployed request path, treat failure to resolve it as a release-engineering blocker rather than a reason to modify CryptRoom’s encryption or relay code. Revert the override if native tooling breaks and pursue an upstream Tailwind plugin update in its own compatibility stage.

## Step 4 — Re-audit and classify residual findings

Run `pnpm audit --json` and produce a fresh matrix containing installed version, dependency path, vulnerable range, fixed version, direct/transitive status, dev/runtime relevance, CryptRoom reachability, and chosen disposition for every remaining critical or high advisory. A finding may be accepted only when it is demonstrably outside the deployed request path or lacks a safe compatible fix, with a named owner and review date.

## Step 5 — Release gate

Promote only after all changed dependency stages pass the following gate:

| Gate | Required evidence |
|---|---|
| Dependency integrity | Clean frozen install and reviewed lockfile diff. |
| Application safety | Typecheck, full test suite twice, and production build pass. |
| Runtime safety | Production explicit-port start, `/health`, security headers, Socket.IO allowed-origin rejection/acceptance, and cleanup endpoint authentication smoke pass. |
| Privacy invariants | No chat persistence, no secret/key/plaintext logging, no tracking/runtime regression, and no generated artifacts committed. |
| Audit result | No unreviewed critical/high findings; all residual findings have documented scope and mitigation. |

## Recommended execution order

1. **Immediately:** test the `path-to-regexp` 0.1.13 override because it is the only remaining high finding in the deployed runtime path.
2. **Next:** perform the Vitest migration in isolation and let it resolve the Vite/Rollup/PostCSS/NanoID test subtree as a unit.
3. **Then:** test the `tar` 7.5.21 override with repeat clean builds.
4. **Finally:** re-run the full security suite and update the readiness decision from evidence, not advisory-count reduction alone.

# CRYPTROOM 7 — FINAL VERIFICATION REPORT

## Issue Fixed

The relay previously bounded reverse arrival by keeping a successor such as sequence 2 pending until sequence 1 arrived, but did not independently expire that pending item. `server/roomRelay.ts` now assigns each deferred envelope a bounded ordering timer: **3 seconds in normal operation** and **80 ms under tests**, configurable through `OUT_OF_ORDER_TIMEOUT_MS` within the safe range of 50–10,000 ms. On expiry, the pending entry is removed, its sequence is retained as a bounded rejected tombstone, and the original sender receives a structured `REPLAY_REJECTED` acknowledgement stating that the envelope expired while waiting for an earlier sequence.

The timer neither advances `lastSequence` nor accepts skipped values. If the predecessor later arrives, the relay advances through expired tombstones only as rejection markers and may then accept the next legitimate sequence. Pending timers are cancelled when a predecessor arrives in time and the envelope is released. The per-participant message queue continues after either result; queue and replay state remain bounded.

## Tests Added

| Scenario | Result |
|---|---|
| Sequence 2 arrives before 1; sequence 1 arrives before ordering timeout | PASS — both messages accepted and released in sequence. |
| Sequence 2 arrives; sequence 1 never arrives | PASS — deterministic `REPLAY_REJECTED` acknowledgement after the test-configured ordering timeout. |
| Duplicate expired sequence 2 | PASS — rejected. |
| Sequence 1 after expired 2, then sequence 3 | PASS — queue remains usable without accepting sequence 2. |
| Exact configured production origin versus unexpected/suffix-confused origin | PASS — exact origin accepted; unexpected and absent origins rejected. |
| Trusted-proxy versus direct handshake identity | PASS — direct uses transport peer; enabled trusted proxy uses a valid first forwarded IP only. |

The default suite is intentionally file-serialized because relay and room lifecycle integration tests share one database. Assertions, per-test timeouts, and security controls were not weakened; serialization eliminates cross-file transaction contention.

## Handshake / Proxy Verification

The handshake limiter now uses `handshakeClientIdentity`. In direct deployments it keys only the Socket.IO transport peer address, which is not client-header controlled. With `TRUST_PROXY=1`, it uses the first syntactically valid `X-Forwarded-For` IP. This mode is supported only behind **one network-restricted trusted proxy that overwrites that header**; direct application-port exposure must be blocked in that deployment model. `ENVIRONMENT.md` documents this requirement.

## Dependency Audit

| Severity | Current total |
|---|---:|
| Critical | 2 |
| High | 15 |
| Moderate | 12 |
| Low | 2 |

Remaining critical/high paths are reviewed in `CRITICAL_HIGH_REMEDIATION_PLAN.md`. `tar` 7.5.1 is a build-only dependency through `@tailwindcss/vite` → Oxide (critical fixed at 7.5.19+, all reported highs covered by 7.5.21+). Direct Vitest 2.1.9 is test-only (fixed at 3.2.6+); its transitive Vite 5.4.21, Rollup 4.52.4, PostCSS 8.5.6, and NanoID 3.3.11 findings are likewise test-only. Runtime Express 4.21.2 resolves `path-to-regexp` 0.1.12 (high, fixed 0.1.13+). The safe staged remediation path is a reviewed `path-to-regexp` override first, then isolated Vitest and Tailwind toolchain work; no blind major upgrade was applied.

## Validation

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm check` | PASS |
| `pnpm test` | PASS — 5 files, 29 tests |
| `pnpm build` | PASS — only the existing chunk-size warning |
| `pnpm audit` | WARNINGS — totals above |
| `pnpm outdated` | REVIEWED — several available upgrades are major-version changes |
| Browser E2E | **NOT EXECUTED** — no independent two-context browser automation surface is available in this workspace |

## Remaining Limitations

Replay, rate-limit, presence, queue, and ordering state remain intentionally process-local; deploy a single application instance unless reviewed shared coordination is introduced. Browser two-context UI E2E remains unexecuted. The dependency audit remains nonzero and the outstanding critical/high items are explicitly classified above. The production bundle retains a performance-only chunk-size warning.

## Production Decision

**READY WITH KNOWN LIMITATIONS.** The targeted pending-buffer issue is fixed with deterministic acknowledgement and cleanup, the proxy identity model is documented and tested, and the available verification suite passes. Before broad launch, configure exact `ALLOWED_ORIGINS`, run a real two-browser production relay exercise, and execute the staged dependency remediation plan.

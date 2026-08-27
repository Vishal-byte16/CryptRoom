# CryptRoom Security

## Scope

CryptRoom is an ephemeral two-participant chat service. Its privacy model minimizes server-side data and prevents anyone who knows only a Room ID from claiming a participant slot.

## Security controls

| Control | Implementation |
|---|---|
| Private room admission | The creator sends a 256-bit secret-derived verifier when opening a room. Guests receive a short-lived challenge and must return an HMAC proof derived from the secret verifier. The server never receives the encryption secret. |
| Guest session credentials | Browser access tokens are generated from cryptographically secure randomness. Only SHA-256 token hashes are persisted. |
| Message confidentiality and integrity | Browsers derive an AES-256-GCM key from the room secret using PBKDF2-SHA-256 with 210,000 iterations. A fresh 96-bit nonce and authenticated metadata are supplied for every message. |
| Replay resistance | Every encrypted envelope includes a random message ID, a monotonically increasing sequence number, and a timestamp. The relay rejects duplicate IDs, non-increasing sequences, stale/future timestamps, malformed IVs, and oversized envelopes. Gaps are allowed. |
| Abuse controls | Message and typing budgets are keyed to the server-authenticated room participant, not to an individual socket. Multiple tabs for one participant share a budget; the other participant has an independent budget. |
| Delivery confirmation | The sender renders an encrypted message as sent only after the relay acknowledges acceptance. A rejection returns a safe code and message without exposing plaintext or relay internals. |
| Metadata minimization | Rooms and participant records contain lifecycle metadata only. There is no message, ciphertext-history, plaintext, key, or raw-secret column. |
| Lifecycle | Rooms accept at most two participants, expire after 30 minutes, are deleted after the final leave, and can be deleted by a protected cleanup endpoint. |
| Transport and web controls | The server disables `X-Powered-By` and sends restrictive production headers including CSP, HSTS, frame denial, no-referrer policy, and restrictive permissions. |

## Deployment scope for relay safeguards

The replay cache, connection presence map, and rate limiters are deliberately **in-memory and single-process**. Deploy one CryptRoom application instance for a room lifecycle. Horizontal scaling without shared replay, rate-limit, and presence state is unsupported: a multi-instance deployment must first introduce a reviewed shared coordination layer (for example, Redis) and adapter-backed Socket.IO routing.

Replay state is process-local and is lost on a server restart. Active rooms and valid guest sessions remain in the database, so participants can reconnect after a restart; client sequence allocation continues with a nonsecret, participant-derived browser counter. Consequently, duplicate rejection for messages sent before a restart is not persistent. This limitation is intentional for the current ephemeral, single-process architecture and must be considered before enabling restarts during active high-sensitivity conversations.

Within a browser profile, outgoing sequence allocation uses the Web Locks API and a nonsecret, hashed participant storage key. This serializes sends across a participant’s tabs and survives refreshes. Browsers without Web Locks cannot send, rather than risking duplicate sequence numbers. The room secret itself is held only in `sessionStorage` for the current browser session after the URL fragment is removed; it is cleared on explicit leave and is never sent to the API or relay.

Join challenges are short-lived and bounded to one active record per room. A new join attempt replaces the prior unused challenge; every accepted challenge is consumed atomically.

## Legacy account table

The original scaffold’s `users` table is not read or written by CryptRoom. It remains declared as `legacyUsers` solely to avoid automatically deleting potential personal data during an application hardening migration. For a clean standalone deployment, create a fresh CryptRoom database with only the room tables. For an existing deployment, export and approve a retention/deletion policy for that legacy data, then apply a separately reviewed migration in a maintenance window; do not include a destructive table drop in the normal application migration path.

## Explicitly not protected against

CryptRoom cannot protect a participant from a compromised endpoint, malware, malicious browser extensions, screenshots, physical device access, copied private links, coercion, a compromised web-asset delivery path, or a participant voluntarily disclosing conversation contents. The application makes no claim of being unhackable or providing anonymity against network-level observers.

## Operational guidance

Run CryptRoom over HTTPS, maintain a current dependency patching process, restrict database access, configure `CLEANUP_SECRET` before enabling scheduled cleanup, and set `TRUST_PROXY=1` only behind a known trusted reverse proxy. Avoid collecting request bodies, URL fragments, room secrets, guest tokens, or message payloads in logs.

## Reporting

If you discover a security issue, report it privately to the deployment owner with reproduction steps and avoid publishing sensitive room data or private links.

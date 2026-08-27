# CryptRoom

**CryptRoom — Private, Ephemeral Encrypted Chat** is a no-account chat application for two people. A participant creates a temporary room, shares the private link, and both browsers encrypt messages before the server relays them. The server stores operational room metadata only; it does not store chat content.

## Architecture

| Layer | Responsibility | Persistent data |
|---|---|---|
| Browser | Generates the room secret, derives the AES-256-GCM key, proves secret possession for guest admission, and encrypts/decrypts messages. | A guest access token and the private room secret are held in `sessionStorage` only while the room session is active, allowing a refresh after the URL fragment is scrubbed. |
| Application server | Creates rooms, verifies HMAC-based join proofs, limits admission to two participants, validates and relays opaque envelopes, and applies abuse limits. | No messages, ciphertext history, encryption keys, raw room secrets, or raw guest tokens. |
| Database | Holds rooms, hashed guest-token verifiers, short-lived join challenges, and participant lifecycle metadata. | Minimum operational metadata required to admit, expire, and delete rooms. |

> The server verifies that a guest knows a secret-derived verifier without receiving the room encryption secret itself. The verifier is not a substitute for the secret and cannot decrypt room traffic.

## Security model

Messages use **AES-256-GCM** in the browser with a fresh 96-bit IV for every message. AES-GCM additional authenticated data binds each ciphertext to the room ID, message ID, sequence number, and timestamp. The server rejects malformed envelopes, oversized payloads, duplicate message IDs, and non-advancing sequences. Room creation, joining, and real-time messages are rate limited in the application process.

CryptRoom uses a private room secret supplied through the fragment portion of a share link. Fragment values are not sent in HTTP requests. After the browser reads the secret, the room view removes the fragment from the visible address bar. The application never sends the secret to the API or the real-time relay.

For boundaries and limitations, read [SECURITY.md](./SECURITY.md).

## Prerequisites

Use Node.js 22 or newer, pnpm 10 or newer, and MySQL 8 / TiDB compatible with the connection string in `DATABASE_URL`.

## Install and configure

```bash
git clone <your-repository-url> cryptroom
cd cryptroom
pnpm install
```

Create an uncommitted `.env` from the safe example in [ENVIRONMENT.md](./ENVIRONMENT.md), then set `DATABASE_URL`. Use a unique `CLEANUP_SECRET` when configuring a scheduler. Do not commit `.env` or actual credentials.

## Database migrations

Generate a migration after editing `drizzle/schema.ts`, review the generated SQL, and then apply it in your deployment environment.

```bash
pnpm db:generate
pnpm db:migrate
```

## Development

```bash
pnpm dev
```

The service exposes `GET /health`, which returns only `{ "status": "ok" }`.

## Test and build

```bash
pnpm check
pnpm test
pnpm build
NODE_ENV=production pnpm start
```

After starting the production build, verify the homepage and health check:

```bash
curl http://127.0.0.1:3000/health
```

## Deployment

Deploy the Node application together with its database configuration. Terminate TLS at a trusted edge or reverse proxy and set `TRUST_PROXY=1` only when that proxy is under your control. The production service requires a secure HTTPS origin because the browser Web Crypto APIs are used for private chat.

Configure a trusted scheduler to call `POST /api/scheduled/cleanupRooms` with `Authorization: Bearer <CLEANUP_SECRET>`. Cleanup is also performed when an expired room is accessed, but a scheduler ensures abandoned metadata is removed without a later request.

CryptRoom’s real-time replay cache, participant presence map, and abuse controls are in-memory. Deploy a single application instance; do not enable horizontal scaling until a reviewed shared-state design has been implemented.

## Limitations and threat model

CryptRoom is designed to prevent server-side chat history and casual unauthorized joining. It does not protect participants against compromised devices, malicious browser extensions, screenshots, keyloggers, copied secrets, a compromised client-side JavaScript delivery path, or an attacker who controls either participant’s device. It is not a replacement for a fully audited secure-messaging protocol or for operational security practices.

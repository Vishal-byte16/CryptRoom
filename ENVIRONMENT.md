# CryptRoom Environment Configuration

Set these variables in the deployment environment or a local uncommitted `.env` file. Do not commit real values.

| Variable | Required | Purpose |
|---|---:|---|
| `DATABASE_URL` | Yes | MySQL or TiDB connection string used by Drizzle. |
| `NODE_ENV` | Yes | Use `development` locally and `production` for deployed builds. |
| `PORT` | No | HTTP port; defaults to `3000`. |
| `TRUST_PROXY` | No | Set to `1` only when one network-restricted trusted proxy overwrites `X-Forwarded-For`; Socket.IO then uses the first validated IP for handshake limiting. Leave unset/`0` for direct deployments, where the transport peer address is used. Never expose the application port directly when this is enabled. |
| `ALLOWED_HOSTS` | No | Comma-separated Vite development hostnames. In production it remains a backward-compatible fallback for exact Socket.IO origins. |
| `ALLOWED_ORIGINS` | Required in production | Comma-separated full origins permitted to complete a Socket.IO handshake, such as `https://cryptroom.example.com`. This exact-origin allowlist takes precedence over `ALLOWED_HOSTS`. |
| `CLEANUP_SECRET` | Required for scheduler | High-entropy bearer secret accepted only by the scheduled cleanup endpoint. |

Example local values:

```dotenv
DATABASE_URL=mysql://user:Vishal@123@127.0.0.1:3306/cryptroom
NODE_ENV=development
PORT=3000
TRUST_PROXY=0
ALLOWED_HOSTS=localhost,127.0.0.1
# Production only: ALLOWED_ORIGINS=https://cryptroom.example.com
CLEANUP_SECRET=replace-with-a-long-random-value-before-enabling-scheduled-cleanup
```

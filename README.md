# Spectrum Sync Server

Realtime sync relay for the Spectrum Platform. Brings the localStorage-only
PWA / mobile APK into a multi-device, always-in-sync experience: submit an
expense on one device and it appears on every other connected device within
~100ms.

## What it does

- Accepts WebSocket connections from web and mobile clients
- Multiplexes mutations (`put` / `remove`) between all connected clients
- Persists state to `state.json` (debounced)
- Provides `/snapshot` for new clients to bootstrap against
- Rebroadcasts semantic events (OTP sent, notify, etc.) across all clients

## Protocol

All messages are JSON envelopes:

```json
{
  "v":        1,
  "type":     "hello|welcome|put|remove|event|snapshot|ping|pong|error",
  "clientId": "c_abc123",
  "userId":   "USR001",
  "msgId":    "c_abc123_1712345678901_x7",
  "ts":       1712345678901,
  "payload":  { ... }
}
```

### Client → Server

- `hello`    — `{ clientId, userId, lastSeenTs }` — first message after connect
- `put`      — `{ table, record }` — create/update a row
- `remove`   — `{ table, id }` — delete a row
- `event`    — `{ name, data }` — relay semantic event (whitelist only)
- `snapshot` — `{ state }` — authoritative seed (only when server uninitialized)
- `ping`     — `{}` — keepalive

### Server → Client

- `welcome`  — `{ serverTime, state, seq, initialized }` — response to `hello`
- `put` / `remove` / `event` — broadcast from other clients (echoed back to all except origin)
- `pong`     — response to `ping`
- `error`    — `{ err }` — protocol or apply error

## Conflict resolution

Tables are classified into two kinds:

| Kind         | Strategy                                                         | Examples                              |
|--------------|------------------------------------------------------------------|---------------------------------------|
| MUTABLE      | Last-Write-Wins with `(timestamp, clientId)` tiebreak            | users, branches, products, kpi, leave |
| APPEND-ONLY  | First write wins; duplicate ids ignored                           | messages, audit, notifications, psi   |

`_syncTs` and `_syncCid` are added to mutable rows so later writes can be compared.

## Run

```bash
npm install
npm start
```

Environment variables:

| Var           | Default              | Purpose                           |
|---------------|----------------------|-----------------------------------|
| `PORT`        | `3860`               | HTTP + WS port                    |
| `HOST`        | `0.0.0.0`            | Bind address                      |
| `STATE_FILE`  | `./state.json`       | Persistence target                |
| `PERSIST_MS`  | `1500`               | Debounce window for disk writes   |

## HTTP endpoints

- `GET /`          — HTML status page
- `GET /health`    — `{ ok, clients, tables, seq, uptime }`
- `GET /snapshot`  — full JSON state (seed for new clients)
- `WS  /sync`      — WebSocket upgrade endpoint

## How it integrates

The client module lives in `deploy/assets/spectrum-core.js` as `SX.sync`. See
the `SX.sync` section in that file for `configure`, `connect`, `disconnect`,
`status` and the echo-safe `putSilent` / `removeSilent` helpers.

In the admin console (`spectrum-admin.html` → System → Realtime Sync), set
the sync server URL (e.g. `ws://192.168.0.10:3860/sync`) and click Connect.

## Testing two-tab sync

1. `node server.js`
2. Open two tabs of `spectrum-dashboard.html` (or one dashboard + one mobile)
3. In tab 1: submit an expense
4. In tab 2: the expense row should appear within ~100ms

## Notes

- All clients run the same app and share an eventually-consistent view.
- No auth is enforced at the WS layer in this demo build — the server trusts
  the `userId` from each envelope. Add a token check before exposing publicly.
- For production: run behind `wss://` with a reverse proxy (nginx, Caddy) and
  swap `state.json` for SQLite/Postgres.

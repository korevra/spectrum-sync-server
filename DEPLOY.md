# Spectrum Sync Server — Deployment Guide

This document covers how to run `sync-server` in three deployment modes, plus
how to point the web app and the Android APK at it.

| Mode | Use for | Transport | Host reachable by |
|------|---------|-----------|-------------------|
| **Local / LAN** | Office, one site, dev | `ws://` (cleartext) | Machines on the same Wi-Fi |
| **Public — reverse proxy + TLS** | Production, multi-site | `wss://` (TLS) | Any device on the Internet |
| **Container** | Portable re-deploy | `wss://` behind ingress | Depends on cluster |

All three modes run the same `server.js`. Only the network wrapper changes.

---

## 0. Prerequisites

- Node.js **18 LTS** or newer (`node -v` must print ≥ v18)
- Outbound firewall allows the chosen TCP port (default **3860**)
- The deploy/APK assets from the Spectrum Platform repo (already contain the
  `SX.sync` client module)

```bash
cd sync-server
npm install
```

---

## 1. Local / LAN deployment

The simplest mode. Suitable for a single office where every device is on the
same subnet.

### Start the server

```bash
PORT=3860 node server.js
```

Console prints:

```
[hh:mm:ss] ═════════════════════════════════════════════════════════
[hh:mm:ss]   SPECTRUM SYNC SERVER
[hh:mm:ss]   listening on http://0.0.0.0:3860
[hh:mm:ss]   WS endpoint ws://0.0.0.0:3860/sync
[hh:mm:ss]   state file  /…/sync-server/state.json
[hh:mm:ss]   initialized no (awaiting first client seed)
[hh:mm:ss] ═════════════════════════════════════════════════════════
```

### Find your LAN IP

```bash
# Windows
ipconfig | findstr IPv4
# macOS / Linux
ifconfig | grep 'inet '
```

Pick the private address on the same interface as your clients, e.g.
`192.168.0.10`.

### Point clients at it

1. Open `spectrum-admin.html` (or the mobile APK) in any browser
2. Go to **System → Settings → 🛰 Realtime Sync**
3. Enter the WS URL, e.g. `ws://192.168.0.10:3860/sync`
4. Click **Save** then **Connect**
5. The topbar pill should turn green and read **LIVE SYNC**

The first device to connect to an empty server sends its full localStorage as
the authoritative seed. Every subsequent device receives that seed in the
`welcome` envelope and then shares mutations in real time.

### Running it as a Windows service / background task

- **PM2** (recommended): `npm i -g pm2 && pm2 start server.js --name spectrum-sync && pm2 save && pm2 startup`
- **Task Scheduler**: Create a Basic Task → At startup → Start a program → `node.exe server.js` → Working directory `C:\…\sync-server`
- **NSSM**: `nssm install SpectrumSync "C:\Program Files\nodejs\node.exe" "C:\…\sync-server\server.js"`

On Linux use `systemd` — see the unit file in **Appendix A**.

---

## 2. Public deployment behind nginx or Caddy

Do **not** expose port 3860 to the Internet directly. Put it behind a reverse
proxy that terminates TLS and adds an auth token check.

### 2a. Caddy (easiest)

`/etc/caddy/Caddyfile`:

```caddy
sync.example.com {
    reverse_proxy 127.0.0.1:3860
    encode zstd gzip
    log {
        output file /var/log/caddy/spectrum-sync.log
    }
}
```

Caddy auto-provisions a Let's Encrypt certificate. Reload with
`sudo systemctl reload caddy`. Your WS endpoint becomes
`wss://sync.example.com/sync`.

### 2b. nginx

```nginx
server {
    listen 443 ssl http2;
    server_name sync.example.com;

    ssl_certificate     /etc/letsencrypt/live/sync.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sync.example.com/privkey.pem;

    # WebSocket upgrade
    location /sync {
        proxy_pass         http://127.0.0.1:3860;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_set_header   X-Real-IP  $remote_addr;
        proxy_read_timeout 3600s;     # keep idle connections alive
        proxy_send_timeout 3600s;
    }

    # HTTP endpoints (health, snapshot, status page)
    location / {
        proxy_pass       http://127.0.0.1:3860;
        proxy_set_header Host $host;
    }
}

server {
    listen 80;
    server_name sync.example.com;
    return 301 https://$host$request_uri;
}
```

Reload with `sudo nginx -t && sudo systemctl reload nginx`. Clients now connect
to `wss://sync.example.com/sync`.

### 2c. Bind the Node process to loopback

When a reverse proxy fronts the server, lock the Node listener to `127.0.0.1`
so it cannot be reached directly from the Internet:

```bash
HOST=127.0.0.1 PORT=3860 node server.js
```

---

## 3. Container deployment (Docker)

`Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
EXPOSE 3860
VOLUME ["/app/data"]
ENV STATE_FILE=/app/data/state.json \
    HOST=0.0.0.0 \
    PORT=3860
CMD ["node", "server.js"]
```

Build & run:

```bash
docker build -t spectrum-sync:1.0 .
docker run -d --name spectrum-sync \
    -p 3860:3860 \
    -v spectrum-sync-data:/app/data \
    --restart unless-stopped \
    spectrum-sync:1.0
```

Put the container behind the same Caddy/nginx terminus as Section 2.

---

## 4. Configuring the Android APK

The sync-enabled APK ships as `deploy/app/SpectrumField-v1.1-sync-debug.apk`
(SHA-256: `8b4db3013d3bd4542e74e5298ca04e5e56d5355bccb46910edaadcb4edba4795`).

### Install

- Side-load via `adb install SpectrumField-v1.1-sync-debug.apk`, or
- Host the APK behind your deploy web server and let users download it

### Configure the sync URL on first launch

1. Open the app
2. Navigate to the **Admin / System** view (embedded in the mobile bundle)
3. Open **Realtime Sync**
4. Enter your sync URL:
    - LAN: `ws://192.168.0.10:3860/sync`
    - Production: `wss://sync.example.com/sync`
5. Save → Connect

The URL is persisted in localStorage (key `spectrum_sync_url_v3`) and the app
auto-reconnects on every launch.

### Why the APK allows cleartext for private ranges

`android/app/src/main/res/xml/network_security_config.xml` permits cleartext
HTTP/WS only for:

- `localhost`
- `10.0.0.0/8`
- `172.16.0.0/12`
- `192.168.0.0/16`

Public `ws://example.com` is still blocked by Android's default TLS policy.
For production deployments always use `wss://` and remove the cleartext
exemption; then rebuild the APK.

---

## 5. Environment variables (server)

### 5a. Core sync server

| Var           | Default              | Purpose                                      |
|---------------|----------------------|----------------------------------------------|
| `PORT`        | `3860`               | HTTP + WS port                               |
| `HOST`        | `0.0.0.0`            | Bind address — set to `127.0.0.1` behind a proxy |
| `STATE_FILE`  | `./state.json`       | Persistence target (can be a Docker volume)  |
| `PERSIST_MS`  | `1500`               | Debounce window for disk writes              |

### 5b. Reports & BI engine

The server ships with `reports.js`, which computes **daily / weekly / monthly**
business-intelligence reports covering every operational area (KPI, sales,
inventory, HR, finance, operations, attendance, customer) and emails them to
managers & the CEO via SMTP. Cron schedules are expressed in the server's
`TZ` so "1 a.m." is office-local, not UTC.

| Var                   | Default                | Purpose                                          |
|-----------------------|------------------------|--------------------------------------------------|
| `TZ`                  | `Africa/Lagos`         | Timezone for all cron schedules                  |
| `SMTP_HOST`           | —                      | SMTP relay hostname (e.g. `smtp.gmail.com`)      |
| `SMTP_PORT`           | `587`                  | `587` for STARTTLS or `465` for TLS wrapper      |
| `SMTP_SECURE`         | auto                   | `"true"` for port 465, `"false"` for 587         |
| `SMTP_USER`           | —                      | SMTP login (usually the from-address)            |
| `SMTP_PASS`           | —                      | App password or SMTP API key (**never commit**)  |
| `SMTP_FROM`           | = `SMTP_USER`          | Display `From:` header e.g. `Spectrum BI <…>`    |
| `REPORTS_RECIPIENTS`  | —                      | CSV of emails, used as fallback when the admin UI list is empty |

If any of `SMTP_HOST / SMTP_USER / SMTP_PASS` is missing, the server still
computes + stores every scheduled report (so the Reports Center shows it and
users can still download HTML/CSV from the portal), but email delivery is
skipped and a warning is logged.

The admin UI (`spectrum-admin.html → Reports & BI`) can override schedule
times, recipients and SMTP config at runtime — those settings are held in the
shared state and survive restarts. Env vars win over admin-UI config **only**
for SMTP credentials (production secrets should live in Render, not in the
state file).

### 5c. Reports & BI HTTP endpoints

| Method | Path                | Purpose                                        |
|--------|---------------------|------------------------------------------------|
| `GET`  | `/reports/list`     | List saved reports (metadata only)             |
| `GET`  | `/reports/preview?type=daily&date=YYYY-MM-DD` | Render the HTML email preview without sending |
| `GET`  | `/reports/cron`     | Report which cron slots are active             |
| `POST` | `/reports/send`     | Body `{ type, date?, recipients? }` — generate + email on demand |
| `POST` | `/reports/config`   | Body `{ schedule, recipients, smtpConfig }` — persist new schedule from admin UI |

All endpoints are CORS-open for the admin domain; gate them behind your
reverse-proxy ACL if you expose the server publicly.

### 5d. Render.com setup

The bundled `render.yaml` declares the variables with `sync: false` so the
blueprint doesn't carry secrets in git. After first deploy, go to
**Render → spectrum-sync → Environment** and paste the real values for
`SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / SMTP_FROM`.

---

## 6. Operations runbook

### Health check

```bash
curl -s http://localhost:3860/health | jq .
```

Returns:

```json
{
  "ok": true,
  "proto": 1,
  "clients": 3,
  "tables": 41,
  "seq": 117,
  "uptime": 84213,
  "stateFile": "/…/state.json"
}
```

Alert if `ok !== true` or the endpoint times out.

### Backup `state.json`

The file is self-contained JSON and safe to copy while the server is running
(the server writes it atomically via `.tmp` + rename):

```bash
# rotate once an hour
0 * * * * cp /srv/spectrum/state.json /backups/spectrum-$(date +\%Y\%m\%d-\%H).json
```

### Restore

Stop the server, replace `state.json`, start the server. New clients will seed
against the restored snapshot on their next `hello`.

### Reseed from a specific client

Delete `state.json` and restart. The very first device that connects uploads
its current localStorage as the authoritative seed (`expectSeed: true` in the
`welcome` envelope). Every subsequent device merges the server state.

### Logs

`server.js` writes to stdout. Pipe into whatever you prefer:

```bash
node server.js >> /var/log/spectrum-sync.log 2>&1
# or with pm2
pm2 logs spectrum-sync
# or inside systemd
journalctl -u spectrum-sync -f
```

### Tuning for many clients

- **< 25 clients, < 10 MB state**: defaults are fine.
- **25 – 200 clients**: raise `PERSIST_MS=3000` to throttle disk churn; ensure
  the host has ≥ 512 MB free RAM (`state` is held in memory).
- **> 200 clients**: move `state.json` to SQLite or Postgres (see Section 8)
  and run two instances behind a sticky-session load balancer.

---

## 7. Security hardening checklist

The demo build is intentionally permissive so you can see sync work end-to-end
on a LAN in under a minute. Before exposing the server to anything bigger than
your office, do **all** of the following:

- [ ] **Terminate TLS** at a reverse proxy (Section 2) and bind Node to `127.0.0.1`
- [ ] **Enforce auth** — today the server trusts `userId` inside each envelope.
      Add a bearer-token check in `wss.on('connection')` before the `hello`
      handler. Reject connections whose `Sec-WebSocket-Protocol` or
      `Authorization` header does not match a known value.
- [ ] **Rate-limit** — wrap `ws.on('message')` with a per-client token bucket
      (e.g. 100 msgs/sec) to protect against a runaway or malicious client.
- [ ] **Validate payloads** — the server accepts any JSON shape for `record`.
      Add a per-table schema check if you do not fully trust every client.
- [ ] **Restrict CORS** — change `Access-Control-Allow-Origin: *` in
      `server.js` to your actual admin domain.
- [ ] **Rotate `state.json` backups** off the server onto separate storage.
- [ ] **Monitor** `/health` externally (UptimeRobot, a tiny cron job, etc.) and
      alert on `clients` dropping to 0 unexpectedly.

A minimal auth snippet for `server.js`:

```js
// before: const wss = new WebSocketServer({ server: httpServer, path: '/sync' });
const AUTH_TOKEN = process.env.SYNC_TOKEN;
const wss = new WebSocketServer({
  noServer: true
});
httpServer.on('upgrade', (req, socket, head) => {
  if (req.url !== '/sync') { socket.destroy(); return; }
  const auth = req.headers['authorization'] || '';
  if (AUTH_TOKEN && auth !== 'Bearer ' + AUTH_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
```

The client already sends the token via `sync.configure({ token: '…' })` if you
extend `SX.sync._ws = new WebSocket(url, [token])` to pass it as a subprotocol.

---

## 8. Swapping `state.json` for a real database

For production you will eventually outgrow the single JSON file. The simplest
next step is SQLite because it keeps the "one process, one file" model:

```js
// npm i better-sqlite3
const Database = require('better-sqlite3');
const db = new Database(STATE_FILE.replace(/\.json$/, '.sqlite'));
db.exec(`CREATE TABLE IF NOT EXISTS rows(
  tbl  TEXT NOT NULL,
  id   TEXT NOT NULL,
  json TEXT NOT NULL,
  ts   INTEGER NOT NULL,
  cid  TEXT,
  PRIMARY KEY (tbl, id)
)`);

function applyPut(table, record, envClientId, envTs) {
  const ts = Number(record._syncTs || envTs || 0);
  const cid = record._syncCid || envClientId || '';
  const existing = db.prepare('SELECT ts, cid FROM rows WHERE tbl=? AND id=?').get(table, record.id);
  if (existing) {
    if (existing.ts > ts) return { ok: false, skipped: 'older ts' };
    if (existing.ts === ts && existing.cid > cid) return { ok: false, skipped: 'tiebreak' };
  }
  db.prepare('REPLACE INTO rows(tbl,id,json,ts,cid) VALUES (?,?,?,?,?)')
    .run(table, record.id, JSON.stringify(record), ts, cid);
  return { ok: true, applied: true };
}
```

Replace `applyPut`, `applyRemove`, and the `welcome` snapshot builder with
SQL-backed equivalents. Everything else (protocol, broadcast, dedupe) stays
the same — the client does not care how the server persists.

For multi-region scaling, move to Postgres with logical replication and put a
shared pub/sub (Redis, NATS) between nodes so that `broadcast()` fans out
across instances.

---

## Appendix A — `systemd` unit file

Save as `/etc/systemd/system/spectrum-sync.service`:

```ini
[Unit]
Description=Spectrum Sync Server
After=network.target

[Service]
Type=simple
User=spectrum
WorkingDirectory=/srv/spectrum/sync-server
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=3860
Environment=STATE_FILE=/srv/spectrum/data/state.json
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3
StandardOutput=append:/var/log/spectrum-sync.log
StandardError=append:/var/log/spectrum-sync.log

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now spectrum-sync
sudo systemctl status spectrum-sync
```

---

## Appendix B — Smoke test

Run a full client round-trip without touching a browser:

```bash
# terminal 1
node server.js

# terminal 2 — listener
node test-client.js

# terminal 3 — sender
node test-client-send.js
```

`test-client.js` should print an `expense` row broadcast from the sender
within a few milliseconds of `test-client-send.js` firing. If it does, the
server is relaying correctly and any failure is on the client side.

---

## Appendix C — Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Pill stays **SYNC ERR** in the app | Wrong URL or firewall | `curl http://host:3860/health` from the client device |
| Pill flips **LIVE SYNC → OFFLINE → LIVE SYNC** | Idle timeout at a proxy | Set `proxy_read_timeout 3600s` (nginx) or raise `idle_timeout` in your load balancer |
| Android app refuses to connect over `ws://` | cleartext blocked | Confirm the target IP is inside one of the RFC1918 ranges in `network_security_config.xml`, or switch to `wss://` |
| Server logs "table X is not a row-table" | Client put a singleton config object as a row | Use `SX.getState('smtpConfig')` / `SX.setState` helpers; do not call `SX.put('smtpConfig', …)` |
| `welcome` received but state still empty | First client seed never fired | Delete `state.json`, restart, reconnect the most up-to-date client first |
| Ports conflict on 3860 | Another service already bound | `PORT=3861 node server.js` and update the URL in the admin console |

---

For protocol details and the table classification reference, see
[`README.md`](README.md).

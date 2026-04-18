/* ===========================================================================
 * SPECTRUM SYNC SERVER
 * Realtime relay for Spectrum Platform clients.
 * ---------------------------------------------------------------------------
 * Multiplexes mutations (CRUD ops on tables, semantic events) between any
 * number of connected clients. Persists state to ./state.json. Implements
 * per-table conflict resolution:
 *
 *   - MUTABLE tables:   Last-Write-Wins with (timestamp, clientId) tiebreak
 *   - APPEND-ONLY:      Ignore duplicate ids, accept any new id
 *
 * Transport: WebSocket (RFC 6455 / ws library)
 * Protocol:  JSON envelopes, see MESSAGE FORMAT below.
 *
 * Endpoints:
 *   HTTP  GET  /health     → { ok, clients, tables, uptime }
 *   HTTP  GET  /snapshot   → full state JSON (authoritative seed)
 *   WS    /sync            → upgrade for bidirectional sync
 *
 * Message format (all envelopes):
 *   {
 *     v:        1,                // protocol version
 *     type:     'hello'|'welcome'|'put'|'remove'|'event'|'snapshot'|'ping'|'pong'|'error',
 *     clientId: string,           // origin client (echo-loop prevention)
 *     userId:   string|null,      // authenticated user
 *     msgId:    string,           // dedupe id
 *     ts:       number,           // epoch ms at origin
 *     payload:  any               // type-specific
 *   }
 *
 * Payloads:
 *   hello    { clientId, userId, lastSeenTs }
 *   welcome  { serverTime, state, seq }
 *   put      { table, record }
 *   remove   { table, id }
 *   event    { name, data }       // semantic events (non-CRUD, e.g. otp-sent)
 *   snapshot { state }            // full state replace (rare, admin tool)
 *
 * Run:
 *   node server.js                // default :3860
 *   PORT=9090 node server.js
 *   STATE_FILE=/tmp/spectrum.json node server.js
 * ======================================================================= */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const reportsRunner = require('./reports');
const mailRunner = require('./mail');

/* ---------------------------------------------------------------- *
 * Config
 * ---------------------------------------------------------------- */
const PORT        = Number(process.env.PORT || 3860);
const HOST        = process.env.HOST || '0.0.0.0';
const STATE_FILE  = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const PERSIST_MS  = Number(process.env.PERSIST_MS || 1500); // debounce
const PING_MS     = 30000;
const PROTO_VER   = 1;

/* Table classification — MUST match client */
const MUTABLE_TABLES = new Set([
  'users', 'branches', 'kpiGroups', 'products', 'psiCatalog',
  'leave', 'expense', 'kpi', 'tickets', 'smtpConfig',
  'integrations', 'roles', 'enrollments', 'policies',
  'training', 'surveys', 'partners', 'partnerOrders',
  'channels', 'attendance', 'notices',
  'reports' // v3.2.1 — saved performance reports
]);
const APPEND_ONLY_TABLES = new Set([
  'messages', 'psi', 'audit', 'emails', 'notifications',
  'surveyResponses', 'rewardsLedger', 'marketIntel', 'userBadges',
  'integrationLogs', 'badges'
]);

/* Semantic events we rebroadcast (not persisted) */
const RELAYED_EVENTS = new Set([
  'auth:changed', 'auth:otp-sent',
  'attendance:clocked',
  'leave:submitted', 'leave:approved', 'leave:rejected',
  'expense:submitted', 'expense:approved', 'expense:rejected',
  'kpi:scored',
  'psi:adjusted',
  'ticket:created', 'ticket:updated', 'ticket:resolved',
  'msg:sent',
  'notify:pushed',
  'smtp:sent',
  'integration:imported',
  'reward:awarded',
  'survey:responded'
]);

/* ---------------------------------------------------------------- *
 * State
 * ---------------------------------------------------------------- */
let state = loadState();
let seq   = state.__meta?.seq || 0;
let persistTimer = null;
let persistDirty = false;

const clients = new Map(); // ws → { id, userId, clientId, lastSeenTs, alive }
const recentMsgIds = new Map(); // msgId → ts (dedupe window)
const DEDUPE_MS = 60_000;

function loadState () {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      log(`Loaded state from ${STATE_FILE}: ${Object.keys(parsed).filter(k => k !== '__meta').length} tables`);
      return parsed;
    }
  } catch (e) {
    log(`Failed to load state: ${e.message}`);
  }
  return { __meta: { initialized: false, seq: 0, createdAt: Date.now() } };
}

function queuePersist () {
  persistDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!persistDirty) return;
    persistDirty = false;
    state.__meta = state.__meta || {};
    state.__meta.seq = seq;
    state.__meta.savedAt = Date.now();
    try {
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state));
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (e) {
      log(`Persist error: ${e.message}`);
    }
  }, PERSIST_MS);
}

function log (msg) {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}] ${msg}`);
}

/* ---------------------------------------------------------------- *
 * Apply logic — the heart of conflict resolution
 * ---------------------------------------------------------------- */
function applyPut (table, record, envClientId, envTs) {
  if (!record || !record.id) return { ok: false, err: 'record.id required' };
  // Guard: a singleton config table that arrived as an object would be
  // silently corrupted if we tried to push records into it. Coerce to array.
  if (state[table] && !Array.isArray(state[table])) {
    return { ok: false, err: 'table ' + table + ' is not a row-table' };
  }
  state[table] = state[table] || [];
  const arr = state[table];

  if (APPEND_ONLY_TABLES.has(table)) {
    if (arr.find(r => r.id === record.id)) return { ok: false, skipped: 'duplicate id' };
    arr.push(record);
    return { ok: true, applied: true };
  }

  // MUTABLE: LWW with (ts, clientId) tiebreak
  const existing = arr.find(r => r.id === record.id);
  const incomingTs = Number(record._syncTs || envTs || 0);
  const incomingCid = record._syncCid || envClientId || '';

  if (existing) {
    const curTs = Number(existing._syncTs || 0);
    const curCid = existing._syncCid || '';
    if (curTs > incomingTs) return { ok: false, skipped: 'older ts' };
    if (curTs === incomingTs && curCid > incomingCid) return { ok: false, skipped: 'tiebreak' };
    const i = arr.findIndex(r => r.id === record.id);
    arr[i] = { ...record, _syncTs: incomingTs, _syncCid: incomingCid };
  } else {
    arr.push({ ...record, _syncTs: incomingTs, _syncCid: incomingCid });
  }
  return { ok: true, applied: true };
}

function applyRemove (table, id, envClientId, envTs) {
  if (!id) return { ok: false, err: 'id required' };
  if (state[table] && !Array.isArray(state[table])) {
    return { ok: false, err: 'table ' + table + ' is not a row-table' };
  }
  state[table] = state[table] || [];
  const arr = state[table];
  const i = arr.findIndex(r => r.id === id);
  if (i < 0) return { ok: false, skipped: 'not found' };

  if (APPEND_ONLY_TABLES.has(table)) {
    // Append-only tables rarely remove, but honor it
    arr.splice(i, 1);
    return { ok: true, applied: true };
  }

  const existing = arr[i];
  const curTs = Number(existing._syncTs || 0);
  const inTs  = Number(envTs || Date.now());
  if (curTs > inTs) return { ok: false, skipped: 'older ts' };
  arr.splice(i, 1);
  return { ok: true, applied: true };
}

/* ---------------------------------------------------------------- *
 * Broadcast
 * ---------------------------------------------------------------- */
function broadcast (env, exceptWs) {
  const msg = JSON.stringify(env);
  let n = 0;
  for (const ws of clients.keys()) {
    if (ws === exceptWs) continue;
    if (ws.readyState !== ws.OPEN) continue;
    try { ws.send(msg); n++; } catch (_) {}
  }
  return n;
}

function send (ws, env) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(env)); } catch (_) {}
}

function serverEnv (type, payload, extra) {
  return {
    v: PROTO_VER,
    type,
    clientId: 'server',
    userId: null,
    msgId: 'srv_' + (++seq) + '_' + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    payload,
    ...(extra || {})
  };
}

/* ---------------------------------------------------------------- *
 * Dedupe
 * ---------------------------------------------------------------- */
function seenMsg (msgId) {
  if (!msgId) return false;
  const now = Date.now();
  // Sweep old
  if (recentMsgIds.size > 2000) {
    for (const [k, t] of recentMsgIds) {
      if (now - t > DEDUPE_MS) recentMsgIds.delete(k);
    }
  }
  if (recentMsgIds.has(msgId)) return true;
  recentMsgIds.set(msgId, now);
  return false;
}

/* ---------------------------------------------------------------- *
 * HTTP + WebSocket
 * ---------------------------------------------------------------- */
const httpServer = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/health') {
    const out = {
      ok: true,
      proto: PROTO_VER,
      clients: clients.size,
      tables: Object.keys(state).filter(k => k !== '__meta').length,
      seq,
      uptime: Math.round(process.uptime()),
      stateFile: STATE_FILE
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }

  if (req.url === '/snapshot') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state, seq }));
    return;
  }

  // Reports runner — handles /reports/* endpoints
  if (req.url.startsWith('/reports')) {
    if (reportsApi && reportsApi.handle(req, res)) return;
  }

  // Mail relay — handles /mail/* endpoints (POST from PWA webhook mode)
  if (req.url.startsWith('/mail')) {
    if (mailApi && mailApi.handle(req, res)) return;
  }

  if (req.url === '/' || req.url === '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Spectrum Sync</title>
<style>body{font:14px -apple-system,Segoe UI,Roboto,sans-serif;background:#060b1a;color:#e6ecf5;padding:32px;max-width:720px;margin:0 auto}code{background:#0f1a2e;padding:2px 6px;border-radius:4px;color:#00b5e2}h1{color:#00b5e2;margin:0 0 4px}.tag{color:#8090aa;font-size:12px}.card{background:#0f1a2e;border:1px solid #1f2e4a;padding:16px 20px;border-radius:12px;margin:12px 0}</style>
<h1>Spectrum Sync Server</h1><div class="tag">v${PROTO_VER} · uptime ${Math.round(process.uptime())}s · ${clients.size} clients · seq ${seq}</div>
<div class="card"><b>WebSocket</b><br>Connect to <code>ws://${req.headers.host}/sync</code></div>
<div class="card"><b>Health</b><br><code>GET /health</code> — JSON status</div>
<div class="card"><b>Snapshot</b><br><code>GET /snapshot</code> — full state (authoritative seed)</div>
<div class="card"><b>Protocol</b><br>JSON envelopes over WS. See <code>server.js</code> header for format.</div>`);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server: httpServer, path: '/sync' });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  ws.isAlive = true;
  clients.set(ws, {
    id: 'c_' + (++seq),
    userId: null,
    clientId: null,
    lastSeenTs: 0,
    ip
  });
  log(`+ client ${ip} (total=${clients.size})`);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let env;
    try { env = JSON.parse(raw.toString()); }
    catch (e) {
      send(ws, serverEnv('error', { err: 'invalid JSON' }));
      return;
    }

    if (!env || typeof env !== 'object' || env.v !== PROTO_VER) {
      send(ws, serverEnv('error', { err: 'bad envelope or version' }));
      return;
    }

    // Dedupe
    if (seenMsg(env.msgId)) return;

    const meta = clients.get(ws);

    switch (env.type) {
      case 'hello': {
        meta.clientId  = env.payload?.clientId || env.clientId || ('anon_' + meta.id);
        meta.userId    = env.payload?.userId || null;
        meta.lastSeenTs = Number(env.payload?.lastSeenTs || 0);
        log(`  hello ${meta.clientId} user=${meta.userId || '—'} lastSeen=${meta.lastSeenTs}`);

        // On first client connect with empty state, they can seed us
        const isInitialized = !!state.__meta?.initialized;

        send(ws, serverEnv('welcome', {
          serverTime: Date.now(),
          state,
          seq,
          initialized: isInitialized,
          expectSeed: !isInitialized
        }));
        break;
      }

      case 'put': {
        const { table, record } = env.payload || {};
        if (!table || !record) {
          send(ws, serverEnv('error', { err: 'put requires table+record', msgId: env.msgId }));
          return;
        }
        const r = applyPut(table, record, env.clientId, env.ts);
        if (r.ok) {
          queuePersist();
          broadcast(env, ws);
        }
        // Always ACK so the origin can measure roundtrip & clear its outbox
        send(ws, serverEnv('ack', { msgId: env.msgId, type: 'put', table, id: record.id, ok: r.ok, err: r.err, skipped: r.skipped }));
        break;
      }

      case 'remove': {
        const { table, id } = env.payload || {};
        if (!table || !id) {
          send(ws, serverEnv('error', { err: 'remove requires table+id', msgId: env.msgId }));
          return;
        }
        const r = applyRemove(table, id, env.clientId, env.ts);
        if (r.ok) {
          queuePersist();
          broadcast(env, ws);
        }
        send(ws, serverEnv('ack', { msgId: env.msgId, type: 'remove', table, id, ok: r.ok, err: r.err, skipped: r.skipped }));
        break;
      }

      case 'event': {
        const { name, data } = env.payload || {};
        if (!name) return;
        if (!RELAYED_EVENTS.has(name)) return;
        broadcast(env, ws);
        break;
      }

      case 'snapshot': {
        // Authoritative seed — first client to arrive when state is empty
        if (!state.__meta?.initialized && env.payload?.state) {
          const incoming = env.payload.state;
          // Merge: copy tables, preserve __meta
          Object.keys(incoming).forEach(k => {
            if (k === '__meta') return;
            state[k] = incoming[k];
          });
          state.__meta = state.__meta || {};
          state.__meta.initialized = true;
          state.__meta.seededBy = meta.clientId;
          state.__meta.seededAt = Date.now();
          seq++;
          queuePersist();
          log(`  state seeded by ${meta.clientId} (${Object.keys(state).length - 1} tables)`);
          // Acknowledge + broadcast welcome to everyone else
          send(ws, serverEnv('welcome', { serverTime: Date.now(), state, seq, initialized: true }));
          broadcast(serverEnv('welcome', { serverTime: Date.now(), state, seq, initialized: true, reason: 'seeded' }), ws);
        }
        break;
      }

      case 'ping': {
        send(ws, serverEnv('pong', { clientTs: env.ts }));
        break;
      }

      default:
        send(ws, serverEnv('error', { err: 'unknown type ' + env.type }));
    }
  });

  ws.on('close', () => {
    const meta = clients.get(ws);
    clients.delete(ws);
    log(`- client ${meta?.clientId || ip} (total=${clients.size})`);
  });

  ws.on('error', (e) => {
    log(`  ws error: ${e.message}`);
  });
});

/* ---------------------------------------------------------------- *
 * Heartbeat — drop dead clients
 * ---------------------------------------------------------------- */
setInterval(() => {
  for (const ws of clients.keys()) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (_) {}
      clients.delete(ws);
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, PING_MS);

/* ---------------------------------------------------------------- *
 * Shutdown
 * ---------------------------------------------------------------- */
function shutdown () {
  log('Shutting down...');
  if (persistDirty) {
    state.__meta = state.__meta || {};
    state.__meta.seq = seq;
    state.__meta.savedAt = Date.now();
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state));
      log('State saved.');
    } catch (e) { log('Final save error: ' + e.message); }
  }
  for (const ws of clients.keys()) {
    try { ws.close(1001, 'server shutdown'); } catch (_) {}
  }
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* ---------------------------------------------------------------- *
 * Start
 * ---------------------------------------------------------------- */
/* ---------------------------------------------------------------- *
 * Reports runner — daily/weekly/monthly scheduled email reports
 * ---------------------------------------------------------------- */
let reportsApi = null;
try {
  reportsApi = reportsRunner.attach({
    state,
    persist: queuePersist,
    broadcast: (env) => broadcast(env, null),
    log: (msg) => log(msg)
  });
  log('Reports runner attached');
} catch (e) {
  log('Reports runner init error: ' + e.message);
}

let mailApi = null;
try {
  mailApi = mailRunner.attach({
    state,
    persist: queuePersist,
    log: (msg) => log('[mail] ' + msg)
  });
  log('Mail relay attached');
} catch (e) {
  log('Mail relay init error: ' + e.message);
}

httpServer.listen(PORT, HOST, () => {
  log('═════════════════════════════════════════════════════════');
  log(`  SPECTRUM SYNC SERVER`);
  log(`  listening on http://${HOST}:${PORT}`);
  log(`  WS endpoint ws://${HOST}:${PORT}/sync`);
  log(`  state file  ${STATE_FILE}`);
  log(`  initialized ${state.__meta?.initialized ? 'yes' : 'no (awaiting first client seed)'}`);
  log(`  reports API ${reportsApi ? 'ready' : 'disabled'}`);
  log(`  mail relay  ${mailApi ? 'ready at POST /mail/send' : 'disabled'}`);
  log('═════════════════════════════════════════════════════════');
});

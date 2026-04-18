/* ===========================================================================
 * SPECTRUM MAIL RELAY  — sync-server HTTP → Gmail (or any) SMTP
 * ---------------------------------------------------------------------------
 * The PWA's Webhook delivery mode POSTs a JSON envelope here. This module
 * dials real SMTP (defaults to Gmail) on the browser's behalf using
 * nodemailer, so the credentials never need to live in the PWA bundle.
 *
 * Credentials resolution, highest priority first:
 *   1. process.env.SMTP_*   (HOST/PORT/SECURE/USER/PASS/FROM) — set on Render
 *   2. state.smtpConfig     (host/port/security/username/password/fromName/fromAddress)
 *   3. request body.auth    (per-request override — used when Spectrum admin
 *                            UI explicitly pushes creds; NOT recommended)
 *
 * Endpoints:
 *   POST /mail/send         — relay one message
 *     body: { to, cc?, bcc?, from?, replyTo?, subject, text, html?,
 *             messageId?, type?, meta?, auth?: { host, port, secure, user, pass, from } }
 *     returns: { ok, id, err? }
 *
 *   POST /mail/test         — probe the SMTP transport without sending
 *     returns: { ok, host, port, secure, user, effective }
 *
 *   GET  /mail/config       — inspect the effective credentials (no password)
 *     returns: { ok, effective: { host, port, secure, user, from, source } }
 *
 * CORS: permissive (* origin) — matches the rest of server.js. Pair this
 * with a bearer token in production.
 *
 * Gmail specifics:
 *   host:   smtp.gmail.com
 *   port:   587 (STARTTLS) or 465 (TLS)
 *   secure: false for 587, true for 465
 *   auth:   your full Gmail address + a 16-char App Password
 *           (Google Account → Security → 2-Step Verification → App Passwords)
 *   from:   must equal the SMTP user (Gmail rewrites otherwise)
 * ======================================================================= */
'use strict';

let nodemailer;
try { nodemailer = require('nodemailer'); }
catch (e) { nodemailer = null; }

let _state = null;
let _persist = null;
let _log = (msg) => console.log('[mail] ' + msg);

/* ------------------------------------------------------------------ *
 * Auth resolution
 * ------------------------------------------------------------------ */
function resolveAuth (overrides) {
  const cfg = (_state && _state.smtpConfig) || {};
  const o = overrides || {};

  const host = o.host || process.env.SMTP_HOST || cfg.host || 'smtp.gmail.com';
  const port = Number(o.port || process.env.SMTP_PORT || cfg.port || 587);
  // secure="true" (for port 465) or false
  const secRaw = (o.secure !== undefined ? o.secure : (process.env.SMTP_SECURE || cfg.security));
  const secure = (secRaw === true || secRaw === 'true' || secRaw === 'TLS' || port === 465);
  const user = o.user || process.env.SMTP_USER || cfg.username;
  const pass = o.pass || process.env.SMTP_PASS || cfg.password;
  const fromEnv = process.env.SMTP_FROM;
  const from =
    o.from || fromEnv ||
    (cfg.fromName && cfg.fromAddress ? `${cfg.fromName} <${cfg.fromAddress}>`
      : (cfg.fromAddress || user));

  const source = o.user ? 'request'
    : (process.env.SMTP_USER ? 'env'
      : (cfg.username ? 'state' : 'none'));

  return { host, port, secure, user, pass, from, source };
}

function safeDescribe (auth) {
  const p = auth.pass || '';
  return {
    host: auth.host, port: auth.port, secure: auth.secure,
    user: auth.user || null,
    from: auth.from || null,
    source: auth.source,
    passwordPresent: !!p,
    passwordLen: p.length,
    passwordHasSpaces: /\s/.test(p),
    passwordMasked: p.length >= 8
      ? p.slice(0, 2) + '*'.repeat(Math.max(0, p.length - 4)) + p.slice(-2)
      : (p ? '*'.repeat(p.length) : '')
  };
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */
let _cachedTransport = null;
let _cachedTransportKey = '';
function keyFor (auth) {
  return [auth.host, auth.port, auth.secure, auth.user, (auth.pass || '').length].join('|');
}
function makeTransport (auth) {
  if (!nodemailer) throw new Error('nodemailer not installed');
  if (!auth.host) throw new Error('Missing SMTP host');
  if (!auth.user || !auth.pass) throw new Error('Missing SMTP credentials (user/pass)');

  const k = keyFor(auth);
  if (_cachedTransport && _cachedTransportKey === k) return _cachedTransport;

  _cachedTransport = nodemailer.createTransport({
    host: auth.host,
    port: auth.port,
    secure: auth.secure,     // true for 465, false for 587 (STARTTLS)
    requireTLS: !auth.secure, // force STARTTLS when not wrapped-TLS
    auth: { user: auth.user, pass: auth.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    tls: { rejectUnauthorized: false }
  });
  _cachedTransportKey = k;
  return _cachedTransport;
}

/* ------------------------------------------------------------------ *
 * Append to the in-state email log so the admin portal's Email Log
 * shows server-relayed messages alongside browser ones.
 * ------------------------------------------------------------------ */
function appendEmailRow (row) {
  if (!_state) return;
  _state.emails = _state.emails || [];
  _state.emails.push(row);
  if (_state.emails.length > 1000) {
    _state.emails.splice(0, _state.emails.length - 1000);
  }
  if (_persist) _persist();
}

/* ------------------------------------------------------------------ *
 * Main relay entry
 * ------------------------------------------------------------------ */
async function relay (body) {
  const started = Date.now();
  const auth = resolveAuth(body.auth);
  if (!auth.user || !auth.pass) {
    return { ok: false, err: 'SMTP credentials not configured on relay', effective: safeDescribe(auth) };
  }
  if (!body.to) return { ok: false, err: 'Missing recipient (to)' };

  let transport;
  try { transport = makeTransport(auth); }
  catch (e) { return { ok: false, err: 'Transport init: ' + e.message, effective: safeDescribe(auth) }; }

  try {
    const res = await transport.sendMail({
      from: body.from || auth.from,
      to: body.to,
      cc: body.cc || undefined,
      bcc: body.bcc || undefined,
      replyTo: body.replyTo || undefined,
      subject: body.subject || '(no subject)',
      text: body.text || '',
      html: body.html || undefined,
      headers: body.messageId ? { 'X-Spectrum-Message-ID': body.messageId } : undefined
    });
    const latency = Date.now() - started;
    _log(`→ ${body.to} "${(body.subject || '').slice(0, 40)}" (${latency}ms) via ${auth.host}`);

    // Mirror to state.emails so admin Email Log reflects server dispatches
    appendEmailRow({
      id: 'em_relay_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      from: body.from || auth.from,
      to: body.to, cc: body.cc || '', bcc: body.bcc || '',
      replyTo: body.replyTo || '',
      subject: body.subject || '',
      body: (body.text || '').slice(0, 500),
      type: body.type || 'relay',
      meta: Object.assign({}, body.meta || {}, { messageId: body.messageId, providerMessageId: res.messageId }),
      provider: 'webhook-smtp',
      status: 'sent',
      at: new Date().toISOString(),
      deliveryMs: latency,
      messageId: body.messageId || null,
      providerMessageId: res.messageId || null,
      err: null,
      _syncTs: Date.now(),
      _syncCid: 'server'
    });

    return { ok: true, id: res.messageId, latencyMs: latency, effective: safeDescribe(auth) };
  } catch (e) {
    const latency = Date.now() - started;
    _log(`✗ ${body.to} "${(body.subject || '').slice(0, 40)}" (${latency}ms): ${e.message}`);
    appendEmailRow({
      id: 'em_relay_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      from: body.from || auth.from,
      to: body.to, cc: body.cc || '', bcc: body.bcc || '',
      subject: body.subject || '',
      body: (body.text || '').slice(0, 500),
      type: body.type || 'relay',
      meta: Object.assign({}, body.meta || {}, { messageId: body.messageId }),
      provider: 'webhook-smtp',
      status: 'failed',
      at: new Date().toISOString(),
      deliveryMs: latency,
      messageId: body.messageId || null,
      err: e.message || String(e),
      _syncTs: Date.now(),
      _syncCid: 'server'
    });
    return { ok: false, err: e.message || String(e), effective: safeDescribe(auth) };
  }
}

async function probe (body) {
  const auth = resolveAuth((body && body.auth) || null);
  if (!auth.user || !auth.pass) {
    return { ok: false, err: 'SMTP credentials missing', effective: safeDescribe(auth) };
  }
  try {
    const t = makeTransport(auth);
    await t.verify();
    return { ok: true, effective: safeDescribe(auth), greeting: `SMTP handshake OK (${auth.host}:${auth.port})` };
  } catch (e) {
    return { ok: false, err: e.message || String(e), effective: safeDescribe(auth) };
  }
}

/* ------------------------------------------------------------------ *
 * HTTP handler
 * ------------------------------------------------------------------ */
function handle (req, res) {
  if (!req.url.startsWith('/mail')) return false;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/mail/config') {
    const auth = resolveAuth(null);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      nodemailerAvailable: !!nodemailer,
      effective: safeDescribe(auth)
    }));
    return true;
  }

  if (req.method === 'POST' && (url.pathname === '/mail/send' || url.pathname === '/mail/test')) {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 2_000_000) req.destroy(); });
    req.on('end', async () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, err: 'invalid JSON' }));
        return;
      }
      // Some probes from the admin UI send {ping:true} to cheaply verify the
      // endpoint exists — treat as a test.
      if (url.pathname === '/mail/test' || body.ping === true) {
        const out = await probe(body);
        res.writeHead(out.ok ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
        return;
      }
      const out = await relay(body);
      res.writeHead(out.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return true;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, err: 'unknown mail endpoint' }));
  return true;
}

/* ------------------------------------------------------------------ *
 * Public: attach to an existing server.js runtime
 * ------------------------------------------------------------------ */
function attach ({ state, persist, log }) {
  _state = state;
  _persist = persist;
  if (log) _log = log;
  _log(`mail relay ready · nodemailer=${!!nodemailer} · defaultHost=${process.env.SMTP_HOST || (state && state.smtpConfig && state.smtpConfig.host) || 'smtp.gmail.com'}`);
  return { handle, relay, probe, resolveAuth };
}

module.exports = { attach };

/* ===========================================================================
 * SPECTRUM SYNC SERVER - RETIRED (7 Nov 2026)
 * ---------------------------------------------------------------------------
 * The platform moved to Firestore (sync), the korevra-relay Cloud Run service
 * (mail, push, PIN reset) and the relay's /ai/chat (assistant). No client has
 * dialled this server since the v1.20 / v2.x fixes removed its URL from the
 * app's defaults and evicted it from stored configuration.
 *
 * What was left running here was an unauthenticated /mail/send relay and a
 * /mail/config page describing the mailbox credential. Both are gone: every
 * request now gets 410 Gone and this process reads no mail, report or SMTP
 * setting at all. The earlier code is in git history (6f3fd3e and before).
 *
 * The service itself should be suspended or deleted in the Render dashboard,
 * and the SMTP_* environment variables removed there.
 * ======================================================================== */
'use strict';

const http = require('http');

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || '0.0.0.0';
const BODY = JSON.stringify({
  ok: false,
  retired: true,
  message: 'This service has been retired and no longer accepts requests.',
});

http.createServer((req, res) => {
  // Drain and ignore any request body; nothing is read from it.
  req.resume();
  // Render's deploy health check may probe /health; a failing check would
  // keep the OLD build (and its mail relay) running, so it alone answers 200.
  if (req.method === 'GET' && (req.url === '/health' || req.url.startsWith('/health?'))) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end('{"ok":true,"retired":true}');
  }
  res.writeHead(410, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(BODY);
}).on('upgrade', (req, socket) => {
  // A WebSocket upgrade is refused the same way, then closed.
  socket.end('HTTP/1.1 410 Gone\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n' + BODY);
}).listen(PORT, HOST, () => {
  console.log('spectrum-sync-server: retired; answering 410 on ' + HOST + ':' + PORT);
});

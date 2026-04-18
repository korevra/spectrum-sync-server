/* Simple test client — connects as 'fakeB', listens, and reports. */
const WebSocket = require('ws');

const url = process.env.URL || 'ws://localhost:3860/sync';
const ws = new WebSocket(url);
const received = [];

ws.on('open', () => {
  console.log('[fakeB] connected');
  ws.send(JSON.stringify({
    v: 1, type: 'hello', clientId: 'fakeB',
    userId: null, msgId: 'fakeB_hi_' + Date.now(), ts: Date.now(),
    payload: { clientId: 'fakeB', userId: null, lastSeenTs: 0 }
  }));
});

ws.on('message', (raw) => {
  try {
    const env = JSON.parse(raw.toString());
    received.push(env);
    if (env.type === 'welcome') {
      console.log('[fakeB] welcome received. initialized=' + env.payload?.initialized +
                  ' tables=' + Object.keys(env.payload?.state || {}).filter(k => k !== '__meta').length);
    } else if (env.type === 'put') {
      console.log(`[fakeB] put ${env.payload?.table}/${env.payload?.record?.id} from ${env.clientId}`);
    } else if (env.type === 'remove') {
      console.log(`[fakeB] remove ${env.payload?.table}/${env.payload?.id} from ${env.clientId}`);
    } else if (env.type === 'event') {
      console.log(`[fakeB] event ${env.payload?.name} from ${env.clientId}`);
    } else {
      console.log(`[fakeB] ${env.type}`);
    }
  } catch (e) {
    console.log('[fakeB] bad message');
  }
});

ws.on('close', () => console.log('[fakeB] closed'));
ws.on('error', (e) => console.log('[fakeB] error:', e.message));

// Run until killed
process.on('SIGINT', () => { ws.close(); setTimeout(() => process.exit(0), 200); });

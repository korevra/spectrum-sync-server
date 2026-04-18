/* Test client that sends a put after connecting, then exits. */
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3860/sync');

ws.on('open', () => {
  console.log('[sender] connected');
  ws.send(JSON.stringify({
    v: 1, type: 'hello', clientId: 'sender',
    userId: null, msgId: 'sender_hi', ts: Date.now(),
    payload: { clientId: 'sender', userId: null, lastSeenTs: 0 }
  }));

  // After a moment, send a put
  setTimeout(() => {
    const ts = Date.now();
    const rec = {
      id: 'exp_sender_' + ts.toString(36),
      userId: 'SPE288',
      branchId: 'SP101',
      category: 'Fuel',
      amount: 4321,
      currency: 'NGN',
      description: 'Reverse-direction test from Node sender',
      receipt: null,
      status: 'pending',
      submittedAt: new Date().toISOString(),
      _syncTs: ts,
      _syncCid: 'sender'
    };
    ws.send(JSON.stringify({
      v: 1, type: 'put', clientId: 'sender',
      userId: null, msgId: 'sender_put_' + ts, ts,
      payload: { table: 'expense', record: rec }
    }));
    console.log('[sender] sent put expense/' + rec.id);
  }, 500);

  setTimeout(() => { ws.close(); process.exit(0); }, 1500);
});

ws.on('message', (raw) => {
  try {
    const env = JSON.parse(raw.toString());
    if (env.type !== 'welcome') console.log('[sender] recv ' + env.type);
  } catch (e) {}
});

ws.on('error', (e) => console.log('[sender] error', e.message));

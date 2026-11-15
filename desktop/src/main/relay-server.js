// LAN relay: a tiny Phoenix-channels compatible broadcast server (same wire format as Supabase Realtime)
// plus static hosting of the phone web controller. It only ever sees encrypted envelopes.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function startRelay({ port, webRoot }) {
  const topics = new Map();
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(webRoot, p));
    if (!file.startsWith(path.normalize(webRoot + path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  server.on('upgrade', (req, sock, head) => {
    if (!String(req.url || '').startsWith('/relay')) return sock.destroy();
    wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    ws.topics = new Set(); ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      const reply = (status, response = {}) => ws.send(JSON.stringify({ topic: m.topic, event: 'phx_reply', ref: m.ref, payload: { status, response } }));
      if (m.event === 'heartbeat') return reply('ok');
      if (m.event === 'phx_join' && typeof m.topic === 'string' && m.topic.length < 200) {
        if (!topics.has(m.topic)) topics.set(m.topic, new Set());
        topics.get(m.topic).add(ws); ws.topics.add(m.topic); return reply('ok');
      }
      if (m.event === 'phx_leave') { leave(ws, m.topic); return reply('ok'); }
      if (m.event === 'broadcast' && ws.topics.has(m.topic)) {
        const out = JSON.stringify({ topic: m.topic, event: 'broadcast', ref: null, payload: m.payload });
        for (const peer of topics.get(m.topic) || []) if (peer !== ws && peer.readyState === 1) peer.send(out);
      }
    });
    ws.on('close', () => { for (const t of [...ws.topics]) leave(ws, t); });
    ws.on('error', () => {});
  });
  function leave(ws, t) { const s = topics.get(t); if (s) { s.delete(ws); if (!s.size) topics.delete(t); } ws.topics.delete(t); }
  const sweep = setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch {} } }, 30000);
  return new Promise((resolve, reject) => {
    let tries = 0;
    const listen = p => {
      server.once('error', e => { if (e.code === 'EADDRINUSE' && tries++ < 10) listen(p + 1); else reject(e); });
      server.listen(p, '0.0.0.0', () => resolve({ port: server.address().port, close: () => { clearInterval(sweep); wss.close(); server.close(); } }));
    };
    listen(port);
  });
}
module.exports = { startRelay };

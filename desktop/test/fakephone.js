// A simulated phone that speaks the same protocol as the Android app. Used by the automated tests.
import { Room, decodePairing } from '../src/core/core.js';
import { sha256 } from '@noble/hashes/sha2.js';

const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const ROOT = '/storage/emulated/0';
const files = new Map(); // path -> { data: Uint8Array, m }
const log = { input: [], sms: [], replies: [], texts: [], clip: null };
const now = Date.now();
const dirOf = p => p.slice(0, p.lastIndexOf('/'));
const baseOf = p => p.slice(p.lastIndexOf('/') + 1);

function prng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return (t ^ t >>> 14) >>> 0; }; }
function randomBytes(size, seed) { const out = new Uint8Array(size), r = prng(seed), v = new DataView(out.buffer); let i = 0; for (; i + 4 <= size; i += 4) v.setUint32(i, r()); for (; i < size; i++) out[i] = r() & 255; return out; }
async function jpeg(w, h, hue, label) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, `hsl(${hue} 55% 70%)`); gr.addColorStop(1, `hsl(${(hue + 60) % 360} 45% 40%)`); g.fillStyle = gr; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(255,255,255,.85)'; g.font = `600 ${Math.round(h / 8)}px sans-serif`; g.fillText(label, w * 0.06, h * 0.9);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8)); return new Uint8Array(await blob.arrayBuffer());
}
async function seed() {
  for (let i = 0; i < 14; i++) files.set(`${ROOT}/DCIM/Camera/IMG_${2041 - i}.jpg`, { data: await jpeg(640, 480, (i * 47) % 360, 'IMG_' + (2041 - i)), m: now - i * 9 * 3600e3 });
  files.set(`${ROOT}/DCIM/Screenshots/Screenshot_1.jpg`, { data: await jpeg(360, 800, 200, 'Screenshot'), m: now - 5e6 });
  files.set(`${ROOT}/Download/Fees receipt.pdf`, { data: randomBytes(212000, 7), m: now - 86400e3 });
  files.set(`${ROOT}/Documents/Resume_final.pdf`, { data: randomBytes(96000, 8), m: now - 2 * 86400e3 });
  files.set(`${ROOT}/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/IMG-WA0001.jpg`, { data: await jpeg(480, 640, 120, 'WA0001'), m: now - 3e6 });
}
function list(path) {
  const pre = path.endsWith('/') ? path : path + '/'; const seen = new Map();
  for (const [p, f] of files) { if (!p.startsWith(pre)) continue; const rest = p.slice(pre.length), i = rest.indexOf('/');
    if (i < 0) seen.set(rest, { n: rest, p, d: false, s: f.data.length, m: f.m }); else { const n = rest.slice(0, i); if (!seen.has(n)) seen.set(n, { n, p: pre + n, d: true, s: 0, m: f.m }); } }
  return [...seen.values()].sort((a, b) => (b.d - a.d) || a.n.localeCompare(b.n));
}
const roots = [{ n: 'Internal storage', p: ROOT, i: 'phone' }];
const places = [{ n: 'Camera', p: ROOT + '/DCIM/Camera', i: 'camera' }, { n: 'Screenshots', p: ROOT + '/DCIM/Screenshots', i: 'camera' }, { n: 'Downloads', p: ROOT + '/Download', i: 'folder' }, { n: 'Documents', p: ROOT + '/Documents', i: 'file' },
  { n: 'WhatsApp media', p: ROOT + '/Android/media/com.whatsapp/WhatsApp/Media', i: 'folder' }, { n: 'Setu inbox', p: ROOT + '/Download/Setu', i: 'folder' }, { n: 'Internal storage', p: ROOT, i: 'phone' }];
const sms = { '+919820041000': { name: 'Mom', msgs: [{ id: 1, body: 'Did you eat dinner?', ts: now - 7200e3, out: false }, { id: 2, body: 'Yes, mess food. Studying for the case round now', ts: now - 7000e3, out: true }, { id: 3, body: 'Reached home? Call when free', ts: now - 600e3, out: false }], unread: 1 },
  '+919811122233': { name: 'Rahul', msgs: [{ id: 4, body: 'Cab at 7:15 tomorrow, ok?', ts: now - 5400e3, out: false }], unread: 1 },
  'VK-COURIER': { name: '', msgs: [{ id: 5, body: 'Your parcel will arrive today', ts: now - 90000e3, out: false }], unread: 0 } };
let notifs = [{ key: 'wa|1', pkg: 'com.whatsapp', app: 'WhatsApp', title: 'Aman', text: 'Send the deck pls, practice at 10', ts: now - 180e3, reply: true }, { key: 'tg|2', pkg: 'org.telegram.messenger', app: 'Telegram', title: 'Class group', text: 'Quiz moved to Monday', ts: now - 1200e3, reply: false }];

let screen = null, room = null;
function startScreen() {
  if (screen) return screen;
  const c = document.createElement('canvas'); c.width = 360; c.height = 780; const g = c.getContext('2d'); let n = 0;
  const draw = () => { g.fillStyle = '#EEF3F1'; g.fillRect(0, 0, 360, 780); g.fillStyle = '#0E6B74'; g.fillRect(0, 0, 360, 56); g.fillStyle = '#fff'; g.font = '600 20px sans-serif'; g.fillText('Simulated phone', 16, 36);
    g.fillStyle = '#15202B'; g.font = '56px sans-serif'; g.fillText(String(n++), 24, 160); g.font = '16px sans-serif'; g.fillText('taps: ' + log.input.filter(e => e.k === 'tap').length, 24, 200);
    const last = log.input.filter(e => e.k === 'tap').pop(); if (last) { g.fillStyle = '#F2A20C'; g.beginPath(); g.arc(last.x * 360, last.y * 780, 14, 0, 7); g.fill(); } };
  draw(); const timer = setInterval(draw, 66);
  const stream = c.captureStream(15); screen = { track: stream.getVideoTracks()[0], timer }; return screen;
}
let cam = null, locked = false;
function startCam(facing) {
  stopCam();
  const c = document.createElement('canvas'); c.width = 640; c.height = 480; const g = c.getContext('2d'); let n = 0;
  const draw = () => { g.fillStyle = facing === 'front' ? '#3A2A55' : '#1F3B2C'; g.fillRect(0, 0, 640, 480); g.fillStyle = '#fff'; g.font = '600 30px sans-serif'; g.fillText('Simulated ' + facing + ' camera', 30, 70); g.font = '80px sans-serif'; g.fillText(String(n++), 30, 200); };
  draw(); const timer = setInterval(draw, 66);
  cam = { track: c.captureStream(15).getVideoTracks()[0], timer, facing }; log.cam = facing; return cam;
}
function stopCam() { if (!cam) return; clearInterval(cam.timer); cam.track.stop(); cam = null; }
function stopScreen(peer) { if (!screen) return; clearInterval(screen.timer); screen.track.stop(); screen = null; peer && peer.setVideo(null).catch(() => {}); }

const handlers = {
  'sys.info': async () => ({ locked, unlock: true, name: 'Test Phone', model: 'vivo V60 (simulated)', android: '16', battery: 78, charging: true, storageTotal: 128e9, storageFree: 54e9, smsUnread: Object.values(sms).reduce((a, t) => a + t.unread, 0), caps: { input: true, files: true, sms: true, notif: true } }),
  'fs.list': async p => { if (!p.path) return { path: '', parent: null, total: roots.length, entries: roots.map(r => ({ ...r, d: true })), roots, places };
    const all = list(p.path); const off = p.offset | 0, lim = p.limit || 500; return { path: p.path, parent: p.path === ROOT ? '' : dirOf(p.path), total: all.length, entries: all.slice(off, off + lim), roots, places }; },
  'fs.read': async p => { const f = files.get(p.path); if (!f) throw new Error('File not found'); return { size: f.data.length, mtime: f.m, name: baseOf(p.path), __stream: (async function* () { for (let o = 0; o < f.data.length; o += 262144) yield f.data.subarray(o, o + 262144); })() }; },
  'fs.write': async p => { const dir = p.dir || ROOT + '/Download/Setu'; let path = dir + '/' + p.name; for (let i = 1; files.has(path); i++) path = `${dir}/${p.name.replace(/(\.[^.]*)?$/, ` (${i})$1`)}`; const parts = [];
    return { path, __sink: { write: c => { parts.push(c.slice()); }, end: ok => { if (ok) { const data = new Uint8Array(parts.reduce((a, c) => a + c.length, 0)); let o = 0; for (const c of parts) { data.set(c, o); o += c.length; } files.set(path, { data, m: p.mtime || Date.now() }); } return { path }; } } }; },
  'fs.thumb': async p => { const f = files.get(p.path); if (!f) throw new Error('File not found'); const bmp = await createImageBitmap(new Blob([f.data], { type: 'image/jpeg' })); const sc = Math.min(1, (p.max || 200) / Math.max(bmp.width, bmp.height)); const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); return { b64: c.toDataURL('image/jpeg', 0.7).split(',')[1], w: bmp.width, h: bmp.height }; },
  'media.recent': async p => ({ items: [...files].filter(([k]) => k.startsWith(ROOT + '/DCIM/')).map(([k, f]) => ({ p: k, n: baseOf(k), s: f.data.length, m: f.m })).sort((a, b) => b.m - a.m).slice(0, p.limit || 300) }),
  'sms.threads': async () => ({ items: Object.entries(sms).map(([addr, t]) => { const l = t.msgs[t.msgs.length - 1]; return { addr, name: t.name, last: l.body, ts: l.ts, unread: t.unread }; }).sort((a, b) => b.ts - a.ts) }),
  'sms.list': async p => { const t = sms[p.addr]; if (!t) throw new Error('No such conversation'); t.unread = 0; return { items: t.msgs.slice(-(p.limit || 50)) }; },
  'sms.send': async p => { if (!p.addr || !p.body) throw new Error('Missing number or text'); (sms[p.addr] ||= { name: '', msgs: [], unread: 0 }).msgs.push({ id: Date.now(), body: p.body, ts: Date.now(), out: true }); log.sms.push(p); return { ok: true }; },
  'notif.list': async () => ({ items: notifs }),
  'notif.reply': async p => { const n = notifs.find(x => x.key === p.key); if (!n || !n.reply) throw new Error('This notification can no longer be replied to'); log.replies.push(p); notifs = notifs.filter(x => x !== n); return { ok: true }; },
  'text.push': async p => { log.texts.push(p.text); log.clip = p.text; return {}; },
  'clip.set': async p => { log.clip = p.text; return {}; },
  'cam.start': async (p, peer) => { stopScreen(); const c = startCam(p.facing === 'front' ? 'front' : 'back'); await peer.setVideo(c.track); return { w: 640, h: 480, facing: c.facing, cams: ['back', 'front'] }; },
  'cam.stop': async (_p, peer) => { stopCam(); peer.setVideo(null).catch(() => {}); return {}; },
  'dev.unlock': async () => { if (!locked) return { ok: true, already: true }; locked = false; log.unlocks = (log.unlocks || 0) + 1; return { ok: true }; },
  'screen.start': async (_p, peer) => { stopCam(); const s = startScreen(); await peer.setVideo(s.track); return { w: 360, h: 780 }; },
  'screen.stop': async (_p, peer) => { stopScreen(peer); return {}; },
};

async function boot() {
  await seed();
  const p = decodePairing(location.hash);
  const relays = (p.lan || []).map(h => ({ url: `ws://${h}/relay?vsn=1.0.0`, kind: 'lan' }));
  const q = new URLSearchParams(location.search);
  room = new Room({ self: { id: q.get('id') || '555000111', name: 'Test Phone', role: 'phone', caps: { input: true, files: true, sms: true, notif: true } }, secret: p.s, relays: q.get('relay') ? [{ url: q.get('relay'), kind: 'lan' }] : relays, offerer: false, handlers,
    onInput: ev => { log.input.push(ev); } });
  const pc = () => [...room.peers.values()].find(x => x.role === 'pc');
  window.__fp = { room, files, log, pc, ready: true,
    addRandom: (path, size, sd) => { files.set(path, { data: randomBytes(size, sd), m: Date.now() }); return true; },
    hash: path => { const f = files.get(path); return f ? hex(sha256(f.data)) : null; },
    find: name => [...files.keys()].filter(k => baseOf(k) === name),
    postNotif: n => { notifs = [n, ...notifs]; return pc().notify('notif.posted', n); },
    smsIn: (addr, body) => { const t = (sms[addr] ||= { name: '', msgs: [], unread: 0 }); t.msgs.push({ id: Date.now(), body, ts: Date.now(), out: false }); t.unread++; return pc().notify('sms.received', { addr, name: t.name, body, ts: Date.now() }); },
    sendToPc: async (name, size, sd) => { const data = randomBytes(size, sd); const r = await pc().push('fs.write', { name, mtime: Date.now() }, (async function* () { for (let o = 0; o < data.length; o += 262144) yield data.subarray(o, o + 262144); })(), size); return { path: r.path, hash: hex(sha256(data)) }; },
    textToPc: t => pc().request('text.push', { text: t }),
    setLocked: v => { locked = !!v; return pc().notify('sys.changed'); }, locked: () => locked,
  };
}
boot();

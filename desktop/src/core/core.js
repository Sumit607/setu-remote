// Setu Remote core: encrypted relay signaling, RPC, on-demand WebRTC link, bulk transfers.
// Runs in any Chromium page (PC app renderer, phone web controller, test phone).
// The wire format is specified in /protocol/PROTOCOL.md; the Android app implements the same.
import { gcm } from '@noble/ciphers/aes.js';
import { sha256 } from '@noble/hashes/sha2.js';

const te = new TextEncoder(), td = new TextDecoder();
export const rand = n => crypto.getRandomValues(new Uint8Array(n));
export const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
export const b64 = {
  enc(b) { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); },
  dec(s) { const bin = atob(s); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; },
};
export const b64u = {
  enc: b => b64.enc(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => b64.dec(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)),
};
const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

export const DEFAULT_RELAY = { u: 'https://onehmelzuguildygncdr.supabase.co', k: 'sb_publishable_-Z_QvDKwSUphuI0bGZpWRw_gjqA3cqF' };
export const relayOf = p => (p.relay === undefined ? DEFAULT_RELAY : p.relay);
export const PAIR_PREFIX = 'setu1.';
export const encodePairing = o => PAIR_PREFIX + b64u.enc(te.encode(JSON.stringify(o)));
export function decodePairing(str) {
  const s = String(str || '').trim();
  const i = s.indexOf(PAIR_PREFIX);
  if (i < 0) throw new Error('That is not a Setu pairing code');
  const o = JSON.parse(td.decode(b64u.dec(s.slice(i + PAIR_PREFIX.length).split(/[\s&]/)[0])));
  if (!o.s || !o.id) throw new Error('Pairing code is incomplete');
  return o;
}
export const newSecret = () => b64u.enc(rand(32));
export const newDeviceId = () => { const v = new DataView(rand(4).buffer).getUint32(0) % 900000000 + 100000000; return String(v); };

export function deriveKeys(secret) {
  const s = b64u.dec(secret);
  return { room: hex(sha256(cat(te.encode('setu-room-v1'), s))).slice(0, 32), key: sha256(cat(te.encode('setu-key-v1'), s)) };
}
export function seal(k, obj) {
  const n = rand(12);
  return { n: b64.enc(n), c: b64.enc(gcm(k.key, n, te.encode(k.room)).encrypt(te.encode(JSON.stringify(obj)))) };
}
export function unseal(k, env) {
  try { return JSON.parse(td.decode(gcm(k.key, b64.dec(env.n), te.encode(k.room)).decrypt(b64.dec(env.c)))); } catch { return null; }
}

class Emitter {
  constructor() { this._l = {}; }
  on(e, f) { (this._l[e] ||= []).push(f); return () => { this._l[e] = (this._l[e] || []).filter(x => x !== f); }; }
  emit(e, ...a) { (this._l[e] || []).slice().forEach(f => { try { f(...a); } catch (err) { console.error(err); } }); }
}

// Phoenix-channels client (the protocol Supabase Realtime speaks; the PC app's LAN relay speaks it too).
export class Relay {
  constructor({ url, topic, kind, onmsg, onstate }) {
    Object.assign(this, { url, topic: 'realtime:' + topic, kind, onmsg, onstate });
    this.state = 'closed'; this.ref = 0; this.retry = 0; this.stopped = false; this.lastPing = 0;
  }
  connect() {
    if (this.stopped) return;
    let ws;
    try { ws = this.ws = new WebSocket(this.url); } catch { return this._again(); }
    ws.onopen = () => {
      this.joinRef = String(++this.ref);
      ws.send(JSON.stringify({ topic: this.topic, event: 'phx_join', ref: this.joinRef,
        payload: { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, private: false } } }));
      this.hb = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++this.ref) })); }, 25000);
    };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.event === 'broadcast' && m.payload && m.payload.event === 'sig') this.onmsg(m.payload.payload);
      else if (m.event === 'phx_reply' && m.ref === this.joinRef) {
        if (m.payload && m.payload.status === 'ok') { this.retry = 0; this._set('open'); } else ws.close();
      } else if (m.event === 'phx_error' || m.event === 'phx_close') { if (m.topic === this.topic) ws.close(); }
    };
    ws.onclose = () => { clearInterval(this.hb); if (ws === this.ws) { this._set('closed'); this._again(); } };
    ws.onerror = () => {};
  }
  _set(s) { if (this.state !== s) { this.state = s; this.onstate && this.onstate(s); } }
  _again() { if (this.stopped) return; clearTimeout(this.rt); this.rt = setTimeout(() => this.connect(), Math.min(15000, 1000 * 2 ** this.retry++)); }
  send(payload) {
    if (this.state !== 'open') return false;
    this.ws.send(JSON.stringify({ topic: this.topic, event: 'broadcast', ref: String(++this.ref), payload: { type: 'broadcast', event: 'sig', payload } }));
    return true;
  }
  close() { this.stopped = true; clearTimeout(this.rt); clearInterval(this.hb); try { this.ws && this.ws.close(); } catch {} this._set('closed'); }
}

export const DEFAULT_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const LINK_METHODS = /^(fs|media|screen)\./;
const CHUNK = 48 * 1024, HIGH = 4 * 1024 * 1024, LOW = 1024 * 1024;
const frame = (xid, flag, data) => { const o = new Uint8Array(5 + (data ? data.length : 0)); new DataView(o.buffer).setUint32(0, xid); o[4] = flag; if (data) o.set(data, 5); return o; };
const defer = () => { const d = {}; d.promise = new Promise((res, rej) => { d.res = res; d.rej = rej; }); d.promise.catch(() => {}); return d; };

export class Room extends Emitter {
  // o: { self:{id,name,role,caps}, secret, relays:[{url,kind}], offerer, handlers, onInput, getIce, selfExtra, idleMs }
  constructor(o) {
    super();
    this.self = o.self; this.keys = deriveKeys(o.secret); this.offerer = !!o.offerer;
    this.handlers = o.handlers || {}; this.onInput = o.onInput; this.getIce = o.getIce;
    this.selfExtra = o.selfExtra || (() => ({})); this.idleMs = o.idleMs || 120000;
    this.peers = new Map(); this.seen = new Set(); this.seenQ = []; this.relays = []; this.boot = hex(rand(4));
    for (const r of o.relays || []) this.addRelay(r);
    this._t = setInterval(() => this._tick(), 3000);
  }
  addRelay(r) {
    if (this.relays.some(x => x.url === r.url)) return;
    const rel = new Relay({ url: r.url, topic: 'setu-' + this.keys.room, kind: r.kind,
      onmsg: p => this._onRelay(p, rel),
      onstate: s => { if (s === 'open') this._announce('hello', rel); this.emit('relay', rel, s); } });
    rel.pingEvery = r.kind === 'lan' ? 10000 : 45000;
    this.relays.push(rel); rel.connect(); return rel;
  }
  removeRelay(url) { const i = this.relays.findIndex(x => x.url === url); if (i >= 0) { this.relays[i].close(); this.relays.splice(i, 1); } }
  get relayOpen() { return this.relays.some(r => r.state === 'open'); }
  _wire(obj, only) {
    const env = { e: seal(this.keys, obj) }; let sent = false;
    for (const r of this.relays) { if (only && r !== only) continue; if (r.send(env)) sent = true; }
    return sent;
  }
  send(to, obj) { return this._wire({ ...obj, from: this.self.id, to, mid: hex(rand(8)) }); }
  _announce(t, rel) {
    if (rel) rel.lastPing = Date.now();
    this._wire({ t, from: this.self.id, to: '*', mid: hex(rand(8)), name: this.self.name, role: this.self.role, caps: this.self.caps || {}, x: this.selfExtra(), boot: this.boot }, rel);
  }
  announce() { for (const r of this.relays) if (r.state === 'open') this._announce('ping', r); }
  _tick() {
    const now = Date.now(); let changed = false;
    for (const r of this.relays) if (r.state === 'open' && now - r.lastPing >= r.pingEvery) this._announce('ping', r);
    for (const p of this.peers.values()) {
      const on = now - p.seenLan < 25000 || now - p.seenCloud < 110000;
      if (on !== p.online) { p.online = on; changed = true; if (!on) p._linkDown(); }
    }
    if (changed) this.emit('peers');
  }
  _onRelay(payload, rel) {
    const m = payload && payload.e && unseal(this.keys, payload.e);
    if (!m || !m.from || m.from === this.self.id) return;
    if (m.to !== '*' && m.to !== this.self.id) return;
    let p = this.peers.get(m.from);
    if (!p) { p = new Peer(this, m.from); this.peers.set(m.from, p); }
    const now = Date.now();
    if (rel.kind === 'lan') p.seenLan = now; else p.seenCloud = now;
    if (this.seen.has(m.mid)) return;
    this.seen.add(m.mid); this.seenQ.push(m.mid); if (this.seenQ.length > 600) this.seen.delete(this.seenQ.shift());
    const was = p.online; p.online = true; let changed = !was;
    switch (m.t) {
      case 'hello': case 'ping': {
        const sig = JSON.stringify([m.name, m.role, m.caps, m.x]);
        if (sig !== p._sig) { p._sig = sig; changed = true; }
        p.name = m.name || p.name; p.role = m.role || ''; p.caps = m.caps || {}; p.x = m.x || {};
        if (m.boot && p.boot && m.boot !== p.boot) p._linkDown(new Error('The other device restarted'));
        if (m.boot) p.boot = m.boot;
        if (m.t === 'hello') this._announce('ping', rel);
        break;
      }
      case 'bye': p.seenLan = p.seenCloud = 0; p.online = false; p._linkDown(); changed = true; break;
      case 'rpc': p._onRpc(m.d, true); break;
      default: p._onSignal(m);
    }
    if (changed) this.emit('peers');
  }
  close() {
    this._wire({ t: 'bye', from: this.self.id, to: '*', mid: hex(rand(8)) });
    clearInterval(this._t);
    for (const p of this.peers.values()) p._linkDown();
    setTimeout(() => this.relays.forEach(r => r.close()), 50);
  }
}

export class Peer extends Emitter {
  constructor(room, id) {
    super();
    Object.assign(this, { room, id, name: id, role: '', caps: {}, x: {}, online: false, seenLan: 0, seenCloud: 0 });
    this.pending = new Map(); this.recv = new Map(); this.doneWait = new Map();
    this.rid = 0; this.xid = 0; this.link = 'idle'; this.busy = 0; this.iceQ = [];
    this.pc = this.ctl = this.bulk = this.input = this.tx = null; this.localTrack = this.remoteTrack = null;
  }
  // ---------- RPC (over the link when it is up, else over the encrypted relay)
  _rpcSend(d, linkOnly, relayOnly) {
    const c = this.ctl;
    if (!relayOnly && c && c.readyState === 'open') { c.send(JSON.stringify(d)); return true; }
    return linkOnly ? false : this.room.send(this.id, { t: 'rpc', d });
  }
  async request(m, p = {}, o = {}) {
    const big = o.link ?? LINK_METHODS.test(m);
    if (big) await this.ensureLink();
    const id = ++this.rid;
    return new Promise((res, rej) => {
      const to = setTimeout(() => { this.pending.delete(id); rej(new Error('No reply from ' + this.name + ' (' + m + ')')); }, o.timeout || 15000);
      this.pending.set(id, { res, rej, to });
      if (!this._rpcSend({ k: 'req', id, m, p }, big)) { clearTimeout(to); this.pending.delete(id); rej(new Error(this.online ? 'Not connected' : this.name + ' is offline')); }
    });
  }
  notify(m, p = {}) { return this._rpcSend({ k: 'evt', m, p }); }
  async _onRpc(d, viaRelay) {
    if (!d) return;
    if (d.k === 'res') {
      const q = this.pending.get(d.id); if (!q) return;
      clearTimeout(q.to); this.pending.delete(d.id);
      d.ok ? q.res(d.r) : q.rej(new Error(d.e || 'Failed'));
    } else if (d.k === 'evt') {
      if (d.m === 'xfer.done') { const w = this.doneWait.get(d.p.xid); if (w) { this.doneWait.delete(d.p.xid); w(d.p); } return; }
      this.emit('evt', d.m, d.p || {}); this.room.emit('evt', this, d.m, d.p || {});
    } else if (d.k === 'req') {
      this._idleCheck();
      const p = d.p || {}; let stream = null;
      try {
        const h = this.room.handlers[d.m];
        if (!h) throw new Error('Not supported: ' + d.m);
        const r = (await h(p, this)) || {};
        if (r.__sink) { this.recv.set(p.xid, { sink: r.__sink, size: p.size, got: 0, notify: true }); delete r.__sink; this._hold(); }
        if (r.__stream) { stream = r.__stream; delete r.__stream; }
        this._rpcSend({ k: 'res', id: d.id, ok: true, r }, false, viaRelay);
      } catch (e) { this._rpcSend({ k: 'res', id: d.id, ok: false, e: String(e && e.message || e) }, false, viaRelay); return; }
      if (stream) this._pump(p.xid, stream).catch(() => {});
    }
  }
  // ---------- bulk data: frames of [u32 transfer id][u8 flag 0=data 1=end 2=error][payload]
  async _pump(xid, iter) {
    this._hold(); const dc = this.bulk;
    try {
      for await (const chunk of iter) for (let o = 0; o < chunk.length; o += CHUNK) { await this._drain(dc); dc.send(frame(xid, 0, chunk.subarray(o, o + CHUNK))); }
      dc.send(frame(xid, 1));
    } catch (e) { try { dc.send(frame(xid, 2, te.encode(String(e && e.message || e)))); } catch {} throw e; } finally { this._release(); }
  }
  _drain(dc) {
    if (!dc || dc.readyState !== 'open') return Promise.reject(new Error('Connection lost'));
    if (dc.bufferedAmount < HIGH) return Promise.resolve();
    return new Promise((res, rej) => {
      const done = f => () => { dc.removeEventListener('bufferedamountlow', ok); dc.removeEventListener('close', bad); f(); };
      const ok = done(res), bad = done(() => rej(new Error('Connection lost')));
      dc.addEventListener('bufferedamountlow', ok); dc.addEventListener('close', bad);
    });
  }
  _onBulk(buf) {
    const v = new DataView(buf), xid = v.getUint32(0), flag = v.getUint8(4), r = this.recv.get(xid);
    if (!r) return;
    const data = new Uint8Array(buf, 5);
    r.chain = (r.chain || Promise.resolve()).then(async () => {
      if (r.dead) return;
      if (flag === 0) { r.got += data.length; await r.sink.write(data); r.progress && r.progress(r.got); return; }
      this.recv.delete(xid);
      const ok = flag === 1 && (r.size == null || r.got === r.size);
      const err = ok ? null : flag === 2 ? td.decode(data) : 'File arrived incomplete';
      let final; try { final = await r.sink.end(ok); } catch (e) { final = null; }
      if (r.notify) { this.notify('xfer.done', { xid, ok, e: err, ...(final || {}) }); this._release(); }
      if (r.done) ok ? r.done.res(r.got) : r.done.rej(new Error(err));
    }).catch(e => this._failRecv(xid, r, e));
  }
  _failRecv(xid, r, e) {
    if (r.dead) return; r.dead = true; this.recv.delete(xid);
    Promise.resolve().then(() => r.sink.end(false)).catch(() => {});
    if (r.notify) { this.notify('xfer.done', { xid, ok: false, e: String(e && e.message || e) }); this._release(); }
    if (r.done) r.done.rej(e instanceof Error ? e : new Error(String(e)));
  }
  // Download: ask the peer to stream something (e.g. fs.read) into `sink` {write(u8), end(ok)}.
  async pull(m, p, sink, onProgress) {
    await this.ensureLink();
    const xid = ++this.xid, done = defer(); this._hold();
    try {
      this.recv.set(xid, { sink, size: null, got: 0, done, progress: onProgress });
      let info;
      try { info = await this.request(m, { ...p, xid }, { link: true, timeout: 20000 }); }
      catch (e) { const r = this.recv.get(xid); if (r) { r.dead = true; this.recv.delete(xid); Promise.resolve().then(() => sink.end(false)).catch(() => {}); } throw e; }
      const got = await done.promise;
      if (info.size != null && got !== info.size) throw new Error('File arrived incomplete');
      return info;
    } finally { this._release(); }
  }
  // Upload: stream `source` (async iterable of Uint8Array) to the peer (e.g. fs.write).
  async push(m, p, source, size, onProgress) {
    await this.ensureLink();
    const xid = ++this.xid; this._hold();
    try {
      const info = await this.request(m, { ...p, size, xid }, { link: true, timeout: 20000 });
      const fin = new Promise(res => this.doneWait.set(xid, res));
      const dc = this.bulk; let sent = 0;
      for await (const chunk of source) for (let o = 0; o < chunk.length; o += CHUNK) {
        await this._drain(dc); const part = chunk.subarray(o, o + CHUNK);
        dc.send(frame(xid, 0, part)); sent += part.length; onProgress && onProgress(sent);
      }
      dc.send(frame(xid, 1));
      const d = await Promise.race([fin, new Promise(res => setTimeout(() => res({ ok: false, e: 'No confirmation from ' + this.name }), 60000))]);
      this.doneWait.delete(xid);
      if (!d.ok) throw new Error(d.e || 'The other device could not save the file');
      return { ...info, ...d };
    } finally { this._release(); }
  }
  // ---------- link (WebRTC), created on demand and closed when idle
  ensureLink() {
    if (this.link === 'up') return Promise.resolve();
    if (!this.online) return Promise.reject(new Error(this.name + ' is offline'));
    if (!this._linkD) {
      this._linkD = defer();
      this._linkTO = setTimeout(() => this._linkDown(new Error('Could not open a direct connection to ' + this.name)), 25000);
      if (this.room.offerer) this._startOffer().catch(e => this._linkDown(e));
      else this.room.send(this.id, { t: 'link-req' });
    }
    return this._linkD.promise;
  }
  _makePc(iceServers) {
    this._closePc();
    const pc = this.pc = new RTCPeerConnection({ iceServers: iceServers || DEFAULT_ICE });
    this.link = 'connecting';
    pc.onicecandidate = e => { if (e.candidate && pc === this.pc) this.room.send(this.id, { t: 'ice', sid: this.sid, c: e.candidate.toJSON() }); };
    pc.ontrack = e => { this.remoteTrack = e.track; this.emit('track', e.track); };
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return; const s = pc.connectionState; clearTimeout(this._discT);
      if (s === 'failed') this._linkDown(new Error('Connection lost'));
      else if (s === 'disconnected') this._discT = setTimeout(() => { if (pc === this.pc && pc.connectionState !== 'connected') this._linkDown(new Error('Connection lost')); }, 8000);
    };
    return pc;
  }
  async _startOffer() {
    const ice = this.room.getIce ? await this.room.getIce() : DEFAULT_ICE;
    this.sid = hex(rand(6));
    const pc = this._makePc(ice);
    this._bind(pc.createDataChannel('ctl')); this._bind(pc.createDataChannel('bulk')); this._bind(pc.createDataChannel('input'));
    this.tx = pc.addTransceiver('video', { direction: 'sendrecv' });
    if (this.localTrack) await this.tx.sender.replaceTrack(this.localTrack);
    await pc.setLocalDescription(await pc.createOffer());
    if (pc === this.pc) this.room.send(this.id, { t: 'offer', sid: this.sid, sdp: pc.localDescription.sdp, ice });
  }
  async _onSignal(m) {
    try {
      if (m.t === 'link-req') {
        if (this.room.offerer && !this._linkD) { this._closePc(); this.ensureLink().catch(() => {}); }
      } else if (m.t === 'offer') {
        if (this.room.offerer) return;
        this.sid = m.sid;
        const pc = this._makePc(m.ice);
        pc.ondatachannel = e => this._bind(e.channel);
        await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        this.tx = pc.getTransceivers().find(t => t.receiver && t.receiver.track && t.receiver.track.kind === 'video') || null;
        if (this.tx) { this.tx.direction = 'sendrecv'; if (this.localTrack) await this.tx.sender.replaceTrack(this.localTrack); }
        await pc.setLocalDescription(await pc.createAnswer());
        if (pc !== this.pc) return;
        this.room.send(this.id, { t: 'answer', sid: m.sid, sdp: pc.localDescription.sdp });
        this._flushIce();
      } else if (m.sid !== this.sid || !this.pc) {
        return;
      } else if (m.t === 'answer') {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); this._flushIce();
      } else if (m.t === 'ice') {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(m.c); else this.iceQ.push(m.c);
      } else if (m.t === 'link-close') {
        this._linkDown();
      }
    } catch (e) { console.warn('[setu] signal error', m.t, e); }
  }
  _flushIce() { const q = this.iceQ; this.iceQ = []; for (const c of q) this.pc && this.pc.addIceCandidate(c).catch(() => {}); }
  _bind(c) {
    if (c.label === 'ctl') {
      this.ctl = c;
      c.onmessage = e => { let d; try { d = JSON.parse(e.data); } catch { return; } this._onRpc(d); };
      c.onclose = () => { if (c === this.ctl) this._linkDown(new Error('Connection lost')); };
    } else if (c.label === 'bulk') {
      this.bulk = c; c.binaryType = 'arraybuffer'; c.bufferedAmountLowThreshold = LOW;
      c.onmessage = e => this._onBulk(e.data);
    } else if (c.label === 'input') {
      this.input = c;
      c.onmessage = e => { let d; try { d = JSON.parse(e.data); } catch { return; } this.room.onInput && this.room.onInput(d, this); };
    } else return;
    c.onopen = () => { if (this.link !== 'up' && [this.ctl, this.bulk, this.input].every(x => x && x.readyState === 'open')) this._linkUp(); };
    if (c.readyState === 'open') c.onopen();
  }
  _linkUp() {
    clearTimeout(this._linkTO); this.link = 'up';
    const d = this._linkD; this._linkD = null; if (d) d.res();
    this.emit('link', 'up'); this.room.emit('link', this, 'up'); this._idleCheck();
  }
  _linkDown(err) {
    if (!this.pc && !this._linkD) return;
    const wasUp = this.link === 'up';
    clearTimeout(this._linkTO); this._closePc();
    const d = this._linkD; this._linkD = null; if (d) d.rej(err instanceof Error ? err : new Error('Connection lost'));
    for (const [xid, r] of [...this.recv]) this._failRecv(xid, r, new Error('Connection lost'));
    for (const [xid, w] of [...this.doneWait]) { this.doneWait.delete(xid); w({ ok: false, e: 'Connection lost' }); }
    this.remoteTrack = null;
    if (this.localTrack) { this.localTrack = null; this._release(); this.emit('video-ended'); }
    if (wasUp) { this.emit('link', 'down'); this.room.emit('link', this, 'down'); }
  }
  _closePc() {
    const pc = this.pc; this.pc = this.ctl = this.bulk = this.input = this.tx = null; this.iceQ = []; this.link = 'idle';
    clearTimeout(this._idleT); clearTimeout(this._discT);
    if (pc) { pc.onconnectionstatechange = pc.onicecandidate = pc.ontrack = null; try { pc.close(); } catch {} }
  }
  closeLink() { if (this.pc) { this.room.send(this.id, { t: 'link-close', sid: this.sid }); this._linkDown(); } }
  _hold() { this.busy++; clearTimeout(this._idleT); }
  _release() { this.busy = Math.max(0, this.busy - 1); this._idleCheck(); }
  _idleCheck() {
    clearTimeout(this._idleT);
    if (this.busy === 0 && this.link === 'up' && this.room.offerer) this._idleT = setTimeout(() => { if (this.busy === 0) this.closeLink(); }, this.room.idleMs);
  }
  hold() { this._hold(); let done = false; return () => { if (!done) { done = true; this._release(); } }; }
  // ---------- video (one pre-negotiated two-way video line; tracks are swapped in without renegotiating)
  async setVideo(track) {
    const had = !!this.localTrack; this.localTrack = track || null;
    if (track && !had) this._hold(); if (!track && had) this._release();
    if (this.tx) await this.tx.sender.replaceTrack(this.localTrack);
  }
  sendInput(d) { const c = this.input; if (c && c.readyState === 'open') { c.send(JSON.stringify(d)); return true; } return false; }
}

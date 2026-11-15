// Phone web controller: control the laptop from a phone browser (or the Android app's built-in web view).
import { Room, decodePairing, newDeviceId, relayOf } from '../core/core.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}"><use href="#i-${n}"/></svg>`;
const fmtSize = b => b == null ? '' : b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(1) + ' GB';
const LS = { get: k => { try { return JSON.parse(localStorage.getItem('setu.' + k)); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem('setu.' + k, JSON.stringify(v)); } catch {} } };

const st = { view: 'home', pairing: null, room: null, pc: null, mode: LS.get('mode') || 'pad', mods: new Set(), kb: false, files: null, busy: '', err: '', live: false };
const params = new URLSearchParams((location.hash.split('&').slice(1).join('&')));
const embedded = params.get('embed') === '1';
const auto = params.get('auto') === '1'; let autoDone = false;
const Z = { s: 1, x: 0, y: 0 }; // zoom of the laptop picture: scale and offset in CSS pixels
const hostClose = () => { try { window.SetuHost && window.SetuHost.close(); } catch {} };

function toast(msg, bad) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : ''); clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, bad ? 6000 : 3000); }
const fail = e => { console.error(e); toast(String(e && e.message || e), true); };

function boot() {
  let pairing = null;
  if (location.hash.includes('setu1.')) { try { pairing = decodePairing(location.hash); LS.set('pairing', pairing); if (!embedded) history.replaceState(null, '', location.pathname); } catch (e) { st.err = e.message; } }
  pairing ||= LS.get('pairing');
  st.pairing = pairing;
  if (pairing) connect();
  render();
}
function connect() {
  const p = st.pairing;
  let me = LS.get('me');
  if (params.get('id')) me = { id: params.get('id'), name: params.get('name') || 'Phone' };
  if (!me) { me = { id: newDeviceId(), name: /Android/i.test(navigator.userAgent) ? 'Android browser' : /iPhone|iPad/i.test(navigator.userAgent) ? 'iPhone browser' : 'Browser' }; LS.set('me', me); }
  const relays = []; const secure = location.protocol === 'https:';
  if (!secure) {
    const hosts = new Set(p.lan || []); if (location.protocol === 'http:' && location.host) hosts.add(location.host);
    for (const h of hosts) relays.push({ url: `ws://${h}/relay?vsn=1.0.0`, kind: 'lan' });
  }
  const cloud = relayOf(p);
  if (cloud && cloud.u) relays.push({ url: cloud.u.replace(/^http/, 'ws').replace(/\/+$/, '') + '/realtime/v1/websocket?apikey=' + encodeURIComponent(cloud.k) + '&vsn=1.0.0', kind: 'cloud' });
  st.room = new Room({ self: { id: me.id, name: me.name, role: 'web', caps: {} }, secret: p.s, relays, offerer: false, handlers: {
    'sys.info': async () => ({ name: me.name, role: 'web' }),
    'text.push': async q => { st.lastText = q.text; try { await navigator.clipboard.writeText(q.text); toast('Text from laptop copied'); } catch { toast('Text from laptop: ' + q.text); } return {}; },
  } });
  st.room.on('peers', () => {
    const pc = [...st.room.peers.values()].find(x => x.role === 'pc') || null;
    if (pc && pc !== st.pc) { st.pc = pc; pc.on('track', () => attach()); pc.on('link', s => { if (s === 'down' && st.view === 'remote') leaveRemote(true); }); pc.on('evt', (m, q) => { if (m === 'screen.ended' && st.view === 'remote') leaveRemote(true); else if (m === 'cursor') { st.cur = q; followCursor(); } else if (m === 'sys.changed') refreshPc(); }); }
    if (pc && pc.online && !st.info && !st.infoBusy) refreshPc();
    if (pc && !pc.online) st.info = null;
    if (auto && !autoDone && st.view === 'home' && pc && pc.online) { autoDone = true; enterRemote('screen'); return; }
    if (st.view !== 'remote') render(); else $('#rstate') && ($('#rstate').className = 'dot ' + (pc && pc.online ? 'on' : ''));
  });
  st.room.on('relay', () => { if (st.view === 'home') render(); });
}
const online = () => !!(st.pc && st.pc.online);
async function refreshPc() { const pc = st.pc; if (!pc || !pc.online) return; st.infoBusy = true; try { st.info = await pc.request('sys.info', {}, { timeout: 6000 }); } catch {} st.infoBusy = false; if (st.view === 'home') render(); }
const needPc = () => { if (!st.pc) throw new Error('Waiting for your laptop. Is Setu Remote open on it?'); if (!st.pc.online) throw new Error((st.pc.name || 'Laptop') + ' is offline'); return st.pc; };

// ------------------------------------------------------------ views
function render() {
  const app = $('#app'); document.body.dataset.view = st.view;
  if (!st.pairing) { app.innerHTML = vUnpaired(); return; }
  app.innerHTML = ({ home: vHome, remote: vRemote, files: vFiles, text: vText }[st.view] || vHome)();
  if (st.view === 'remote') bindRemote();
}
function vUnpaired() {
  return `<div class="page"><div class="brand"><svg><use href="#logo"/></svg>Setu Remote</div><h1>Pair with your laptop</h1><p class="txt">On the laptop, open Setu Remote and click <b>Pair a phone</b>. Then scan the QR code with this phone's camera, or paste the pairing code here.</p>
  ${st.err ? `<div class="note warn">${esc(st.err)}</div>` : ''}<form data-submit="pair"><textarea name="code" rows="4" placeholder="Pairing code (starts with setu1.)" autocapitalize="off" spellcheck="false"></textarea><button class="btn primary">Pair</button></form></div>`;
}
function vHome() {
  const pc = st.pc, on = online(), relay = st.room && st.room.relayOpen;
  return `<div class="page"><header class="bar"><svg class="logo"><use href="#logo"/></svg><b>Setu Remote</b></header>
  <div class="card"><div class="row"><span class="tile peacock">${ic('laptop', 'md')}</span><div class="grow"><div class="name">${esc(pc ? pc.name : 'Your laptop')}</div><div class="sub"><span class="dot ${on ? 'on' : ''}"></span>${on ? (st.info && st.info.locked ? 'Online, locked' : Date.now() - pc.seenLan < 25000 ? 'Online on your Wi-Fi' : 'Online') : relay ? 'Offline. Open Setu Remote on the laptop.' : 'Connecting…'}</div></div></div>
  <button class="btn primary" data-act="remote" ${on ? '' : 'disabled'}>${ic('cast')}Control laptop</button>
  ${on && st.info && st.info.locked ? (st.info.unlock ? `<button class="btn soft" data-act="unlock">${ic('unlock')}Unlock laptop</button>` : `<div class="note">The laptop is locked. To unlock it from here, turn on “Unlock from phone” in the laptop app's Settings.</div>`) : ''}</div>
  <div class="qgrid"><button class="qa" data-act="pick" ${on ? '' : 'disabled'}><span class="tile peacock">${ic('send')}</span>Send files<span>Photos, videos, documents</span></button>
  <button class="qa" data-act="nav" data-view="text" ${on ? '' : 'disabled'}><span class="tile peacock">${ic('clipboard')}</span>Send text or link<span>Copied on the laptop</span></button>
  <button class="qa" data-act="files" ${on ? '' : 'disabled'}><span class="tile peacock">${ic('folder')}</span>Laptop files<span>Browse and download</span></button>
  <button class="qa" data-act="paste" ${on ? '' : 'disabled'}><span class="tile peacock">${ic('copy')}</span>Get laptop clipboard<span>Copy it to this phone</span></button>
  <button class="qa" data-act="camera" ${on ? '' : 'disabled'}><span class="tile peacock">${ic('webcam')}</span>Laptop camera<span>See through its webcam</span></button>
  <button class="qa" data-act="lock" ${on && !(st.info && st.info.locked) ? '' : 'disabled'}><span class="tile peacock">${ic('lock')}</span>Lock laptop<span>${st.info && st.info.locked ? 'Already locked' : 'Lock its screen now'}</span></button></div>
  ${st.busy ? `<div class="card slim"><div class="row"><span class="spin"></span><div class="grow"><div class="name sm">${esc(st.busy)}</div><div class="progress"><i id="prog" style="width:0"></i></div></div></div></div>` : ''}
  <input type="file" id="pick" multiple hidden>
  ${embedded ? '' : `<button class="link" data-act="unpair">Unpair this browser</button>`}</div>`;
}
function vText() {
  return `<div class="page"><header class="bar"><button class="iconbtn" data-act="nav" data-view="home">${ic('arrow-left', 'md')}</button><b>Send text or link</b></header><form data-submit="text"><textarea name="t" rows="6" placeholder="Type or paste here" autofocus></textarea><button class="btn primary">${ic('send')}Send to laptop</button></form><p class="fine">It's copied to the laptop's clipboard, ready to paste.</p></div>`;
}
function vFiles() {
  const d = st.files;
  const rows = !d ? `<div class="empty"><span class="spin"></span></div>` : d.err ? `<div class="note warn">${esc(d.err)}</div>` : (d.entries.length ? d.entries.map(e => `<button class="frow" data-act="${e.d ? 'cd' : 'get'}" data-path="${esc(e.p)}" data-name="${esc(e.n)}" data-size="${e.s || 0}"><span class="tile ${e.d ? 'dir' : ''}">${ic(e.d ? 'folder' : 'file')}</span><span class="grow"><b>${esc(e.n)}</b><em>${e.d ? 'Folder' : fmtSize(e.s)}</em></span>${e.d ? ic('chev') : ic('arrow-left', 'dl')}</button>`).join('') : `<div class="empty"><b>This folder is empty</b></div>`);
  return `<div class="page"><header class="bar"><button class="iconbtn" data-act="${d && d.path ? 'cd' : 'nav'}" data-view="home" data-path="${esc(d && d.parent || '')}">${ic('arrow-left', 'md')}</button><b>${esc(d && d.path ? d.path.split(/[\\/]/).filter(Boolean).pop() : 'Laptop files')}</b></header>${st.busy ? `<div class="card slim"><div class="row"><span class="spin"></span><div class="grow"><div class="name sm">${esc(st.busy)}</div><div class="progress"><i id="prog" style="width:0"></i></div></div></div></div>` : ''}<div class="flist">${rows}</div></div>`;
}
function vRemote() {
  const K = (label, attrs, cls = '') => `<button class="key ${cls}" ${attrs}>${label}</button>`;
  const mod = m => K(m[0].toUpperCase() + m.slice(1), `data-mod="${m}"`, st.mods.has(m) ? 'on' : '');
  const cam = st.kind === 'camera';
  return `<div class="remote ${cam ? 'cam' : ''}"><video id="rv" autoplay playsinline muted></video><div class="pad" id="pad"></div>
  <div class="rtool">${cam ? `<span class="rlabel">${ic('webcam', 'sm')}Laptop camera</span>` : `<div class="seg"><button data-act="mode" data-mode="pad" class="${st.mode === 'pad' ? 'on' : ''}">${ic('touchpad', 'sm')}Touchpad</button><button data-act="mode" data-mode="touch" class="${st.mode === 'touch' ? 'on' : ''}">${ic('touch', 'sm')}Touch</button></div>`}<button class="zbtn" data-act="zoom" id="zbtn" aria-label="Zoom">${ic('search', 'sm')}<b id="zval">1×</b></button><span class="dot on" id="rstate"></span><span class="stats" id="rstats"></span></div>
  <button class="btn sm danger rend" data-act="leave">${ic('stop', 'sm')}End</button>
  ${st.live ? '' : `<div class="wait"><span class="spin light"></span><b>${cam ? 'Opening the laptop camera…' : 'Connecting to your laptop…'}</b></div>`}
  ${cam ? '' : `<div class="keybar">${K(ic('keyboard', 'sm'), 'data-act="kb"', 'kb')}${K('Esc', 'data-key="Escape"')}${K('Tab', 'data-key="Tab"')}${mod('ctrl')}${mod('alt')}${mod('shift')}${mod('win')}${K('←', 'data-key="ArrowLeft"')}${K('↑', 'data-key="ArrowUp"')}${K('↓', 'data-key="ArrowDown"')}${K('→', 'data-key="ArrowRight"')}${K('Enter', 'data-key="Enter"')}${K('Alt+Tab', 'data-key="Tab" data-mods="alt"')}${K('Ctrl+C', 'data-key="KeyC" data-mods="ctrl"')}${K('Ctrl+V', 'data-key="KeyV" data-mods="ctrl"')}${K('Ctrl+Z', 'data-key="KeyZ" data-mods="ctrl"')}${K('Del', 'data-key="Delete"')}${K('F5', 'data-key="F5"')}${K('Right-click', 'data-click="1"')}${K('Lock', 'data-act="lock"')}</div>`}
  <textarea id="kbin" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"></textarea></div>`;
}

// ------------------------------------------------------------ remote control
async function enterRemote(kind) {
  kind = kind === 'camera' ? 'camera' : 'screen';
  let pc; try { pc = needPc(); } catch (e) { return fail(e); }
  st.view = 'remote'; st.kind = kind; st.live = false; st.release = pc.hold(); Z.s = 1; Z.x = Z.y = 0; st.cur = null; render();
  try {
    if (kind === 'screen' && st.info && st.info.locked) {
      if (st.info.unlock) { const w = $('.wait b'); if (w) w.textContent = 'Unlocking your laptop…'; await pc.request('pc.unlock', {}, { timeout: 25000 }); }
      else toast('The laptop is locked. The picture stays blank until it is unlocked.');
    }
    await pc.request(kind === 'camera' ? 'cam.start' : 'screen.start', {}, { timeout: 30000 }); if (st.view !== 'remote') return; st.live = true; const w = $('.wait'); w && w.remove(); attach(); try { screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {}); } catch {} }
  catch (e) { leaveRemote(true); fail(e); }
}
function attach() { const v = $('#rv'); if (v && st.pc && st.pc.remoteTrack) { v.srcObject = new MediaStream([st.pc.remoteTrack]); v.play().catch(() => {}); } }
function leaveRemote(remote) {
  if (st.view !== 'remote') return;
  if (!remote && st.pc) st.pc.request(st.kind === 'camera' ? 'cam.stop' : 'screen.stop', {}).catch(() => {});
  st.release && st.release(); st.release = null; clearInterval(st.statT); st.view = 'home'; st.live = false; st.mods.clear();
  try { screen.orientation.unlock && screen.orientation.unlock(); } catch {}
  render();
  if (auto && autoDone) setTimeout(hostClose, remote ? 2500 : 150); // inside the Android app: go back to the app's own screen
}
const send = d => st.pc && st.kind !== 'camera' && st.pc.sendInput(d);

// ------------------------------------------------------------ zoom
// The picture is scaled and shifted with a CSS transform; taps are mapped through the transformed box, so they stay accurate.
function applyZoom(anim) {
  const v = $('#rv'), pad = $('#pad'); if (!v || !pad) return;
  const W = pad.clientWidth, H = pad.clientHeight;
  Z.s = Math.min(6, Math.max(1, Z.s)); Z.x = Math.min(0, Math.max(W - W * Z.s, Z.x)); Z.y = Math.min(0, Math.max(H - H * Z.s, Z.y));
  v.style.transition = anim ? 'transform .18s ease-out' : 'none';
  v.style.transform = Z.s === 1 ? '' : `translate(${Z.x}px,${Z.y}px) scale(${Z.s})`;
  const b = $('#zval'); if (b) b.textContent = (Math.round(Z.s * 10) / 10) + '×'; const zb = $('#zbtn'); if (zb) zb.classList.toggle('on', Z.s > 1);
}
function zoomAt(scale, cx, cy, anim) { const k = Math.min(6, Math.max(1, scale)) / Z.s; Z.x = cx - (cx - Z.x) * k; Z.y = cy - (cy - Z.y) * k; Z.s *= k; applyZoom(anim); }
// Where a point of the laptop screen (0..1) sits inside the un-zoomed picture box.
function screenPoint(q) { const v = $('#rv'), pad = $('#pad'); if (!v || !pad) return null; const W = pad.clientWidth, H = pad.clientHeight, vw = v.videoWidth || 16, vh = v.videoHeight || 9, sc = Math.min(W / vw, H / vh), w = vw * sc, h = vh * sc; return [(W - w) / 2 + q.x * w, (H - h) / 2 + q.y * h, W, H]; }
// Touchpad mode while zoomed in: keep the laptop's pointer in view.
function followCursor() {
  if (st.view !== 'remote' || st.kind === 'camera' || st.mode !== 'pad' || Z.s <= 1 || !st.cur || st.pinching) return;
  const p = screenPoint(st.cur); if (!p) return; const [px, py, W, H] = p, m = 56;
  const sx = Z.x + px * Z.s, sy = Z.y + py * Z.s; let moved = false;
  if (sx < m) { Z.x += m - sx; moved = true; } else if (sx > W - m) { Z.x -= sx - (W - m); moved = true; }
  if (sy < m) { Z.y += m - sy; moved = true; } else if (sy > H - m) { Z.y -= sy - (H - m); moved = true; }
  if (moved) applyZoom(false);
}
function cycleZoom() {
  const pad = $('#pad'); if (!pad) return; const next = Z.s < 1.5 ? 2 : Z.s < 2.5 ? 3 : 1;
  let cx = pad.clientWidth / 2, cy = pad.clientHeight / 2;
  if (next > 1 && Z.s === 1 && st.cur && st.kind !== 'camera') { const p = screenPoint(st.cur); if (p) { cx = p[0]; cy = p[1]; } }
  if (next === 1) { Z.s = 1; Z.x = Z.y = 0; applyZoom(true); } else zoomAt(next, cx, cy, true);
}
function tapKey(code, mods) { const m = new Set([...(mods || []), ...st.mods]); send({ k: 'tapkey', code, mods: [...m] }); if (st.mods.size) { st.mods.clear(); document.querySelectorAll('.key[data-mod]').forEach(k => k.classList.remove('on')); } }
function bindRemote() {
  const pad = $('#pad'), v = $('#rv'), kb = $('#kbin');
  if (st.live) attach();
  const rel = t => { const r = v.getBoundingClientRect(), vw = v.videoWidth || 16, vh = v.videoHeight || 9, sc = Math.min(r.width / vw, r.height / vh), w = vw * sc, h = vh * sc; return [Math.min(1, Math.max(0, (t.clientX - r.left - (r.width - w) / 2) / w)), Math.min(1, Math.max(0, (t.clientY - r.top - (r.height - h) / 2) / h))]; };
  let g = null; applyZoom(false);
  pad.addEventListener('wheel', e => { e.preventDefault(); const r = pad.getBoundingClientRect(); zoomAt(Z.s * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX - r.left, e.clientY - r.top, false); }, { passive: false });
  pad.addEventListener('touchstart', e => { e.preventDefault(); const t = e.touches[0]; const n = e.touches.length;
    if (n === 1) { g = { x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, t0: Date.now(), moved: false, fingers: 1, drag: false };
      if (st.mode === 'touch') { const [x, y] = rel(t); send({ k: 'abs', x, y }); }
      g.hold = setTimeout(() => { if (g && !g.moved && g.fingers === 1) { g.drag = true; send({ k: 'btn', b: 0, down: true }); navigator.vibrate && navigator.vibrate(15); } }, 420);
    } else if (g) { g.fingers = Math.max(g.fingers, n); clearTimeout(g.hold); g.y2 = (e.touches[0].clientY + e.touches[1].clientY) / 2; g.x2 = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      g.d0 = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); g.z0 = Z.s; g.two = null; g.ax = g.ay = 0; }
  }, { passive: false });
  pad.addEventListener('touchmove', e => { e.preventDefault(); if (!g) return; const t = e.touches[0];
    if (e.touches.length >= 2) {
      const y = (e.touches[0].clientY + e.touches[1].clientY) / 2, x = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY), dy = y - g.y2, dx = x - g.x2;
      // Decide once per gesture: fingers moving apart or together zoom; moving together pan the zoomed picture, then scroll the laptop.
      if (!g.two) { if (Math.abs(d - g.d0) > 22) g.two = 'zoom'; else if (Math.abs(dy) > 12 || Math.abs(dx) > 12) g.two = 'pan'; else return; g.moved = true; st.pinching = g.two === 'zoom'; }
      const r = pad.getBoundingClientRect();
      if (g.two === 'zoom') { zoomAt(g.z0 * d / g.d0, x - r.left, y - r.top, false); Z.x += dx; Z.y += dy; applyZoom(false); }
      else { const bx = Z.x, by = Z.y; Z.x += dx; Z.y += dy; applyZoom(false);
        g.ax += dx - (Z.x - bx); g.ay += dy - (Z.y - by); // what the picture could not absorb scrolls the laptop
        if (Math.abs(g.ay) > 12 || Math.abs(g.ax) > 12) { send({ k: 'wheel', dy: -g.ay / 40, dx: Math.abs(g.ax) > Math.abs(g.ay) * 2 ? g.ax / 40 : 0 }); g.ax = g.ay = 0; } }
      g.y2 = y; g.x2 = x; return; }
    const dx = t.clientX - g.x, dy = t.clientY - g.y; if (Math.hypot(t.clientX - g.sx, t.clientY - g.sy) > 8) { g.moved = true; if (!g.drag) clearTimeout(g.hold); }
    if (st.mode === 'pad') { const sp = 1.7 + Math.min(2, Math.hypot(dx, dy) / 14); send({ k: 'move', dx: dx * sp, dy: dy * sp }); }
    else { const [x, y] = rel(t); if (g.moved && !g.drag) { g.drag = true; send({ k: 'btn', b: 0, down: true }); } send({ k: 'abs', x, y }); }
    g.x = t.clientX; g.y = t.clientY;
  }, { passive: false });
  const end = e => { e.preventDefault(); if (!g || e.touches.length) return; clearTimeout(g.hold); const quick = Date.now() - g.t0 < 350;
    if (g.drag) send({ k: 'btn', b: 0, down: false }); else if (!g.moved && g.fingers >= 2) send({ k: 'click', b: 1 }); else if (!g.moved && quick) send({ k: 'click', b: 0 });
    g = null; st.pinching = false; };
  pad.addEventListener('touchend', end, { passive: false }); pad.addEventListener('touchcancel', end, { passive: false });
  // mouse fallback (desktop browsers, tests)
  pad.addEventListener('mousedown', e => { const [x, y] = rel(e); send({ k: 'abs', x, y }); send({ k: 'btn', b: e.button === 2 ? 1 : 0, down: true }); pad._m = e.button === 2 ? 1 : 0; });
  pad.addEventListener('mousemove', e => { if (pad._m != null) { const [x, y] = rel(e); send({ k: 'abs', x, y }); } });
  window.onmouseup = () => { if (pad._m != null) { send({ k: 'btn', b: pad._m, down: false }); pad._m = null; } };
  pad.addEventListener('contextmenu', e => e.preventDefault());
  // typing: diff the hidden text box so predictive keyboards work
  let prev = ''; kb.value = '';
  kb.addEventListener('input', () => { const cur = kb.value; let i = 0; while (i < prev.length && i < cur.length && prev[i] === cur[i]) i++;
    for (let n = prev.length - i; n > 0; n--) send({ k: 'tapkey', code: 'Backspace', mods: [] });
    const add = cur.slice(i); if (add) { if (st.mods.size && add.length === 1 && /[a-z0-9]/i.test(add)) tapKey(/[0-9]/.test(add) ? 'Digit' + add : 'Key' + add.toUpperCase()); else send({ k: 'text', s: add }); }
    prev = cur; if (cur.length > 300) { kb.value = ''; prev = ''; } });
  kb.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); tapKey('Enter'); } else if (e.key === 'Backspace' && !kb.value) { e.preventDefault(); tapKey('Backspace'); } });
  clearInterval(st.statT);
  st.statT = setInterval(async () => { const el = $('#rstats'), pc = st.pc && st.pc.pc; if (!el || !pc) return; try { const s = await pc.getStats(); let fps = 0, rtt = null; s.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'video') fps = r.framesPerSecond || 0; if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime; }); el.textContent = `${rtt != null ? Math.round(rtt * 1000) + ' ms · ' : ''}${Math.round(fps)} fps`; } catch {} }, 1500);
}

// ------------------------------------------------------------ files and text
async function sendFiles(files) {
  let pc; try { pc = needPc(); } catch (e) { return fail(e); }
  let n = 0;
  for (const f of files) {
    st.busy = `Sending ${f.name}`; render();
    try { const src = (async function* () { const r = f.stream().getReader(); for (;;) { const { done, value } = await r.read(); if (done) break; yield value; } })();
      await pc.push('fs.write', { name: f.name, mtime: f.lastModified }, src, f.size, d => { const b = $('#prog'); if (b) b.style.width = (100 * d / Math.max(1, f.size)).toFixed(1) + '%'; }); n++; }
    catch (e) { fail(e); break; }
  }
  st.busy = ''; render(); if (n) toast(`Sent ${n} file${n === 1 ? '' : 's'} to the laptop's Downloads/Setu folder`);
}
async function listFiles(path) { st.view = 'files'; st.files = null; render(); try { const d = await needPc().request('fs.list', { path, limit: 400 }); st.files = d; } catch (e) { st.files = { err: String(e.message || e), entries: [], path, parent: '' }; } if (st.view === 'files') render(); }
async function download(path, name, size) {
  if (size > 600 * 1048576) return toast('That file is too large to download in the browser', true);
  st.busy = `Downloading ${name}`; render(); const parts = [];
  try { await needPc().pull('fs.read', { path }, { write: c => { parts.push(c.slice()); }, end: () => {} }, d => { const b = $('#prog'); if (b) b.style.width = (100 * d / Math.max(1, size)).toFixed(1) + '%'; });
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(parts)); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); toast('Saved ' + name); }
  catch (e) { fail(e); }
  st.busy = ''; if (st.view === 'files') render();
}

const actions = {
  nav: el => { st.view = el.dataset.view; render(); }, remote: () => enterRemote('screen'), camera: () => enterRemote('camera'), leave: () => leaveRemote(false), zoom: cycleZoom,
  unlock: async () => { try { toast('Unlocking your laptop…'); await needPc().request('pc.unlock', {}, { timeout: 25000 }); toast('Laptop unlocked'); refreshPc(); } catch (e) { fail(e); refreshPc(); } },
  lock: async () => { try { await needPc().request('pc.lock', {}); toast('Laptop locked'); if (st.view === 'remote') leaveRemote(false); setTimeout(refreshPc, 1500); } catch (e) { fail(e); } },
  pick: () => $('#pick').click(), files: () => listFiles(''), cd: el => listFiles(el.dataset.path), get: el => download(el.dataset.path, el.dataset.name, +el.dataset.size),
  paste: async () => { try { const r = await needPc().request('clip.get'); if (!r.text) return toast('The laptop clipboard is empty'); try { await navigator.clipboard.writeText(r.text); toast('Copied to this phone'); } catch { st.view = 'text'; render(); $('textarea').value = r.text; } } catch (e) { fail(e); } },
  mode: el => { st.mode = el.dataset.mode; LS.set('mode', st.mode); document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.mode === st.mode)); },
  kb: () => { const k = $('#kbin'); k.focus(); },
  unpair: () => { if (st.room) st.room.close(); try { localStorage.removeItem('setu.pairing'); } catch {} st.pairing = null; st.pc = null; st.room = null; render(); },
};
document.addEventListener('click', e => {
  const key = e.target.closest('.key'); if (key && !key.dataset.act) { e.preventDefault();
    if (key.dataset.mod) { const m = key.dataset.mod; st.mods.has(m) ? st.mods.delete(m) : st.mods.add(m); key.classList.toggle('on'); }
    else if (key.dataset.click) send({ k: 'click', b: +key.dataset.click });
    else tapKey(key.dataset.key, key.dataset.mods ? key.dataset.mods.split(',') : []);
    return; }
  const el = e.target.closest('[data-act]'); if (!el || el.disabled) return; const f = actions[el.dataset.act]; if (f) { e.preventDefault(); f(el); } });
document.addEventListener('change', e => { if (e.target.id === 'pick' && e.target.files.length) sendFiles([...e.target.files]); });
document.addEventListener('submit', async e => { e.preventDefault(); const f = e.target, k = f.dataset.submit;
  if (k === 'pair') { try { st.pairing = decodePairing(f.code.value); LS.set('pairing', st.pairing); st.err = ''; connect(); } catch (err) { st.err = err.message; } render(); }
  if (k === 'text') { const t = f.t.value; if (!t.trim()) return; try { await needPc().request('text.push', { text: t }); toast('Sent to laptop'); st.view = 'home'; render(); } catch (err) { fail(err); } } });
window.addEventListener('pagehide', () => { st.room && st.room.close(); });
window.__setuWeb = { st, send, Z, zoomAt, applyZoom };
boot();

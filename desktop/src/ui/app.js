import { Room, encodePairing, newSecret, DEFAULT_RELAY } from '../core/core.js';

const N = window.native;
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n, c = '') => `<svg class="ic ${c}"><use href="#i-${n}"/></svg>`;
const fmtSize = b => b == null ? '' : b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(1) + ' GB';
const pad = n => String(n).padStart(2, '0');
const fmtClock = t => { const d = new Date(t); let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${pad(d.getMinutes())} ${ap}`; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtDay = t => { const k = dayKey(t), now = Date.now(); if (k === dayKey(now)) return 'Today'; if (k === dayKey(now - 864e5)) return 'Yesterday'; const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : ''}`; };
const fmtWhen = t => (dayKey(t) === dayKey(Date.now()) ? fmtClock(t) : fmtDay(t));
const isImg = n => /\.(jpe?g|png|webp|gif|heic|bmp)$/i.test(n);
const isVid = n => /\.(mp4|mkv|mov|3gp|webm)$/i.test(n);

let S = null;                       // native state {store, lan, port, ...}
const rooms = new Map();            // secret -> Room
const ui = { view: 'devices', modal: null, files: { path: '', data: null, sel: new Set(), loading: false, err: '' }, msgs: { threads: null, notifs: [], cur: null, list: null, err: '' },
  photos: { items: null, err: '', busy: false }, info: {}, screen: { on: false, state: '' }, pairing: null, update: { state: 'off' }, power: { locked: false }, unlock: { supported: false, installed: false, cred: false } };
let hosting = null;
const jobs = []; let jobRunning = false;
const thumbs = new Map();

// ---------------------------------------------------------------- engine
const settings = () => S.store.settings;
function relayList() {
  const out = [{ url: `ws://127.0.0.1:${S.port}/relay?vsn=1.0.0`, kind: 'lan' }];
  const st = settings();
  if (st.useCloud && st.relayUrl && st.relayKey) out.push({ url: st.relayUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/realtime/v1/websocket?apikey=' + encodeURIComponent(st.relayKey) + '&vsn=1.0.0', kind: 'cloud' });
  return out;
}
const lanAddrs = () => S.lan.map(ip => ip + ':' + S.port);
function save(patch) { Object.assign(S.store, patch); return N.saveStore(patch); }
function addHistory(icon, title, sub) { const h = S.store.history; h.unshift({ ts: Date.now(), icon, title, sub }); if (h.length > 300) h.length = 300; save({ history: h }); if (ui.view === 'history') render(); }
function toast(msg, bad) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : ''); clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, bad ? 6000 : 3500); }
const fail = e => { console.error(e); toast(String(e && e.message || e), true); };

function fileStream(id) { return (async function* () { for (;;) { const c = await N.fsRead(id); if (!c) break; yield c; } })(); }
const handlers = {
  'sys.info': async () => ({ name: S.store.device.name, role: 'pc', os: S.platform, primary: S.primary, locked: !!ui.power.locked, unlock: !!(ui.unlock.installed && ui.unlock.cred && !ui.unlock.blocked) }),
  'fs.list': p => N.fsList(p.path || '', p.offset | 0, Math.min(p.limit || 500, 1000)),
  'fs.read': async p => { const f = await N.fsOpenRead(p.path); const src = fileStream(f.id); return { size: f.size, mtime: f.mtime, name: f.name, __stream: (async function* () { try { yield* src; } finally { N.fsClose(f.id); } })() }; },
  'fs.write': async (p, peer) => {
    const f = await N.fsOpenWrite(p.dir || settings().downloadDir, p.name || 'file');
    return { path: f.path, __sink: { write: c => N.fsWrite(f.id, c), end: async ok => {
      const final = await N.fsClose(f.id, ok, p.mtime);
      if (ok && final) { addHistory('file', `Received ${p.name}`, `${fmtSize(p.size)} from ${peer.name}`); S.store.lastRecv = final; N.notify('File from ' + peer.name, p.name); toast(`Received ${p.name}`); }
      return { path: final };
    } } };
  },
  'clip.set': async p => { await N.clipSet(p.text); return {}; },
  'clip.get': async () => ({ text: await N.clipGet() }),
  'text.push': async (p, peer) => { await N.clipSet(p.text); addHistory('clipboard', `Text from ${peer.name}`, String(p.text).slice(0, 120)); N.notify('Text from ' + peer.name + ' (copied)', p.text); toast('Text copied to clipboard'); return {}; },
  'screen.start': async (_p, peer) => startHosting(peer, 'screen'),
  'screen.stop': async () => { stopHosting(); return {}; },
  'cam.start': async (_p, peer) => startHosting(peer, 'camera'),
  'cam.stop': async () => { stopHosting(); return {}; },
  'pc.unlock': async (_p, peer) => { const r = await N.unlockNow(); if (!r.already) addHistory('lock', `Unlocked by ${peer.name}`, ''); return r; },
  'pc.lock': async (_p, peer) => { stopHosting(); await N.pcLock(); addHistory('lock', `Locked by ${peer.name}`, ''); return {}; },
};
async function getIce() { return (await N.turnIce()) || undefined; }

function openRoom(pairing) {
  if (rooms.has(pairing.secret)) return rooms.get(pairing.secret);
  const room = new Room({ self: { id: S.store.device.id, name: S.store.device.name, role: 'pc', caps: { host: true, files: true } }, secret: pairing.secret,
    relays: relayList(), offerer: true, handlers, getIce, selfExtra: () => ({ lan: lanAddrs() }),
    onInput: (ev, peer) => { if (hosting && hosting.peer === peer) N.inject(ev); } });
  room.pairing = pairing;
  room.on('peers', () => onPeers(room));
  room.on('relay', () => renderSide());
  room.on('evt', (peer, m, p) => onEvt(peer, m, p));
  room.on('link', (peer, st) => { if (st === 'down' && ui.screen.peer === peer) closeViewer(true); renderSide(); });
  rooms.set(pairing.secret, room);
  return room;
}
function onPeers(room) {
  const pairing = room.pairing; let dirty = false;
  for (const p of room.peers.values()) {
    if (!p.role) continue;
    pairing.peers ||= {};
    const rec = pairing.peers[p.id];
    if (!rec || rec.name !== p.name || rec.role !== p.role) { pairing.peers[p.id] = { name: p.name, role: p.role }; dirty = true; if (!rec) newPeer(room, p); }
    if (p.online && p.role === 'phone' && !ui.info[p.id]) refreshInfo(p);
  }
  if (dirty) { if (!S.store.pairings.includes(pairing)) S.store.pairings.push(pairing); save({ pairings: S.store.pairings }); }
  render();
}
function newPeer(room, p) {
  if (ui.pairing && ui.pairing.secret === room.pairing.secret) { ui.pairing.done = p.name; ui.modal = null; toast(`Paired with ${p.name}`); addHistory('devices', `Paired with ${p.name}`, p.role === 'web' ? 'Phone browser' : 'Phone app'); }
}
function allPeers() { const out = []; for (const r of rooms.values()) for (const p of r.peers.values()) if (p.role) out.push(p); return out; }
function knownDevices() {
  const out = [];
  for (const pr of S.store.pairings) for (const [id, rec] of Object.entries(pr.peers || {})) { const room = rooms.get(pr.secret); const live = room && room.peers.get(id); out.push({ id, ...rec, pairing: pr, peer: live, online: !!(live && live.online) }); }
  return out;
}
function phone() { const ps = allPeers().filter(p => p.role === 'phone'); return ps.find(p => p.online) || ps[0] || null; }
const needPhone = () => { const p = phone(); if (!p) throw new Error('Pair the Setu Remote app on your phone first'); if (!p.online) throw new Error(p.name + ' is offline'); return p; };
async function refreshInfo(p) { try { ui.info[p.id] = await p.request('sys.info', {}, { timeout: 8000 }); if (ui.view !== 'messages') p.request('notif.list', {}).then(r => { ui.msgs.notifs = r.items || []; if (ui.view === 'devices') render(); else renderSide(); }).catch(() => {}); render(); } catch {} }
function announceChange() { for (const p of allPeers()) if (p.online) try { p.notify('sys.changed'); } catch {} }
function onEvt(peer, m, p) {
  if (m === 'notif.posted') { ui.msgs.notifs = [p, ...ui.msgs.notifs.filter(n => n.key !== p.key)].slice(0, 60); N.notify(`${p.title || p.app}${p.app ? ' · ' + p.app : ''}`, p.text); if (ui.view === 'messages') render(); renderSide(); }
  else if (m === 'notif.removed') { ui.msgs.notifs = ui.msgs.notifs.filter(n => n.key !== p.key); if (ui.view === 'messages') render(); renderSide(); }
  else if (m === 'sms.received') { N.notify('Text from ' + (p.name || p.addr), p.body); if (ui.view === 'messages') loadMessages(); if (ui.info[peer.id]) { ui.info[peer.id].smsUnread = (ui.info[peer.id].smsUnread || 0) + 1; renderSide(); } }
  else if (m === 'screen.ended' && ui.screen.peer === peer) closeViewer(true);
  else if (m === 'sys.changed') refreshInfo(peer);
}

// ---------------------------------------------------------------- PC being controlled
async function startHosting(peer, kind = 'screen') {
  if (hosting && (hosting.peer !== peer || hosting.kind !== kind)) stopHosting(hosting.peer === peer); // same phone switching between screen and camera: swap quietly
  if (!hosting) {
    let stream;
    if (kind === 'camera') {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 } } }); }
      catch (e) { throw new Error(e.name === 'NotFoundError' ? 'No camera was found on the laptop' : e.name === 'NotAllowedError' ? 'Windows is blocking the camera. Allow desktop apps to use it in Windows Settings, Privacy, Camera.' : e.name === 'NotReadableError' ? 'The laptop camera is in use by another app' : 'The laptop could not open its camera (' + e.name + ')'); }
    } else {
      const srcId = await N.screenSource();
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: srcId, maxFrameRate: 30 } } });
    }
    const track = stream.getVideoTracks()[0]; if (kind === 'screen') track.contentHint = 'detail';
    const h = hosting = { peer, kind, track, t0: Date.now(), off: peer.on('video-ended', () => stopHosting()) };
    await peer.setVideo(track);
    N.overlay(true, peer.name, kind);
    // Tell the phone where the pointer is, so its zoomed view can follow it.
    if (kind === 'screen') h.cur = setInterval(async () => { try { const c = await N.cursorRel(), k = c.x.toFixed(3) + ',' + c.y.toFixed(3); if (k !== h.ck) { h.ck = k; peer.notify('cursor', { x: +c.x.toFixed(4), y: +c.y.toFixed(4) }); } } catch {} }, 110);
    renderSide();
  }
  const st = hosting.track.getSettings();
  return { w: st.width, h: st.height, kind };
}
function stopHosting(swap) {
  if (!hosting) return;
  const h = hosting; hosting = null; h.off(); clearInterval(h.cur); h.track.stop(); h.peer.setVideo(null).catch(() => {}); if (!swap) h.peer.notify('screen.ended'); N.overlay(false);
  addHistory('phone', h.kind === 'camera' ? `${h.peer.name} viewed this PC's camera` : `${h.peer.name} controlled this PC`, `for ${Math.max(1, Math.round((Date.now() - h.t0) / 60000))} min`);
  renderSide();
}

// ---------------------------------------------------------------- transfers
function enqueue(label, run) { const job = { label, done: 0, total: 0, state: 'wait', run }; jobs.push(job); pumpJobs(); renderXfer(); return job; }
async function pumpJobs() {
  if (jobRunning) return; jobRunning = true;
  for (;;) {
    const job = jobs.find(j => j.state === 'wait'); if (!job) break;
    job.state = 'run'; renderXfer();
    try { job.result = await job.run((d, t) => { job.done = d; if (t) job.total = t; renderXfer(true); }); job.state = 'ok'; }
    catch (e) { job.state = 'err'; job.err = String(e.message || e); toast(`${job.label}: ${job.err}`, true); }
    renderXfer();
  }
  jobRunning = false;
  setTimeout(() => { if (!jobRunning) { jobs.length = 0; renderXfer(); } }, 4000);
}
function renderXfer(light) {
  const el = $('#xfer'); const cur = jobs.find(j => j.state === 'run'); const left = jobs.filter(j => j.state === 'wait').length;
  const last = !cur && jobs.length ? jobs[jobs.length - 1] : null;
  if (!cur && !last) { el.innerHTML = ''; el.className = ''; return; }
  if (light && el.dataset.job === (cur && cur.label)) { const bar = $('.progress i', el), sub = $('.xsub', el); if (bar && cur.total) bar.style.width = (100 * cur.done / cur.total).toFixed(1) + '%'; if (sub) sub.textContent = `${fmtSize(cur.done)} of ${fmtSize(cur.total)}${left ? ` · ${left} more waiting` : ''}`; return; }
  el.className = 'show'; el.dataset.job = cur ? cur.label : '';
  if (cur) el.innerHTML = `${ic('send')}<div class="xmain"><b>${esc(cur.label)}</b><div class="progress"><i style="width:${cur.total ? (100 * cur.done / cur.total).toFixed(1) : 0}%"></i></div></div><span class="xsub tnum">${fmtSize(cur.done)} of ${fmtSize(cur.total)}${left ? ` · ${left} more waiting` : ''}</span>`;
  else { const ok = jobs.filter(j => j.state === 'ok').length, bad = jobs.filter(j => j.state === 'err').length; el.innerHTML = `${ic(bad ? 'alert' : 'check')}<div class="xmain"><b>${ok} transfer${ok === 1 ? '' : 's'} finished${bad ? `, ${bad} failed` : ''}</b></div>${S.store.lastRecv || last.result ? `<button class="btn sm outline" data-act="reveal-last">Show in folder</button>` : ''}`; ui.lastPath = (jobs.filter(j => j.state === 'ok').pop() || {}).result; }
}
async function pullFile(peer, remotePath, name, dir, mtime, onProg, size) {
  const f = await N.fsOpenWrite(dir, name); let final = null;
  await peer.pull('fs.read', { path: remotePath }, { write: c => N.fsWrite(f.id, c), end: async ok => { final = await N.fsClose(f.id, ok, mtime); } }, d => onProg(d, size));
  return final;
}
async function pushFile(peer, localPath, remoteDir, onProg) {
  const f = await N.fsOpenRead(localPath);
  try { const r = await peer.push('fs.write', { name: f.name, dir: remoteDir || '', mtime: f.mtime }, fileStream(f.id), f.size, d => onProg(d, f.size)); return r.path; }
  finally { N.fsClose(f.id); }
}
function sendPaths(paths, remoteDir) {
  let peer; try { peer = needPhone(); } catch (e) { return fail(e); }
  paths.forEach((p, i) => { const name = p.split(/[\\/]/).pop(); enqueue(`Sending ${name} to ${peer.name}`, async prog => {
    const r = await pushFile(peer, p, remoteDir, prog); addHistory('send', `Sent ${name}`, `to ${peer.name}`);
    if (i === paths.length - 1 && remoteDir && ui.view === 'files' && ui.files.path === remoteDir) loadFiles(remoteDir);
    return r; }); });
}

// ---------------------------------------------------------------- views
function sideHtml() {
  const unread = Object.values(ui.info).reduce((a, i) => a + (i.smsUnread || 0), 0) + ui.msgs.notifs.length;
  const nav = [['devices', 'devices', 'Devices'], ['files', 'folder', 'Phone files'], ['messages', 'mail', 'Messages', unread], ['photos', 'camera', 'Photos'], ['history', 'history', 'History'], ['settings', 'gear', 'Settings']];
  const anyRoom = [...rooms.values()][0]; const cloud = anyRoom && anyRoom.relays.find(r => r.kind === 'cloud');
  const status = hosting ? `<span class="dot live"></span>Being controlled` : !settings().useCloud ? `<span class="dot on"></span>Same Wi-Fi only` : cloud && cloud.state === 'open' ? `<span class="dot on"></span>Online` : rooms.size ? `<span class="dot"></span>Wi-Fi only (no internet relay)` : `<span class="dot on"></span>Ready`;
  return `<div class="brand"><svg aria-hidden="true"><use href="#logo"/></svg>Setu Remote</div>` +
    nav.map(n => `<a data-act="nav" data-view="${n[0]}" class="${ui.view === n[0] || (ui.view === 'screen' && n[0] === 'devices') ? 'on' : ''}">${ic(n[1])}${n[2]}${n[3] ? `<span class="count">${n[3]}</span>` : ''}</a>`).join('') +
    `<div class="acct"><span class="av">${ic('laptop')}</span><div><b>${esc(S.store.device.name)}</b><span id="netstat">${status}</span></div></div>`;
}
function renderSide() { $('#side').innerHTML = sideHtml(); }
function render(force) {
  renderSide();
  const m = $('#main');
  const keep = !force && ui.view === 'screen' && $('#stage');
  if (!keep) m.innerHTML = ({ devices: vDevices, files: vFiles, messages: vMessages, photos: vPhotos, history: vHistory, settings: vSettings, screen: vScreen }[ui.view] || vDevices)();
  m.className = 'main v-' + ui.view;
  $('#modal').innerHTML = ui.modal ? ui.modal() : '';
  if (ui.view === 'files' || ui.view === 'photos') lazyThumbs();
  if (ui.view === 'screen' && !keep) bindStage();
}
const offlineNote = p => `<div class="empty">${ic('phone', 'lg')}<b>${p ? esc(p.name) + ' is offline' : 'No phone app paired yet'}</b><p>${p ? 'Open Setu Remote on the phone and check it has internet or is on this Wi-Fi.' : 'Install the Setu Remote app on your phone, then pair it from the Devices page.'}</p><button class="btn sm primary" data-act="nav" data-view="devices">Go to Devices</button></div>`;

function vDevices() {
  const p = phone(), devs = knownDevices(), info = p && ui.info[p.id];
  const others = devs.filter(d => !p || d.id !== p.id);
  let top;
  if (p) {
    const g = (l, v, s) => `<div><span>${l}</span><b>${v}</b><em>${s}</em></div>`;
    top = `<div class="topgrid"><div class="panel">
      <div class="row"><span class="tile peacock">${ic('phone', 'md')}</span><div class="grow"><div class="name">${esc(p.name)}</div><div class="sub">${info ? esc([info.model, info.android && 'Android ' + info.android].filter(Boolean).join(', ')) : 'Phone app'}</div></div>
      <span class="badge ${p.online ? 'ok' : 'neutral'}"><span class="dot ${p.online ? 'on' : ''}"></span>${p.online ? (info && info.locked ? 'Online, locked' : Date.now() - p.seenLan < 25000 ? 'Online, same Wi-Fi' : 'Online') : 'Offline'}</span></div>
      ${info ? `<div class="glance">${g('Battery', info.battery != null ? info.battery + '%' : '–', info.charging ? 'Charging' : 'On battery')}${g('Storage', info.storageTotal ? fmtSize(info.storageTotal - info.storageFree) : '–', info.storageTotal ? 'of ' + fmtSize(info.storageTotal) + ' used' : '')}${g('Texts', info.smsUnread ?? '–', 'unread')}${g('Chats', ui.msgs.notifs.length, 'new notifications')}</div>` : ''}
      <div class="row acts"><button class="btn sm primary" data-act="screen" ${p.online ? '' : 'disabled'}>${ic('cast', 'sm')}Show screen</button><button class="btn sm soft" data-act="phone-cam" ${p.online ? '' : 'disabled'}>${ic('webcam', 'sm')}Camera</button>${info && info.locked ? `<button class="btn sm soft" data-act="phone-unlock" ${p.online && info.unlock ? '' : 'disabled'} title="${info.unlock ? '' : 'Save the phone’s PIN or pattern in the phone app first (Unlock from laptop)'}">${ic('unlock', 'sm')}Unlock</button>` : ''}<button class="btn sm soft" data-act="nav" data-view="files">${ic('folder', 'sm')}Files</button><button class="btn sm soft" data-act="nav" data-view="messages">${ic('mail', 'sm')}Messages</button><button class="btn sm soft" data-act="nav" data-view="photos">${ic('camera', 'sm')}Photos</button></div>
    </div><div class="panel dropzone" id="drop"><span class="tile peacock big">${ic('send', 'lg')}</span><b>Drop files here</b><span class="txt">They go straight to the phone's Download/Setu folder.</span><div class="row center"><button class="btn sm outline" data-act="send-files">Choose files</button><button class="btn sm outline" data-act="send-text">Send text</button></div></div></div>`;
  } else {
    top = `<div class="panel hero"><span class="tile peacock big">${ic('qr', 'lg')}</span><div class="grow"><b>Pair your phone to get started</b><p class="txt">Scan one QR code with your phone. It works with the Setu Remote app, or straight from the phone's browser with nothing to install.</p></div><button class="btn primary auto" data-act="pair">${ic('qr')}Pair a phone</button></div>`;
  }
  return `<div class="mainhead"><h2 class="h2">Devices</h2>${p ? `<button class="btn sm outline" data-act="pair">${ic('qr', 'sm')}Pair a phone</button>` : ''}</div>${top}
    <div class="secthead"><b>This PC</b></div>
    <div class="panel row tight"><span class="tile">${ic('laptop', 'md')}</span><div class="grow"><div class="name sm">${esc(S.store.device.name)}</div><div class="sub">Device ID <b class="tnum idv">${S.store.device.id.replace(/(\d{3})(?=\d)/g, '$1 ')}</b></div></div><div class="right"><div class="name sm">Your paired phones can control this PC</div><div class="sub">A banner with a Stop button shows while they do</div></div></div>
    ${others.length ? `<div class="secthead"><b>${p ? 'Other paired devices' : 'Paired devices'}</b><span>${others.length}</span></div><div class="dtable">${others.map(d => `<div class="r"><div class="row"><span class="tile">${ic(d.role === 'web' ? 'globe' : 'phone', 'md')}</span><div><div class="name sm">${esc(d.name)}</div><div class="sub">${d.role === 'web' ? 'Phone browser, controls this PC' : 'Phone app'}</div></div></div><span class="sub big"><span class="dot ${d.online ? 'on' : ''}"></span>${d.online ? 'Online' : 'Offline'}</span><div class="acts"><button class="btn sm outline" data-act="unpair" data-secret="${esc(d.pairing.secret)}">Remove</button></div></div>`).join('')}</div>` : ''}`;
}

function vFiles() {
  const p = phone(), f = ui.files; if (!p || !p.online) return `<div class="mainhead"><h2 class="h2">Phone files</h2></div>${offlineNote(p)}`;
  if (!f.data && !f.loading && !f.err) { loadFiles(f.path); }
  const d = f.data, info = ui.info[p.id];
  const crumbs = d && d.path ? d.crumbs.map((c, i) => `${i ? ic('chev', 'sm') : ''}<span data-act="cd" data-path="${esc(c.p)}" class="${i === d.crumbs.length - 1 ? 'here' : ''}">${esc(c.n)}</span>`).join('') : '<span class="here">Phone</span>';
  const places = (d && d.places || []).map(pl => `<span data-act="cd" data-path="${esc(pl.p)}" class="${d.path === pl.p ? 'on' : ''}">${ic(pl.i || 'folder', 'sm')}${esc(pl.n)}</span>`).join('');
  let body;
  if (f.err) body = `<div class="empty">${ic('alert', 'lg')}<b>Could not open this folder</b><p>${esc(f.err)}</p><button class="btn sm outline" data-act="cd" data-path="">Back to start</button></div>`;
  else if (!d) body = `<div class="empty"><span class="spin"></span><p>Connecting to ${esc(p.name)}…</p></div>`;
  else if (!d.entries.length) body = `<div class="empty">${ic('folder', 'lg')}<b>This folder is empty</b><p>Drop files here to copy them to the phone.</p></div>`;
  else body = `<div class="fgrid">${d.entries.map(e => `<div class="ft ${f.sel.has(e.p) ? 'sel' : ''}" data-act="${e.d ? 'cd' : 'sel'}" data-path="${esc(e.p)}" title="${esc(e.n)}">${e.d ? `<i class="img dir">${ic('folder', 'lg')}</i>` : isImg(e.n) || isVid(e.n) ? `<i class="img" data-thumb="${esc(e.p)}">${ic(isVid(e.n) ? 'cast' : 'camera', 'md')}</i>` : `<i class="img doc">${ic('file', 'lg')}</i>`}${f.sel.has(e.p) ? `<span class="ck">${ic('check', 'sm')}</span>` : ''}<b>${esc(e.n)}</b><em>${e.d ? 'Folder' : fmtSize(e.s)}</em></div>`).join('')}</div>${d.total > d.entries.length ? `<p class="fine pad">Showing the first ${d.entries.length} of ${d.total} items.</p>` : ''}`;
  return `<div class="mainhead tightb"><h2 class="h2">${esc(p.name)}</h2>${info && info.storageTotal ? `<span class="sub big"><span class="dot on"></span>${fmtSize(info.storageTotal - info.storageFree)} of ${fmtSize(info.storageTotal)} used</span>` : ''}</div>
    <div class="ftool"><div class="crumbs">${crumbs}</div><span class="grow"></span><button class="btn sm outline" data-act="upload" ${d && d.path ? '' : 'disabled'}>${ic('plus', 'sm')}Upload to phone</button><button class="btn sm primary" data-act="download" ${f.sel.size ? '' : 'disabled'}>${ic('laptop', 'sm')}Copy ${f.sel.size || ''} to this PC</button></div>
    <div class="fbody"><div class="places">${places}</div><div class="fscroll" id="drop">${body}</div></div>`;
}
async function loadFiles(path) {
  const f = ui.files; f.loading = true; f.err = ''; f.sel = new Set(); f.path = path;
  try {
    const p = needPhone(); const d = await p.request('fs.list', { path, limit: 600 });
    if (f.path !== path) return;
    const parts = []; let cur = d.path; const rootsList = d.roots || [];
    if (d.path) { const root = rootsList.find(r => d.path === r.p || d.path.startsWith(r.p + '/')); const base = root ? root.p : ''; const rel = d.path.slice(base.length).split('/').filter(Boolean); parts.push({ n: root ? root.n : 'Phone', p: base }); let acc = base; for (const seg of rel) { acc += '/' + seg; parts.push({ n: seg, p: acc }); } }
    d.crumbs = parts; d.places = d.places || rootsList; f.data = d; void cur;
  } catch (e) { f.err = String(e.message || e); f.data = null; }
  f.loading = false; if (ui.view === 'files') render();
}
let thumbQ = [], thumbBusy = 0, thumbIO = null;
function lazyThumbs() {
  if (thumbIO) thumbIO.disconnect();
  thumbIO = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { thumbIO.unobserve(e.target); queueThumb(e.target); } }, { root: null, rootMargin: '200px' });
  document.querySelectorAll('[data-thumb]').forEach(el => { const c = thumbs.get(el.dataset.thumb); if (c) setThumb(el, c); else thumbIO.observe(el); });
}
const setThumb = (el, url) => { el.style.backgroundImage = `url(${url})`; el.classList.add('has'); };
function queueThumb(el) { thumbQ.push(el); pumpThumbs(); }
async function pumpThumbs() {
  while (thumbBusy < 3 && thumbQ.length) {
    const el = thumbQ.shift(); if (!el.isConnected) continue; const path = el.dataset.thumb; thumbBusy++;
    (async () => { try { const p = needPhone(); const r = await p.request('fs.thumb', { path, max: 220 }, { timeout: 20000 }); if (r && r.b64) { const url = 'data:image/jpeg;base64,' + r.b64; thumbs.set(path, url); if (el.isConnected) setThumb(el, url); } } catch {} thumbBusy--; pumpThumbs(); })();
  }
}

function vMessages() {
  const p = phone(), m = ui.msgs; if (!p || !p.online) return `<div class="mainhead padded"><h2 class="h2">Messages</h2></div>${offlineNote(p)}`;
  if (!m.threads && !m.err && !m.loading) loadMessages();
  const item = (cls, av, t, when, s, extra = '', attrs = '') => `<div class="citem ${cls}" ${attrs}><span class="av">${esc(av)}</span><div class="info"><div class="t"><b>${esc(t)}</b><em>${esc(when)}</em></div><div class="s">${esc(s)}</div>${extra}</div></div>`;
  const notifs = m.notifs.map(n => item('chat', (n.title || n.app || '?')[0].toUpperCase(), n.title || n.app, `${n.app || ''}${n.ts ? ', ' + fmtWhen(n.ts) : ''}`, n.text, n.reply ? `<form class="qreply" data-act-submit="notif-reply" data-key="${esc(n.key)}"><input placeholder="Reply…" name="t" autocomplete="off"><button class="btn sm primary tiny">Send</button></form>` : '')).join('');
  const threads = (m.threads || []).map(t => item((m.cur === t.addr ? 'on' : '') + (t.unread ? ' unread' : ''), (t.name || t.addr || '?')[0].toUpperCase(), t.name || t.addr, fmtWhen(t.ts), t.last, t.unread ? '<span class="unreaddot"></span>' : '', `data-act="thread" data-addr="${esc(t.addr)}"`)).join('');
  const cur = (m.threads || []).find(t => t.addr === m.cur);
  const thread = !cur ? `<div class="empty">${ic('mail', 'lg')}<b>${m.err ? 'Could not load messages' : 'Choose a conversation'}</b><p>${esc(m.err || 'Texts are sent through your phone and its SIM.')}</p></div>` :
    `<div class="thead"><span class="av">${esc((cur.name || cur.addr)[0].toUpperCase())}</span><div class="grow"><b>${esc(cur.name || cur.addr)}</b><span>${esc(cur.name ? cur.addr : '')}</span></div><span class="vchip">${ic('phone', 'sm')}Sends from ${esc(p.name)}</span></div>
     <div class="tmsgs" id="tmsgs">${(m.list || []).map((x, i, a) => `${!i || dayKey(a[i - 1].ts) !== dayKey(x.ts) ? `<div class="day">${fmtDay(x.ts)}</div>` : ''}<div class="msg ${x.out ? 'me' : ''}">${esc(x.body)}<small>${fmtClock(x.ts)}</small></div>`).join('') || '<div class="day">Loading…</div>'}</div>
     <form class="tcompose" data-act-submit="sms-send"><input name="t" placeholder="Text message" autocomplete="off"><button class="btn primary auto">${ic('send')}Send SMS</button></form>`;
  return `<div class="mlayout"><div class="clist">${notifs ? `<div class="clabel">Chat notifications</div>${notifs}` : ''}<div class="clabel">Texts</div>${threads || `<p class="fine pad">${m.loading ? 'Loading…' : 'No texts found.'}</p>`}</div><div class="thread">${thread}</div></div>`;
}
async function loadMessages() {
  const m = ui.msgs; m.loading = true; m.err = '';
  try { const p = needPhone(); const [t, n] = await Promise.all([p.request('sms.threads', { limit: 40 }), p.request('notif.list', {}).catch(() => ({ items: [] }))]); m.threads = t.items || []; m.notifs = n.items || []; if (m.cur) loadThread(m.cur, true); }
  catch (e) { m.err = String(e.message || e); m.threads = m.threads || []; }
  m.loading = false; if (ui.view === 'messages') render();
}
async function loadThread(addr, quiet) {
  const m = ui.msgs; m.cur = addr; if (!quiet) { m.list = null; render(); }
  try { const r = await needPhone().request('sms.list', { addr, tid: ((m.threads || []).find(x => x.addr === addr) || {}).tid, limit: 60 }); if (m.cur !== addr) return; m.list = (r.items || []).sort((a, b) => a.ts - b.ts); const t = (m.threads || []).find(x => x.addr === addr); if (t) t.unread = 0; }
  catch (e) { fail(e); m.list = []; }
  if (ui.view === 'messages') { render(); const el = $('#tmsgs'); if (el) el.scrollTop = el.scrollHeight; }
}

function vPhotos() {
  const p = phone(), ph = ui.photos; if (!p || !p.online) return `<div class="mainhead"><h2 class="h2">Photos</h2></div>${offlineNote(p)}`;
  if (!ph.items && !ph.err && !ph.loading) loadPhotos();
  const last = (S.store.imported[p.id] || 0), items = ph.items || [], fresh = items.filter(x => x.m > last);
  const groups = new Map(); for (const x of items) { const k = dayKey(x.m); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  const size = fresh.reduce((a, x) => a + (x.s || 0), 0);
  const body = ph.err ? `<div class="empty">${ic('alert', 'lg')}<b>Could not read the phone's photos</b><p>${esc(ph.err)}</p></div>` : !ph.items ? `<div class="empty"><span class="spin"></span><p>Reading photos on ${esc(p.name)}…</p></div>` : !items.length ? `<div class="empty">${ic('camera', 'lg')}<b>No photos found on the phone</b></div>` :
    [...groups].map(([k, arr]) => { const n = arr.filter(x => x.m > last).length; return `<div class="pday"><b>${fmtDay(arr[0].m)}</b><span>${n ? n + ' new' : 'Already imported'}</span></div><div class="pgrid ${n ? '' : 'done'}">${arr.map(x => `<i class="${x.m > last ? 'new' : ''}" data-thumb="${esc(x.p)}" title="${esc(x.n)}"></i>`).join('')}</div>`; }).join('');
  return `<div class="mainhead top"><div class="grow"><h2 class="h2">Import photos</h2><p class="txt">${ph.items ? (fresh.length ? `${fresh.length} new photo${fresh.length === 1 ? '' : 's'} and videos since your last import, ${fmtSize(size)}.` : 'Everything on the phone is already imported.') : ''}</p></div><button class="btn primary auto" data-act="import" ${fresh.length && !ph.busy ? '' : 'disabled'}>${ic('laptop')}Import ${fresh.length || ''} new</button></div>
    <div class="iopts"><span>Save to</span><button class="select" data-act="pick-import">${ic('folder', 'sm')}${esc(settings().importDir)}${ic('chev-down', 'sm')}</button><span class="fine">Photos already in that folder are skipped.</span></div><div class="pscroll">${body}</div>`;
}
async function loadPhotos() { const ph = ui.photos; ph.loading = true; ph.err = ''; try { const r = await needPhone().request('media.recent', { limit: 400 }, { timeout: 30000 }); ph.items = (r.items || []).sort((a, b) => b.m - a.m); } catch (e) { ph.err = String(e.message || e); } ph.loading = false; if (ui.view === 'photos') render(); }
function importPhotos() {
  const p = needPhone(), ph = ui.photos, last = S.store.imported[p.id] || 0, fresh = (ph.items || []).filter(x => x.m > last).sort((a, b) => a.m - b.m);
  if (!fresh.length) return; ph.busy = true; render();
  let skipped = 0, done = 0, bytes = 0; const total = fresh.reduce((a, x) => a + (x.s || 0), 0);
  enqueue(`Importing ${fresh.length} photos from ${p.name}`, async prog => { try {
    for (const x of fresh) {
      const d = new Date(x.m), dir = `${settings().importDir}${S.platform === 'win32' ? '\\' : '/'}${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
      if (await N.fsExists(dir, x.n, x.s)) skipped++;
      else { const base = bytes; await pullFile(p, x.p, x.n, dir, x.m, dd => prog(base + dd, total), x.s); done++; }
      bytes += x.s || 0; prog(bytes, total);
      S.store.imported[p.id] = x.m;
    }
    await save({ imported: S.store.imported });
    addHistory('camera', `Imported ${done} photo${done === 1 ? '' : 's'} from ${p.name}`, `${fmtSize(total)}${skipped ? `, skipped ${skipped} already here` : ''}`);
    return settings().importDir;
  } finally { ph.busy = false; save({ imported: S.store.imported }); if (ui.view === 'photos') render(); } });
}

function vHistory() {
  const h = S.store.history; const groups = new Map(); for (const x of h) { const k = dayKey(x.ts); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  return `<div class="mainhead"><h2 class="h2">History</h2></div>${h.length ? [...groups].map(([, arr]) => `<div class="sgroup">${fmtDay(arr[0].ts)}</div><div class="slist">${arr.map(x => `<div class="sitem"><span class="tile">${ic(x.icon || 'history')}</span><div class="info"><div class="t">${esc(x.title)}</div><div class="d">${fmtClock(x.ts)}${x.sub ? ', ' + esc(x.sub) : ''}</div></div></div>`).join('')}</div>`).join('') : `<div class="empty">${ic('history', 'lg')}<b>Nothing here yet</b><p>Sessions, transfers and imports will be listed here. History stays on this PC.</p></div>`}`;
}

function updateLine() {
  const u = ui.update;
  return ({ off: 'Personal build for your own devices.', checking: 'Checking for updates…', current: 'Up to date. New versions install by themselves.',
    downloading: `Downloading version ${esc(u.version)}… ${u.percent || 0}%`, ready: `Version ${esc(u.version)} is ready. It installs when nothing is running, or now if you restart.`,
    installing: 'Installing the update…', error: `Could not check for updates: ${esc(u.error)}` })[u.state] || '';
}
function vSettings() {
  const st = settings(); const sw = (k, on) => `<button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${!!on}" data-act="toggle" data-key="${k}"></button>`;
  const item = (t, d, ctl) => `<div class="sitem"><div class="info"><div class="t">${t}</div>${d ? `<div class="d">${d}</div>` : ''}</div>${ctl}</div>`;
  const field = (k, ph, type = 'text') => `<input class="field" data-setting="${k}" type="${type}" value="${esc(st[k])}" placeholder="${ph}" spellcheck="false">`;
  return `<div class="mainhead"><h2 class="h2">Settings</h2></div><div class="sset">
    <div class="sgroup">Files and messages</div><div class="slist">
      ${item('Save files from the phone to', '', `<button class="select" data-act="pick-download">${ic('folder', 'sm')}${esc(st.downloadDir)}${ic('chev-down', 'sm')}</button>`)}
      ${item('Import photos to', '', `<button class="select" data-act="pick-import">${ic('folder', 'sm')}${esc(st.importDir)}${ic('chev-down', 'sm')}</button>`)}
      ${item('Show phone notifications on this PC', 'Texts, chat apps and received files.', sw('showNotifications', st.showNotifications))}</div>
    <div class="sgroup">Connections</div><div class="slist">
      ${item('This PC is called', '', `<input class="field" data-device-name value="${esc(S.store.device.name)}" spellcheck="false">`)}
      ${S.platform === 'win32' ? item('Start Setu Remote when Windows starts', 'It waits quietly in the system tray.', sw('startWithWindows', st.startWithWindows)) : ''}
      ${item('Connect over the internet', 'When off, your devices find each other only on the same Wi-Fi.', sw('useCloud', st.useCloud))}
      ${item('Show a banner while this PC is being controlled', 'Always on, so a live session can\'t go unnoticed.', `<span class="lockpill">${ic('lock', 'sm')}Always on</span>`)}</div>
    ${ui.unlock.supported ? `<div class="sgroup">Unlock from phone</div><div class="slist">
      ${item('Let your phone unlock this PC', ui.unlock.installed && ui.unlock.cred ? (ui.unlock.blocked ? 'The saved PIN or password did not work. Save it again.' : 'On. The PIN or password is kept encrypted on this PC only, and typed on the lock screen when your phone asks.') : 'Type exactly what you enter on the Windows lock screen: your PIN if it asks for a PIN, otherwise your password. Windows asks for permission once.', `<input class="field" id="unlockSecret" type="password" autocomplete="off" placeholder="${ui.unlock.cred ? 'New PIN or password' : 'PIN or password'}"><button class="btn sm primary" data-act="unlock-save">Save</button>${ui.unlock.installed ? `<button class="btn sm outline" data-act="unlock-off">Turn off</button>` : ''}`)}
      ${item('Good to know', 'Anyone holding your unlocked phone can unlock this PC. It only works while the PC is awake; a sleeping or shut-down PC cannot be reached.', '')}</div>` : ''}
    <div class="sgroup">Advanced</div><div class="slist">
      ${item('Relay server', 'Passes encrypted setup messages between your devices.', field('relayUrl', 'https://project.supabase.co'))}
      ${item('Relay key', '', field('relayKey', 'publishable key'))}
      ${item('Cloudflare TURN key ID', 'Optional. Helps when mobile networks block direct connections.', field('turnKeyId', 'key id'))}
      ${item('Cloudflare TURN API token', '', field('turnToken', 'token', 'password'))}
      ${item('Same Wi-Fi address', 'The phone web controller is served here.', `<span class="mono">${S.lan.length ? esc(`http://${S.lan[0]}:${S.port}`) : 'No network'}</span>`)}</div>
    <div class="sgroup">About</div><div class="slist">${item(`Setu Remote ${S.version}`, updateLine(), ui.update.state === 'ready' ? `<button class="btn sm primary" data-act="update-install">Restart to update</button>` : ui.update.state === 'off' ? '' : `<button class="btn sm" data-act="update-check">Check for updates</button>`)}</div></div>`;
}

// ---------------------------------------------------------------- phone screen viewer
function vScreen() {
  const s = ui.screen, p = s.peer, cam = s.kind === 'camera'; const key = (a, i, l) => `<span data-act="pkey" data-a="${a}">${ic(i, 'md')}${l}</span>`;
  const wait = s.state === 'live' ? '' : `<div class="wait"><span class="spin light"></span><b>${esc(s.msg || 'Connecting…')}</b><p>${s.state === 'ask' && !cam ? `If ${esc(p ? p.name : 'the phone')} asks, tap “Start now” to share its screen.` : ''}</p></div>`;
  return `<div class="vbar"><span class="conn"><span class="dot ${s.state === 'live' ? 'on' : ''}"></span><span id="vstate">${s.state === 'live' ? (cam ? 'Phone camera' : 'Connected') : esc(s.msg || 'Connecting…')}</span></span><span class="vchip" id="vstats"></span><span class="grow"></span><button class="btn sm danger" data-act="screen-end">${ic('stop', 'sm')}End session</button></div>
   <div class="vbody">${cam
     ? `<div class="keys"><b>Phone camera</b><p class="txt">The phone shows a notice while its camera is on.</p><button class="btn sm soft" data-act="cam-flip" ${s.state === 'live' ? '' : 'disabled'}>${ic('rotate', 'sm')}${s.facing === 'front' ? 'Use back camera' : 'Use front camera'}</button><button class="btn sm soft" data-act="cam-shot" ${s.state === 'live' ? '' : 'disabled'}>${ic('camera', 'sm')}Save a photo</button></div>`
     : `<div class="keys"><b>Mouse and keyboard</b><div><span>Tap</span><kbd>Click</kbd></div><div><span>Swipe</span><kbd>Drag</kbd></div><div><span>Back</span><kbd>Right-click</kbd></div><div><span>Home</span><kbd>Middle-click</kbd></div><div><span>Scroll</span><kbd>Wheel</kbd></div><div><span>Type into the phone</span><kbd>Just type</kbd></div><div><span>Paste from PC</span><kbd>Ctrl+V</kbd></div></div>`}
   <div class="stage" id="stage" tabindex="0">${wait}<video id="pvideo" autoplay playsinline muted></video></div>
   ${cam ? '<div class="rail"></div>' : `<div class="rail">${key('back', 'nav-back', 'Back')}${key('home', 'nav-home', 'Home')}${key('recents', 'nav-recents', 'Recents')}<span class="sep"></span>${key('notifications', 'bell', 'Alerts')}${key('volup', 'vol-up', 'Vol +')}${key('voldown', 'vol-down', 'Vol −')}${key('lock', 'lock', 'Lock')}</div>`}</div>`;
}
async function unlockPhone(p) { const r = await p.request('dev.unlock', {}, { timeout: 25000 }); if (ui.info[p.id]) ui.info[p.id].locked = false; return r; }
async function openViewer(kind = 'screen', facing) {
  let p; try { p = needPhone(); } catch (e) { return fail(e); }
  const s = ui.screen; if (s.on && s.kind === kind && !facing) { ui.view = 'screen'; return render(); }
  if (s.on) closeViewer(false, true);
  const cam = kind === 'camera', info = ui.info[p.id];
  Object.assign(s, { on: true, kind, peer: p, state: 'ask', msg: cam ? 'Opening the phone camera…' : 'Asking the phone to share its screen…', t0: Date.now(), release: p.hold(), facing: facing || s.facing || 'back' });
  ui.view = 'screen'; render();
  try {
    if (!cam && info && info.locked && info.unlock) { s.msg = 'Unlocking the phone…'; render(true); await unlockPhone(p); if (!s.on) return; s.msg = 'Asking the phone to share its screen…'; render(true); }
    const r = cam ? await p.request('cam.start', { facing: s.facing }, { timeout: 30000 }) : await p.request('screen.start', {}, { timeout: 60000 });
    if (!s.on) return;
    s.state = 'live'; s.size = r; if (cam && r.facing) s.facing = r.facing; render(true);
  } catch (e) { closeViewer(true); fail(e); }
}
async function savePhoto() {
  const v = $('#pvideo'); if (!v || !v.videoWidth) return;
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92)), d = new Date(), z = n => String(n).padStart(2, '0');
  const name = `Phone camera ${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}.${z(d.getMinutes())}.${z(d.getSeconds())}.jpg`;
  const f = await N.fsOpenWrite(settings().downloadDir, name); await N.fsWrite(f.id, new Uint8Array(await blob.arrayBuffer())); const final = await N.fsClose(f.id, true);
  ui.lastPath = final || f.path; toast('Photo saved to ' + settings().downloadDir);
}
function attachVideo() { const v = $('#pvideo'), s = ui.screen; if (!v || !s.peer || !s.peer.remoteTrack) return; v.srcObject = new MediaStream([s.peer.remoteTrack]); v.play().catch(() => {}); }
function closeViewer(remote, stay) {
  const s = ui.screen; if (!s.on) return;
  if (!remote && s.peer) s.peer.request(s.kind === 'camera' ? 'cam.stop' : 'screen.stop', {}).catch(() => {});
  if (s.state === 'live') addHistory(s.kind === 'camera' ? 'camera' : 'cast', s.kind === 'camera' ? `Viewed ${s.peer.name}'s camera` : `Viewed ${s.peer.name}'s screen`, `for ${Math.max(1, Math.round((Date.now() - s.t0) / 60000))} min`);
  s.release && s.release(); clearInterval(s.statT);
  Object.assign(s, { on: false, peer: null, state: '', release: null });
  if (ui.view === 'screen' && !stay) { ui.view = 'devices'; render(); }
}
function bindStage() {
  const stage = $('#stage'), v = $('#pvideo'), s = ui.screen; if (!stage) return;
  if (s.state === 'live') attachVideo();
  const send = d => s.peer && s.kind !== 'camera' && s.peer.sendInput(d);
  const pos = e => { const r = v.getBoundingClientRect(); const vw = v.videoWidth || 9, vh = v.videoHeight || 16; const sc = Math.min(r.width / vw, r.height / vh); const w = vw * sc, h = vh * sc; const x = (e.clientX - r.left - (r.width - w) / 2) / w, y = (e.clientY - r.top - (r.height - h) / 2) / h; return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)), x >= 0 && x <= 1 && y >= 0 && y <= 1]; };
  let g = null;
  stage.addEventListener('mousedown', e => { stage.focus(); if (s.state !== 'live' || s.kind === 'camera') return; e.preventDefault(); const [x, y, inside] = pos(e); if (!inside) return; if (e.button === 2) return send({ k: 'key', a: 'back' }); if (e.button === 1) return send({ k: 'key', a: 'home' }); g = { t0: performance.now(), pts: [[x, y, 0]], moved: false, cx: e.clientX, cy: e.clientY }; });
  window.onmousemove = e => { if (!g) return; const [x, y] = pos(e); if (Math.hypot(e.clientX - g.cx, e.clientY - g.cy) > 6) g.moved = true; const t = Math.round(performance.now() - g.t0); if (t - g.pts[g.pts.length - 1][2] >= 16) g.pts.push([x, y, t]); };
  window.onmouseup = e => { if (!g) return; const gg = g; g = null; const [x, y] = pos(e), ms = Math.round(performance.now() - gg.t0);
    if (!gg.moved) return send(ms < 450 ? { k: 'tap', x: gg.pts[0][0], y: gg.pts[0][1] } : { k: 'gesture', pts: [gg.pts[0], [gg.pts[0][0], gg.pts[0][1], ms]], ms });
    gg.pts.push([x, y, ms]); let pts = gg.pts; if (pts.length > 40) { const step = pts.length / 40; pts = Array.from({ length: 40 }, (_, i) => gg.pts[Math.floor(i * step)]); pts.push(gg.pts[gg.pts.length - 1]); }
    send({ k: 'gesture', pts: pts.map(q => [+q[0].toFixed(4), +q[1].toFixed(4), q[2]]), ms: Math.max(60, ms) }); };
  stage.addEventListener('contextmenu', e => e.preventDefault());
  let wheelAcc = 0, wheelT = 0;
  stage.addEventListener('wheel', e => { if (s.state !== 'live') return; e.preventDefault(); const [x, y] = pos(e); wheelAcc += e.deltaY; const now = performance.now(); if (now - wheelT > 120) { wheelT = now; send({ k: 'scroll', x, y, dy: Math.max(-3, Math.min(3, wheelAcc / 100)) }); wheelAcc = 0; } }, { passive: false });
  stage.addEventListener('keydown', async e => { if (s.state !== 'live') return; e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { const t = await N.clipGet(); if (t) send({ k: 'text', s: t }); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const map = { Enter: 'enter', Backspace: 'backspace', Escape: 'back', Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Delete: 'delete' };
    if (map[e.key]) send({ k: 'key', a: map[e.key] }); else if (e.key.length === 1 || [...e.key].length === 1) send({ k: 'text', s: e.key }); });
  clearInterval(s.statT);
  s.statT = setInterval(async () => { const el = $('#vstats'), pc = s.peer && s.peer.pc; if (!el || !pc) return; try { const st = await pc.getStats(); let fps = 0, rtt = null, w = 0, h = 0; st.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'video') { fps = r.framesPerSecond || 0; w = r.frameWidth; h = r.frameHeight; } if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime; }); el.innerHTML = `<b>${rtt != null ? Math.round(rtt * 1000) + ' ms' : ''}</b> ${Math.round(fps)} fps ${w ? `· ${w}×${h}` : ''}`; } catch {} }, 1500);
  stage.focus();
}

// ---------------------------------------------------------------- pairing + dialogs
async function startPairing() {
  const pairing = { secret: newSecret(), created: Date.now(), peers: {} };
  const room = openRoom(pairing);
  const st = settings();
  const std = st.relayUrl === DEFAULT_RELAY.u && st.relayKey === DEFAULT_RELAY.k;
  const code = encodePairing({ v: 1, id: S.store.device.id, s: pairing.secret, lan: lanAddrs().slice(0, 2), ...(st.useCloud ? (std ? {} : { relay: { u: st.relayUrl, k: st.relayKey } }) : { relay: null }) });
  const link = S.lan.length ? `http://${S.lan[0]}:${S.port}/#${code}` : code;
  ui.pairing = { secret: pairing.secret, code, link, qr: await N.qr(link), room };
  ui.modal = () => `<div class="scrim" data-act="pair-close"></div><div class="dialog"><div class="dhead"><b>Pair a phone</b><button class="iconbtn" data-act="pair-close">${ic('x')}</button></div><div class="dbody pairgrid"><img class="qrimg" src="${ui.pairing.qr}" alt="Pairing QR code"><div><h3 class="h3">Scan this with your phone</h3>
    <ol class="steps"><li><b>With the Setu Remote app:</b> open it and tap <i>Pair with laptop</i>.</li><li><b>Without installing anything:</b> point the phone's camera at the code and open the link. The phone must be on this Wi-Fi.</li></ol>
    <div class="waiting"><span class="spin"></span>Waiting for your phone…</div>
    <div class="row" style="margin-top:14px"><button class="btn sm outline" data-act="copy" data-text="${esc(ui.pairing.code)}">${ic('copy', 'sm')}Copy pairing code</button>${S.lan.length ? `<button class="btn sm outline" data-act="copy" data-text="${esc(ui.pairing.link)}">${ic('globe', 'sm')}Copy browser link</button>` : ''}</div>
    <p class="fine" style="margin-top:12px">The code holds a secret key for your devices. Don't share it with anyone else.</p></div></div></div>`;
  render();
}
function closePairing() {
  const pr = ui.pairing; ui.modal = null; ui.pairing = null;
  if (pr && !pr.done && !S.store.pairings.some(x => x.secret === pr.secret)) { pr.room.close(); rooms.delete(pr.secret); }
  render();
}
function promptText() {
  ui.modal = () => `<div class="scrim" data-act="modal-close"></div><div class="dialog narrow"><div class="dhead"><b>Send text to your phone</b><button class="iconbtn" data-act="modal-close">${ic('x')}</button></div><form class="dbody" data-act-submit="text-send"><textarea name="t" rows="5" placeholder="Paste a link, an address, a note…" autofocus></textarea><p class="fine">It's copied to the phone's clipboard and shown as a notification.</p><div class="btnrow"><button type="button" class="btn outline auto" data-act="modal-close">Cancel</button><button class="btn primary auto">${ic('send')}Send</button></div></form></div>`;
  render(); setTimeout(() => { const t = $('#modal textarea'); t && t.focus(); }, 30);
}
async function sendText(text) { if (!text.trim()) return; const p = needPhone(); await p.request('text.push', { text }); addHistory('clipboard', `Sent text to ${p.name}`, text.slice(0, 120)); toast('Sent to ' + p.name); }

// ---------------------------------------------------------------- actions
const actions = {
  nav: el => { ui.view = el.dataset.view; if (ui.view === 'messages') { ui.msgs.threads = null; } if (ui.view === 'photos') ui.photos.items = null; if (ui.view === 'files') { ui.files.data = null; ui.files.err = ''; } if (ui.view === 'devices') { const p = phone(); p && p.online && refreshInfo(p); } render(); },
  pair: () => startPairing().catch(fail), 'pair-close': closePairing, 'modal-close': () => { ui.modal = null; render(); },
  copy: async el => { await N.clipSet(el.dataset.text); toast('Copied'); },
  unpair: el => { const sec = el.dataset.secret; const r = rooms.get(sec); if (r) { r.close(); rooms.delete(sec); } save({ pairings: S.store.pairings.filter(p => p.secret !== sec) }); toast('Device removed'); render(); },
  'send-files': async () => { try { needPhone(); const paths = await N.pickFiles(); if (paths.length) sendPaths(paths, ''); } catch (e) { fail(e); } },
  'send-text': () => { try { needPhone(); promptText(); } catch (e) { fail(e); } },
  'send-clipboard': async () => { try { await sendText(await N.clipGet()); } catch (e) { fail(e); } },
  screen: () => openViewer('screen'), 'screen-end': () => closeViewer(false),
  'phone-cam': () => openViewer('camera'), 'cam-flip': () => openViewer('camera', ui.screen.facing === 'front' ? 'back' : 'front'), 'cam-shot': () => savePhoto().catch(fail),
  'phone-unlock': async () => { try { const p = needPhone(); toast('Unlocking the phone…'); await unlockPhone(p); toast('Phone unlocked'); render(); } catch (e) { fail(e); const p = phone(); if (p) refreshInfo(p); } },
  'unlock-save': async () => { const f = $('#unlockSecret'); if (!f || !f.value) return toast('Type the PIN or password you use on the Windows lock screen', true); try { toast('Windows may ask for permission once. Choose Yes.'); ui.unlock = await N.unlockSetup(f.value); toast('Saved. Your phone can now unlock this PC.'); announceChange(); render(); } catch (e) { fail(e); } },
  'unlock-off': async () => { try { ui.unlock = await N.unlockRemove(); announceChange(); render(); } catch (e) { fail(e); } },
  pkey: el => ui.screen.peer && ui.screen.peer.sendInput({ k: 'key', a: el.dataset.a }),
  cd: el => { ui.files.data = null; loadFiles(el.dataset.path); render(); },
  sel: (el, e) => { const f = ui.files, p = el.dataset.path; if (!(e.ctrlKey || e.metaKey || e.shiftKey) && !f.sel.has(p) && f.sel.size && e.detail > 1) f.sel.clear(); f.sel.has(p) ? f.sel.delete(p) : f.sel.add(p); render(); },
  upload: async () => { const paths = await N.pickFiles(); if (paths.length) sendPaths(paths, ui.files.data.path); },
  download: () => { let p; try { p = needPhone(); } catch (e) { return fail(e); } const f = ui.files; for (const path of f.sel) { const e = f.data.entries.find(x => x.p === path); if (!e) continue; enqueue(`Copying ${e.n} to this PC`, async prog => { const out = await pullFile(p, e.p, e.n, settings().downloadDir, e.m, prog, e.s); addHistory('file', `Copied ${e.n} from ${p.name}`, fmtSize(e.s)); return out; }); } f.sel = new Set(); render(); },
  thread: el => loadThread(el.dataset.addr),
  import: () => { try { importPhotos(); } catch (e) { fail(e); } },
  'pick-import': async () => { const d = await N.pickFolder(settings().importDir); if (d) { settings().importDir = d; save({ settings: settings() }); render(); } },
  'pick-download': async () => { const d = await N.pickFolder(settings().downloadDir); if (d) { settings().downloadDir = d; save({ settings: settings() }); render(); } },
  'update-check': async () => { ui.update = await N.updateCheck(); render(); }, 'update-install': () => N.updateInstall(),
  toggle: el => { const k = el.dataset.key, st = settings(); st[k] = !st[k]; save({ settings: st }); if (k === 'startWithWindows') N.autostart(st[k]); if (k === 'useCloud') restartRooms(); render(); },
  'reveal-last': () => { const p = ui.lastPath || S.store.lastRecv; if (p) N.reveal(p); },
};
const submits = {
  'sms-send': async form => { const t = form.t.value.trim(); if (!t) return; form.t.disabled = true; try { await needPhone().request('sms.send', { addr: ui.msgs.cur, body: t }, { timeout: 20000 }); form.t.value = ''; ui.msgs.list = [...(ui.msgs.list || []), { body: t, ts: Date.now(), out: true }]; addHistory('mail', `Sent a text to ${ui.msgs.cur}`, 'through your phone'); render(); const el = $('#tmsgs'); if (el) el.scrollTop = el.scrollHeight; setTimeout(() => loadThread(ui.msgs.cur, true), 2500); } catch (e) { fail(e); form.t.disabled = false; } },
  'notif-reply': async form => { const t = form.t.value.trim(); if (!t) return; try { await needPhone().request('notif.reply', { key: form.dataset.key, text: t }); ui.msgs.notifs = ui.msgs.notifs.filter(n => n.key !== form.dataset.key); toast('Reply sent'); render(); } catch (e) { fail(e); } },
  'text-send': async form => { try { await sendText(form.t.value); ui.modal = null; render(); } catch (e) { fail(e); } },
};
function restartRooms() { for (const r of rooms.values()) r.close(); rooms.clear(); ui.info = {}; for (const p of S.store.pairings) openRoom(p); }

document.addEventListener('click', e => { const el = e.target.closest('[data-act]'); if (!el || el.disabled) return; const f = actions[el.dataset.act]; if (f) { e.preventDefault(); f(el, e); } });
document.addEventListener('submit', e => { const f = e.target.closest('[data-act-submit]'); if (!f) return; e.preventDefault(); submits[f.dataset.actSubmit](f); });
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.setting) { settings()[t.dataset.setting] = t.value.trim(); save({ settings: settings() }); if (/relay/.test(t.dataset.setting)) restartRooms(); }
  if ('deviceName' in t.dataset && t.value.trim()) { S.store.device.name = t.value.trim().slice(0, 40); save({ device: S.store.device }); restartRooms(); renderSide(); }
});
document.addEventListener('dragover', e => { if (e.target.closest('#drop')) { e.preventDefault(); e.target.closest('#drop').classList.add('over'); } });
document.addEventListener('dragleave', e => { const d = e.target.closest && e.target.closest('#drop'); d && d.classList.remove('over'); });
document.addEventListener('drop', e => { const d = e.target.closest('#drop'); if (!d) return; e.preventDefault(); d.classList.remove('over'); const paths = [...e.dataTransfer.files].map(f => N.pathOf(f)).filter(Boolean); if (paths.length) sendPaths(paths, ui.view === 'files' && ui.files.data ? ui.files.data.path : ''); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && ui.modal) { ui.pairing ? closePairing() : (ui.modal = null, render()); } });
N.on('overlay:stop', () => stopHosting());
N.on('action', a => actions[a] && actions[a]());

(async function boot() {
  S = await N.state();
  for (const p of S.store.pairings) openRoom(p);
  render();
  setInterval(() => { const p = phone(); if (p && p.online && ui.view === 'devices' && !document.hidden) refreshInfo(p); }, 60000);
  N.lockState().then(p => { ui.power = p; }); N.unlockStatus().then(u => { ui.unlock = u; });
  N.on('power', p => { ui.power = p; announceChange(); N.unlockStatus().then(u => { ui.unlock = u; if (ui.view === 'settings') render(); }); });
  window.__setuBusy = () => !!hosting || jobRunning || jobs.some(j => j.state === 'run' || j.state === 'wait') || ui.screen.on;
  N.updateState().then(u => { ui.update = u; }); N.on('update', u => { ui.update = u; if (ui.view === 'settings') render(); });
  window.__setu = { ui, rooms, phone, allPeers, state: () => S, startPairing, hosting: () => hosting, jobs, sendPaths };
})();

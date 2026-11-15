const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, shell, clipboard, Notification, screen, session, desktopCapturer, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { startRelay } = require('./relay-server');
const injector = require('./inject');

const TEST = !!process.env.SETU_DATA;
if (TEST) app.setPath('userData', process.env.SETU_DATA);
// This is a trusted desktop app: advertise real LAN addresses so phones can connect directly on the same Wi-Fi.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_RELAY = { url: 'https://onehmelzuguildygncdr.supabase.co', key: 'sb_publishable_-Z_QvDKwSUphuI0bGZpWRw_gjqA3cqF' };

let win = null, banner = null, tray = null, relay = null, quitting = false, store = null;
const storeFile = () => path.join(app.getPath('userData'), 'setu.json');

function loadStore() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(storeFile(), 'utf8')); } catch {}
  s.device ||= { id: String(crypto.randomInt(100000000, 999999999)), name: os.hostname() };
  s.pairings ||= []; s.history ||= []; s.imported ||= {};
  s.settings = { relayUrl: DEFAULT_RELAY.url, relayKey: DEFAULT_RELAY.key, useCloud: true, turnKeyId: '', turnToken: '',
    downloadDir: path.join(app.getPath('downloads'), 'Setu'), importDir: path.join(app.getPath('pictures'), 'Phone imports'),
    autoAccept: true, startWithWindows: false, showNotifications: true, ...(s.settings || {}) };
  return s;
}
function saveStore() { try { fs.mkdirSync(path.dirname(storeFile()), { recursive: true }); fs.writeFileSync(storeFile() + '.tmp', JSON.stringify(store, null, 1)); fs.renameSync(storeFile() + '.tmp', storeFile()); } catch (e) { console.error('[setu] save failed', e); } }
const lanIps = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);

// ---------- file access for transfers
const handles = new Map(); let hid = 0;
function roots() {
  const out = [];
  for (const [n, k] of [['Desktop', 'desktop'], ['Downloads', 'downloads'], ['Documents', 'documents'], ['Pictures', 'pictures'], ['Videos', 'videos']]) { try { out.push({ n, p: app.getPath(k), d: true }); } catch {} }
  out.push({ n: 'Home', p: os.homedir(), d: true });
  if (process.platform === 'win32') for (let c = 67; c <= 90; c++) { const p = String.fromCharCode(c) + ':\\'; if (fs.existsSync(p)) out.push({ n: 'Drive ' + String.fromCharCode(c) + ':', p, d: true }); }
  return out;
}
async function fsList(dir, offset = 0, limit = 500) {
  if (!dir) return { path: '', parent: null, sep: path.sep, total: 0, entries: roots() };
  const names = await fsp.readdir(dir, { withFileTypes: true });
  const all = names.filter(d => !d.name.startsWith('.') && !d.name.endsWith('.part')).map(d => ({ n: d.name, p: path.join(dir, d.name), d: d.isDirectory() }));
  all.sort((a, b) => (b.d - a.d) || a.n.localeCompare(b.n, undefined, { numeric: true }));
  const page = all.slice(offset, offset + limit);
  await Promise.all(page.map(async e => { try { const st = await fsp.stat(e.p); e.s = e.d ? 0 : st.size; e.m = Math.round(st.mtimeMs); } catch { e.s = 0; e.m = 0; } }));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? '' : parent, sep: path.sep, total: all.length, entries: page };
}
async function uniquePath(dir, name) {
  const safe = String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 180) || 'file';
  const ext = path.extname(safe), base = safe.slice(0, safe.length - ext.length);
  for (let i = 0; i < 1000; i++) { const p = path.join(dir, i ? `${base} (${i})${ext}` : safe); if (!fs.existsSync(p) && !fs.existsSync(p + '.part')) return p; }
  throw new Error('Too many files with the same name');
}

function registerIpc() {
  const h = (ch, f) => ipcMain.handle(ch, (_e, ...a) => f(...a));
  h('state', () => ({ store, lan: lanIps(), port: relay ? relay.port : 0, platform: process.platform, hostname: os.hostname(), version: app.getVersion(), test: TEST,
    primary: screen.getPrimaryDisplay().size }));
  h('update:state', () => update);
  h('update:check', () => { if (updater) updater.check(); return update; });
  h('update:install', () => { if (updater && update.state === 'ready') updater.install(); return true; });
  h('store:save', patch => { Object.assign(store, patch); saveStore(); return true; });
  h('qr', text => QRCode.toDataURL(text, { errorCorrectionLevel: 'L', margin: 1, scale: 6 }));
  h('fs:list', fsList);
  h('fs:openRead', async p => { const fh = await fsp.open(p, 'r'); const st = await fh.stat(); if (!st.isFile()) { await fh.close(); throw new Error('Not a file'); } const id = ++hid; handles.set(id, { fh }); return { id, size: st.size, mtime: Math.round(st.mtimeMs), name: path.basename(p) }; });
  h('fs:read', async (id, len = 256 * 1024) => { const x = handles.get(id); if (!x) throw new Error('Closed'); const buf = Buffer.allocUnsafe(len); const { bytesRead } = await x.fh.read(buf, 0, len, null); return bytesRead ? new Uint8Array(buf.buffer, buf.byteOffset, bytesRead).slice() : null; });
  h('fs:openWrite', async (dir, name) => { await fsp.mkdir(dir, { recursive: true }); const final = await uniquePath(dir, name); const fh = await fsp.open(final + '.part', 'w'); const id = ++hid; handles.set(id, { fh, final }); return { id, path: final }; });
  h('fs:write', async (id, data) => { const x = handles.get(id); if (!x) throw new Error('Closed'); await x.fh.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength)); return true; });
  h('fs:close', async (id, ok = true, mtime) => {
    const x = handles.get(id); if (!x) return null; handles.delete(id); await x.fh.close();
    if (!x.final) return null;
    if (ok) { await fsp.rename(x.final + '.part', x.final); if (mtime) { try { await fsp.utimes(x.final, new Date(), new Date(mtime)); } catch {} } return x.final; }
    await fsp.unlink(x.final + '.part').catch(() => {}); return null;
  });
  h('fs:exists', async (dir, name, size) => { try { const st = await fsp.stat(path.join(dir, name)); return size == null || st.size === size; } catch { return false; } });
  h('fs:mkdir', async p => { await fsp.mkdir(p, { recursive: true }); return true; });
  h('pick:files', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] }); return r.canceled ? [] : r.filePaths; });
  h('pick:folder', async current => { const r = await dialog.showOpenDialog(win, { defaultPath: current, properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
  h('reveal', p => { shell.showItemInFolder(p); return true; });
  h('open', p => shell.openPath(p));
  h('clip:get', () => clipboard.readText());
  h('clip:set', t => { clipboard.writeText(String(t || '')); return true; });
  h('notify', (title, body) => { if (store.settings.showNotifications && Notification.isSupported()) { const n = new Notification({ title, body: String(body || '').slice(0, 240), icon: iconPath() }); n.on('click', showWindow); n.show(); } return true; });
  h('cursor', () => screen.getCursorScreenPoint());
  h('inject:status', () => injector.status());
  h('autostart', on => { if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] }); store.settings.startWithWindows = !!on; saveStore(); return true; });
  h('overlay', (show, name) => { showBanner(show, name); return true; });
  h('turn:ice', turnIce);
  h('screen:source', async () => { const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }); if (!src.length) throw new Error('No screen to share'); return src[0].id; });
  ipcMain.on('inject', (_e, ev) => { try { injector.inject(ev); } catch (e) { console.error('[setu] inject', e.message); } });
  ipcMain.on('overlay:stop', () => { if (win) win.webContents.send('overlay:stop'); });
}

let turnCache = null;
async function turnIce() {
  const { turnKeyId, turnToken } = store.settings;
  if (!turnKeyId || !turnToken) return null;
  if (turnCache && Date.now() - turnCache.at < 12 * 3600e3) return turnCache.ice;
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(turnKeyId)}/credentials/generate-ice-servers`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + turnToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json(); const ice = Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers];
    turnCache = { at: Date.now(), ice }; return ice;
  } catch (e) { console.error('[setu] TURN credentials failed:', e.message); return null; }
}

// ---------- self-update
// Installed Windows builds fetch new versions by themselves from the "windows" release on GitHub
// (see build.publish in package.json). The update installs silently when nothing is in progress.
let update = { state: 'off', version: '', percent: 0, error: '' }, updater = null;
function setUpdate(p) { Object.assign(update, p); if (win && !win.isDestroyed()) win.webContents.send('update', update); }
async function installWhenIdle() {
  if (!updater || update.state !== 'ready') return;
  let busy = true;
  try { busy = await win.webContents.executeJavaScript('typeof window.__setuBusy === "function" ? window.__setuBusy() : false'); } catch {}
  if (busy) { setTimeout(installWhenIdle, 2 * 60e3); return; }
  updater.install();
}
function initUpdater() {
  if (TEST || !app.isPackaged || process.platform !== 'win32') return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { console.error('[setu] updater unavailable:', e.message); return; }
  autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true; autoUpdater.disableDifferentialDownload = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking', error: '' }));
  autoUpdater.on('update-available', i => setUpdate({ state: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => setUpdate({ state: 'current' }));
  autoUpdater.on('download-progress', pr => setUpdate({ state: 'downloading', percent: Math.round(pr.percent || 0) }));
  autoUpdater.on('update-downloaded', i => { setUpdate({ state: 'ready', version: i.version }); setTimeout(installWhenIdle, 15e3); });
  autoUpdater.on('error', e => setUpdate({ state: 'error', error: String((e && e.message) || e).split('\n')[0].slice(0, 200) }));
  const check = () => { if (update.state !== 'downloading' && update.state !== 'ready') autoUpdater.checkForUpdates().catch(() => {}); };
  updater = {
    check,
    install: () => { store.startHiddenOnce = !(win && win.isVisible()); saveStore(); quitting = true; autoUpdater.quitAndInstall(true, true); },
  };
  update.state = 'current';
  setTimeout(check, 20e3); setInterval(check, 3 * 3600e3);
}

// ---------- windows
const iconPath = () => path.join(ROOT, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
function createWindow() {
  win = new BrowserWindow({ width: 1240, height: 800, minWidth: 980, minHeight: 640, show: false, backgroundColor: '#ffffff', title: 'Setu Remote', icon: iconPath(), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(ROOT, 'dist', 'app', 'index.html'));
  const hiddenOnce = !!store.startHiddenOnce; if (hiddenOnce) { delete store.startHiddenOnce; saveStore(); } // restarted by a background update
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden') && !hiddenOnce) win.show(); });
  win.on('close', e => { if (!quitting && tray) { e.preventDefault(); win.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}
function showWindow() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
function showBanner(show, name) {
  if (!show) { if (banner) { banner.destroy(); banner = null; } return; }
  if (banner) return;
  const { width } = screen.getPrimaryDisplay().workAreaSize, w = 500, hgt = 52;
  banner = new BrowserWindow({ width: w, height: hgt, x: Math.round((width - w) / 2), y: 10, frame: false, resizable: false, movable: true, alwaysOnTop: true, skipTaskbar: true,
    focusable: false, show: false, backgroundColor: '#F2A20C', webPreferences: { preload: path.join(__dirname, 'banner-preload.js'), contextIsolation: true } });
  banner.setAlwaysOnTop(true, 'screen-saver');
  banner.loadFile(path.join(ROOT, 'src', 'ui', 'banner.html'), { query: { name: name || 'Your phone' } });
  banner.once('ready-to-show', () => banner && banner.showInactive());
  banner.on('closed', () => { banner = null; });
}
function createTray() {
  if (process.env.SETU_NO_TRAY) return;
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray.png')));
    tray.setToolTip('Setu Remote');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Setu Remote', click: showWindow },
      { label: 'Send files to phone', click: () => { showWindow(); win.webContents.send('action', 'send-files'); } },
      { label: 'Send clipboard to phone', click: () => win.webContents.send('action', 'send-clipboard') },
      { type: 'separator' },
      { label: 'Quit Setu Remote', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  } catch (e) { console.error('[setu] tray unavailable:', e.message); tray = null; }
}

if (!TEST && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    store = loadStore(); saveStore();
    registerIpc();
    session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
      desktopCapturer.getSources({ types: ['screen'] }).then(src => cb(src.length ? { video: src[0] } : {})).catch(() => cb({}));
    });
    try { relay = await startRelay({ port: Number(process.env.SETU_PORT) || 47800, webRoot: path.join(ROOT, 'dist', 'web') }); }
    catch (e) { console.error('[setu] LAN relay failed to start:', e.message); }
    createTray(); createWindow(); initUpdater();
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { if (!tray) app.quit(); });
}

// End-to-end tests: the real PC app on a virtual display, a simulated phone, and the phone web controller.
const { _electron, chromium } = require('playwright-core');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const WebSocket = require('ws');
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, '..', 'test-report'), PORT = 47901;
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; let failed = 0;
async function step(name, fn) { const t0 = Date.now(); try { const note = await fn(); results.push({ name, ok: true, ms: Date.now() - t0, note: note || '' }); console.log(`PASS  ${name}${note ? '  — ' + note : ''}`); } catch (e) { failed++; results.push({ name, ok: false, ms: Date.now() - t0, note: String(e.message || e).split('\n')[0] }); console.log(`FAIL  ${name}  — ${e.message}`); } }
const assert = (c, msg) => { if (!c) throw new Error(msg); };
async function until(fn, ms = 15000, what = 'condition') { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('Timed out waiting for ' + what); await sleep(150); } }

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'setu-data-')), dl = path.join(data, 'Downloads', 'Setu'), imp = path.join(data, 'Pictures', 'Phone imports');
  fs.writeFileSync(path.join(data, 'setu.json'), JSON.stringify({ device: { id: '731054862', name: 'Study laptop' }, settings: { downloadDir: dl, importDir: imp, useCloud: false } }));
  const app = await _electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, SETU_DATA: data, SETU_PORT: String(PORT), SETU_NO_TRAY: '1', SETU_FAKE_UNLOCK: '1' } });
  const win = await app.firstWindow(); const errors = [];
  win.on('pageerror', e => errors.push('app: ' + e.message)); win.on('console', m => { if (m.type() === 'error') errors.push('app console: ' + m.text()); });
  await win.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await win.waitForSelector('.brand'); win.setDefaultTimeout(12000);
  const shot = (n, page = win) => page.screenshot({ path: path.join(OUT, n + '.png') });
  const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : fs.existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome' } : { channel: 'chrome' }), headless: true, args: ['--no-sandbox', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] });
  let phone, code;
  const fp = (fn, arg) => phone.evaluate(fn, arg);
  const openPhone = async () => { phone = await browser.newPage(); phone.setDefaultTimeout(12000); phone.on('pageerror', e => errors.push('phone: ' + e.message)); await phone.goto(require('url').pathToFileURL(path.join(ROOT, 'dist/test/fakephone.html')).href + '#' + code); await phone.waitForFunction(() => window.__fp && window.__fp.ready); };

  await step('PC app starts, LAN relay and input backend ready', async () => {
    const s = await win.evaluate(async () => ({ port: window.__setu.state().port, inj: await window.native.injectStatus() }));
    assert(s.port === PORT, 'relay port ' + s.port); assert(s.inj.ok, 'input backend: ' + s.inj.error); await shot('01-first-run');
  });
  await step('Pairing: QR shown, phone joins, PC stores the pairing', async () => {
    await win.click('[data-act=pair]'); await win.waitForSelector('.qrimg'); await shot('02-pair-dialog');
    code = await win.evaluate(() => window.__setu.ui.pairing.code); assert(code.startsWith('setu1.') && code.length < 220, 'pairing code length ' + code.length);
    await openPhone();
    await win.waitForSelector('.glance', { timeout: 15000 });
    const txt = await win.textContent('.topgrid'); assert(/Test Phone/.test(txt) && /Online/.test(txt), 'phone card missing');
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'setu.json'))); assert(saved.pairings.length === 1 && Object.keys(saved.pairings[0].peers).length === 1, 'pairing not saved');
    return 'code ' + code.length + ' chars';
  });
  await step('Phone status over the encrypted relay (battery, storage, unread)', async () => {
    const t = await win.textContent('.glance'); assert(/78%/.test(t) && /Charging/.test(t) && /69\.\d GB|68\.\d GB/.test(t), 'glance: ' + t); await shot('03-devices');
  });
  await step('Relay traffic is opaque: only encrypted envelopes, forged messages ignored', async () => {
    const room = await win.evaluate(() => [...window.__setu.rooms.values()][0].keys.room); const seen = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/relay?vsn=1.0.0`); await new Promise(r => ws.on('open', r));
    ws.on('message', d => seen.push(d.toString()));
    ws.send(JSON.stringify({ topic: 'realtime:setu-' + room, event: 'phx_join', ref: '1', payload: {} })); await sleep(300);
    await win.evaluate(async () => { const p = window.__setu.phone(); p.closeLink(); await p.request('sys.info'); await p.request('sms.threads', { limit: 5 }); });
    ws.send(JSON.stringify({ topic: 'realtime:setu-' + room, event: 'broadcast', ref: '2', payload: { type: 'broadcast', event: 'sig', payload: { e: { n: 'AAAAAAAAAAAAAAAA', c: crypto.randomBytes(80).toString('base64') } } } }));
    ws.send(JSON.stringify({ topic: 'realtime:setu-' + room, event: 'broadcast', ref: '3', payload: { type: 'broadcast', event: 'sig', payload: { t: 'hello', from: '999', to: '*', name: 'Intruder', role: 'phone' } } }));
    await sleep(600); ws.close();
    const frames = seen.map(s => JSON.parse(s)).filter(m => m.event === 'broadcast'); assert(frames.length >= 4, 'captured ' + frames.length + ' frames');
    for (const f of frames) { const keys = Object.keys(f.payload.payload); assert(keys.length === 1 && keys[0] === 'e' && f.payload.payload.e.n && f.payload.payload.e.c, 'unencrypted frame seen'); }
    const blob = seen.join(''); for (const leak of ['Test Phone', 'sys.info', 'sms.threads', 'Mom', 'Reached home']) assert(!blob.includes(leak), 'plaintext leaked: ' + leak);
    const peers = await win.evaluate(() => window.__setu.allPeers().map(p => p.name)); assert(peers.length === 1 && peers[0] === 'Test Phone', 'forged peer accepted: ' + peers);
    return frames.length + ' frames inspected';
  });
  await step('Phone files: browse folders and show thumbnails', async () => {
    await win.click('[data-act=nav][data-view=files]'); await win.waitForSelector('.places span'); await win.click('.places span:has-text("Camera")');
    await win.waitForSelector('.ft b:has-text("IMG_2041.jpg")'); await win.waitForSelector('.ft .img.has', { timeout: 15000 });
    const n = await win.locator('.ft').count(); assert(n === 14, 'expected 14 photos, saw ' + n); await sleep(700); await shot('04-phone-files');
  });
  await step('Copy 3 photos from phone to PC, byte-identical', async () => {
    for (const n of ['IMG_2041.jpg', 'IMG_2040.jpg', 'IMG_2039.jpg']) await win.click(`.ft:has(b:text-is("${n}"))`);
    await win.click('[data-act=download]');
    await until(() => ['IMG_2041.jpg', 'IMG_2040.jpg', 'IMG_2039.jpg'].every(n => fs.existsSync(path.join(dl, n))), 20000, 'downloads');
    for (const n of ['IMG_2041.jpg', 'IMG_2040.jpg', 'IMG_2039.jpg']) assert(sha(path.join(dl, n)) === await fp(n => window.__fp.hash('/storage/emulated/0/DCIM/Camera/' + n), n), 'hash mismatch ' + n);
  });
  await step('Large file phone → PC (40 MB), byte-identical', async () => {
    await fp(() => window.__fp.addRandom('/storage/emulated/0/Download/lecture-video.mp4', 40 * 1048576, 42));
    await win.click('.places span:has-text("Downloads")'); await win.click('.ft:has(b:text-is("lecture-video.mp4"))'); const t0 = Date.now(); await win.click('[data-act=download]');
    await win.waitForSelector('#xfer.show .progress'); await sleep(250); await shot('05-transfer-progress');
    await until(() => fs.existsSync(path.join(dl, 'lecture-video.mp4')), 90000, '40 MB download'); const secs = (Date.now() - t0) / 1000;
    assert(sha(path.join(dl, 'lecture-video.mp4')) === await fp(() => window.__fp.hash('/storage/emulated/0/Download/lecture-video.mp4')), 'hash mismatch');
    assert(!fs.readdirSync(dl).some(f => f.endsWith('.part')), 'leftover .part file'); return `${(40 / secs).toFixed(1)} MB/s on loopback`;
  });
  await step('Large file PC → phone (25 MB) and a small document, byte-identical', async () => {
    const big = path.join(data, 'Marketing case deck.pptx'), small = path.join(data, 'notes.txt'); fs.writeFileSync(big, crypto.randomBytes(25 * 1048576)); fs.writeFileSync(small, 'Room 204, viva at 10 AM\n');
    await win.evaluate(p => window.__setu.sendPaths(p, ''), [big, small]);
    await until(() => fp(() => window.__fp.find('notes.txt').length && window.__fp.find('Marketing case deck.pptx').length), 90000, 'upload');
    assert(await fp(() => window.__fp.hash('/storage/emulated/0/Download/Setu/Marketing case deck.pptx')) === sha(big), 'big hash mismatch');
    assert(await fp(() => window.__fp.hash('/storage/emulated/0/Download/Setu/notes.txt')) === sha(small), 'small hash mismatch');
  });
  await step('Phone → PC push (file arrives in Downloads/Setu, text lands on clipboard)', async () => {
    const r = await fp(() => window.__fp.sendToPc('from-phone.bin', 3 * 1048576 + 17, 99)); assert(fs.existsSync(r.path) && sha(r.path) === r.hash, 'pushed file wrong');
    await fp(() => window.__fp.textToPc('https://example.com/placement-form')); assert(await win.evaluate(() => window.native.clipGet()) === 'https://example.com/placement-form', 'clipboard not set');
  });
  await step('Messages: SMS threads, open a conversation, send a text', async () => {
    await win.click('[data-act=nav][data-view=messages]'); await win.waitForSelector('.citem[data-act=thread]');
    await win.click('.citem[data-addr="+919820041000"]'); await win.waitForSelector('.msg:has-text("Reached home?")');
    await win.fill('.tcompose input', 'Home now, will call in 10 min'); await shot('06-messages'); await win.press('.tcompose input', 'Enter');
    await until(() => fp(() => window.__fp.log.sms.length), 8000, 'sms.send'); const s = await fp(() => window.__fp.log.sms[0]); assert(s.addr === '+919820041000' && s.body === 'Home now, will call in 10 min', 'wrong sms ' + JSON.stringify(s));
    await win.waitForSelector('.msg.me:has-text("Home now")');
  });
  await step('Chat notifications: live push, reply from the PC', async () => {
    await fp(() => window.__fp.postNotif({ key: 'wa|9', pkg: 'com.whatsapp', app: 'WhatsApp', title: 'Priya', text: 'Need it before 10 for the practice round', ts: Date.now(), reply: true }));
    await win.waitForSelector('.citem.chat:has-text("Priya")');
    const form = win.locator('.citem.chat:has-text("Priya") form'); await form.locator('input').fill('Sending in 2 min'); await form.locator('input').press('Enter');
    await until(() => fp(() => window.__fp.log.replies.length), 8000, 'reply'); const r = await fp(() => window.__fp.log.replies[0]); assert(r.key === 'wa|9' && r.text === 'Sending in 2 min', 'wrong reply');
    await fp(() => window.__fp.smsIn('+919811122233', 'Running 5 min late')); await win.waitForSelector('.citem:has-text("Running 5 min late")', { timeout: 8000 });
  });
  await step('Photos: list new photos, import into dated folders, skip on re-import', async () => {
    await win.click('[data-act=nav][data-view=photos]'); await win.waitForSelector('.pgrid i.new'); await win.waitForSelector('.pgrid i.has, .pgrid i[style*="background-image"]', { timeout: 15000 }); await sleep(900); await shot('07-photos');
    assert(/15 new/.test(await win.textContent('.mainhead')), 'expected 15 new'); await win.click('[data-act=import]');
    const walk = d => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
    await until(() => walk(imp).filter(f => !f.endsWith('.part')).length === 15, 30000, 'import'); const got = walk(imp);
    assert(got.every(f => /Phone imports[\\/]\d{4}-\d{2}[\\/]/.test(f)), 'not in dated folders');
    const one = got.find(f => f.endsWith('IMG_2030.jpg')); assert(sha(one) === await fp(() => window.__fp.hash('/storage/emulated/0/DCIM/Camera/IMG_2030.jpg')), 'import hash mismatch');
    await win.waitForSelector('text=Everything on the phone is already imported', { timeout: 10000 });
    await fp(async () => { window.__fp.addRandom('/storage/emulated/0/DCIM/Camera/IMG_2042.jpg', 5000, 5); });
    await win.click('[data-act=nav][data-view=devices]'); await win.click('[data-act=nav][data-view=photos]'); await win.waitForSelector('text=1 new photo');
    return '15 imported, re-import finds only the 1 added later';
  });
  await step('Phone screen on the PC: live video', async () => {
    await win.click('[data-act=nav][data-view=devices]'); await win.click('[data-act=screen]');
    await win.waitForFunction(() => { const v = document.querySelector('#pvideo'); return v && v.videoWidth > 0; }, null, { timeout: 20000 });
    const f1 = await win.evaluate(() => document.querySelector('#pvideo').getVideoPlaybackQuality().totalVideoFrames); await sleep(1500);
    const f2 = await win.evaluate(() => document.querySelector('#pvideo').getVideoPlaybackQuality().totalVideoFrames); assert(f2 > f1 + 5, `frames not advancing (${f1} -> ${f2})`);
    const dim = await win.evaluate(() => { const v = document.querySelector('#pvideo'); return v.videoWidth + 'x' + v.videoHeight; }); return `${dim}, ${Math.round((f2 - f1) / 1.5)} fps`;
  });
  await step('Control the phone from the PC: tap, swipe, Back, typing', async () => {
    const box = await win.evaluate(() => { const v = document.querySelector('#pvideo'), r = v.getBoundingClientRect(), sc = Math.min(r.width / v.videoWidth, r.height / v.videoHeight), w = v.videoWidth * sc, h = v.videoHeight * sc; return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h }; });
    await fp(() => { window.__fp.log.input.length = 0; });
    await win.mouse.click(box.x + box.w * 0.25, box.y + box.h * 0.75);
    await win.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.8); await win.mouse.down(); await win.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5, { steps: 6 }); await win.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.3, { steps: 6 }); await win.mouse.up();
    await win.mouse.click(box.x + box.w * 0.5, box.y + box.h * 0.5, { button: 'right' }); await win.click('.rail [data-a=home]'); await win.focus('#stage'); await win.keyboard.type('hi'); await win.keyboard.press('Enter');
    await until(() => fp(() => window.__fp.log.input.length >= 7), 6000, 'inputs'); const log = await fp(() => window.__fp.log.input);
    const tap = log.find(e => e.k === 'tap'); assert(tap && Math.abs(tap.x - 0.25) < 0.02 && Math.abs(tap.y - 0.75) < 0.02, 'tap coords ' + JSON.stringify(tap));
    const g = log.find(e => e.k === 'gesture'); assert(g && g.pts.length >= 3 && Math.abs(g.pts[0][1] - 0.8) < 0.03 && Math.abs(g.pts[g.pts.length - 1][1] - 0.3) < 0.03, 'gesture ' + JSON.stringify(g));
    assert(log.some(e => e.k === 'key' && e.a === 'back') && log.some(e => e.k === 'key' && e.a === 'home') && log.some(e => e.k === 'key' && e.a === 'enter'), 'keys missing');
    assert(log.filter(e => e.k === 'text').map(e => e.s).join('') === 'hi', 'text'); await sleep(400); await shot('08-phone-screen');
    await win.click('[data-act=screen-end]'); await win.waitForSelector('.topgrid');
  });

  await step('Phone camera on the PC: live picture, switch camera, save a photo', async () => {
    const live = async () => { await win.waitForFunction(() => { const v = document.querySelector('#pvideo'); return window.__setu.ui.screen.state === 'live' && v && v.videoWidth === 640; }, null, { timeout: 20000 });
      const f1 = await win.evaluate(() => document.querySelector('#pvideo').getVideoPlaybackQuality().totalVideoFrames); await sleep(1200); const f2 = await win.evaluate(() => document.querySelector('#pvideo').getVideoPlaybackQuality().totalVideoFrames); assert(f2 > f1 + 4, `camera frames not advancing (${f1} -> ${f2})`); };
    await win.click('[data-act=phone-cam]'); await live(); assert(await fp(() => window.__fp.log.cam) === 'back', 'back camera expected');
    await win.click('[data-act=cam-flip]'); await until(() => fp(() => window.__fp.log.cam === 'front'), 8000, 'front camera'); await live();
    await win.click('[data-act=cam-shot]'); const saved = await until(async () => { const p = await win.evaluate(() => window.__setu.ui.lastPath); return p && /Phone camera .*\.jpg$/.test(p) && fs.existsSync(p) && fs.statSync(p).size > 3000 ? p : null; }, 6000, 'saved photo');
    const before = await fp(() => window.__fp.log.input.length); await win.mouse.click(700, 400); await sleep(300); assert(await fp(() => window.__fp.log.input.length) === before, 'camera view must not send taps');
    await shot('18-phone-camera'); await win.click('[data-act=screen-end]'); await win.waitForSelector('.topgrid'); return path.basename(saved);
  });
  await step('Unlock the phone from the PC; opening a locked phone unlocks it first', async () => {
    await fp(() => window.__fp.setLocked(true)); await win.waitForSelector('[data-act=phone-unlock]:not([disabled])', { timeout: 8000 }); await win.waitForSelector('.badge:has-text("locked")'); await shot('19-phone-locked');
    await win.click('[data-act=phone-unlock]'); await until(() => fp(() => !window.__fp.locked()), 6000, 'phone to unlock'); await until(async () => !(await win.$('[data-act=phone-unlock]')), 6000, 'Unlock button to go away');
    await fp(() => window.__fp.setLocked(true)); await win.waitForSelector('[data-act=phone-unlock]:not([disabled])', { timeout: 8000 });
    await win.click('[data-act=screen]'); await win.waitForFunction(() => { const v = document.querySelector('#pvideo'); return window.__setu.ui.screen.state === 'live' && v && v.videoWidth === 360; }, null, { timeout: 20000 });
    assert(await fp(() => window.__fp.log.unlocks) === 2 && !(await fp(() => window.__fp.locked())), 'phone should have been unlocked twice');
    await win.click('[data-act=screen-end]'); await win.waitForSelector('.topgrid');
  });

  // ---------------- phone web controller (no install) controlling the PC
  let web, ctx, code2;
  await step('Web controller: pairs from the QR link served by the PC', async () => {
    await win.click('[data-act=pair]'); await win.waitForSelector('.qrimg'); const link = await win.evaluate(() => window.__setu.ui.pairing.link); code2 = link.split('#')[1];
    ctx = await browser.newContext({ viewport: { width: 780, height: 360 }, hasTouch: true, isMobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 16; vivo V60) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36' });
    web = await ctx.newPage(); web.setDefaultTimeout(12000); web.on('pageerror', e => errors.push('web: ' + e.message));
    await web.goto(`http://127.0.0.1:${PORT}/#${code2}`); await web.waitForSelector('.sub:has-text("Online")', { timeout: 15000 });
    await win.waitForSelector('.dtable:has-text("Android browser")'); await web.screenshot({ path: path.join(OUT, '09-web-home.png') });
  });
  await step('Web controller: PC screen streams to the phone, banner shows on the PC', async () => {
    await web.tap('[data-act=remote]');
    await web.waitForFunction(() => { const v = document.querySelector('#rv'); return v && v.videoWidth > 0; }, null, { timeout: 25000 });
    const f1 = await web.evaluate(() => document.querySelector('#rv').getVideoPlaybackQuality().totalVideoFrames); await sleep(1500);
    const f2 = await web.evaluate(() => document.querySelector('#rv').getVideoPlaybackQuality().totalVideoFrames); assert(f2 > f1, `frames not advancing (${f1} -> ${f2})`);
    await until(() => app.windows().length === 2, 5000, 'banner window'); assert(await win.evaluate(() => !!window.__setu.hosting()), 'not hosting');
    return await web.evaluate(() => { const v = document.querySelector('#rv'); return v.videoWidth + 'x' + v.videoHeight; });
  });
  await step('Web controller: touch-mode tap becomes a real click on the PC', async () => {
    await web.tap('.seg [data-mode=touch]');
    const target = await win.evaluate(() => { const r = document.querySelector('[data-act=nav][data-view=history]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const cb = await app.evaluate(({ BrowserWindow, screen }) => ({ b: BrowserWindow.getAllWindows().sort((a, b) => b.getBounds().height - a.getBounds().height)[0].getContentBounds(), s: screen.getPrimaryDisplay().size }));
    const nx = (cb.b.x + target.x) / cb.s.width, ny = (cb.b.y + target.y) / cb.s.height;
    const vr = await web.evaluate(() => { const v = document.querySelector('#rv'), r = v.getBoundingClientRect(), sc = Math.min(r.width / v.videoWidth, r.height / v.videoHeight), w = v.videoWidth * sc, h = v.videoHeight * sc; return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h }; });
    await web.touchscreen.tap(vr.x + nx * vr.w, vr.y + ny * vr.h);
    await until(() => win.evaluate(() => window.__setu.ui.view === 'history'), 5000, 'click to land on History'); const cur = await win.evaluate(() => window.native.cursor());
    assert(Math.abs(cur.x - (cb.b.x + target.x)) < 6 && Math.abs(cur.y - (cb.b.y + target.y)) < 6, 'cursor at ' + JSON.stringify(cur)); return `cursor landed at ${cur.x},${cur.y}`;
  });
  await step('Web controller: touchpad drag moves the pointer, typing reaches the PC', async () => {
    await web.tap('.seg [data-mode=pad]'); const c0 = await win.evaluate(() => window.native.cursor());
    const cdp = await ctx.newCDPSession(web); const T = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await T('touchStart', 300, 200); for (let i = 1; i <= 8; i++) { await T('touchMove', 300 + i * 6, 200 + i * 3); await sleep(16); } await T('touchEnd');
    const c1 = await until(async () => { const c = await win.evaluate(() => window.native.cursor()); return c.x > c0.x + 40 && c.y > c0.y + 15 ? c : null; }, 4000, 'pointer to move');
    await win.click('[data-act=nav][data-view=settings]'); await win.fill('[data-device-name]', ''); await win.focus('[data-device-name]');
    await web.focus('#kbin'); await web.keyboard.type('Sumit laptop 2', { delay: 25 });
    await until(() => win.evaluate(() => document.querySelector('[data-device-name]').value === 'Sumit laptop 2'), 6000, 'typed text'); await web.screenshot({ path: path.join(OUT, '10-web-remote.png') });
    await web.evaluate(() => window.__setuWeb.send({ k: 'tapkey', code: 'KeyA', mods: ['ctrl'] })); await web.evaluate(() => window.__setuWeb.send({ k: 'tapkey', code: 'Backspace', mods: [] }));
    await until(() => win.evaluate(() => document.querySelector('[data-device-name]').value === ''), 4000, 'Ctrl+A then Backspace');
    await win.fill('[data-device-name]', 'Study laptop'); return `pointer moved ${c1.x - c0.x}px, ${c1.y - c0.y}px`;
  });
  await step('Web controller: zoom the laptop screen (button, pinch, pan), taps stay accurate, view follows the pointer', async () => {
    const Zs = () => web.evaluate(() => ({ ...window.__setuWeb.Z })); const reset = () => web.evaluate(() => { const w = window.__setuWeb; w.Z.s = 1; w.Z.x = w.Z.y = 0; w.applyZoom(false); });
    await web.tap('#zbtn'); await until(async () => (await Zs()).s === 2, 2000, 'zoom button to give 2x'); assert((await web.textContent('#zval')) === '2×', 'zoom label');
    const cdp = await ctx.newCDPSession(web); const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    // pinch: two fingers 100 px apart moving to 200 px apart doubles the zoom
    await T('touchStart', [[340, 150]]); await T('touchStart', [[340, 150], [440, 150]]);
    for (let i = 1; i <= 10; i++) { await T('touchMove', [[340 - i * 5, 150], [440 + i * 5, 150]]); await sleep(16); } await T('touchEnd', []);
    const z1 = await Zs(); assert(z1.s > 3.6 && z1.s < 4.4, 'pinch zoom ' + JSON.stringify(z1)); await web.screenshot({ path: path.join(OUT, '17-web-zoom.png') });
    // a tap on the zoomed picture still lands on the right spot of the laptop
    await reset(); await web.tap('.seg [data-mode=touch]');
    const target = await win.evaluate(() => { const r = document.querySelector('[data-act=nav][data-view=devices]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const cb = await app.evaluate(({ BrowserWindow, screen }) => ({ b: BrowserWindow.getAllWindows().sort((a, b) => b.getBounds().height - a.getBounds().height)[0].getContentBounds(), s: screen.getPrimaryDisplay().size }));
    const nx = (cb.b.x + target.x) / cb.s.width, ny = (cb.b.y + target.y) / cb.s.height;
    const box = () => web.evaluate(() => { const v = document.querySelector('#rv'), r = v.getBoundingClientRect(), sc = Math.min(r.width / v.videoWidth, r.height / v.videoHeight), w = v.videoWidth * sc, h = v.videoHeight * sc; return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h }; });
    const b0 = await box(); await web.evaluate(([x, y]) => window.__setuWeb.zoomAt(2.5, x, y, false), [b0.x + nx * b0.w, b0.y + ny * b0.h]);
    let b1 = await box(); assert(b1.w > b0.w * 2.4, 'picture should be 2.5x larger');
    // slide the zoomed picture so the target sits mid-screen, clear of the on-screen buttons
    await web.evaluate(([dx, dy]) => { const w = window.__setuWeb; w.Z.x += dx; w.Z.y += dy; w.applyZoom(false); }, [390 - (b1.x + nx * b1.w), 170 - (b1.y + ny * b1.h)]); b1 = await box();
    const tx = b1.x + nx * b1.w, ty = b1.y + ny * b1.h; assert(tx > 0 && tx < 780 && ty > 64 && ty < 310, `target not in a clear spot ${tx},${ty}`);
    await web.touchscreen.tap(tx, ty); await until(() => win.evaluate(() => window.__setu.ui.view === 'devices'), 5000, 'zoomed tap to land on Devices').catch(async e => { const c = await win.evaluate(() => window.native.cursor()); throw new Error(`${e.message}; pointer at ${c.x},${c.y}, wanted ${Math.round(cb.b.x + target.x)},${Math.round(cb.b.y + target.y)}; tap ${Math.round(tx)},${Math.round(ty)}; box ${JSON.stringify(b1)}; view ${await win.evaluate(() => window.__setu.ui.view)}`); });
    // touchpad mode: the zoomed view follows the laptop pointer
    await web.tap('.seg [data-mode=pad]'); await reset(); await web.evaluate(() => window.__setuWeb.zoomAt(3, 0, 0, false)); assert((await Zs()).x === 0, 'should start at the left edge');
    await win.evaluate(() => window.native.inject({ k: 'abs', x: 0.95, y: 0.9 }));
    const z2 = await until(async () => { const z = await Zs(); return z.x < -1000 && z.y < -300 ? z : null; }, 4000, 'view to follow the pointer'); const cur = await web.evaluate(() => window.__setuWeb.st.cur); assert(cur && cur.x > 0.9, 'pointer position from laptop ' + JSON.stringify(cur));
    // two fingers moving together pan the zoomed picture
    await T('touchStart', [[300, 150]]); await T('touchStart', [[300, 150], [360, 150]]); for (let i = 1; i <= 10; i++) { await T('touchMove', [[300 + i * 10, 150], [360 + i * 10, 150]]); await sleep(16); } await T('touchEnd', []);
    const z3 = await Zs(); assert(z3.x > z2.x + 60 && Math.abs(z3.s - 3) < 0.01, 'two-finger pan ' + JSON.stringify([z2, z3]));
    await web.tap('#zbtn'); await until(async () => (await Zs()).s === 1, 2000, 'zoom button to reset'); return `pinch ${z1.s.toFixed(1)}x, follow to x=${Math.round(z2.x)}`;
  });
  await step('Stop button on the PC banner ends the session at once', async () => {
    const banner = app.windows().find(w => w !== win); await banner.waitForSelector('#stop'); await banner.screenshot({ path: path.join(OUT, '11-banner.png') }); await shot('12-desktop-during-control');
    await banner.click('#stop'); await until(() => win.evaluate(() => !window.__setu.hosting()), 4000, 'hosting to stop');
    await web.waitForSelector('[data-act=remote]', { timeout: 6000 }); await until(() => app.windows().length === 1, 4000, 'banner to close');
    const before = await win.evaluate(() => window.native.cursor()); await web.evaluate(() => window.__setuWeb.send({ k: 'abs', x: 0.9, y: 0.9 })); await sleep(500); const after = await win.evaluate(() => window.native.cursor());
    assert(before.x === after.x && before.y === after.y, 'input still accepted after Stop');
  });
  await step('Web controller: laptop camera streams to the phone, with a notice on the PC', async () => {
    await web.tap('[data-act=camera]'); await web.waitForFunction(() => { const v = document.querySelector('#rv'); return v && v.videoWidth > 0 && !document.querySelector('.wait'); }, null, { timeout: 25000 });
    const f1 = await web.evaluate(() => document.querySelector('#rv').getVideoPlaybackQuality().totalVideoFrames); await sleep(1500); const f2 = await web.evaluate(() => document.querySelector('#rv').getVideoPlaybackQuality().totalVideoFrames); assert(f2 > f1 + 5, `camera frames not advancing (${f1} -> ${f2})`);
    assert(await win.evaluate(() => window.__setu.hosting() && window.__setu.hosting().kind) === 'camera', 'PC should be sharing its camera'); assert(!(await web.$('.keybar')), 'no keyboard row in camera view');
    await until(() => app.windows().length === 2, 5000, 'notice window'); const note = await app.windows().find(w => w !== win).textContent('#t'); assert(/camera/.test(note), 'notice text: ' + note);
    await web.screenshot({ path: path.join(OUT, '20-web-laptop-camera.png') }); const dim = await web.evaluate(() => { const v = document.querySelector('#rv'); return v.videoWidth + 'x' + v.videoHeight; });
    await web.tap('[data-act=leave]'); await until(() => win.evaluate(() => !window.__setu.hosting()), 5000, 'camera to stop'); await web.waitForSelector('[data-act=remote]'); return dim;
  });
  await step('Web controller: lock the laptop, then unlock it from the phone', async () => {
    await web.tap('[data-act=lock]'); await until(() => win.evaluate(() => window.__setu.ui.power.locked), 4000, 'PC to lock'); await web.waitForSelector('.sub:has-text("locked")', { timeout: 6000 });
    await web.waitForSelector('.note:has-text("Unlock from phone")'); assert(!(await web.$('[data-act=unlock]')), 'no Unlock button before it is set up');
    await win.click('[data-act=nav][data-view=settings]'); await win.fill('#unlockSecret', '4321'); await win.click('[data-act=unlock-save]'); await until(() => win.evaluate(() => window.__setu.ui.unlock.cred), 4000, 'PIN saved'); await shot('21-settings-unlock');
    await web.waitForSelector('[data-act=unlock]', { timeout: 6000 }); await web.screenshot({ path: path.join(OUT, '22-web-locked.png') });
    await web.tap('[data-act=unlock]'); await until(() => win.evaluate(() => !window.__setu.ui.power.locked), 5000, 'PC to unlock'); await until(async () => !(await web.$('.sub:has-text("locked")')), 6000, 'phone to show unlocked');
    // "Control laptop" on a locked laptop unlocks it first
    await web.tap('[data-act=lock]'); await web.waitForSelector('[data-act=unlock]', { timeout: 6000 }); await web.tap('[data-act=remote]');
    await web.waitForFunction(() => { const v = document.querySelector('#rv'); return v && v.videoWidth > 0 && !document.querySelector('.wait'); }, null, { timeout: 25000 }); assert(!(await win.evaluate(() => window.__setu.ui.power.locked)), 'PC should be unlocked');
    await web.tap('[data-act=leave]'); await until(() => win.evaluate(() => !window.__setu.hosting()), 5000, 'hosting to stop'); await web.waitForSelector('[data-act=remote]');
  });
  await step('Web controller: send a file and text to the PC, browse laptop files', async () => {
    const f = path.join(data, 'from-browser.pdf'); fs.writeFileSync(f, crypto.randomBytes(1500000));
    await web.setInputFiles('#pick', f); await until(() => fs.existsSync(path.join(dl, 'from-browser.pdf')), 20000, 'browser upload'); assert(sha(path.join(dl, 'from-browser.pdf')) === sha(f), 'hash mismatch');
    await web.tap('[data-act=nav][data-view=text]'); await web.fill('textarea[name=t]', 'Flat 12, Shivaji Nagar'); await web.tap('form button'); await until(() => win.evaluate(async () => (await window.native.clipGet()) === 'Flat 12, Shivaji Nagar'), 5000, 'clipboard');
    await web.waitForSelector('[data-act=files]'); await web.tap('[data-act=files]'); await web.waitForSelector('.frow:has-text("Downloads")'); await web.screenshot({ path: path.join(OUT, '13-web-files.png') });
  });
  await step("Android app's built-in controller: opens straight into laptop control, returns to the app on End", async () => {
    const emb = await ctx.newPage(); emb.setDefaultTimeout(12000); emb.on('pageerror', e => errors.push('embedded: ' + e.message));
    await emb.addInitScript(() => { window.SetuHost = { close() { window.__closed = true; } }; });
    await emb.goto(`http://127.0.0.1:${PORT}/#${code2}&id=5550001117&name=${encodeURIComponent('vivo V60')}&embed=1&auto=1`);
    await emb.waitForFunction(() => { const v = document.querySelector('#rv'); return v && v.videoWidth > 0; }, null, { timeout: 30000 });
    await until(() => win.evaluate(() => { const h = window.__setu.hosting(); return !!h; }), 5000, 'hosting');
    await emb.screenshot({ path: path.join(OUT, '16-app-embedded-control.png') });
    await emb.tap('[data-act=leave]'); await emb.waitForFunction(() => window.__closed === true, null, { timeout: 5000 });
    await until(() => win.evaluate(() => !window.__setu.hosting()), 6000, 'hosting to stop'); await emb.close();
  });
  await step('Connection modes change which relays the PC uses', async () => {
    await win.click('[data-act=nav][data-view=settings]');
    const relays = () => win.evaluate(() => { const r = window.__setu.rooms; const first = r && [...r.values()][0]; return first ? first.relays.map(x => x.kind).sort() : []; });
    await win.click('[data-act=set-mode][data-mode=wifi]'); await sleep(400);
    assert(JSON.stringify(await relays()) === JSON.stringify(['lan']), 'same-Wi-Fi mode should drop the cloud relay');
    await win.click('[data-act=set-mode][data-mode=internet]'); await sleep(400);
    assert(JSON.stringify(await relays()) === JSON.stringify(['cloud']), 'internet mode should drop the LAN relay');
    await win.click('[data-act=set-mode][data-mode=auto]'); await sleep(400);
    assert(JSON.stringify(await relays()) === JSON.stringify(['cloud', 'lan']), 'automatic should use both');
    await shot('23-connection-modes');
  });
  await step('History records sessions and transfers', async () => {
    await win.click('[data-act=nav][data-view=history]'); await win.waitForSelector('.sitem'); const t = await win.textContent('#main');
    for (const s of ['Paired with Test Phone', 'Copied IMG_2041.jpg', 'Sent Marketing case deck.pptx', 'Imported 15 photos', 'controlled this PC', 'Received from-browser.pdf']) assert(t.includes(s), 'history missing: ' + s); await shot('14-history');
    await win.click('[data-act=nav][data-view=settings]'); await win.waitForSelector('.sset'); await shot('15-settings');
  });
  await step('Phone goes offline and comes back: PC notices both', async () => {
    await win.click('[data-act=nav][data-view=devices]'); await phone.close();
    await win.waitForSelector('.topgrid .badge:has-text("Offline")', { timeout: 40000 }); await openPhone(); await win.waitForSelector('.topgrid .badge:has-text("Online")', { timeout: 20000 });
    await win.click('[data-act=nav][data-view=files]'); await win.waitForSelector('.places span', { timeout: 20000 });
  });
  await step('Restart: pairings and settings survive, phone reconnects without re-pairing', async () => {
    await app.close();
    const app2 = await _electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, SETU_DATA: data, SETU_PORT: String(PORT), SETU_NO_TRAY: '1', SETU_FAKE_UNLOCK: '1' } });
    const w2 = await app2.firstWindow(); await w2.waitForSelector('.brand'); await sleep(14000); console.log('RESTART', JSON.stringify(await w2.evaluate(() => ({ port: window.__setu.state().port, pair: window.__setu.state().store.pairings.length, peers: window.__setu.allPeers().map(p => [p.name, p.role, p.online]), relays: [...window.__setu.rooms.values()].map(r => r.relays.map(x => x.state)) })))); await w2.waitForSelector('.glance', { timeout: 20000 }); assert(/Test Phone/.test(await w2.textContent('.topgrid')), 'phone not back'); await app2.close();
  });
  await step('No JavaScript errors in the app, the simulated phone or the web controller', async () => { const real = errors.filter(e => !/supabase|ERR_TUNNEL|net::ERR/.test(e)); assert(!real.length, real.slice(0, 3).join(' | ')); });

  await browser.close().catch(() => {});
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ when: new Date().toISOString(), passed: results.filter(r => r.ok).length, failed, results }, null, 1));
  console.log(`\n${results.filter(r => r.ok).length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('RUNNER CRASHED', e); process.exit(2); });

const { _electron } = require('playwright-core'); const fs = require('fs'); const os = require('os'); const path = require('path');
(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'setu-'));
  const app = await _electron.launch({ args: ['.', '--no-sandbox'], cwd: path.join(__dirname, '..'), env: { ...process.env, SETU_DATA: data, SETU_PORT: '47901', SETU_NO_TRAY: '1' } });
  app.process().stderr.on('data', d => process.stderr.write('[main] ' + d));
  const win = await app.firstWindow(); win.on('console', m => console.log('[page]', m.type(), m.text())); win.on('pageerror', e => console.log('[pageerror]', e.message));
  await win.waitForSelector('.brand'); await win.waitForTimeout(800);
  console.log('title:', await win.title(), '| state port:', await win.evaluate(() => window.__setu.state().port), '| inject:', JSON.stringify(await win.evaluate(() => window.native.injectStatus())));
  await win.screenshot({ path: '/tmp/smoke1.png' });
  await win.click('[data-act=pair]'); await win.waitForSelector('.qrimg'); await win.waitForTimeout(300);
  await win.screenshot({ path: '/tmp/smoke2.png' });
  console.log('code len', (await win.evaluate(() => window.__setu.ui.pairing.code)).length);
  await app.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });

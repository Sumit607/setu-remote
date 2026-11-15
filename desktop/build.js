// Bundles the PC app UI and the phone web controller into dist/.
const esbuild = require('esbuild'); const fs = require('fs'); const path = require('path');
const icons = fs.readFileSync(path.join(__dirname, 'src/ui/icons.html'), 'utf8');
const cp = (a, b) => { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(a, b); };
async function main() {
  for (const [entry, out, html, css] of [['src/ui/app.js', 'dist/app', 'src/ui/index.html', 'src/ui/app.css'], ['src/web/web.js', 'dist/web', 'src/web/index.html', 'src/web/web.css']]) {
    fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
    await esbuild.build({ entryPoints: [entry], bundle: true, format: 'iife', target: 'chrome110', minify: process.argv.includes('--min'), outfile: path.join(out, path.basename(entry)), logLevel: 'warning' });
    fs.writeFileSync(path.join(out, 'index.html'), fs.readFileSync(html, 'utf8').replace('<!--ICONS-->', icons));
    cp(css, path.join(out, path.basename(css)));
    for (const f of fs.readdirSync('assets/fonts')) cp(path.join('assets/fonts', f), path.join(out, 'fonts', f));
  }
  if (process.argv.includes('--test')) {
    await esbuild.build({ entryPoints: ['test/fakephone.js'], bundle: true, format: 'iife', target: 'chrome110', outfile: 'dist/test/fakephone.js', logLevel: 'warning' });
    fs.writeFileSync('dist/test/fakephone.html', '<!DOCTYPE html><meta charset="utf-8"><title>Fake phone</title><body><script src="fakephone.js"></script>');
  }
  console.log('built dist/app and dist/web');
}
main().catch(e => { console.error(e); process.exit(1); });

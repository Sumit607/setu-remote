// Writes release/latest.yml (what the installed app reads to find a newer version) if electron-builder did not.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const dir = path.join(__dirname, '..', 'release'), exe = 'SetuRemote-Setup.exe', out = path.join(dir, 'latest.yml');
const { version } = require('../package.json');
if (!fs.existsSync(path.join(dir, exe))) { console.error('missing ' + exe); process.exit(1); }
if (fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes(`version: ${version}`)) { console.log('latest.yml already written by electron-builder'); process.exit(0); }
const buf = fs.readFileSync(path.join(dir, exe)), sha512 = crypto.createHash('sha512').update(buf).digest('base64');
fs.writeFileSync(out, `version: ${version}\nfiles:\n  - url: ${exe}\n    sha512: ${sha512}\n    size: ${buf.length}\npath: ${exe}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`);
console.log('wrote latest.yml for', version);

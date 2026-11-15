// Checks that the JS envelope format matches the javax.crypto format the Android app uses.
import { deriveKeys, seal, unseal, newSecret } from '../src/core/core.js';
import { execFileSync } from 'node:child_process';
const secret = newSecret(), k = deriveKeys(secret), msg = { t: 'hello', name: 'नमस्ते Setu ✓', n: 42 };
const env = seal(k, msg);
const out = execFileSync('java', ['-Dstdout.encoding=UTF-8', '-Dfile.encoding=UTF-8', '-Dsun.jnu.encoding=UTF-8', '-cp', '/tmp/interop', 'Interop', secret, 'open', env.n, env.c]).toString().trim();
if (out !== k.room + ' ' + JSON.stringify(msg)) throw new Error('Java could not open JS envelope: ' + out);
const [n, c] = execFileSync('java', ['-Dstdout.encoding=UTF-8', '-Dfile.encoding=UTF-8', '-Dsun.jnu.encoding=UTF-8', '-cp', '/tmp/interop', 'Interop', secret, 'seal', JSON.stringify(msg)]).toString().trim().split(' ');
const back = unseal(k, { n, c }); if (JSON.stringify(back) !== JSON.stringify(msg)) throw new Error('JS could not open Java envelope');
console.log('interop OK: JS <-> javax.crypto AES-256-GCM, room id matches');

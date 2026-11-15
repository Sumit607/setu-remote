// Turns input events from a controlling phone into real mouse and keyboard input.
// Windows: user32 SendInput. Linux (used by the automated tests): XTest.
// Loaded on first use, so a problem with the native module disables remote input instead of stopping the whole app.
let koffi = null;

const VK = {
  Enter: 0x0d, Escape: 0x1b, Backspace: 0x08, Tab: 0x09, Space: 0x20, ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Delete: 0x2e, Insert: 0x2d, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, ShiftLeft: 0x10, ShiftRight: 0x10, ControlLeft: 0x11, ControlRight: 0x11,
  AltLeft: 0x12, AltRight: 0x12, MetaLeft: 0x5b, MetaRight: 0x5b, CapsLock: 0x14, Minus: 0xbd, Equal: 0xbb, BracketLeft: 0xdb, BracketRight: 0xdd,
  Backslash: 0xdc, Semicolon: 0xba, Quote: 0xde, Comma: 0xbc, Period: 0xbe, Slash: 0xbf, Backquote: 0xc0, PrintScreen: 0x2c,
  AudioVolumeUp: 0xaf, AudioVolumeDown: 0xae, AudioVolumeMute: 0xad,
};
const KS = {
  Enter: 0xff0d, Escape: 0xff1b, Backspace: 0xff08, Tab: 0xff09, Space: 0x20, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
  Delete: 0xffff, Insert: 0xff63, Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56, ShiftLeft: 0xffe1, ShiftRight: 0xffe2, ControlLeft: 0xffe3,
  ControlRight: 0xffe4, AltLeft: 0xffe9, AltRight: 0xffea, MetaLeft: 0xffeb, MetaRight: 0xffec, Minus: 0x2d, Equal: 0x3d, BracketLeft: 0x5b, BracketRight: 0x5d,
  Backslash: 0x5c, Semicolon: 0x3b, Quote: 0x27, Comma: 0x2c, Period: 0x2e, Slash: 0x2f, Backquote: 0x60,
};
const EXTENDED = new Set(['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'MetaLeft', 'MetaRight', 'ControlRight', 'AltRight']);
const MODS = { ctrl: 'ControlLeft', alt: 'AltLeft', shift: 'ShiftLeft', win: 'MetaLeft' };
function codeTo(table, code, letterBase, digitBase, fBase) {
  if (table[code] != null) return table[code];
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return letterBase + m[1].charCodeAt(0) - 65;
  if ((m = /^Digit(\d)$/.exec(code))) return digitBase + Number(m[1]);
  if ((m = /^F(\d{1,2})$/.exec(code))) return fBase + Number(m[1]) - 1;
  return null;
}

function winBackend() {
  const user32 = koffi.load('user32.dll');
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', { dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }) });
  const SendInput = user32.func('unsigned int __stdcall SendInput(unsigned int cInputs, INPUT *pInputs, int cbSize)');
  const size = koffi.sizeof(INPUT);
  const send = evs => { if (evs.length) SendInput(evs.length, evs, size); };
  const mouse = (flags, dx = 0, dy = 0, data = 0) => ({ type: 0, u: { mi: { dx, dy, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
  const key = (vk, scan, flags) => ({ type: 1, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
  const DOWN = [0x0002, 0x0008, 0x0020], UP = [0x0004, 0x0010, 0x0040];
  return {
    move: (dx, dy) => send([mouse(0x0001, Math.round(dx), Math.round(dy))]),
    abs: (x, y) => send([mouse(0x0001 | 0x8000, Math.round(x * 65535), Math.round(y * 65535))]),
    btn: (b, down) => send([mouse((down ? DOWN : UP)[b] || DOWN[0])]),
    wheel: (dx, dy) => {
      if (dy) send([mouse(0x0800, 0, 0, Math.round(-dy * 120))]);
      if (dx) send([mouse(0x1000, 0, 0, Math.round(dx * 120))]);
    },
    key: (code, down) => {
      const vk = codeTo(VK, code, 0x41, 0x30, 0x70); if (vk == null) return;
      send([key(vk, 0, (down ? 0 : 0x0002) | (EXTENDED.has(code) ? 0x0001 : 0))]);
    },
    text: s => { const evs = []; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c === 10) { evs.push(key(0x0d, 0, 0), key(0x0d, 0, 2)); continue; } evs.push(key(0, c, 0x0004), key(0, c, 0x0004 | 0x0002)); } send(evs); },
  };
}

function x11Backend() {
  const x11 = koffi.load('libX11.so.6'), xtst = koffi.load('libXtst.so.6');
  const XOpenDisplay = x11.func('void *XOpenDisplay(const char *name)');
  const XFlush = x11.func('int XFlush(void *dpy)');
  const XKeysymToKeycode = x11.func('uint8_t XKeysymToKeycode(void *dpy, unsigned long keysym)');
  const XDisplayWidth = x11.func('int XDisplayWidth(void *dpy, int screen)');
  const XDisplayHeight = x11.func('int XDisplayHeight(void *dpy, int screen)');
  const Motion = xtst.func('int XTestFakeMotionEvent(void *dpy, int screen, int x, int y, unsigned long delay)');
  const RelMotion = xtst.func('int XTestFakeRelativeMotionEvent(void *dpy, int dx, int dy, unsigned long delay)');
  const Button = xtst.func('int XTestFakeButtonEvent(void *dpy, unsigned int button, int is_press, unsigned long delay)');
  const Key = xtst.func('int XTestFakeKeyEvent(void *dpy, unsigned int keycode, int is_press, unsigned long delay)');
  const dpy = XOpenDisplay(null);
  if (!dpy) throw new Error('No X display');
  const W = XDisplayWidth(dpy, 0), H = XDisplayHeight(dpy, 0), BTN = [1, 3, 2];
  const keysym = (ks, down) => { const kc = XKeysymToKeycode(dpy, ks); if (kc) Key(dpy, kc, down ? 1 : 0, 0); };
  const SHIFTED = '~!@#$%^&*()_+{}|:"<>?';
  return {
    move: (dx, dy) => { RelMotion(dpy, Math.round(dx), Math.round(dy), 0); XFlush(dpy); },
    abs: (x, y) => { Motion(dpy, 0, Math.round(x * (W - 1)), Math.round(y * (H - 1)), 0); XFlush(dpy); },
    btn: (b, down) => { Button(dpy, BTN[b] || 1, down ? 1 : 0, 0); XFlush(dpy); },
    wheel: (dx, dy) => { const n = Math.max(1, Math.round(Math.abs(dy || dx))); const b = dy ? (dy > 0 ? 5 : 4) : (dx > 0 ? 7 : 6); for (let i = 0; i < n; i++) { Button(dpy, b, 1, 0); Button(dpy, b, 0, 0); } XFlush(dpy); },
    key: (code, down) => { const ks = codeTo(KS, code, 0x61, 0x30, 0xffbe); if (ks != null) { keysym(ks, down); XFlush(dpy); } },
    text: s => {
      for (const ch of s) {
        const c = ch.charCodeAt(0); if (ch === '\n') { keysym(0xff0d, true); keysym(0xff0d, false); continue; }
        if (c < 0x20 || c > 0x7e) continue;
        const shift = (ch >= 'A' && ch <= 'Z') || SHIFTED.includes(ch);
        if (shift) keysym(0xffe1, true);
        keysym(c, true); keysym(c, false);
        if (shift) keysym(0xffe1, false);
      }
      XFlush(dpy);
    },
  };
}

let backend = null, failed = null;
function get() {
  if (backend || failed) return backend;
  try { koffi = require('koffi'); backend = process.platform === 'win32' ? winBackend() : process.platform === 'linux' ? x11Backend() : null; if (!backend) failed = 'unsupported platform'; }
  catch (e) { failed = String(e.message || e); console.error('[setu] input backend failed:', failed); }
  return backend;
}

function inject(ev) {
  const b = get(); if (!b || !ev) return false;
  const num = v => (Number.isFinite(+v) ? +v : 0), clamp01 = v => Math.min(1, Math.max(0, num(v)));
  switch (ev.k) {
    case 'move': b.move(num(ev.dx), num(ev.dy)); break;
    case 'abs': b.abs(clamp01(ev.x), clamp01(ev.y)); break;
    case 'btn': b.btn(ev.b | 0, !!ev.down); break;
    case 'click': for (let i = 0; i < Math.min(3, ev.n || 1); i++) { b.btn(ev.b | 0, true); b.btn(ev.b | 0, false); } break;
    case 'wheel': b.wheel(num(ev.dx), num(ev.dy)); break;
    case 'key': b.key(String(ev.code), !!ev.down); break;
    case 'tapkey': {
      const mods = (ev.mods || []).map(m => MODS[m]).filter(Boolean);
      mods.forEach(m => b.key(m, true)); b.key(String(ev.code), true); b.key(String(ev.code), false); mods.reverse().forEach(m => b.key(m, false));
      break;
    }
    case 'text': b.text(String(ev.s || '').slice(0, 2000)); break;
    default: return false;
  }
  return true;
}
module.exports = { inject, status: () => ({ ok: !!get(), error: failed }) };

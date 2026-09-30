'use strict';
// 5dive browser — a small X11 client for the INPUT drive mode (DIVE-5287).
//
// WHAT IT IS FOR. Some sites refuse to render for a browser that is under
// automation control (tiktok.com, measured 2026-09-30: blank /foryou through the
// session daemon's Playwright launch, fine in plain Chrome on the same box and
// IP). In input mode the site is served as PLAIN Chrome — no CDP, no
// --remote-debugging-*, no --enable-automation — and the agent acts on it the
// way the person at the viewer does: through the X display it is drawn on.
//
// It does three things and nothing else:
//   1. SCREENSHOT the display (GetImage on the root window -> PNG).
//   2. INPUT through the XTEST extension — pointer moves, clicks, scroll
//      notches, key presses. XTEST events enter the X server exactly where a
//      physical keyboard's do, so Chrome delivers them to the page as
//      isTrusted=true events. There is no synthetic DOM event anywhere on this
//      path, and nothing on the page can tell it from the person's own input.
//   3. READ THE WINDOW TITLE (WM_NAME / _NET_WM_NAME), which is the page title
//      Chrome publishes to the window system. It is the one piece of page state
//      that is readable with no channel into the browser at all.
//
// WHY NOT xdotool / ImageMagick. They would be two more packages a box has to
// carry and `setup` has to install, for a protocol this small. The X11 wire
// protocol is stable since 1987; the requests used here are six core ones plus
// one extension request. Node's `net` and `zlib` are the whole dependency list.
//
// WHY NOT A CHROME EXTENSION FOR READING (main's 15:15Z design). Branded Google
// Chrome ignores --load-extension since 137 (measured on this box's Chrome 153:
// the flag, and the DisableLoadExtensionCommandLineSwitch escape hatch, both
// load nothing). The remaining installs are box-wide enterprise policy or a
// person clicking "Load unpacked" once. See CHANGES.md for the alternatives.
//
// The display is a UNIX SOCKET only (serve starts Xvfb with -nolisten tcp), so
// this client connects to /tmp/.X11-unix/X<n> and nothing else.

const net = require('net');
const zlib = require('zlib');
const path = require('path');

const X11_DIR = process.env.FIVEDIVE_BROWSER_X11_DIR || '/tmp/.X11-unix';

// Core request opcodes used here.
const OP = {
  GetWindowAttributes: 3, QueryTree: 15, InternAtom: 16, GetProperty: 20,
  QueryPointer: 38, SetInputFocus: 42, GetInputFocus: 43, GetImage: 73, QueryExtension: 98,
  ChangeKeyboardMapping: 100, GetKeyboardMapping: 101,
};
// XTEST FakeInput event types.
const EV = { KeyPress: 2, KeyRelease: 3, ButtonPress: 4, ButtonRelease: 5, Motion: 6 };

const pad4 = (n) => (4 - (n % 4)) % 4;

function displaySocket(display) {
  const m = String(display || '').match(/^:?(\d+)(?:\.\d+)?$/);
  if (!m) throw new Error(`not a local X display: '${display}'`);
  return path.join(X11_DIR, `X${m[1]}`);
}

class X11 {
  constructor(sock) {
    this.sockPath = sock;
    this.seq = 0;
    this.pending = new Map();     // seq -> {resolve, reject}
    this.voidErrors = [];         // errors on requests that have no reply
    this.buf = Buffer.alloc(0);
    this.setup = null;
    this.atoms = new Map();
    this.keymap = null;
    this.scratch = new Map();     // keysym -> keycode we bound for it
  }

  connect() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(this.sockPath);
      this.s = s;
      let setupDone = false;
      s.on('error', (e) => {
        if (!setupDone) reject(new Error(`cannot reach the X display at ${this.sockPath}: ${e.message}`));
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
      });
      s.on('close', () => {
        const e = new Error('the X display closed the connection');
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
        this.closed = true;
      });
      s.on('data', (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        if (!setupDone) {
          if (this.buf.length < 8) return;
          const extra = this.buf.readUInt16LE(6) * 4;
          if (this.buf.length < 8 + extra) return;
          const status = this.buf[0];
          const block = this.buf.subarray(0, 8 + extra);
          this.buf = this.buf.subarray(8 + extra);
          setupDone = true;
          if (status !== 1) {
            const reason = block.subarray(8, 8 + block[1]).toString('latin1');
            return reject(new Error(`the X display refused the connection: ${reason || `status ${status}`}`));
          }
          try { this.setup = parseSetup(block); } catch (e) { return reject(e); }
          resolve(this);
        }
        this.drain();
      });
      // Little-endian, protocol 11.0, no authorization: serve's Xvfb is started
      // without -auth, so the socket's file mode is the access control.
      const hello = Buffer.alloc(12);
      hello[0] = 0x6c; hello.writeUInt16LE(11, 2); hello.writeUInt16LE(0, 4);
      s.write(hello);
    });
  }

  drain() {
    while (this.buf.length >= 32) {
      const kind = this.buf[0];
      let len = 32;
      if (kind === 1) len = 32 + this.buf.readUInt32LE(4) * 4;
      else if (kind === 35) len = 32 + this.buf.readUInt32LE(4) * 4;  // GenericEvent
      if (this.buf.length < len) return;
      const msg = this.buf.subarray(0, len);
      this.buf = this.buf.subarray(len);
      if (kind === 1 || kind === 0) {
        const seq = msg.readUInt16LE(2);
        const p = this.pending.get(seq);
        if (kind === 0) {
          const err = new Error(`X error ${msg[1]} (request ${msg[10]}.${msg.readUInt16LE(8)})`);
          if (p) { this.pending.delete(seq); p.reject(err); } else this.voidErrors.push(err);
        } else if (p) { this.pending.delete(seq); p.resolve(msg); }
      }
      // Events (MappingNotify after a keymap change, among others) are not
      // selected for and carry nothing this client needs.
    }
  }

  // Send a request. `reply` true -> resolves with the reply buffer.
  req(opcode, data, body, reply) {
    const b = body || Buffer.alloc(0);
    const total = 4 + b.length + pad4(b.length);
    const h = Buffer.alloc(total);
    h[0] = opcode; h[1] = data || 0; h.writeUInt16LE(total / 4, 2);
    b.copy(h, 4);
    this.seq = (this.seq + 1) & 0xffff;
    const seq = this.seq;
    const p = reply ? new Promise((resolve, reject) => this.pending.set(seq, { resolve, reject })) : null;
    this.s.write(h);
    return p;
  }

  // A round trip. Every void request before it has been processed when this
  // resolves, and an error any of them raised is thrown here, not lost.
  async sync() {
    await this.req(OP.GetInputFocus, 0, null, true);
    if (this.voidErrors.length) { const e = this.voidErrors[0]; this.voidErrors = []; throw e; }
  }

  close() { try { this.s.end(); } catch (e) { /* going anyway */ } }

  get root() { return this.setup.screen.root; }
  get width() { return this.setup.screen.width; }
  get height() { return this.setup.screen.height; }

  async atom(name) {
    if (this.atoms.has(name)) return this.atoms.get(name);
    const n = Buffer.from(name, 'latin1');
    const body = Buffer.alloc(4 + n.length + pad4(n.length));
    body.writeUInt16LE(n.length, 0); n.copy(body, 4);
    const r = await this.req(OP.InternAtom, 0, body, true);
    const a = r.readUInt32LE(8);
    this.atoms.set(name, a);
    return a;
  }

  async xtest() {
    if (this.xtestOp) return this.xtestOp;
    const n = Buffer.from('XTEST', 'latin1');
    const body = Buffer.alloc(4 + n.length + pad4(n.length));
    body.writeUInt16LE(n.length, 0); n.copy(body, 4);
    const r = await this.req(OP.QueryExtension, 0, body, true);
    if (!r[8]) throw new Error('this X display has no XTEST extension, so no input can be sent to it');
    this.xtestOp = r[9];
    return this.xtestOp;
  }

  async fake(type, detail, x, y) {
    const op = await this.xtest();
    const b = Buffer.alloc(32);
    b[0] = type; b[1] = detail || 0;
    b.writeUInt32LE(0, 4);                       // time: CurrentTime
    b.writeUInt32LE(type === EV.Motion ? this.root : 0, 8);
    b.writeInt16LE(x || 0, 20); b.writeInt16LE(y || 0, 22);
    this.req(op, 2, b, false);                   // XTestFakeInput
  }

  // ---- reading ------------------------------------------------------------
  async screenshotPNG() {
    const { width: w, height: h } = this;
    const body = Buffer.alloc(16);
    body.writeUInt32LE(this.root, 0);
    body.writeInt16LE(0, 4); body.writeInt16LE(0, 6);
    body.writeUInt16LE(w, 8); body.writeUInt16LE(h, 10);
    body.writeUInt32LE(0xffffffff, 12);
    const r = await this.req(OP.GetImage, 2 /* ZPixmap */, body, true);
    const data = r.subarray(32);
    const bpp = this.setup.bppOf(r[1]) || 32;
    return encodePNG(data, w, h, bpp, this.setup.imageByteOrder);
  }

  async pointer() {
    const b = Buffer.alloc(4); b.writeUInt32LE(this.root, 0);
    const r = await this.req(OP.QueryPointer, 0, b, true);
    return { x: r.readInt16LE(16), y: r.readInt16LE(18) };
  }

  async children(win) {
    const b = Buffer.alloc(4); b.writeUInt32LE(win, 0);
    const r = await this.req(OP.QueryTree, 0, b, true);
    const n = r.readUInt16LE(16), out = [];
    for (let i = 0; i < n; i++) out.push(r.readUInt32LE(32 + i * 4));
    return out;
  }

  async viewable(win) {
    const b = Buffer.alloc(4); b.writeUInt32LE(win, 0);
    try { const r = await this.req(OP.GetWindowAttributes, 0, b, true); return r[26] === 2; }
    catch (e) { return false; }   // gone between QueryTree and here
  }

  async prop(win, name, type) {
    const b = Buffer.alloc(20);
    b.writeUInt32LE(win, 0);
    b.writeUInt32LE(await this.atom(name), 4);
    b.writeUInt32LE(type ? await this.atom(type) : 0, 8);
    b.writeUInt32LE(0, 12); b.writeUInt32LE(1024, 16);
    let r;
    try { r = await this.req(OP.GetProperty, 0, b, true); } catch (e) { return ''; }
    const fmt = r[1], n = r.readUInt32LE(16);
    if (fmt !== 8 || !n) return '';
    return r.subarray(32, 32 + n).toString(type === 'UTF8_STRING' ? 'utf8' : 'latin1');
  }

  // The title of the browser window on this display: the largest viewable
  // top-level window that has a name. Chrome's is "<page title> - Google Chrome".
  async windowTitle() {
    let best = null;
    for (const w of await this.children(this.root)) {
      if (!(await this.viewable(w))) continue;
      const t = (await this.prop(w, '_NET_WM_NAME', 'UTF8_STRING')) || (await this.prop(w, 'WM_NAME', 'STRING'));
      if (!t) continue;
      const score = /(Google Chrome|Chromium)$/.test(t) ? 2 : 1;
      if (!best || score > best.score) best = { t, score, id: w };
    }
    if (!best) return { window: '', page: '', id: 0 };
    return { window: best.t, page: best.t.replace(/ [-–—] (Google Chrome|Chromium)(?: [^-–—]*)?$/, ''), id: best.id };
  }

  // ---- whose window is it -------------------------------------------------
  // WHY THIS EXISTS (DIVE-5287, quinn's rejection). XTEST input is delivered by
  // the X server to whichever window has the keyboard focus (keys) or is under
  // the pointer (buttons). Neither is Chrome's just because Chrome's window is
  // up: with no window manager, Chrome only makes itself active when the
  // pointer CROSSES into it, and a window mapped under a pointer that is
  // already there gets no crossing. Keys sent then are dropped with no error
  // anywhere. So the daemon checks, and makes true, the two facts input needs.

  async parent(win) {
    const b = Buffer.alloc(4); b.writeUInt32LE(win, 0);
    const r = await this.req(OP.QueryTree, 0, b, true);
    return r.readUInt32LE(12);
  }

  async prop32(win, name) {
    const b = Buffer.alloc(20);
    b.writeUInt32LE(win, 0); b.writeUInt32LE(await this.atom(name), 4);
    b.writeUInt32LE(0, 8); b.writeUInt32LE(0, 12); b.writeUInt32LE(1, 16);
    let r;
    try { r = await this.req(OP.GetProperty, 0, b, true); } catch (e) { return null; }
    return r[1] === 32 && r.readUInt32LE(16) ? r.readUInt32LE(32) : null;
  }

  // Chrome's own windows: _NET_WM_PID is the browser process, or (a wrapper
  // that did not exec, a browser that did not set the pid) WM_CLASS names it.
  async isBrowserWindow(win, pid) {
    if (!win || win === this.root) return false;
    if (pid && (await this.prop32(win, '_NET_WM_PID')) === pid) return true;
    return /chrom/i.test(await this.prop(win, 'WM_CLASS', 'STRING'));
  }

  // The window and its ancestors up to (not including) the root: with a window
  // manager the browser's window sits inside a frame, and the frame is not it.
  async lineage(win) {
    const out = [];
    for (let w = win, i = 0; w && w !== this.root && i < 16; i++) {
      out.push(w);
      try { w = await this.parent(w); } catch (e) { break; }
    }
    return out;
  }

  // The stack of windows under the pointer, outermost first.
  async underPointer() {
    const out = [];
    let w = this.root;
    for (let i = 0; i < 16; i++) {
      const b = Buffer.alloc(4); b.writeUInt32LE(w, 0);
      let r;
      try { r = await this.req(OP.QueryPointer, 0, b, true); } catch (e) { break; }
      const child = r.readUInt32LE(12);
      if (!child) break;
      out.push(child); w = child;
    }
    return out;
  }

  async anyBrowser(wins, pid) {
    for (const w of wins) if (await this.isBrowserWindow(w, pid)) return w;
    return 0;
  }

  // Where the keyboard goes: { focus, browser } — `focus` is the raw focus
  // window (0 None, 1 PointerRoot), `browser` the browser window it resolves to
  // (0 when keys would go somewhere else, or nowhere).
  // PointerRoot (the server's start state) is NOT counted: the server does
  // route keys to the window under the pointer then, but Chrome only treats
  // itself as active after a pointer crossing, so it is the ambiguous state
  // this exists to leave. Only an explicit focus on the browser counts.
  async keyboardTarget(pid) {
    const r = await this.req(OP.GetInputFocus, 0, null, true);
    const focus = r.readUInt32LE(8);
    if (focus === 0 || focus === 1) return { focus, browser: 0 };
    return { focus, browser: await this.anyBrowser(await this.lineage(focus), pid) };
  }

  async setFocus(win) {
    const b = Buffer.alloc(8); b.writeUInt32LE(win, 0); b.writeUInt32LE(0, 4);   // CurrentTime
    this.req(OP.SetInputFocus, 2 /* RevertToParent */, b, false);
    await this.sync();
  }

  // Make the browser's window the one keys go to — what a window manager does
  // when a window maps or is clicked — and CONFIRM it with the server. Throws
  // when it cannot be made true: input sent anyway would be dropped silently.
  async ensureBrowserFocus(pid, waitMs) {
    let t = await this.keyboardTarget(pid);
    if (t.browser) return t.browser;
    const main = (await this.windowTitle()).id;
    if (!main || !(await this.isBrowserWindow(main, pid))) {
      throw new Error('no browser window is showing on the display, so there is nothing to send keys to');
    }
    const until = Date.now() + (waitMs || 2000);
    for (;;) {
      try { await this.setFocus(main); } catch (e) { /* not viewable yet: BadMatch; retried below */ }
      t = await this.keyboardTarget(pid);
      if (t.browser) return t.browser;
      if (Date.now() >= until) break;
      await sleep(50);
    }
    throw new Error(`the keyboard focus is not on the browser window (it is on ${t.focus === 0 ? 'no window' : t.focus === 1 ? 'the window under the pointer' : '0x' + t.focus.toString(16)}) and could not be moved there`);
  }

  // ---- input --------------------------------------------------------------
  async move(x, y, opts) {
    const o = opts || {};
    const from = o.from || await this.pointer();
    // A pointer that TELEPORTS onto a button is the one input shape a person
    // never produces. A few intermediate points give the page the mouseover /
    // mousemove sequence a real hand gives it. Cheap: ~8 events.
    const steps = o.steps === undefined ? 8 : o.steps;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, e = t * t * (3 - 2 * t);
      await this.fake(EV.Motion, 0, Math.round(from.x + (x - from.x) * e), Math.round(from.y + (y - from.y) * e));
      await sleep(jitter(8, 16));
    }
    await this.fake(EV.Motion, 0, x, y);
    await this.sync();
  }

  async click(x, y, opts) {
    const o = opts || {};
    const button = o.button || 1;
    await this.move(x, y, o);
    for (let i = 0; i < (o.count || 1); i++) {
      await this.fake(EV.ButtonPress, button);
      await this.sync(); await sleep(jitter(40, 90));
      await this.fake(EV.ButtonRelease, button);
      await this.sync(); await sleep(jitter(60, 120));
    }
  }

  // One notch per step; a notch is what one click of a physical wheel sends.
  async scroll(dy, dx, at) {
    if (at) await this.move(at.x, at.y);
    const notch = async (btn) => {
      await this.fake(EV.ButtonPress, btn); await this.fake(EV.ButtonRelease, btn);
      await this.sync(); await sleep(jitter(30, 70));
    };
    for (let i = 0; i < Math.abs(dy || 0); i++) await notch(dy > 0 ? 5 : 4);
    for (let i = 0; i < Math.abs(dx || 0); i++) await notch(dx > 0 ? 7 : 6);
  }

  async loadKeymap() {
    if (this.keymap) return this.keymap;
    const { minKeycode: min, maxKeycode: max } = this.setup;
    const b = Buffer.alloc(4); b[0] = min; b[1] = max - min + 1;
    const r = await this.req(OP.GetKeyboardMapping, 0, b, true);
    const per = r[1], map = new Map(), free = [];
    for (let kc = min; kc <= max; kc++) {
      const base = 32 + (kc - min) * per * 4;
      let any = false;
      for (let lvl = 0; lvl < per; lvl++) {
        const ks = r.readUInt32LE(base + lvl * 4);
        if (!ks) continue;
        any = true;
        if (lvl < 2 && !map.has(ks)) map.set(ks, { kc, shift: lvl === 1 });
      }
      if (!any && kc > min + 8) free.push(kc);
    }
    this.keymap = { map, free, per };
    return this.keymap;
  }

  // keysym -> {kc, shift}. A keysym the keyboard has no key for (é, ü, an
  // emoji) is bound to a spare keycode for the moment it is typed, the way
  // xdotool does it; the page receives the character, as from a real layout.
  async keyFor(ks) {
    const km = await this.loadKeymap();
    const hit = km.map.get(ks);
    if (hit) return hit;
    if (this.scratch.has(ks)) return { kc: this.scratch.get(ks), shift: false };
    const kc = km.free.shift();
    if (!kc) throw new Error(`no spare key to type keysym 0x${ks.toString(16)} with`);
    const body = Buffer.alloc(4 + km.per * 4);
    body[0] = kc; body[1] = km.per;
    for (let i = 0; i < km.per; i++) body.writeUInt32LE(i < 2 ? ks : 0, 4 + i * 4);
    this.req(OP.ChangeKeyboardMapping, 1, body, false);
    await this.sync();
    await sleep(40);   // clients re-read the map on MappingNotify; give them the moment
    this.scratch.set(ks, kc);
    return { kc, shift: false };
  }

  async tapKeysym(ks, mods) {
    const k = await this.keyFor(ks);
    const held = [];
    for (const m of mods || []) held.push((await this.keyFor(m)).kc);
    if (k.shift && !(mods || []).includes(KEYSYM.Shift_L)) held.push((await this.keyFor(KEYSYM.Shift_L)).kc);
    for (const kc of held) await this.fake(EV.KeyPress, kc);
    await this.fake(EV.KeyPress, k.kc);
    await this.sync(); await sleep(jitter(25, 60));
    await this.fake(EV.KeyRelease, k.kc);
    for (const kc of held.reverse()) await this.fake(EV.KeyRelease, kc);
    await this.sync();
  }

  // "Enter", "ctrl+l", "Control+Shift+T", "PageDown", "a".
  async press(combo) {
    const parts = String(combo).split('+').map(s => s.trim()).filter(Boolean);
    if (!parts.length) throw new Error('press needs a key, e.g. Enter or ctrl+l');
    const keyName = parts.pop();
    const mods = parts.map((m) => {
      const ks = MODS[m.toLowerCase()];
      if (!ks) throw new Error(`'${m}' is not a modifier (ctrl, shift, alt, meta)`);
      return ks;
    });
    const ks = keysymOf(keyName);
    if (ks === null) throw new Error(`'${keyName}' is not a key this can press`);
    await this.tapKeysym(ks, mods);
  }

  async type(text, delayMs) {
    for (const ch of String(text)) {
      const ks = charKeysym(ch);
      await this.tapKeysym(ks);
      await sleep(delayMs === undefined ? jitter(35, 110) : delayMs);
    }
  }
}

// ---- setup block ------------------------------------------------------------
function parseSetup(b) {
  const vlen = b.readUInt16LE(24);
  const nScreens = b[28], nFormats = b[29];
  const imageByteOrder = b[30];
  const minKeycode = b[34], maxKeycode = b[35];
  const ridBase = b.readUInt32LE(12), ridMask = b.readUInt32LE(16);
  let off = 40 + vlen + pad4(vlen);
  const formats = [];
  for (let i = 0; i < nFormats; i++, off += 8) formats.push({ depth: b[off], bpp: b[off + 1], pad: b[off + 2] });
  if (!nScreens) throw new Error('the X display has no screens');
  const screen = {
    root: b.readUInt32LE(off), width: b.readUInt16LE(off + 20), height: b.readUInt16LE(off + 22),
    rootDepth: b[off + 38],
  };
  return {
    imageByteOrder, minKeycode, maxKeycode, formats, screen, ridBase, ridMask,
    bppOf: (depth) => { const f = formats.find(x => x.depth === depth); return f ? f.bpp : 0; },
  };
}

// ---- PNG --------------------------------------------------------------------
let CRC_TABLE = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
// ZPixmap, 32 bits per pixel, depth 24: B G R X in LSBFirst order (Xvfb's).
function encodePNG(data, w, h, bpp, byteOrder) {
  if (bpp !== 32) throw new Error(`screenshots need a 32-bit display (this one is ${bpp}-bit)`);
  const stride = w * 4, raw = Buffer.alloc(h * (1 + w * 3));
  const lsb = byteOrder === 0;
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 3);
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * stride + x * 4, j = o + 1 + x * 3;
      if (lsb) { raw[j] = data[i + 2]; raw[j + 1] = data[i + 1]; raw[j + 2] = data[i]; }
      else { raw[j] = data[i + 1]; raw[j + 1] = data[i + 2]; raw[j + 2] = data[i + 3]; }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- keysyms ----------------------------------------------------------------
const KEYSYM = {
  BackSpace: 0xff08, Tab: 0xff09, Return: 0xff0d, Escape: 0xff1b, Delete: 0xffff,
  Home: 0xff50, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54,
  Prior: 0xff55, Next: 0xff56, End: 0xff57, Insert: 0xff63,
  Shift_L: 0xffe1, Control_L: 0xffe3, Alt_L: 0xffe9, Super_L: 0xffeb, space: 0x20,
};
const ALIASES = {
  enter: 'Return', return: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape',
  backspace: 'BackSpace', delete: 'Delete', del: 'Delete', home: 'Home', end: 'End',
  left: 'Left', right: 'Right', up: 'Up', down: 'Down', arrowleft: 'Left',
  arrowright: 'Right', arrowup: 'Up', arrowdown: 'Down', pageup: 'Prior',
  pagedown: 'Next', insert: 'Insert', space: 'space',
};
const MODS = {
  ctrl: KEYSYM.Control_L, control: KEYSYM.Control_L, shift: KEYSYM.Shift_L,
  alt: KEYSYM.Alt_L, meta: KEYSYM.Super_L, super: KEYSYM.Super_L,
};
function charKeysym(ch) {
  if (ch === '\n') return KEYSYM.Return;
  if (ch === '\t') return KEYSYM.Tab;
  const cp = ch.codePointAt(0);
  return cp >= 0x20 && cp <= 0x7e ? cp : cp >= 0xa0 && cp <= 0xff ? cp : 0x01000000 + cp;
}
function keysymOf(name) {
  const f = String(name).match(/^f([1-9]|1[0-2])$/i);
  if (f) return 0xffbd + Number(f[1]);
  const canon = ALIASES[String(name).toLowerCase()] || name;
  if (KEYSYM[canon] !== undefined) return KEYSYM[canon];
  if ([...String(name)].length === 1) return charKeysym(String(name));
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(a, b) {
  if (process.env.FIVEDIVE_BROWSER_INPUT_FAST === '1') return 0;
  return a + Math.floor(Math.random() * (b - a + 1));
}

async function open(display) {
  const x = new X11(displaySocket(display));
  await x.connect();
  return x;
}

module.exports = { open, displaySocket, keysymOf, charKeysym, encodePNG, crc32, KEYSYM };

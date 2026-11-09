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
// It does four things and nothing else:
//   1. SCREENSHOT the display (GetImage on the root window -> PNG).
//   2. INPUT through the XTEST extension — pointer moves, clicks, scroll
//      notches, key presses. XTEST events enter the X server exactly where a
//      physical keyboard's do, so Chrome delivers them to the page as
//      isTrusted=true events. There is no synthetic DOM event anywhere on this
//      path, and nothing on the page can tell it from the person's own input.
//   3. READ THE WINDOW TITLE (WM_NAME / _NET_WM_NAME), which is the page title
//      Chrome publishes to the window system. It is the one piece of page state
//      that is readable with no channel into the browser at all.
//   4. DROP A FILE onto the page (DIVE-6704), over XDND: the drag-and-drop
//      protocol a file manager speaks to Chrome. Chrome reads the dropped file
//      itself and the page gets a trusted `drop`, as from a person's drag. No
//      file chooser is involved, so nothing depends on GTK taking a typed path.
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
  CreateWindow: 1, GetWindowAttributes: 3, DestroyWindow: 4, ConfigureWindow: 12, GetGeometry: 14, QueryTree: 15,
  InternAtom: 16, ChangeProperty: 18, GetProperty: 20, SetSelectionOwner: 22, ConvertSelection: 24, SendEvent: 25,
  QueryPointer: 38, SetInputFocus: 42, GetInputFocus: 43, GetImage: 73, QueryExtension: 98,
  ChangeKeyboardMapping: 100, GetKeyboardMapping: 101,
};
// Core event codes the drop listens for (the sent-event bit 0x80 is masked off).
const XE = { PropertyNotify: 28, SelectionRequest: 30, SelectionNotify: 31, ClientMessage: 33 };
// XTEST FakeInput event types.
const EV = { KeyPress: 2, KeyRelease: 3, ButtonPress: 4, ButtonRelease: 5, Motion: 6 };

const pad4 = (n) => (4 - (n % 4)) % 4;
// One ChangeProperty without BIG-REQUESTS is at most 262140 bytes; a paste stays
// well under it rather than speak INCR.
const PASTE_MAX = 200000;

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
    this.listeners = new Set();   // fn(event) for every event the server sends
    this.nextId = 0;
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
      } else {
        // Events. Most (MappingNotify after a keymap change, among others) carry
        // nothing this client needs; the drop listens for its own (DIVE-6704).
        for (const fn of this.listeners) { try { fn(msg); } catch (e) { /* a listener's own fault */ } }
      }
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

  // ---- the window's size (DIVE-6646) --------------------------------------
  // A phone at the login-link viewer gets the browser WINDOW narrowed to the
  // phone's width, so the site lays itself out for a phone and the phone draws
  // it at about 1:1. With no window manager on the display, a ConfigureWindow
  // from any client is applied as asked and Chrome follows it like any resize.
  async geometry(win) {
    const b = Buffer.alloc(4); b.writeUInt32LE(win, 0);
    const r = await this.req(OP.GetGeometry, 0, b, true);
    return { x: r.readInt16LE(12), y: r.readInt16LE(14), w: r.readUInt16LE(16), h: r.readUInt16LE(18) };
  }

  async configure(win, g) {
    const b = Buffer.alloc(24);
    b.writeUInt32LE(win, 0);
    b.writeUInt16LE(0x0f, 4);                    // x | y | width | height
    b.writeInt32LE(g.x, 8); b.writeInt32LE(g.y, 12);
    b.writeUInt32LE(g.w, 16); b.writeUInt32LE(g.h, 20);
    this.req(OP.ConfigureWindow, 0, b, false);
    await this.sync();
  }

  // The browser's main window: the largest viewable top-level browser window
  // that is not override-redirect (menus and popups are; the window is not).
  async browserWindow(pid) {
    let best = null;
    for (const w of await this.children(this.root)) {
      const a = await this.attrs(w);
      if (!a.viewable || a.override || !(await this.isBrowserWindow(w, pid))) continue;
      let g; try { g = await this.geometry(w); } catch (e) { continue; }
      if (!best || g.w * g.h > best.g.w * best.g.h) best = { id: w, g };
    }
    return best;
  }

  // ---- a popup window of the browser (DIVE-7680) ---------------------------
  // Box bug 690: a click opened Google's or Meta's sign-in in its OWN browser
  // window. With no window manager nothing gives a new window the keyboard, and
  // browserWindow() (the largest) and browserDialog() (a file chooser, which skips
  // every other "… - Google Chrome" window) both kept input on the window under
  // it. So the popup showed in the screenshot and every key went behind it.
  // This finds it: the topmost viewable browser window that is not the main one,
  // not override-redirect (menus are), titled like a browser window, and smaller
  // than the main window (a second full-size window is a tab torn off, not a
  // popup). Returns {id, name, page} or null.
  async browserPopup(pid) {
    const main = await this.browserWindow(pid);
    if (!main) return null;
    const area = main.g.w * main.g.h;
    const kids = await this.children(this.root);
    for (let i = kids.length - 1; i >= 0; i--) {      // topmost first
      const w = kids[i];
      if (w === main.id) continue;
      const a = await this.attrs(w);
      if (!a.viewable || a.override) continue;
      if (!(await this.isBrowserWindow(w, pid))) continue;
      const name = (await this.prop(w, '_NET_WM_NAME', 'UTF8_STRING')) || (await this.prop(w, 'WM_NAME', 'STRING'));
      if (!/ [-–—] (Google Chrome|Chromium)/.test(name || '')) continue;   // a dialog is browserDialog's
      let g; try { g = await this.geometry(w); } catch (e) { continue; }
      if (g.w * g.h >= area) continue;
      return { id: w, name, page: name.replace(/ [-–—] (Google Chrome|Chromium)(?: [^-–—]*)?$/, '') };
    }
    return null;
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

  async attrs(win) {
    const b = Buffer.alloc(4); b.writeUInt32LE(win, 0);
    try { const r = await this.req(OP.GetWindowAttributes, 0, b, true); return { viewable: r[26] === 2, override: r[27] === 1 }; }
    catch (e) { return { viewable: false, override: false }; }
  }

  // ---- the browser's own dialog (DIVE-5740) -------------------------------
  // A page's upload control opens Chrome's GTK file chooser: a second top-level
  // window of the browser, small, named "Open File" or similar, transient for
  // the main window. With no window manager nothing gives it the keyboard, and
  // on chill-gorge the focus fell to the root window (0x21f on Xvfb), so the
  // click that opened it was reported as lost and the next keys were sent to
  // the PAGE behind it (a corrupted ad draft). While it is up, it is where keys
  // belong. Menus and popups are override-redirect and do not count.
  async browserDialog(pid) {
    const main = (await this.windowTitle()).id;
    const kids = await this.children(this.root);
    for (let i = kids.length - 1; i >= 0; i--) {      // topmost first
      const w = kids[i];
      if (w === main) continue;
      const a = await this.attrs(w);
      if (!a.viewable || a.override) continue;
      if (!(await this.isBrowserWindow(w, pid))) continue;
      const name = (await this.prop(w, '_NET_WM_NAME', 'UTF8_STRING')) || (await this.prop(w, 'WM_NAME', 'STRING'));
      const transient = await this.prop32(w, 'WM_TRANSIENT_FOR');
      if (/ [-–—] (Google Chrome|Chromium)/.test(name || '')) continue;   // another browser window, not a dialog
      if ((transient && transient !== this.root) || /^(open|save|select|upload|choose)\b|file/i.test(name || '')) {
        return { id: w, name: name || '' };
      }
    }
    return null;
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
    // An open dialog of the browser takes the keys, not the page behind it.
    const dlg = await this.browserDialog(pid);
    if (dlg) return this.focusOn(dlg.id, waitMs, `the browser's "${dlg.name || 'dialog'}" window`);
    // ...and so does a popup window it opened, a sign-in window on top (DIVE-7680).
    const pw = await this.browserPopup(pid);
    if (pw) return this.focusOn(pw.id, waitMs, `the browser's popup window "${pw.page || pw.name}"`);
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

  // Put the keyboard on exactly <win> (or a window inside it), confirmed.
  async focusOn(win, waitMs, what) {
    const until = Date.now() + (waitMs || 2000);
    let f = 0;
    for (;;) {
      const r = await this.req(OP.GetInputFocus, 0, null, true);
      f = r.readUInt32LE(8);
      if (f > 1 && (await this.lineage(f)).includes(win)) return win;
      if (Date.now() >= until) break;
      try { await this.setFocus(win); } catch (e) { /* not viewable yet: retried */ }
      await sleep(50);
    }
    throw new Error(`the keyboard focus could not be put on ${what} (it is on 0x${f.toString(16)})`);
  }

  // ---- dropping a file (DIVE-6704) ----------------------------------------
  // WHY A DROP. chill-gorge, Chrome 154, 2026-10-21: the upload step's file
  // chooser showed the typed path in its location field and still did not take
  // it on Open, for every path, while CI's Chrome 155 passed the same step. A
  // drop has no dialog in it. The daemon offers the file as text/uri-list on
  // the XdndSelection, the browser fetches it and reads the file itself, and
  // the page gets a trusted `drop` on whatever is at the point: an
  // <input type=file>, or a site's drop area. The protocol is XDND version 5
  // (freedesktop.org/wiki/Specifications/XDND), which every file manager speaks.

  newId() {
    const m = this.setup.ridMask, shift = Math.log2(m & -m);
    this.nextId++;
    return (this.setup.ridBase | ((this.nextId << shift) & m)) >>> 0;
  }

  // An unmapped 1x1 window of this connection's own: the drag's source, and the
  // owner of the selection the browser reads the file's name from.
  async createInputWindow() {
    const id = this.newId(), b = Buffer.alloc(32);
    b.writeUInt32LE(id, 0); b.writeUInt32LE(this.root, 4);
    b.writeInt16LE(-10, 8); b.writeInt16LE(-10, 10); b.writeUInt16LE(1, 12); b.writeUInt16LE(1, 14);
    b.writeUInt16LE(0, 16); b.writeUInt16LE(2, 18);              // border 0, InputOnly
    b.writeUInt32LE(0, 20);                                      // visual: CopyFromParent
    b.writeUInt32LE(0x800, 24); b.writeUInt32LE(0x400000, 28);   // CWEventMask: PropertyChangeMask
    this.req(OP.CreateWindow, 0, b, false);
    await this.sync();
    return id;
  }

  async destroyWindow(win) {
    const b = Buffer.alloc(4); b.writeUInt32LE(win, 0);
    this.req(OP.DestroyWindow, 0, b, false);
    await this.sync();
  }

  // ChangeProperty with atoms already interned, so it is sent at once (an
  // answer to a SelectionRequest must reach the server before its notify).
  changeProp(win, prop, type, data, mode) {
    const fmt = Buffer.isBuffer(data) ? 8 : 32;
    const bytes = fmt === 8 ? data : Buffer.alloc(data.length * 4);
    if (fmt === 32) data.forEach((v, i) => bytes.writeUInt32LE(v >>> 0, i * 4));
    const b = Buffer.alloc(20 + bytes.length);
    b.writeUInt32LE(win, 0); b.writeUInt32LE(prop, 4); b.writeUInt32LE(type, 8);
    b[12] = fmt; b.writeUInt32LE(fmt === 8 ? bytes.length : data.length, 16); bytes.copy(b, 20);
    this.req(OP.ChangeProperty, mode || 0, b, false);
  }

  // SendEvent of a 32-byte event to <dest>, with no event mask: the server
  // hands it to the client that created <dest>, which is how XDND talks.
  sendEvent(dest, ev) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(dest, 0); b.writeUInt32LE(0, 4); ev.copy(b, 8);
    this.req(OP.SendEvent, 0, b, false);
  }

  async clientMessage(dest, type, data) {
    const ev = Buffer.alloc(32);
    ev[0] = XE.ClientMessage; ev[1] = 32;
    ev.writeUInt32LE(dest, 4); ev.writeUInt32LE(await this.atom(type), 8);
    for (let i = 0; i < 5; i++) ev.writeUInt32LE((data[i] || 0) >>> 0, 12 + i * 4);
    this.sendEvent(dest, ev);
    await this.sync();
  }

  // DIVE-6775: close a top-level window as a window manager's close button does:
  // WM_PROTOCOLS/WM_DELETE_WINDOW. No key is involved, so it works on a dialog
  // that never got the keyboard; GTK answers it as the dialog's Cancel.
  async closeWindow(win) {
    await this.clientMessage(win, 'WM_PROTOCOLS', [await this.atom('WM_DELETE_WINDOW'), 0]);
  }

  // The events that match `pred`, from now on: next(ms) resolves the oldest,
  // or null when none comes within ms. stop() when done.
  events(pred) {
    const q = [], waiters = [];
    const fn = (e) => { if (!pred(e)) return; const w = waiters.shift(); if (w) w(e); else q.push(e); };
    this.listeners.add(fn);
    return {
      next: (ms) => q.length ? Promise.resolve(q.shift()) : new Promise((resolve) => {
        const w = (e) => { clearTimeout(t); resolve(e); };
        const t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); resolve(null); },
          Math.max(0, ms));
        waiters.push(w);
      }),
      stop: () => { this.listeners.delete(fn); },
    };
  }

  // The server's clock, which a selection owner has to name: a zero-length
  // append to a property of our own window, and the time on its PropertyNotify.
  async serverTime(win) {
    const ev = this.events((e) => (e[0] & 0x7f) === XE.PropertyNotify && e.readUInt32LE(4) === win);
    try {
      this.changeProp(win, await this.atom('_5DIVE_TIME'), await this.atom('STRING'), Buffer.alloc(0), 2 /* Append */);
      const e = await ev.next(2000);
      if (!e) throw new Error('the X server never said what time it is, so nothing can be offered to the browser');
      return e.readUInt32LE(12);
    } finally { ev.stop(); }
  }

  // Own <selection> on <win> from <time>, and answer every request for it from
  // `offers` ({ 'text/uri-list': Buffer }) and TARGETS. `served` lists the
  // targets handed out, so a caller can say whether the browser ever asked.
  async ownSelection(selection, win, time, offers) {
    const sel = await this.atom(selection), TARGETS = await this.atom('TARGETS'), ATOM = await this.atom('ATOM');
    const types = new Map();
    for (const [k, v] of Object.entries(offers)) types.set(await this.atom(k), v);
    const served = [];
    const fn = (e) => {
      if ((e[0] & 0x7f) !== XE.SelectionRequest || e.readUInt32LE(8) !== win || e.readUInt32LE(16) !== sel) return;
      const t = e.readUInt32LE(4), requestor = e.readUInt32LE(12), target = e.readUInt32LE(20);
      let property = e.readUInt32LE(24) || target;     // an obsolete client names none: the target, by the ICCCM
      if (target === TARGETS) this.changeProp(requestor, property, ATOM, [TARGETS, ...types.keys()]);
      else if (types.has(target)) { this.changeProp(requestor, property, target, types.get(target)); served.push(target); }
      else property = 0;                                // not offered: the requestor reads None
      const ev = Buffer.alloc(32);
      ev[0] = XE.SelectionNotify;
      ev.writeUInt32LE(t, 4); ev.writeUInt32LE(requestor, 8); ev.writeUInt32LE(sel, 12);
      ev.writeUInt32LE(target, 16); ev.writeUInt32LE(property, 20);
      this.sendEvent(requestor, ev);
    };
    this.listeners.add(fn);
    const b = Buffer.alloc(12);
    b.writeUInt32LE(win, 0); b.writeUInt32LE(sel, 4); b.writeUInt32LE(time, 8);
    this.req(OP.SetSelectionOwner, 0, b, false);
    await this.sync();
    return { served, stop: () => { this.listeners.delete(fn); } };
  }

  // DIVE-7237 (GAP-17): <text> into the focused field as ONE paste, not as
  // keystrokes. A code editor answers each typed key (closes a quote, commits an
  // autocomplete on "," or ".", re-indents a new line), so a pixel code typed key
  // by key came out with characters changed and dropped (Shopify's custom pixel,
  // DIVE-6902). A paste is inserted as it is. The text is offered on CLIPBOARD
  // from a window of our own, ctrl+v is pressed, and the window is destroyed
  // once the browser has read it, so nothing holds the text for a later paste.
  // Resolves { served } — false when nothing asked for it (no text field had
  // the focus). One property request: at most PASTE_MAX bytes.
  async paste(text, waitMs) {
    const data = Buffer.from(String(text), 'utf8');
    if (!data.length) throw new Error('nothing to paste');
    if (data.length > PASTE_MAX) throw new Error(`${data.length} bytes is more than one paste carries (${PASTE_MAX}); split it`);
    const win = await this.createInputWindow();
    let own = null;
    try {
      const time = await this.serverTime(win);
      own = await this.ownSelection('CLIPBOARD', win, time,
        { UTF8_STRING: data, 'text/plain;charset=utf-8': data, TEXT: data });
      const before = await this.atom('UTF8_STRING');
      await this.press('ctrl+v');
      const until = Date.now() + (waitMs || 3000);
      while (Date.now() < until && !own.served.length) await sleep(30);
      if (own.served.length) await sleep(150);   // a second target (TARGETS first) arrives right after
      return { served: own.served.length > 0, utf8: own.served.includes(before) };
    } finally {
      if (own) own.stop();
      await this.destroyWindow(win).catch(() => {});   // the selection goes with the window
    }
  }

  // DIVE-7171: what is on the CLIPBOARD, read as any X client reads it, and
  // then cleared. A site that shows a new API key masked, with only a Copy
  // button (CJdropshipping), puts it here and nowhere else. ConvertSelection of
  // CLIPBOARD (UTF8_STRING, then STRING) onto a window of our own, the
  // property read and deleted; then the selection is taken by that window and
  // the window destroyed, so nothing holds the value for the next paste.
  // Resolves { text, cleared } — text '' when nobody holds the clipboard.
  async readClipboard(waitMs) {
    const win = await this.createInputWindow();
    try {
      const sel = await this.atom('CLIPBOARD'), into = await this.atom('_5DIVE_CLIP');
      const time = await this.serverTime(win);
      let text = '';
      for (const tname of ['UTF8_STRING', 'STRING']) {
        const target = await this.atom(tname);
        const ev = this.events((e) => (e[0] & 0x7f) === XE.SelectionNotify && e.readUInt32LE(8) === win);
        let e;
        try {
          const b = Buffer.alloc(20);
          b.writeUInt32LE(win, 0); b.writeUInt32LE(sel, 4); b.writeUInt32LE(target, 8);
          b.writeUInt32LE(into, 12); b.writeUInt32LE(time, 16);
          this.req(OP.ConvertSelection, 0, b, false);
          e = await ev.next(waitMs || 3000);
        } finally { ev.stop(); }
        if (!e) throw new Error('the clipboard\'s owner never answered, so nothing was read');
        if (e.readUInt32LE(20) === 0) continue;          // property None: not held, or not in this type
        const g = Buffer.alloc(20);
        g.writeUInt32LE(win, 0); g.writeUInt32LE(into, 4); g.writeUInt32LE(0, 8);   // AnyPropertyType
        g.writeUInt32LE(0, 12); g.writeUInt32LE(16384, 16);                         // up to 64 KB
        const r = await this.req(OP.GetProperty, 1 /* delete */, g, true);
        if (r.readUInt32LE(8) === await this.atom('INCR')) throw new Error('the clipboard holds more than this reads at once (64 KB), so nothing was read');
        if (r[1] !== 8) continue;
        text = r.subarray(32, 32 + r.readUInt32LE(16)).toString(tname === 'UTF8_STRING' ? 'utf8' : 'latin1');
        break;
      }
      const o = Buffer.alloc(12);
      o.writeUInt32LE(win, 0); o.writeUInt32LE(sel, 4); o.writeUInt32LE(0, 8);      // CurrentTime
      this.req(OP.SetSelectionOwner, 0, o, false);
      await this.sync();
      return { text, cleared: true };
    } finally {
      await this.destroyWindow(win).catch(() => {});   // the selection it owns goes with it
    }
  }

  // The window at the pointer that takes drops: the outermost one with
  // XdndAware (the browser's top-level window), and the version it speaks.
  async dropTarget() {
    for (const w of await this.underPointer()) {
      const v = await this.prop32(w, 'XdndAware');
      if (v !== null) return { win: w, version: v };
    }
    return null;
  }

  // Drag <file> onto x,y and drop it, as a file manager does. Resolves
  // { finished, accepted, fetched } when the browser has said it is done;
  // throws, having sent XdndLeave so the page sees the drag go, when what is at
  // the point never takes a file.
  async dropFile(x, y, file, pid, opts) {
    const o = opts || {};
    await this.move(x, y);
    const tgt = await this.dropTarget();
    if (!tgt) throw new Error(`nothing at ${x},${y} takes a dropped file: no window there speaks drag-and-drop`);
    if (pid && !(await this.isBrowserWindow(tgt.win, pid))) {
      throw new Error(`the window at ${x},${y} that takes drops is not the browser (0x${tgt.win.toString(16)}), so nothing was dropped`);
    }
    const version = Math.min(5, tgt.version);
    if (version < 3) throw new Error(`the browser speaks drag-and-drop version ${tgt.version}, older than this needs (3)`);
    const uri = require('url').pathToFileURL(file).href;
    const src = await this.createInputWindow();
    const [STATUS, FINISHED, COPY, URIS] = await Promise.all(
      ['XdndStatus', 'XdndFinished', 'XdndActionCopy', 'text/uri-list'].map((a) => this.atom(a)));
    const said = this.events((e) => (e[0] & 0x7f) === XE.ClientMessage && e.readUInt32LE(4) === src);
    let sel = null;
    try {
      const t = await this.serverTime(src);
      sel = await this.ownSelection('XdndSelection', src, t, { 'text/uri-list': Buffer.from(uri + '\r\n') });
      await this.clientMessage(tgt.win, 'XdndEnter', [src, version << 24, URIS]);
      // The first answers are "no" while the page has not seen the drag yet:
      // Chrome answers each position with what the page said to the one before.
      // So keep the drag over the point, as a hand does, until it says yes.
      let yes = false, answers = 0;
      const until = Date.now() + (o.acceptMs || 5000);
      while (!yes && Date.now() < until) {
        await this.clientMessage(tgt.win, 'XdndPosition', [src, 0, ((x & 0xffff) << 16) | (y & 0xffff), t, COPY]);
        for (let e; (e = await said.next(400));) {
          if (e.readUInt32LE(8) !== STATUS) continue;
          answers++; yes = !!(e.readUInt32LE(16) & 1);
          break;
        }
        if (!yes) await sleep(100);
      }
      if (!yes) {
        await this.clientMessage(tgt.win, 'XdndLeave', [src]);
        throw new Error(`the page at ${x},${y} did not take the file: ` + (answers
          ? `the browser answered ${answers} drag position(s) with "no drop here"`
          : 'the browser never answered the drag'));
      }
      await this.clientMessage(tgt.win, 'XdndDrop', [src, 0, t]);
      let fin = null;
      const until2 = Date.now() + (o.finishMs || 8000);
      while (!fin && Date.now() < until2) {
        const e = await said.next(until2 - Date.now());
        if (!e) break;
        if (e.readUInt32LE(8) === FINISHED) fin = e;
      }
      return { finished: !!fin, accepted: !!fin && (version < 5 || !!(fin.readUInt32LE(16) & 1)), fetched: sel.served.length };
    } finally {
      said.stop(); if (sel) sel.stop();
      try { await this.destroyWindow(src); } catch (e) { /* the connection is going anyway */ }
    }
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
    const per = r[1], map = new Map(), spare = [], held = new Map();
    for (let kc = min; kc <= max; kc++) {
      const base = 32 + (kc - min) * per * 4;
      const on = new Set();
      for (let lvl = 0; lvl < per; lvl++) {
        const ks = r.readUInt32LE(base + lvl * 4);
        if (!ks) continue;
        on.add(ks);
        if (lvl < 2 && !map.has(ks)) map.set(ks, { kc, shift: lvl === 1 });
      }
      if (kc <= min + 8) continue;
      // A key with nothing on it is spare. So is a key an earlier connection
      // bound for one character (a single Unicode keysym, nothing else): this
      // daemon after a restart, or xdotool. It keeps its character until the
      // spare keys run out, and is then rebound like any other.
      const [only] = on;
      if (!on.size) spare.unshift(kc);
      else if (on.size === 1 && isUnicodeKeysym(only)) { spare.push(kc); held.set(kc, only); }
    }
    this.keymap = { map, spare, held, per };
    return this.keymap;
  }

  // keysym -> {kc, shift}. A keysym the keyboard has no key for (é, ü, an
  // emoji, 服) is bound to a spare keycode for the moment it is typed, the way
  // xdotool does it; the page receives the character, as from a real layout.
  // The spare keys are RECYCLED, least recently used first: Xvfb's keymap has
  // about 18 of them, and a Chinese message has more distinct characters than
  // that (DIVE-5433: chill-gorge's Telegram draft stopped after '服务器上',
  // the 18th). A key is rebound only after every other spare has been used
  // since, so the page has long read the character it carried.
  async keyFor(ks) {
    const km = await this.loadKeymap();
    const hit = km.map.get(ks);
    if (hit) { touch(km.spare, hit.kc); return hit; }
    const kc = km.spare.shift();
    if (!kc) throw new Error(`no spare key to type keysym 0x${ks.toString(16)} with`);
    const was = km.held.get(kc);
    if (was !== undefined && km.map.get(was)?.kc === kc) km.map.delete(was);
    const body = Buffer.alloc(4 + km.per * 4);
    body[0] = kc; body[1] = km.per;
    for (let i = 0; i < km.per; i++) body.writeUInt32LE(i < 2 ? ks : 0, 4 + i * 4);
    this.req(OP.ChangeKeyboardMapping, 1, body, false);
    await this.sync();
    await sleep(40);   // clients re-read the map on MappingNotify; give them the moment
    const k = { kc, shift: false };
    km.map.set(ks, k); km.held.set(kc, ks); km.spare.push(kc);
    return k;
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
// The keysym a character gets when it has none of its own: 0x01000000 + code point.
function isUnicodeKeysym(ks) { return ks >= 0x01000100 && ks <= 0x0110ffff; }
// Move a spare key to the most-recently-used end, if it is one.
function touch(spare, kc) {
  const i = spare.indexOf(kc);
  if (i >= 0) { spare.splice(i, 1); spare.push(kc); }
}
function keysymOf(name) {
  const f = String(name).match(/^f([1-9]|1[0-2])$/i);
  if (f) return 0xffbd + Number(f[1]);
  const canon = ALIASES[String(name).toLowerCase()] || name;
  if (KEYSYM[canon] !== undefined) return KEYSYM[canon];
  // A modifier on its own is a key too (DIVE-5740: 'ctrl' was "not a key").
  if (MODS[String(name).toLowerCase()] !== undefined) return MODS[String(name).toLowerCase()];
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

module.exports = { open, displaySocket, keysymOf, charKeysym, encodePNG, crc32, KEYSYM, XE };

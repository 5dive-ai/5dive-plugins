#!/usr/bin/env node
'use strict';
// 5dive browser — a phone at the login-link viewer (DIVE-6646).
//
// The served browser is a 1280x800 window on a 1280x800 Xvfb. A phone draws
// that whole screen into a ~390-px-wide page, about 0.3 scale, so every field
// and button is a third of its size and the login is close to impossible to
// do with a thumb. While a phone is at the viewer, the browser WINDOW is made
// the phone's size instead: the site sees a phone-wide window and uses its own
// phone layout, and the viewer page draws that corner of the screen at about
// 1:1. When the view ends, the window gets back the exact geometry it had.
//
// WHY THE WINDOW AND NOT CDP. The login view is plain Chrome (DIVE-5203) and an
// input-mode site is plain Chrome (DIVE-5287): neither has a CDP channel, by
// design, and a loopback debugging port is not added for this (see bin/browser,
// "the viewer"). The window is the one thing all three serve modes share.
//
//   viewer-fit.cjs fit <display> <W>x<H> <state>    W, H: the phone page's CSS size
//   viewer-fit.cjs restore <display> <state>
//   viewer-fit.cjs hold <display> <state> <pid>     restore when <pid> exits
//
// `fit` prints `fit=<w>x<h>` and `screen=<w>x<h>` when it resized the window,
// and NOTHING for a client that is not a phone (the desktop viewer is left
// exactly as it is) or a display with no browser window on it.
const fs = require('fs');
const path = require('path');
const x11 = require(path.join(__dirname, 'x11.cjs'));

// Narrower than this is a phone (or a phone-sized window) and gets a fit.
const PHONE_MAX_W = 600;
const MIN_W = 200, MIN_H = 200, MAX_H = 4000;

function phone(spec) {
  const m = /^(\d{1,4})x(\d{1,4})$/.exec(String(spec || ''));
  if (!m) return null;
  const w = +m[1], h = +m[2];
  if (w < MIN_W || w >= PHONE_MAX_W || h < MIN_H || h > MAX_H) return null;
  return { w, h };
}

async function fit(display, spec, state) {
  const p = phone(spec);
  if (!p) return;
  const x = await x11.open(display);
  try {
    const win = await x.browserWindow();
    if (!win) return;
    // The FIRST geometry is the one to give back: a second fit in one view
    // (a re-redeem cannot happen, but a re-run by hand can) keeps it.
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(state, 'utf8')); } catch (e) { saved = null; }
    if (!saved || saved.win !== win.id) {
      saved = { win: win.id, ...win.g };
      fs.writeFileSync(state, JSON.stringify(saved) + '\n', { mode: 0o600 });
    }
    const want = { x: 0, y: 0, w: p.w, h: Math.min(p.h, x.height) };
    await x.configure(win.id, want);
    // Read it back after Chrome has had its turn: the page is told what the
    // window IS, not what was asked for.
    await new Promise(r => setTimeout(r, 300));
    const got = await x.geometry(win.id);
    process.stdout.write(`fit=${got.w}x${got.h}\nscreen=${x.width}x${x.height}\n`);
  } finally { x.close(); }
}

// Claim the state file by renaming it, so `restore` from the viewer's stop and
// the holder's own restore cannot both act on it; the loser finds nothing.
async function restore(display, state) {
  const mine = `${state}.${process.pid}`;
  try { fs.renameSync(state, mine); } catch (e) { return false; }
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(mine, 'utf8')); } catch (e) { saved = null; }
  try {
    if (!saved || !saved.win) return false;
    const x = await x11.open(display);
    try {
      try { await x.geometry(saved.win); } catch (e) { return false; }   // the window is gone
      await x.configure(saved.win, { x: saved.x, y: saved.y, w: saved.w, h: saved.h });
      return true;
    } finally { x.close(); }
  } catch (e) {
    return false;                                 // no display any more: nothing to restore
  } finally {
    try { fs.unlinkSync(mine); } catch (e) { /* gone */ }
  }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

async function hold(display, state, pid) {
  let done = false;
  const end = async () => { if (done) return; done = true; await restore(display, state); process.exit(0); };
  process.on('SIGTERM', end); process.on('SIGINT', end); process.on('SIGHUP', end);
  for (;;) {
    if (!fs.existsSync(state)) process.exit(0);   // restored by the viewer's stop
    if (!alive(pid)) return end();
    await new Promise(r => setTimeout(r, 400));
  }
}

async function main(argv) {
  const [cmd, display, a, b] = argv;
  if (cmd === 'fit' && display && a && b) return fit(display, a, b);
  if (cmd === 'restore' && display && a) { await restore(display, a); return; }
  if (cmd === 'hold' && display && a && /^\d+$/.test(b || '')) return hold(display, a, +b);
  process.stderr.write('usage: viewer-fit.cjs fit <display> <W>x<H> <state> | restore <display> <state> | hold <display> <state> <pid>\n');
  process.exit(2);
}

if (require.main === module) main(process.argv.slice(2)).catch(e => { process.stderr.write(`viewer-fit: ${e.message}\n`); process.exit(1); });

module.exports = { phone, PHONE_MAX_W };

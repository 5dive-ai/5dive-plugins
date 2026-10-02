#!/usr/bin/env node
// DIVE-5342 — what is on the display at a point, for the input-mode harness.
//
//   node tests/x11_stack.cjs <label> <x> <y> <browser-pid> [png-out]
//
// Prints every top-level window (topmost first: QueryTree returns them bottom
// to top) with its geometry, map state, pid, class and name, marks the ones
// that contain the point, and ends with ONE machine line:
//
//   top=0x<id> browser=yes|no      (top=none when nothing viewable is there)
//
// That line is the readiness assertion (L1c: the browser is the topmost window
// at the click point) and, after a red L3, the explanation of where the click
// went. With [png-out] it also writes the whole display as a PNG, so the CI
// artifact shows the screen the input met. DISPLAY names the display.
'use strict';
const path = require('path');
const fs = require('fs');
const x11 = require(path.join(__dirname, '..', 'browser', 'lib', 'x11.cjs'));

const [label, xs, ys, pids, png] = process.argv.slice(2);
const px = Number(xs), py = Number(ys), pid = Number(pids) || 0;
const hex = (w) => '0x' + w.toString(16);

async function geometry(x, w) {
  const b = Buffer.alloc(4); b.writeUInt32LE(w, 0);
  const r = await x.req(14, 0, b, true);                         // GetGeometry
  return { x: r.readInt16LE(12), y: r.readInt16LE(14), w: r.readUInt16LE(16), h: r.readUInt16LE(18),
    border: r.readUInt16LE(20) };
}

(async () => {
  const x = await x11.open(process.env.DISPLAY);
  const rows = [];
  for (const w of (await x.children(x.root)).reverse()) {
    let g;
    try { g = await geometry(x, w); } catch (e) { continue; }   // gone since QueryTree
    const viewable = await x.viewable(w);
    const at = viewable && px >= g.x && py >= g.y && px < g.x + g.w + 2 * g.border && py < g.y + g.h + 2 * g.border;
    rows.push({ w, g, viewable, at, browser: await x.isBrowserWindow(w, pid),
      wpid: await x.prop32(w, '_NET_WM_PID'),
      cls: (await x.prop(w, 'WM_CLASS', 'STRING')).replace(/\0+$/, '').replace(/\0/g, '.'),
      name: (await x.prop(w, '_NET_WM_NAME', 'UTF8_STRING')) || (await x.prop(w, 'WM_NAME', 'STRING')) });
  }
  const top = rows.find(r => r.at);
  const focus = await x.keyboardTarget(pid).catch(() => ({ focus: -1, browser: 0 }));
  const out = [`window stack at ${px},${py} on ${process.env.DISPLAY} (${label}), topmost first; ` +
    `keyboard focus ${focus.focus > 1 ? hex(focus.focus) : ['None', 'PointerRoot'][focus.focus] || '?'}` +
    `${focus.browser ? ' (the browser)' : ''}:`];
  for (const r of rows) {
    if (!r.viewable && !r.browser) continue;                       // unmapped helpers are noise
    out.push(`  ${r === top ? '>' : r.at ? '+' : ' '} ${hex(r.w)} ${r.g.x},${r.g.y} ${r.g.w}x${r.g.h}` +
      ` ${r.viewable ? 'viewable' : 'unmapped'} pid=${r.wpid ?? '-'} class=${r.cls || '-'}` +
      ` ${r.browser ? '[browser] ' : ''}name=${JSON.stringify(r.name.slice(0, 80))}`);
  }
  if (png) {
    try { fs.writeFileSync(png, await x.screenshotPNG()); out.push(`  screen written to ${png}`); }
    catch (e) { out.push(`  screen NOT written: ${e.message}`); }
  }
  out.push(top ? `top=${hex(top.w)} browser=${top.browser ? 'yes' : 'no'}` : 'top=none browser=no');
  process.stdout.write(out.join('\n') + '\n');
  x.close();
})().catch((e) => { process.stdout.write(`window stack unreadable: ${e.message}\ntop=none browser=no\n`); process.exit(1); });

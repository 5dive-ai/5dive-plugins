#!/usr/bin/env node
'use strict';
// 5dive browser — delta snapshots (DIVE-5335).
//
// WHAT PROBLEM THIS IS. On a long flow an agent snapshots the same page again
// and again: after a click opens a menu, after a toast lands, to check that a
// step went through. Each full snapshot is the whole ref list, the whole page
// text and a PNG, and the agent reads all three to find the one line that
// changed. agent-browser ships the same fix (`snapshot --delta`, `screenshot
// --if-changed`): after the first full read, answer with what moved.
//
// WHAT A DELTA IS, and what it is not:
//   refs   added and removed `ref=<role>/<name>[#n]` lines. A ref is re-derived
//          from the page every time (lib/aria.cjs), so the set difference IS
//          the change in what can be acted on; there is no "moved" to report.
//   text   page.md lines that appeared and lines that went away, as multisets
//          (a line printed twice and now once is one removal). Not an ordered
//          diff: the agent needs "what does the page say now that it did not",
//          and an LCS over a reflowed article reports the reflow.
//   png    the fraction of pixels that differ. Under the threshold the picture
//          is not written at all, because a file that is there gets opened.
//
// IT FALLS BACK TO FULL, rather than printing a delta bigger than the page: a
// navigation to a different page makes everything "added", and a delta that
// costs more to read than the snapshot is the opposite of the point.
//
// No dependencies: the PNG decoder below is the subset Chrome writes (8-bit
// RGB/RGBA, non-interlaced), on node's own zlib. Anything else is "unknown",
// which the caller treats as changed, so a format surprise costs a picture,
// never a missed change.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- PNG -> RGBA ------------------------------------------------------------
function decodePng(buf) {
  const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = ctype === 6 ? 4 : ctype === 2 ? 3 : 0;
  if (depth !== 8 || !bpp || interlace) throw new Error(`unsupported PNG (depth ${depth}, color type ${ctype}, interlace ${interlace})`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const f = raw[base];
    for (let x = 0; x < stride; x++) {
      const v = raw[base + 1 + x];
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let r;
      switch (f) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: throw new Error(`bad PNG filter ${f}`);
      }
      cur[x] = r & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, i = x * bpp;
      px[o] = cur[i]; px[o + 1] = cur[i + 1]; px[o + 2] = cur[i + 2]; px[o + 3] = bpp === 4 ? cur[i + 3] : 255;
    }
    const t = prev; prev = cur; cur = t;
  }
  return { width, height, px };
}

// The share of pixels whose largest channel difference exceeds `tol` (0-255).
// A different size is a different picture: 1.
function pixelChange(aBuf, bBuf, { tol = 16 } = {}) {
  const a = decodePng(aBuf), b = decodePng(bBuf);
  if (a.width !== b.width || a.height !== b.height) return 1;
  const n = a.width * a.height;
  if (!n) return 0;
  let diff = 0;
  for (let i = 0; i < n * 4; i += 4) {
    if (Math.abs(a.px[i] - b.px[i]) > tol || Math.abs(a.px[i + 1] - b.px[i + 1]) > tol ||
        Math.abs(a.px[i + 2] - b.px[i + 2]) > tol || Math.abs(a.px[i + 3] - b.px[i + 3]) > tol) diff++;
  }
  return diff / n;
}

// ---- refs and text ----------------------------------------------------------
function refsOf(tree) {
  return ((tree && tree.nodes) || []).filter((n) => n && n.ref).map((n) => `ref=${n.ref}`);
}

function multisetDiff(oldList, newList) {
  const count = new Map();
  for (const x of oldList) count.set(x, (count.get(x) || 0) + 1);
  const added = [];
  for (const x of newList) {
    const c = count.get(x) || 0;
    if (c > 0) count.set(x, c - 1); else added.push(x);
  }
  const removed = [];
  for (const x of oldList) {
    const c = count.get(x) || 0;
    if (c > 0) { removed.push(x); count.set(x, c - 1); }
  }
  return { added, removed };
}

// page.md without its front matter (it carries the capture time and hash, which
// change on every capture and are not a change in the page), blank lines dropped.
function textLines(md) {
  let s = String(md || '');
  if (s.startsWith('---\n')) { const end = s.indexOf('\n---', 4); if (end >= 0) s = s.slice(s.indexOf('\n', end + 1) + 1); }
  return s.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
}

function readMaybe(p, enc) { try { return fs.readFileSync(p, enc); } catch (e) { return null; } }

// diff(<baseline dir>, <new dir>) -> the delta object. Both dirs hold
// tree.json, page.md and (optionally) page.png, as `snapshot` writes them.
function diff(oldDir, newDir, { pngThreshold = 0.01, tol = 16, fallbackRatio = 0.6 } = {}) {
  const oldTree = JSON.parse(readMaybe(path.join(oldDir, 'tree.json'), 'utf8') || '{}');
  const newTree = JSON.parse(readMaybe(path.join(newDir, 'tree.json'), 'utf8') || '{}');
  const oldMd = readMaybe(path.join(oldDir, 'page.md'), 'utf8') || '';
  const newMd = readMaybe(path.join(newDir, 'page.md'), 'utf8') || '';
  const refs = multisetDiff(refsOf(oldTree), refsOf(newTree));
  const text = multisetDiff(textLines(oldMd), textLines(newMd));

  let png = { changed: null, write: true, why: 'no picture to compare' };
  const oldPng = readMaybe(path.join(oldDir, 'page.png')), newPng = readMaybe(path.join(newDir, 'page.png'));
  if (oldPng && newPng) {
    try {
      const changed = pixelChange(oldPng, newPng, { tol });
      png = { changed: Math.round(changed * 10000) / 10000, write: changed >= pngThreshold,
        why: changed >= pngThreshold ? 'the picture changed' : `under ${pngThreshold * 100}% of pixels changed` };
    } catch (e) { png = { changed: null, write: true, why: `could not compare (${e.message})` }; }
  } else if (!newPng) png = { changed: null, write: false, why: 'no picture was taken' };

  // The size of what the agent reads, in bytes: full = the files, delta = the lines.
  const fullBytes = Buffer.byteLength(JSON.stringify(newTree)) + Buffer.byteLength(newMd);
  const deltaBytes = [...refs.added, ...refs.removed, ...text.added, ...text.removed]
    .reduce((n, l) => n + Buffer.byteLength(l) + 3, 0);
  const sameUrl = (oldTree.url || '') === (newTree.url || '');
  const useful = deltaBytes <= fullBytes * fallbackRatio;
  return {
    applied: useful,
    why: useful ? (sameUrl ? 'same page' : 'a different URL, but most of the page is the same')
      : `the change is ${deltaBytes} bytes against ${fullBytes} for the whole page, so the full snapshot is shorter to read`,
    from_url: oldTree.url || null, url: newTree.url || null,
    refs, text, png, full_bytes: fullBytes, delta_bytes: deltaBytes,
  };
}

function render(d, { maxLines = 400 } = {}) {
  const out = [];
  const push = (prefix, list) => { for (const l of list) out.push(prefix + l); };
  if (d.refs.added.length || d.refs.removed.length) {
    out.push(`refs: +${d.refs.added.length} -${d.refs.removed.length}`);
    push('  + ', d.refs.added); push('  - ', d.refs.removed);
  } else out.push('refs: unchanged');
  if (d.text.added.length || d.text.removed.length) {
    out.push(`text: +${d.text.added.length} -${d.text.removed.length} line(s)`);
    push('  + ', d.text.added); push('  - ', d.text.removed);
  } else out.push('text: unchanged');
  if (out.length > maxLines) {
    const cut = out.length - maxLines;
    out.length = maxLines;
    out.push(`  … ${cut} more line(s) in delta.json`);
  }
  return out.join('\n');
}

module.exports = { decodePng, pixelChange, multisetDiff, textLines, refsOf, diff, render };

// CLI: delta.cjs <baseline-dir> <new-dir> [--png-threshold=<0..1>] [--render]
//      delta.cjs --render-json < delta.json     (the lines bin/browser prints)
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--render-json') {
    process.stdout.write(render(JSON.parse(fs.readFileSync(0, 'utf8'))) + '\n');
    process.exit(0);
  }
  const dirs = args.filter((a) => !a.startsWith('--'));
  const opt = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : undefined; };
  if (dirs.length !== 2) { process.stderr.write('usage: delta.cjs <baseline-dir> <new-dir> [--png-threshold=0.01] [--render]\n'); process.exit(64); }
  const th = opt('png-threshold');
  const d = diff(dirs[0], dirs[1], th !== undefined ? { pngThreshold: Number(th) } : {});
  if (args.includes('--render')) process.stdout.write(render(d) + '\n');
  else process.stdout.write(JSON.stringify(d) + '\n');
}

'use strict';
// A FILE AN ACT DOWNLOADED, HANDED TO THE SEAT (DIVE-5751).
//
// A click on an export button (a report, an audio file, a CSV) starts a download.
// Playwright keeps it as a nameless temp file inside the browser's own 0700 cache
// and deletes it when the context closes, so before this the file never reached
// the seat that asked: `act` said "done: every step ran" and nothing else, and on
// a seat without sudo there was no way to reach it at all (measured 2026-10-06:
// a 24.6 MB m4a, found only by `sudo find`).
//
// Both step loops (bin/driver-playwright and bin/session-daemon) use this file,
// for the reason lib/aria.cjs exists: two copies of one rule drift. Each loop
// watches the pages of the act, and after the re-read saves every download into
// a directory, under the name the site suggested, made safe. Where the bytes go
// next is the caller's business: the one-shot driver runs as the caller and
// writes into the caller's own staging directory; the daemon runs as the
// profile's owner and sends the bytes back over the socket (the DIVE-4664 trade
// `render` and `snapshot` already make), so the caller writes them itself.

const fs = require('fs');
const path = require('path');

// The longest a download is waited for after the steps. An export the server is
// still building is normal; one that has not finished in two minutes is reported
// as unfinished and cancelled, never waited on forever under the lease.
const WAIT_MS = Number(process.env.FIVEDIVE_BROWSER_DOWNLOAD_WAIT_MS) || 120000;
// The most one act hands over. The served path carries the bytes as base64 over
// the socket, so the cap is what keeps one act from holding hundreds of MB in two
// processes. Over it, the file is named and its size given, and nothing is saved.
const MAX_BYTES = (Number(process.env.FIVEDIVE_BROWSER_DOWNLOAD_MAX_MB) || 100) * 1024 * 1024;
// Raw bytes per chunk line on the socket: a multiple of 3, so the base64 chunks
// concatenate into one valid stream and `base64 -d` decodes them as one.
const CHUNK = 3 * 256 * 1024;

// THE NAME IS THE SITE'S, SO IT IS UNTRUSTED. A suggested filename of
// `../../.bashrc` or `.ssh/authorized_keys` must land as a plain file inside the
// directory, never beside it: the last path segment only, no control characters,
// no leading dots, and never empty. A second file with the same name gets -2, -3.
function safeName(suggested, taken) {
  let n = String(suggested == null ? '' : suggested).replace(/[\x00-\x1f\x7f]/g, '');
  n = n.split(/[\\/]/).pop().trim().replace(/^\.+/, '').trim();
  if (Buffer.byteLength(n) > 180) {
    const ext = path.extname(n).slice(0, 16);
    n = Buffer.from(n.slice(0, n.length - ext.length)).subarray(0, 160).toString('utf8').replace(/�+$/, '') + ext;
  }
  if (!n) n = 'download';
  let out = n, k = 2;
  const ext = path.extname(n), stem = n.slice(0, n.length - ext.length);
  while (taken.has(out)) out = `${stem}-${k++}${ext}`;
  taken.add(out);
  return out;
}

// Start listening on every page the act can reach: the one it acts on, any other
// open tab, and any tab a click opens (an export that opens a new tab to download
// is common). Returns the list it fills and a stop().
function watch(ctx, page) {
  const seen = [];
  // Files a goto landed ON (DIVE-7646): a PDF Chrome shows in its viewer fires no
  // download event, so keepResponse() puts its bytes here and save() writes them.
  const files = [];
  const pages = new Set();
  const onDownload = (d) => seen.push(d);
  const add = (p) => {
    if (!p || pages.has(p) || typeof p.on !== 'function') return;
    pages.add(p); p.on('download', onDownload);
  };
  add(page);
  try { for (const p of (ctx && typeof ctx.pages === 'function' ? ctx.pages() : [])) add(p); } catch (e) { /* best effort */ }
  const onPage = (p) => add(p);
  if (ctx && typeof ctx.on === 'function') ctx.on('page', onPage);
  return {
    list: seen,
    files,
    stop() {
      for (const p of pages) { try { (p.off || p.removeListener).call(p, 'download', onDownload); } catch (e) { /* gone */ } }
      if (ctx && typeof ctx.off === 'function') { try { ctx.off('page', onPage); } catch (e) { /* gone */ } }
    },
  };
}

// A download raced against a deadline. The timer is cleared when the save wins,
// so a finished save never holds the process open for the rest of the wait.
function saveBefore(d, file, ms) {
  let t;
  const late = new Promise((resolve) => { t = setTimeout(() => resolve('timeout'), ms); });
  return Promise.race([d.saveAs(file).then(() => 'saved'), late]).finally(() => clearTimeout(t));
}

// Save every download the watch saw into <dir>, waiting for unfinished ones up
// to WAIT_MS in all. One entry per download, in the order they started:
//   { name, bytes, file }          saved: <dir>/<name>
//   { name, bytes?, error }        not saved, and why in words
async function save(w, dir, opts = {}) {
  const waitMs = opts.waitMs || WAIT_MS, max = opts.maxBytes || MAX_BYTES;
  const deadline = Date.now() + waitMs;
  const taken = new Set(), out = [];
  for (const d of w.list) {
    let raw = '';
    try { raw = d.suggestedFilename(); } catch (e) { /* unnamed */ }
    const name = safeName(raw, taken);
    const file = path.join(dir, name);
    try {
      const left = Math.max(1000, deadline - Date.now());
      const r = await saveBefore(d, file, left);
      if (r === 'timeout') {
        try { await d.cancel(); } catch (e) { /* it may have just finished */ }
        try { fs.unlinkSync(file); } catch (e) { /* never written */ }
        out.push({ name, error: `still downloading after ${Math.round(waitMs / 1000)}s, so it was cancelled` });
        continue;
      }
      const bytes = fs.statSync(file).size;
      if (bytes > max) {
        fs.unlinkSync(file);
        const cap = max >= 1048576 ? `${Math.round(max / 1048576)} MB` : `${max} bytes`;
        out.push({ name, bytes, error: `${bytes} bytes is over the limit an act hands over (${cap}, FIVEDIVE_BROWSER_DOWNLOAD_MAX_MB)` });
        continue;
      }
      out.push({ name, bytes, file });
    } catch (e) {
      let why = '';
      try { why = (await d.failure()) || ''; } catch (e2) { /* no reason to give */ }
      try { fs.unlinkSync(file); } catch (e3) { /* never written */ }
      out.push({ name, error: `the download failed: ${why || (e && e.message) || 'no reason given'}` });
    } finally {
      // Playwright's own temp copy goes now, not when the context closes: a served
      // browser stays up for days, and every export would otherwise stay in its cache.
      if (typeof d.delete === 'function') { try { await d.delete(); } catch (e) { /* already gone */ } }
    }
  }
  for (const f of (w.files || [])) {
    const name = safeName(f.name, taken);
    if (f.error) { out.push({ name, error: f.error }); continue; }
    const bytes = f.buf.length;
    if (bytes > max) {
      const cap = max >= 1048576 ? `${Math.round(max / 1048576)} MB` : `${max} bytes`;
      out.push({ name, bytes, error: `${bytes} bytes is over the limit an act hands over (${cap}, FIVEDIVE_BROWSER_DOWNLOAD_MAX_MB)` });
      continue;
    }
    const file = path.join(dir, name);
    try {
      fs.writeFileSync(file, f.buf, { mode: 0o600, flag: 'wx' });
      out.push({ name, bytes, file, ...(f.type ? { type: f.type } : {}) });
    } catch (e) {
      out.push({ name, error: `it could not be written: ${e.message}` });
    }
  }
  return out;
}

// ============================================================================
// A FILE AT A URL (DIVE-7646). Chrome opens a PDF in its own viewer: no download
// event fires, the page's DOM is an empty <body>, and the viewer's Download
// button lives in an extension Playwright cannot drive (a 30 s timeout). So the
// bytes are fetched through the context's own request client, which carries the
// profile's cookies: the logged-in invoice comes back, not the sign-in page.
// A bare fetch() would carry none, and that is the mutant the harness keeps red.

// What the server said the file is called, else the URL's last segment. Always
// passed through safeName() by whoever writes it.
function nameFrom(headers, url) {
  const cd = String((headers && headers['content-disposition']) || '');
  let m = cd.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i);
  if (m) { try { return decodeURIComponent(m[2].trim().replace(/^"|"$/g, '')); } catch (e) { /* fall through */ } }
  m = cd.match(/filename\s*=\s*"([^"]*)"/i) || cd.match(/filename\s*=\s*([^;]+)/i);
  if (m && m[1].trim()) return m[1].trim();
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(seg);
  } catch (e) { return ''; }
}

const typeOf = (headers) => String((headers && headers['content-type']) || '').split(';')[0].trim().toLowerCase();

// A response that IS a file, as opposed to a page: a PDF, or anything the server
// marks as an attachment. A goto that lands on one hands its bytes over.
function isFileResponse(headers) {
  return /^application\/(x-)?pdf$/.test(typeOf(headers))
    || /^\s*attachment\b/i.test(String((headers && headers['content-disposition']) || ''));
}

// A web page where a file was asked for. A sign-in page is the common case (the
// session lapsed, or the URL needs a login this profile does not hold), and it
// is named as one, because "saved invoice.pdf" holding a login form is the
// failure this guards against.
function pageNotFile(body, finalUrl) {
  const head = Buffer.isBuffer(body) ? body.subarray(0, 200000).toString('utf8') : String(body || '');
  const signin = /type\s*=\s*["']?password/i.test(head)
    || /\/(login|signin|sign-in|sign_in|ap\/signin|auth|sso|oauth)\b/i.test(String(finalUrl || ''));
  return signin
    ? 'got a sign-in page, not a file: the session for this site has lapsed or the link needs a login this profile does not hold. Nothing was saved.'
    : 'got a web page, not a file. Nothing was saved. To read a page use browser read; browser download is for a PDF or another file at a URL.';
}

// GET <url> through the context's own request client (the profile's cookies ride
// along). Never throws: { ok:true, name, type, buf, url } or { ok:false, error }.
async function fetchFile(ctx, url, opts = {}) {
  const max = opts.maxBytes || MAX_BYTES;
  const timeout = opts.timeoutMs || WAIT_MS;
  if (!ctx || !ctx.request || typeof ctx.request.get !== 'function') {
    return { ok: false, error: 'this browser has no request client, so nothing was fetched' };
  }
  let r;
  try { r = await ctx.request.get(url, { timeout, failOnStatusCode: false }); }
  catch (e) { return { ok: false, error: `could not fetch ${url}: ${String(e && e.message || e).split('\n')[0]}` }; }
  const headers = (typeof r.headers === 'function' ? r.headers() : r.headers) || {};
  const status = typeof r.status === 'function' ? r.status() : r.status;
  const finalUrl = (typeof r.url === 'function' ? r.url() : r.url) || url;
  const type = typeOf(headers);
  const declared = Number(headers['content-length']);
  const capWords = max >= 1048576 ? `${Math.round(max / 1048576)} MB` : `${max} bytes`;
  if (declared > max) {
    try { if (typeof r.dispose === 'function') await r.dispose(); } catch (e) { /* gone */ }
    return { ok: false, error: `the file is ${declared} bytes, over the ${capWords} a download hands over (FIVEDIVE_BROWSER_DOWNLOAD_MAX_MB). Nothing was saved.` };
  }
  let buf;
  try { buf = await r.body(); } catch (e) { return { ok: false, error: `the server answered but the body could not be read: ${String(e && e.message || e).split('\n')[0]}` }; }
  try { if (typeof r.dispose === 'function') await r.dispose(); } catch (e) { /* gone */ }
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || '');
  if (status < 200 || status > 299) {
    const lapsed = status === 401 || status === 403 ? ' (the sign-in may have lapsed)' : '';
    return { ok: false, status, error: `the server answered ${status}${lapsed}, not a file. Nothing was saved.` };
  }
  if (/^(text\/html|application\/xhtml\+xml)$/.test(type) && !/^\s*attachment\b/i.test(String(headers['content-disposition'] || ''))) {
    return { ok: false, status, error: pageNotFile(buf, finalUrl) };
  }
  if (buf.length > max) {
    return { ok: false, error: `the file is ${buf.length} bytes, over the ${capWords} a download hands over (FIVEDIVE_BROWSER_DOWNLOAD_MAX_MB). Nothing was saved.` };
  }
  return { ok: true, name: nameFrom(headers, finalUrl), type: type || 'application/octet-stream', buf, url: finalUrl };
}

// THE NAVIGATION'S BODY IS KEPT ONLY WHEN IT IS THE FILE (DIVE-7646 it2). Real
// Chrome hands a PDF to its viewer, and what the navigation's body() returns then
// is not the server's bytes (measured on CI: the right headers, other bytes). So
// the body must match what the headers declare: its length, where one is given
// and not compressed, and a PDF's %PDF- header in its first 1024 bytes. Anything
// else is fetched again through the context, with the same cookies.
function bodyIsTheFile(buf, headers) {
  if (!buf || !buf.length) return false;
  const declared = Number(headers && headers['content-length']);
  if (!(headers && headers['content-encoding']) && Number.isFinite(declared) && declared > 0 && declared !== buf.length) return false;
  if (/pdf$/.test(typeOf(headers)) && Buffer.from(buf).subarray(0, 1024).indexOf('%PDF-') < 0) return false;
  return true;
}

// A goto that LANDED on a file (DIVE-7646): its bytes go into w.files, for save().
// The navigation's own body when it is the file; otherwise it is fetched
// again through the context. Returns the entry, or null for an ordinary page.
async function keepResponse(w, ctx, resp) {
  if (!w || !resp || typeof resp.headers !== 'function') return null;
  let headers;
  try { headers = resp.headers(); } catch (e) { return null; }
  if (!isFileResponse(headers)) return null;
  const url = typeof resp.url === 'function' ? resp.url() : '';
  let entry = null;
  try {
    const buf = await resp.body();
    if (bodyIsTheFile(buf, headers)) entry = { name: nameFrom(headers, url), type: typeOf(headers), buf: Buffer.from(buf) };
  } catch (e) { /* the viewer kept it; fetched below */ }
  if (!entry) {
    const r = await fetchFile(ctx, url);
    entry = r.ok ? { name: r.name, type: r.type, buf: r.buf } : { name: nameFrom(headers, url), error: r.error };
  }
  w.files.push(entry);
  return entry;
}

// The served path's wire shape: one metadata line per download, then its bytes as
// chunk lines. `send` is the daemon's out-line writer.
function stream(entries, send) {
  entries.forEach((e, i) => {
    const meta = { act_download: true, i, name: e.name };
    if (e.bytes != null) meta.bytes = e.bytes;
    if (e.type) meta.type = e.type;
    if (e.error) meta.error = e.error;
    send(JSON.stringify(meta) + '\n');
    if (e.error || !e.file) return;
    const fd = fs.openSync(e.file, 'r');
    try {
      const buf = Buffer.alloc(CHUNK);
      let n;
      while ((n = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
        send(JSON.stringify({ act_download_chunk: true, i, b64: buf.subarray(0, n).toString('base64') }) + '\n');
      }
    } finally { fs.closeSync(fd); }
  });
}

module.exports = { safeName, watch, save, stream, nameFrom, isFileResponse, bodyIsTheFile, fetchFile, keepResponse, WAIT_MS, MAX_BYTES, CHUNK };

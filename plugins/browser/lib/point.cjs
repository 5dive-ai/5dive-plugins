'use strict';
// ---- AN ACT'S TWO FALLBACKS: A CLICK BY POSITION, AND A READ-ONLY PAGE SCRIPT (DIVE-8241)
//
// WHY. In the 7-agent bench (DIVE-7804, 2026-11-07) BrowserOS made 94 clicks at
// screenshot coordinates in 22 of 100 runs, in 9 of the 18 tasks it won and 5dive
// lost, and ran page JavaScript 216 times. 5dive had coordinates only in input mode
// (the X11 path), so on a normal page a control that was covered, off the window or
// missing from the accessibility tree was a dead end: 31 clicks failed that way.
// bench/matrix-7804-2026-11-07/BROWSEROS-EDGE.md, items 1 and 5 of its ranked list.
//
// THE STEPS, `act` only (the step loops admit them only on a guarded plan, so an
// adapter's `run` recipe keeps its closed vocabulary: no eval, no script, no position):
//   click_at {x, y}           a mouse click at that point of page.png
//   hover_at {x, y}           the mouse moved there (menus that open on hover)
//   type_at  {x, y, value}    a click there, then the value typed key by key into
//                             the field the click focused (refused when it focused none)
//   eval     {expr}           one JavaScript expression evaluated in the page, its
//                             value handed back as JSON. READ-ONLY, see EVAL below.
//
// THE POINT IS A PIXEL OF page.png, the picture the agent looked at: the window's
// viewport, taken at the device's scale, so it is divided by devicePixelRatio
// here. A point outside the window is refused, never scrolled to: the picture was
// of the window, so a point outside it is not a point the agent saw.
//
// THE OWNER'S FOUR STILL APPLY (DIVE-4943). A click by position is classified by the
// element UNDER THE POINT (elementFromPoint, through open shadow roots and into
// frames), read the way stepRisk reads a ref's element: its accessible label, a
// field being a field. A point whose element cannot be read — nothing there, a frame
// this browser cannot enter — is the STRICTEST kind (pay): the owner is asked rather
// than a guess made in the direction that spends money.

const aria = require('./aria.cjs');

const ACT_ONLY = new Set(['click_at', 'hover_at', 'type_at', 'eval']);
const POINT_OPS = new Set(['click_at', 'hover_at', 'type_at']);
const XY_MAX = 20000;
const EVAL_EXPR_MAX = 4000;
// How long a page script may run, and how much of its answer comes back. A script
// that loops forever is cut by Chrome at the bound (Runtime.evaluate's own timeout).
const EVAL_MS = Number(process.env.FIVEDIVE_BROWSER_EVAL_MS || 3000);
const EVAL_OUT_MAX = Number(process.env.FIVEDIVE_BROWSER_EVAL_OUT_MAX || 20000);
const STRICTEST = 'pay';

// A step as the loops hand it in, checked before anything touches the page. Returns
// the step to run, or throws with the reason (the caller marks it "nothing ran").
function validate(s, n, typeRefusal = aria.typeRefusal, typeDelay = aria.typeDelay) {
  const out = { op: s.op };
  if (POINT_OPS.has(s.op)) {
    for (const k of ['x', 'y']) {
      const v = s[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > XY_MAX) {
        throw new Error(`step ${n} (${s.op}) needs '${k}': a pixel of page.png, a number from 0 (got ${JSON.stringify(v)})`);
      }
      out[k] = v;
    }
    if (s.op === 'type_at') {
      if (typeof s.value !== 'string' || !s.value) throw new Error(`step ${n} (type_at) is missing 'value'`);
      const why = typeRefusal(s.delay_ms, s.value);
      if (why) throw new Error(`step ${n} (type_at) ${why}`);
      out.value = s.value;
      out.delay_ms = typeDelay(s.delay_ms);
    }
  } else if (s.op === 'eval') {
    if (typeof s.expr !== 'string' || !s.expr.trim()) throw new Error(`step ${n} (eval) is missing 'expr', the JavaScript expression to read`);
    if (s.expr.length > EVAL_EXPR_MAX) throw new Error(`step ${n} (eval) has a ${s.expr.length}-character expression; at most ${EVAL_EXPR_MAX}`);
    out.expr = s.expr;
  } else {
    throw new Error(`step ${n}: '${s.op}' is not a position or page-script step`);
  }
  if (typeof s.intent === 'string' && s.intent) out.intent = s.intent;
  return out;
}

// ---- WHAT IS UNDER THE POINT -------------------------------------------------
// In the page, closing over nothing (page.evaluate serialises it). The element at
// (x, y) in CSS pixels of this frame, down through open shadow roots; the clickable
// it belongs to (a button's inner <span> is the button); that one's label, read as
// _labelIn reads a ref's; whether it is a field. A frame under the point comes back
// as its content box, so the caller can read inside it.
function _hitIn(arg) {
  var x = arg.x, y = arg.y;
  var el = document.elementFromPoint(x, y), guard = 0;
  while (el && el.shadowRoot && guard++ < 12) {
    var inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  if (!el) return { none: true };
  var tag = String(el.tagName || '').toLowerCase();
  if (tag === 'iframe' || tag === 'frame') {
    var cs = getComputedStyle(el);
    var px = function (v) { return parseFloat(v) || 0; };
    return { frame: true, bl: px(cs.borderLeftWidth) + px(cs.paddingLeft), bt: px(cs.borderTopWidth) + px(cs.paddingTop),
      desc: tag + (el.id ? '#' + el.id : '') + (el.title ? ' "' + String(el.title).slice(0, 60) + '"' : '') };
  }
  var CLICKABLE = 'a[href],button,input,select,textarea,summary,label,option,[role=button],[role=link],[role=menuitem],' +
    '[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=option],[role=checkbox],[role=radio],[role=switch],' +
    '[role=textbox],[role=searchbox],[role=combobox],[onclick],[contenteditable=""],[contenteditable=true],[contenteditable=plaintext-only]';
  var t = null;
  try { t = el.closest ? el.closest(CLICKABLE) : null; } catch (e) { t = null; }
  var n = t || el;
  var ntag = String(n.tagName || '').toLowerCase();
  var itype = String((n.getAttribute && n.getAttribute('type')) || n.type || '').toLowerCase();
  var btnValue = ntag === 'input' && /^(submit|button|reset|image)$/.test(itype);
  var inner = String(n.innerText || '');
  // A bare container's text is the whole region's, not a label: read only when short.
  if (!t && inner.length > 200) inner = '';
  var img = '';
  try { var im = n.querySelector && n.querySelector('img[alt]'); img = im ? im.getAttribute('alt') : ''; } catch (e) { img = ''; }
  if (ntag === 'img') img = n.getAttribute('alt') || '';
  var label = [n.getAttribute && n.getAttribute('aria-label'), inner, btnValue ? n.value : '', n.title, img]
    .filter(function (v) { return typeof v === 'string' && v.trim(); }).join(' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  var entry = false;
  if (n.isContentEditable === true || ntag === 'textarea') entry = true;
  else if (ntag === 'input') entry = !/^(button|submit|reset|image|checkbox|radio|file|color|range)$/.test(itype || 'text');
  else { try { entry = !!(n.matches && n.matches('[role=textbox],[role=searchbox],[role=combobox]')); } catch (e) { entry = false; } }
  var cls = typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\s+/)[0] : '';
  var desc = ntag + (n.id ? '#' + n.id : '') + cls;
  // A CLOSED SHADOW ROOT: a custom element with no open root, no children and no
  // label is drawn by a tree this page script cannot see into (a <pay-button> could
  // hold "Pay now"). Unreadable, so the strictest kind.
  if (!t && tag.indexOf('-') > 0 && !el.shadowRoot && !el.firstElementChild && !label) {
    return { none: true, closed: true, desc: desc };
  }
  return { label: label, entry: entry, desc: desc };
}

// The page's scale and window, in one read: page.png pixels -> this page's CSS pixels.
async function cssPoint(page, s) {
  let m = null;
  try { m = await page.evaluate(() => ({ dpr: window.devicePixelRatio || 1, w: window.innerWidth, h: window.innerHeight })); }
  catch (e) { m = null; }
  const dpr = m && m.dpr > 0 ? m.dpr : 1;
  const x = s.x / dpr, y = s.y / dpr;
  if (m && (x >= m.w || y >= m.h)) {
    throw new Error(`(${s.x}, ${s.y}) is outside the page's window, which page.png shows as ` +
      `${Math.round(m.w * dpr)} x ${Math.round(m.h * dpr)}; take a picture and use a point in it`);
  }
  return { x, y, dpr };
}

// What the point lands on, read through frames: { label, entry, desc } or { unreadable: why }.
async function hitAt(page, x, y) {
  let at = page.mainFrame ? page.mainFrame() : page, ox = 0, oy = 0;
  const path = [];
  for (let depth = 0; depth < 5; depth++) {
    let hit;
    try { hit = await at.evaluate(_hitIn, { x: x - ox, y: y - oy }); }
    catch (e) { return { unreadable: `the page could not be read there (${String(e.message || e).split('\n')[0]})`, path }; }
    if (hit && hit.closed) return { unreadable: `${hit.desc}, whose inside is closed to page scripts`, path };
    if (!hit || hit.none) return { unreadable: 'nothing is drawn there', path };
    if (!hit.frame) return { ...hit, path };
    path.push(hit.desc);
    // Which child frame owns the element at the point: the one whose element box holds it.
    let next = null;
    for (const f of (at.childFrames ? at.childFrames() : [])) {
      try {
        const h = await f.frameElement();
        const b = h ? await h.boundingBox() : null;   // in the top page's CSS pixels
        if (b && x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) { next = f; break; }
      } catch (e) { /* a frame that detached: not this one */ }
    }
    if (!next) return { unreadable: `a frame (${hit.desc}) this browser cannot enter`, path };
    // The frame's content box in the top page's CSS pixels: its element's box
    // (Playwright gives it relative to the main frame) plus its border and padding.
    try { const h = await next.frameElement(); const b = await h.boundingBox(); ox = b.x + hit.bl; oy = b.y + hit.bt; }
    catch (e) { return { unreadable: `a frame (${hit.desc}) that moved while it was read`, path }; }
    at = next;
  }
  return { unreadable: 'frames nested deeper than five', path };
}

// THE OWNER'S FOUR, for a step by position: null, or { cls, label, payload, at }.
async function pointRisk(page, s) {
  if (!s || (s.op !== 'click_at' && s.op !== 'type_at')) return null;
  let pt;
  try { pt = await cssPoint(page, s); } catch (e) { return null; }   // refused at the act, not here
  const hit = await hitAt(page, pt.x, pt.y);
  const at = { x: s.x, y: s.y };
  if (hit.unreadable) {
    return { cls: STRICTEST, label: aria.cleanText(`a click at (${s.x}, ${s.y}) on what this browser cannot read: ${hit.unreadable}`), payload: {}, at };
  }
  if (hit.entry) return null;   // a click into a field only focuses it (DIVE-7670)
  const cls = aria.classifyLabel(hit.label);
  if (!cls) return null;
  let payload = {};
  try { payload = await page.evaluate(aria._payloadIn, { sel: null, op: 'click', cls, payloadOf: true }); } catch (e) { payload = {}; }
  return { cls, label: aria.cleanText(`${hit.label} (${hit.desc} at ${s.x}, ${s.y})`), payload: aria.cleanPayload(payload), at };
}

// ---- RUN ONE STEP BY POSITION ------------------------------------------------
// Returns the line the act prints: what the point landed on, so the agent can tell
// a click on the button from a click on what covered it.
async function runPoint(page, s, { timeoutMs = 10000 } = {}) {
  const pt = await cssPoint(page, s);
  const hit = await hitAt(page, pt.x, pt.y);
  const what = hit.unreadable ? hit.unreadable : `${hit.desc}${hit.label ? ` "${aria.cleanText(hit.label).slice(0, 80)}"` : ''}`;
  if (s.op === 'hover_at') { await page.mouse.move(pt.x, pt.y); return `the mouse is over ${what}`; }
  await page.mouse.click(pt.x, pt.y);
  if (s.op === 'click_at') return `clicked ${what}`;
  // type_at: only into the field the click focused. Keys on a page with no field in
  // focus are shortcuts (a video's "k", a feed's "j"), not text.
  let focused = false;
  try {
    focused = await page.evaluate(() => {
      let a = document.activeElement;
      while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
      if (a && (a.tagName === 'IFRAME' || a.tagName === 'FRAME')) return 'frame';
      if (!a || a === document.body) return false;
      if (a.isContentEditable || a.tagName === 'TEXTAREA') return true;
      if (a.tagName === 'INPUT') return !/^(button|submit|reset|image|checkbox|radio|file|color|range)$/i.test(a.type || 'text');
      return !!(a.matches && a.matches('[role=textbox],[role=searchbox],[role=combobox]'));
    });
  } catch (e) { focused = false; }
  if (!focused) throw new Error(`the click at (${s.x}, ${s.y}) landed on ${what}, which took no typing, so nothing was typed`);
  // As `type` does: the field ends up saying this, not this appended.
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type(s.value, { delay: s.delay_ms });
  return `typed ${[...s.value].length} characters into ${what}`;
}

// ---- EVAL: A READ-ONLY PAGE SCRIPT --------------------------------------------
//
// HOW IT IS KEPT FROM WRITING OR ACTING. The expression is evaluated by Chrome's
// Runtime.evaluate with throwOnSideEffect: V8 runs it in side-effect-free mode and
// throws EvalError at the first operation that could change anything outside the
// script's own new objects. Measured on Chrome 155 (bench rig, 2026-11-11): reads
// of text, attributes, hrefs, field values, window state and embedded JSON pass; every
// one of click(), dispatchEvent, focus(), form submit()/requestSubmit(), location
// assignment and assign(), history.pushState, window.open, fetch, sendBeacon,
// XMLHttpRequest, setAttribute, innerHTML=, assigning to a page object, setTimeout,
// eval/new Function, Promise and localStorage.getItem throws. That is the engine's
// own check, not a word list: `document['cl'+'ick']` is refused the same way.
// A loop that never ends is cut at EVAL_MS by the same call's timeout.
//
// WHAT IT MAY NOT READ. Two things a page holds that page.html does not show the
// agent: cookies and a typed password. During the evaluation document.cookie is
// switched off for the whole page, every frame (Emulation.setDocumentCookieDisabled;
// measured: the cross-frame getter returns "" too), and switched back after. A page
// with a password field holding anything, in any frame, refuses the step before it
// runs, as does a tab a saved login or detail was typed into this session
// (DIVE-6844: a saved value never comes back to the agent).
//
// THE ANSWER comes back as JSON on one line of the act's output, cut at EVAL_OUT_MAX
// characters with the full size said. DOM nodes do not serialise: read their text.
const savedTabs = new WeakMap();   // page -> the origin a saved value was typed on
function markSaved(page) {
  try { savedTabs.set(page, new URL(page.url()).origin); } catch (e) { savedTabs.set(page, '*'); }
}
function savedHere(page) {
  if (!savedTabs.has(page)) return false;
  const o = savedTabs.get(page);
  try { return o === '*' || new URL(page.url()).origin === o; } catch (e) { return true; }
}
function _passwordFilledIn() {
  function walk(root, depth) {
    var list = root.querySelectorAll('input[type=password]');
    for (var i = 0; i < list.length; i++) if (list[i].value) return true;
    if (depth > 6) return false;
    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) if (all[j].shadowRoot && walk(all[j].shadowRoot, depth + 1)) return true;
    return false;
  }
  return walk(document, 0);
}
async function passwordFilled(page) {
  for (const f of (page.frames ? page.frames() : [])) {
    try { if (await f.evaluate(_passwordFilledIn)) return true; } catch (e) { /* a frame that went away holds nothing */ }
  }
  return false;
}
const BIDI = /[‎‏‪-‮⁦-⁩]/g;
async function evalStep(page, s) {
  if (savedHere(page)) throw new Error('not run: a saved login or detail was typed on this page, and a page script could read it back');
  if (await passwordFilled(page)) throw new Error('not run: a password field on this page holds a value, and a page script could read it back');
  const cdp = await page.context().newCDPSession(page);
  let off = false;
  try {
    try { await cdp.send('Emulation.setDocumentCookieDisabled', { disabled: true }); off = true; }
    catch (e) { throw new Error(`not run: this browser could not switch cookies off for the script (${e.message})`); }
    let r;
    try {
      r = await cdp.send('Runtime.evaluate', { expression: s.expr, throwOnSideEffect: true, timeout: EVAL_MS,
        returnByValue: true, silent: true, awaitPromise: false, userGesture: false });
    } catch (e) {
      if (/terminated/i.test(String(e.message))) throw new Error(`stopped after ${EVAL_MS / 1000} s: the expression did not finish`);
      throw e;
    }
    if (r.exceptionDetails) {
      const d = String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || 'it threw').split('\n')[0];
      if (/Possible side-effect/i.test(d)) {
        throw new Error('refused: the expression would change the page, act on it or reach the network ' +
          '(a page script only reads). Read with querySelector/querySelectorAll, textContent, getAttribute, value; click with click or click_at');
      }
      throw new Error(`the expression threw: ${d}`);
    }
    const v = r.result;
    let json;
    if (v.type === 'undefined') json = 'undefined';
    else if ('value' in v) json = JSON.stringify(v.value);
    else json = JSON.stringify(v.description || v.type);
    if (json === undefined) json = 'null';
    json = json.replace(BIDI, '');
    if (json.length > EVAL_OUT_MAX) json = `${json.slice(0, EVAL_OUT_MAX)} …(cut: ${json.length} characters, the first ${EVAL_OUT_MAX} shown; narrow it with .slice())`;
    return json;
  } finally {
    if (off) { try { await cdp.send('Emulation.setDocumentCookieDisabled', { disabled: false }); } catch (e) { /* the page went away */ } }
    try { await cdp.detach(); } catch (e) { /* the page went away */ }
  }
}

module.exports = {
  ACT_ONLY, POINT_OPS, STRICTEST, EVAL_MS, EVAL_OUT_MAX, validate, pointRisk, runPoint, evalStep,
  markSaved, savedHere, cssPoint, hitAt, _hitIn, _passwordFilledIn,
};

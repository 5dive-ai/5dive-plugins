'use strict';
// 5dive browser — what an act changed on the page (DIVE-6795).
//
// WHAT PROBLEM THIS IS. After every act the agent was handed the whole page:
// page.md inline (up to 4 KB), and when that was not enough it opened tree.json
// or page.md itself. On the Online-Mind2Web bench those reads were 32 KB each,
// the model's gap between calls was 3.2 s against 1.8 s for agent-browser, whose
// act answers in about 2 KB. And deriving page.md cost the act 0.9-4 s of
// Defuddle walking the DOM, every time, for text the agent mostly did not read.
//
// WHAT THIS IS INSTEAD. The served browser is one long-lived process, so it can
// remember what each tab looked like the last time the agent saw it (a snapshot
// or an act), and answer an act with the difference:
//   refs   interactive refs that appeared, and the ones that went away. Only the
//          interactive roles count, so an interactive snapshot and an act's full
//          walk compare like with like.
//   text   lines of the readable text (lib/aria.cjs _textIn) that appeared, in
//          page order, as multisets: a line printed twice and now three times is
//          one new line. Lines that went away are a count.
// A tab nobody has looked at yet, or one the act took to another page, answers
// with the same shape: everything on it is new, capped, which is what the agent
// would have snapshotted for.
//
// The caps are what keeps the answer short; the full capture is still on disk
// (tree.json, page.html, page.png) and `act --full` prints page.md as before.

const { INTERACTIVE } = require('./aria.cjs');
const ROLES = new Set(INTERACTIVE);

const REFS_MAX = 60;        // added refs printed
const GONE_MAX = 10;        // removed refs printed by name; past this, a count
const TEXT_MAX = 1500;      // characters of added text printed
// A country list is 230 option refs that pushed every other new ref past the
// cap (FedEx on the bench): the first few options say the list opened.
const OPTIONS_MAX = 8;

// What one look at a page is: its url, its interactive refs in page order, and
// its readable text as lines.
function lookOf(url, nodes, text) {
  const refs = [];
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (n && typeof n.ref === 'string' && ROLES.has(n.role)) refs.push(n.ref);
  }
  const lines = String(text || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return { url: String(url || ''), refs, lines };
}

function counts(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

// The items of <cur> that <prev> does not account for, in <cur>'s order.
function added(prev, cur) {
  const left = counts(prev);
  const out = [];
  for (const x of cur) {
    const k = left.get(x) || 0;
    if (k > 0) left.set(x, k - 1); else out.push(x);
  }
  return out;
}

// The difference between two looks. <prev> null: the agent has not seen this tab.
function compare(prev, cur, { refsMax = REFS_MAX, goneMax = GONE_MAX, textMax = TEXT_MAX, optionsMax = OPTIONS_MAX } = {}) {
  const base = prev || { url: '', refs: [], lines: [] };
  const refsNew = added(base.refs, cur.refs);
  let options = 0;
  const refsShown = refsNew.filter((r) => !r.startsWith('option/') || ++options <= optionsMax);
  const refsGone = added(cur.refs, base.refs);
  const textNew = added(base.lines, cur.lines);
  const textGone = added(cur.lines, base.lines);
  const text = [];
  let chars = 0;
  for (const l of textNew) {
    if (chars + l.length > textMax) {
      if (!text.length) text.push(l.slice(0, textMax) + '…');
      break;
    }
    text.push(l); chars += l.length + 1;
  }
  return {
    first: !prev,
    same_url: !!prev && prev.url === cur.url,
    refs_total: cur.refs.length,
    refs_added: refsShown.slice(0, refsMax),
    refs_added_total: refsNew.length,
    refs_removed: refsGone.length <= goneMax ? refsGone : [],
    refs_removed_total: refsGone.length,
    text_added: text,
    text_added_total: textNew.length,
    text_removed_total: textGone.length,
  };
}

// Per-tab memory for the served browser: a WeakMap, so a closed tab takes its
// look with it.
function memory() {
  const seen = new WeakMap();
  return {
    remember(page, look) { if (page && typeof page === 'object') seen.set(page, look); },
    // Compare <look> with the last one of <page>, and keep <look> as the new last.
    since(page, look, opts) {
      const prev = page && typeof page === 'object' ? seen.get(page) || null : null;
      this.remember(page, look);
      return compare(prev, look, opts);
    },
  };
}

module.exports = { lookOf, compare, memory, REFS_MAX, GONE_MAX, TEXT_MAX, OPTIONS_MAX };

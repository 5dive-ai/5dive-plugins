'use strict';
// 5dive browser — the ref layer (DIVE-4588, proposal 3).
//
// WHAT PROBLEM THIS IS. An agent driving a real site spends its hour GUESSING
// selectors: `tr.zA`, `.yX .yP`, `input[name=subjectbox]`. Those are Gmail's
// obfuscated class names, they are not documented anywhere, and they change.
// claude-luca measured it on the teal-fox box (2026-09-16): "four rounds at a
// minute each" of trial and error, and his own ranking put this ABOVE the warm
// browser, because a warm browser makes a guessing loop faster and does not stop
// it.
//
// ---- WHY A REF IS A ROLE AND A NAME, NOT A SNAPSHOT HANDLE ------------------
//
// The obvious shape is Playwright's own: take an ARIA snapshot, hand back `e12`,
// resolve `e12` against that snapshot. It is the wrong shape HERE for one
// reason: `e12` is only meaningful to the page instance that produced it. Every
// verb in this plugin today opens its own browser, acts, and closes it — so a
// handle minted by `tree` would be dead by the time `run` quoted it, and the
// agent would be back to guessing. Tying refs to a live session would make the
// session daemon a PRECONDITION for the thing that pays for itself on its own.
//
// So a ref is SEMANTIC and RE-DERIVABLE:
//
//     ref=button/Send            the button whose accessible name is "Send"
//     ref=textbox/To             the text field labelled "To"
//     ref=link/Inbox#3           the third link named "Inbox"
//
// It survives a navigation, a fresh browser, a daemon restart, and a class-name
// change — it breaks only when the page's own accessible name changes, which is
// a change a person made to the label and can read.
//
// ---- ONE WALK, NOT TWO ------------------------------------------------------
//
// `tree` prints refs and `run` resolves them. If those were two implementations
// they would drift, and the failure mode of drift here is the expensive one: a
// ref that `tree` printed and `run` resolves to a DIFFERENT element clicks the
// wrong thing inside a real account. So there is exactly one walk, below, run in
// the page, used for both. `tree` asks it to enumerate; `run` asks it to MARK —
// the marked element is then addressed with an ordinary CSS attribute selector,
// which means the rest of the executor needs no ref-awareness at all.

// Roles that can be acted on. `--interactive` keeps these and drops the rest;
// it is the list an agent actually needs, and the full tree is still one flag away.
const INTERACTIVE = [
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch',
  'slider', 'spinbutton', 'tab', 'treeitem',
];

// THE PAGE-SIDE WALK. Serialized into the browser by page.evaluate, so it may
// close over nothing: everything it needs arrives in `opts`.
//
// It returns the SAME ordered node list in both modes. In mark mode it also
// stamps `data-5dive-ref` on the one node whose ref matches, and reports the
// marker — the caller turns that into a CSS selector. Same ordering, same ref
// assignment, same filter: that is what makes "tree printed it" and "run found
// it" the same statement.
function pageWalk(opts) {
  var ROLE_BY_TAG = {
    a: 'link', button: 'button', select: 'combobox', textarea: 'textbox',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    img: 'img', form: 'form', nav: 'navigation', main: 'main', table: 'table',
    ul: 'list', ol: 'list', li: 'listitem', summary: 'button', dialog: 'dialog',
    iframe: 'iframe', label: 'label', option: 'option',
  };
  var INPUT_ROLE = {
    checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button',
    reset: 'button', image: 'button', search: 'searchbox', range: 'slider',
    number: 'spinbutton', file: 'button', hidden: null,
  };

  function roleOf(el) {
    var explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (explicit) return explicit.toLowerCase();
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (Object.prototype.hasOwnProperty.call(INPUT_ROLE, t)) return INPUT_ROLE[t];
      return 'textbox';
    }
    if (tag === 'a' && !el.hasAttribute('href')) return null;
    return ROLE_BY_TAG[tag] || null;
  }

  function text(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // Accessible name, in the order the ARIA spec resolves it, stopping at the
  // first that yields something. Not the full algorithm — the parts a real page
  // uses, in the real order. A name we cannot compute is an EMPTY name and the
  // node still appears: a ref of `button/` is useless, but hiding the node would
  // tell the agent the button does not exist, which is worse than telling it the
  // button has no label.
  function nameOf(el) {
    var byId = el.getAttribute('aria-labelledby');
    if (byId) {
      var parts = byId.split(/\s+/).map(function (id) {
        var n = el.ownerDocument.getElementById(id);
        return n ? text(n) : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    var lab = el.getAttribute('aria-label');
    if (lab && lab.trim()) return lab.trim();
    if (el.id) {
      var forLab = el.ownerDocument.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (forLab && text(forLab)) return text(forLab);
    }
    var wrap = el.closest ? el.closest('label') : null;
    if (wrap && text(wrap)) return text(wrap);
    var ph = el.getAttribute('placeholder');
    if (ph && ph.trim()) return ph.trim();
    var alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
    var ttl = el.getAttribute('title');
    if (ttl && ttl.trim()) return ttl.trim();
    var val = el.getAttribute('value');
    if (val && val.trim() && el.tagName.toLowerCase() === 'input') return val.trim();
    var own = text(el);
    if (own && own.length <= 120) return own;
    return '';
  }

  // Hidden is not a style question we can always answer (offsetParent is null for
  // position:fixed too), so this is the conservative set: a node the page has
  // DECLARED hidden. A node we wrongly keep is noise in the tree; a node we
  // wrongly drop is an agent told the button is not there.
  function hidden(el) {
    if (el.hasAttribute('hidden')) return true;
    if ((el.getAttribute('aria-hidden') || '') === 'true') return true;
    if (el.tagName.toLowerCase() === 'input' && (el.getAttribute('type') || '') === 'hidden') return true;
    var st = el.ownerDocument.defaultView.getComputedStyle(el);
    if (st && (st.display === 'none' || st.visibility === 'hidden')) return true;
    return false;
  }

  var interactive = {};
  (opts.interactiveRoles || []).forEach(function (r) { interactive[r] = true; });

  var out = [];
  var seen = {};
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var role = roleOf(el);
    if (!role) continue;
    if (opts.interactiveOnly && !interactive[role]) continue;
    if (hidden(el)) continue;
    var name = nameOf(el);
    var key = role + '/' + name;
    seen[key] = (seen[key] || 0) + 1;
    out.push({ role: role, name: name, n: seen[key], el: el });
  }

  // The #n suffix is only written when it DISAMBIGUATES. A ref that carries an
  // ordinal it does not need is a ref that breaks when an unrelated second copy
  // of the element appears; a ref that omits one it does need is ambiguous. So
  // the suffix is decided after the whole walk, from the final counts.
  var total = {};
  out.forEach(function (o) { var k = o.role + '/' + o.name; total[k] = (total[k] || 0) + 1; });

  var marker = null;
  var nodes = out.map(function (o, idx) {
    var base = o.role + '/' + o.name;
    var ref = total[base] > 1 ? base + '#' + o.n : base;
    if (opts.mark && ref === opts.mark && marker === null) {
      marker = 'r' + idx;
      o.el.setAttribute('data-5dive-ref', marker);
    }
    return { ref: ref, role: o.role, name: o.name, tag: o.el.tagName.toLowerCase() };
  });

  // ---- ONE SNAPSHOT PER DECISION (DIVE-4653) --------------------------------
  //
  // An agent deciding what to do on a page needs three things: what it can act
  // on (the refs above), what the page SAYS (the DOM, which the pinned extractor
  // turns into Markdown), and where it actually ended up (the post-redirect URL
  // and title). Until this flag those were three separate commands, each opening
  // its own browser and loading the same URL again — `tree` here, `read` through
  // a second chrome with --dump-dom, `shot` through a third with --screenshot.
  //
  // Three loads is not only slow, it is three DIFFERENT page instants: a ref
  // `tree` printed can be missing from the DOM `read` captured a few seconds
  // later, and neither output says so. Reading the extra fields HERE, inside the
  // walk that is already standing in the page, makes the whole payload one
  // instant by construction — there is no window for the page to move in.
  //
  // It is a FLAG ON THE SAME WALK rather than a second page-side function on
  // purpose. The file's own invariant is "one walk, not two": if the snapshot
  // enumerated elements by its own copy of this code, a ref printed by `snapshot`
  // and a ref resolved by `run` could drift apart, which is the expensive
  // failure (clicking the wrong thing inside a real account). Callers that do not
  // pass the flag get the byte-identical old return value.
  if (opts.snapshot) {
    var doc = document.documentElement;
    return {
      nodes: nodes,
      marker: marker,
      title: document.title || '',
      url: location.href,
      html: doc ? doc.outerHTML : '',
    };
  }
  return { nodes: nodes, marker: marker };
}

const REF_PREFIX = 'ref=';
const isRef = (s) => typeof s === 'string' && s.startsWith(REF_PREFIX);
const refBody = (s) => s.slice(REF_PREFIX.length);

async function walk(page, { interactiveOnly = false, mark = null } = {}) {
  return page.evaluate(pageWalk, {
    interactiveOnly,
    interactiveRoles: INTERACTIVE,
    mark,
  });
}

// THE ATOMIC READ (DIVE-4653). One page.evaluate, one DOM instant, everything a
// decision needs: the addressable nodes, the document the extractor will read,
// the title and the URL the page actually settled on after its redirects.
//
// The caller gets `html` as a string and is expected to put it on disk and hand
// it to the SAME pinned extractor `read` uses. That split is deliberate: the
// Markdown, the links and the word count stay the pinned extractor's answer
// about bytes we can hash and re-extract, rather than a second summariser living
// in the page where nobody can check it.
async function snapshot(page, { interactiveOnly = false } = {}) {
  return page.evaluate(pageWalk, {
    interactiveOnly,
    interactiveRoles: INTERACTIVE,
    mark: null,
    snapshot: true,
  });
}

// ref=  ->  a CSS selector for the one element it names, or a refusal.
//
// AMBIGUITY IS A REFUSAL, not a first-match. `run` acts inside a real account:
// "there were two Send buttons and I took one" is the shape that mails a draft
// to the wrong thread. The walk already appends #n wherever a base ref is not
// unique, so a bare ref reaching here with two candidates means the page changed
// under the agent between `tree` and `run` — which is precisely when guessing is
// most expensive.
async function resolveRef(page, sel) {
  const ref = refBody(sel);
  const { nodes, marker } = await walk(page, { mark: ref });
  if (marker) return `[data-5dive-ref="${marker}"]`;
  const roleOnly = ref.split('/')[0];
  const near = nodes.filter((n) => n.role === roleOnly).slice(0, 8).map((n) => `ref=${n.ref}`);
  const hint = near.length
    ? ` Refs of that role on this page: ${near.join(', ')}.`
    : ` No ${roleOnly} is on this page at all.`;
  const err = new Error(
    `ref=${ref} matches nothing on this page. A ref is <role>/<accessible name>[#n] and is re-derived ` +
    `from the page every time, so this means the page is not the one \`tree\` described — not that the ` +
    `ref was mistyped.${hint}`);
  err.refMiss = true;
  throw err;
}

// The selector a step should be executed with. A plain CSS selector is returned
// untouched and never touches the page — the ref path is the only one that pays
// for a walk, so nothing about the existing executor gets slower.
async function resolveSelector(page, sel) {
  return isRef(sel) ? resolveRef(page, sel) : sel;
}

function render(nodes, { json = false } = {}) {
  if (json) return JSON.stringify({ nodes }, null, 2);
  const w = nodes.reduce((m, n) => Math.max(m, n.role.length), 0);
  return nodes.map((n) => {
    const nm = n.name ? ` "${n.name}"` : ' (no accessible name — it cannot be addressed by ref)';
    return `${n.role.padEnd(w)}${nm}\n${' '.repeat(w + 2)}ref=${n.ref}`;
  }).join('\n');
}

module.exports = { INTERACTIVE, pageWalk, walk, snapshot, resolveRef, resolveSelector, isRef, render, REF_PREFIX };

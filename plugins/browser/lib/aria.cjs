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

const cp = require('child_process');
const path = require('path');

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
  err.nodes = nodes;   // the page as it was looked at, for resolveOrRepick
  throw err;
}

// The selector a step should be executed with. A plain CSS selector is returned
// untouched and never touches the page — the ref path is the only one that pays
// for a walk, so nothing about the existing executor gets slower.
async function resolveSelector(page, sel) {
  return isRef(sel) ? resolveRef(page, sel) : sel;
}

// ---- a ref that is not there YET (DIVE-4674) --------------------------------
//
// THE DEFECT. `resolveRef` walks the page ONCE and throws, and the step loops
// resolved every selector through it before the switch. So a CSS `wait_for`
// polled for the whole step timeout via page.waitForSelector, and a ref
// `wait_for` — the same instruction, written the way this plugin tells agents to
// write it — probed for 0 ms and failed. Measured on a GitHub issue page: `tree`
// at the default settle showed 54 nodes and no textbox, at settle=6000 it showed
// 76 including `textbox/Add a comment`, and `run` (which had no settle at all)
// resolved ~50 ms after domcontentloaded and reported that no textbox was on the
// page at all. The refusal was accurate about the instant it looked at and wrong
// about the page.
//
// THE LAST ERROR IS RETHROWN UNCHANGED, deliberately. Its message is the one
// that names the refs that ARE on the page, and the exit-code contract downstream
// keys on `refMiss` — a wrapper saying "timed out" would lose the hint the
// operator reads and the 70-on-step-one that stops a phantom re-read.
async function resolveRefWithin(page, sel, { timeoutMs = 30000, pollMs = 250 } = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    try {
      return await resolveRef(page, sel);
    } catch (e) {
      // Only a refMiss is worth waiting out. Anything else (a closed page, a
      // navigation mid-walk) is not going to resolve by being asked again.
      if (!e.refMiss || Date.now() >= deadline) throw e;
      await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    }
  }
}

// WHICH STEPS WAIT, and why it is only this one. `wait_for` exists to say "the
// page is not ready yet"; giving it the poll makes a ref `wait_for` mean what a
// CSS `wait_for` already meant. `fill`/`click`/`press`/`select`/`upload` keep the
// one-shot resolve: an adapter that needs to wait says so with a `wait_for`
// step, and a `click` that hovered for thirty seconds would turn "this is not the
// page `tree` described" into the same wrong answer, thirty seconds later, inside
// somebody's live account.
async function resolveStepSelector(page, step, { timeoutMs = 30000, pollMs = 250 } = {}) {
  const sel = step.selector;
  if (sel === undefined) return undefined;
  if (!isRef(sel)) return sel;
  if (step.op === 'wait_for') return resolveRefWithin(page, sel, { timeoutMs, pollMs });
  return resolveRef(page, sel);
}

// ---- A REF WHOSE ELEMENT IS REPLACED IS FOUND AGAIN (DIVE-5335) --------------
//
// THE DEFECT. A ref resolves ONCE, to a marker attribute on the element the walk
// saw. A page that swaps that element for a new one leaves the marker on a node
// that is no longer in the document, and the step then waits out its whole
// timeout for a selector nothing can match. Measured on en.wikipedia.org: `fill`
// on `ref=searchbox/Search Wikipedia#1` focused the server-rendered input, the
// focus loaded the typeahead, the typeahead mounted a NEW input in its place
// (keeping the value and the focus), and `press Enter` on the same ref timed out
// at 30 s with "element was detached from the DOM, retrying". Every `replay` of
// that routine would have failed the same way.
//
// THE FIX. The step runs in short attempts. When an attempt fails AND the marker
// now matches nothing, the ref is resolved again — the same role and accessible
// name, re-derived from the page as it is now — and the step runs on that, until
// the step's own timeout. A marker that is still on the page keeps its selector:
// that element exists and is only slow, which is the old wait, unchanged.
//
// IT NEVER RE-RUNS A STEP THAT MAY HAVE ACTED. A re-run is allowed only when the
// failure says the element was detached BEFORE the action (Playwright's call log)
// and the page is still on the URL it was on: a click that navigated and then
// timed out has acted, and running it again on the next page is a double action
// in somebody's account. `type` is never re-run at all — it types key by key, so
// a half-typed value re-typed is a wrong value. A plain CSS selector is the
// agent's own and is never re-resolved.
//
// THE OWNER'S CHECK IS READ AGAIN on the element found again (`check`), because
// for `press` it reads the form around the element, and a new element can sit
// in a new form.
const REFIND_OPS = { fill: 1, click: 1, press: 1, select: 1, upload: 1 };
const REFIND_ATTEMPT_MS = 5000;
const actedAlready = (msg) => /action done|navigat/i.test(String(msg || ''));
async function onRef(page, step, sel, act, { timeoutMs = 30000, attemptMs = REFIND_ATTEMPT_MS, check = null, log = null } = {}) {
  if (!isRef(step.selector) || !REFIND_OPS[step.op]) return act(sel, timeoutMs);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let cur = sel, refound = 0;
  for (;;) {
    const left = deadline - Date.now();
    let urlBefore = '';
    try { urlBefore = String(await page.url()); } catch (e) { /* compared as '' */ }
    try {
      return await act(cur, Math.max(1, Math.min(attemptMs, left)));
    } catch (e) {
      if (Date.now() >= deadline - 50) throw e;
      let gone = false;
      try { gone = (await page.locator(cur).count()) === 0; } catch (x) { throw e; }
      if (!gone) {
        // Still on the page: only slow. A non-timeout failure is a real one.
        if (!(e && e.name === 'TimeoutError')) throw e;
        continue;
      }
      let urlNow = '';
      try { urlNow = String(await page.url()); } catch (x) { /* compared as '' */ }
      if (actedAlready(e && e.message) || urlNow !== urlBefore) throw e;
      let next;
      try { next = await resolveRefWithin(page, step.selector, { timeoutMs: Math.max(0, deadline - Date.now()) }); }
      catch (x) { if (x.refMiss) throw e; throw x; }
      if (check && !(await check(next))) {
        e.message += ` The element was replaced, and the one found again for ${step.selector} is not one this step may act on without the owner, so it was not retried.`;
        throw e;
      }
      refound++;
      if (log) log(`step ${step.selector}: the element was replaced on the page; found it again (${refound}x)`);
      cur = next;
    }
  }
}

// ---- TYPE: KEY BY KEY --------------------------------------------------------
//
// `fill` sets the value in ONE input event, with no keydown, keypress or keyup,
// so a search box whose suggestions open on keystrokes never opens. Measured on
// a hotel search: fill "Lisbon" then Search went to the results for an empty
// city ("0 properties found"); fill "Lisbo", press "n", wait_for the suggestion
// timed out at 30s. `type` sends the value one key at a time, as a person types
// it. It clears the field first, as fill does, so the step means "the field now
// says this", never "this was appended". Here, not in either step loop, because
// there are two of them.
//
// THE FIRST MATCH, as page.fill takes it: a bare locator is strict and would throw
// on a selector that matches twice, where the same selector in a `fill` works.
//
// THE BOUND GROWS WITH THE TEXT. Playwright's timeout covers the whole typing,
// delays included, so 600 characters at 50 ms is the whole default 30 s: a flat
// bound would cut a long message off half-typed.
//
// A LINE BREAK IS THE ENTER KEY. pressSequentially sends "\n" and "\r" as Enter,
// which submits the form the box is in, and Enter is a step the owner's policy
// reads (stepRisk). Typed inside a value it would never be read, so a `type`
// value with a line break is refused: press Enter as its own step.
const TYPE_DELAY_DEFAULT = 50;
const TYPE_DELAY_MAX = 1000;
function typeDelay(v) {  // a step's delay_ms -> ms between keys, or null when it is not one
  if (v === undefined) return TYPE_DELAY_DEFAULT;
  return Number.isInteger(v) && v >= 0 && v <= TYPE_DELAY_MAX ? v : null;
}
function typeRefusal(delayMs, value) {  // why a `type` step cannot run, or null
  if (typeDelay(delayMs) === null) {
    return `has delay_ms ${JSON.stringify(delayMs)} — it takes whole milliseconds between keys, ` +
      `0 to ${TYPE_DELAY_MAX} (default ${TYPE_DELAY_DEFAULT})`;
  }
  if (/[\r\n]/.test(value)) {
    return 'has a line break in its value — typed, that is the Enter key, which sends the form ' +
      'without the owner\'s policy reading it. Press Enter as its own step, or fill multi-line text';
  }
  return null;
}
async function typeKeys(page, sel, value, delayMs, { timeoutMs = 30000 } = {}) {
  const box = page.locator(sel).first();
  await box.clear({ timeout: timeoutMs });
  await box.pressSequentially(value, { delay: delayMs, timeout: timeoutMs + [...value].length * delayMs });
}

// ---- THE OWNER'S FOUR (DIVE-4943) ------------------------------------------
//
// An agent may click and type anywhere, but four kinds of act are the owner's to
// allow: paying, publishing, sending and deleting. They are named by what the
// element SAYS, read off the live page at the moment before the step, and not by
// the selector the agent wrote: `#btn-3` and `ref=button/Place your order` are
// the same click, and a rule keyed on how the agent spelled the target would
// be walked by spelling it differently.
//
// WHAT IS READ. For `click`: the element's accessible label (aria-label, the
// visible text, a button's value, its title), plus the ref's own name when the
// step used a ref. For `press`: inside a form, Enter submits that form, so it is
// the label of the form's submit button; a modifier+Enter is the send/post
// shortcut on every composer that has one (X, Slack, GitHub comments), so it is
// refused as `send` without reading anything — a composer rarely carries a label
// that says so, and guessing "harmless" there is the expensive direction.
//
// A PLAIN ENTER WITH NO FORM IS NOT "NO FORM, NOTHING SUBMITTED" (DIVE-620). A chat
// composer is a contenteditable with no <form> around it, and a plain Enter is its
// send key: on Telegram Web `fill` then `press Enter` delivered a message past
// send=ask, because there was no form to read a submit button from, the label was
// '', and '' classifies as nothing. So a plain Enter on a formless composer — the
// target, or the focused element when the target is not one: `contenteditable`,
// `textarea` or `[role=textbox]` — is `send`, without reading a label, by the same
// rule as modifier+Enter. A formless search box (`input[type=search]`, a plain
// text input) is not a composer and keeps running without an ask. Shift+Enter is
// a composer's NEW LINE, not its send key, so it is not caught here.
//
// IT IS A GUARD, NOT A CLASSIFIER OF INTENT. It catches the literal buttons. An
// agent that submits an order through a button labelled "Continue" is not caught
// here, and saying so is better than a pattern list that pretends otherwise.
const RISK = [
  ['pay', /\b(buy|buy now|purchase|place (your |my )?order|order now|confirm (order|purchase|payment)|complete (order|purchase|payment)|pay( now)?|checkout|check out|proceed to (checkout|payment)|subscribe|donate|book now|start (free )?trial|upgrade( now)?)\b/i],
  ['publish', /\b(post|publish|tweet|reply|repost|retweet|share|comment|submit|save and publish|go live)\b/i],
  ['send', /\b(send|send now|send message|send email)\b/i],
  ['delete', /\b(delete|remove|discard|erase|trash|destroy|deactivate|close (my )?account|unsubscribe|empty trash)\b/i],
];
function classifyLabel(label) {
  const l = String(label || '').replace(/\s+/g, ' ').trim();
  if (!l) return null;
  for (const [cls, re] of RISK) if (re.test(l)) return cls;
  return null;
}
// In the page. Kept tiny and free of closures: page.evaluate serialises it.
function _labelIn(arg) {
  const el = document.querySelector(arg.sel);
  if (!el) return '';
  const txt = (n) => n ? [n.getAttribute && n.getAttribute('aria-label'), n.innerText, n.value, n.title]
    .filter((x) => typeof x === 'string' && x.trim()).join(' ').slice(0, 160) : '';
  if (arg.op !== 'press') return txt(el);
  const form = el.form || (el.closest && el.closest('form'));
  if (!form) return '';
  const sub = form.querySelector('button[type=submit],input[type=submit],button:not([type])');
  return txt(sub) || String(form.getAttribute('action') || '');
}
// Is a plain Enter here a formless composer's send key? In the page, like _labelIn.
function _composerIn(arg) {
  var el = null;
  try { el = arg.sel ? document.querySelector(arg.sel) : null; } catch (e) { el = null; }
  function formless(n) { return !(n.form || (n.closest && n.closest('form'))); }
  function composer(n) {
    if (!n) return false;
    if (n.isContentEditable === true) return true;
    try { return !!(n.matches && n.matches('[contenteditable=""],[contenteditable=true],[contenteditable=plaintext-only],textarea,[role=textbox]')); }
    catch (e) { return false; }
  }
  if (el && !formless(el)) return false;
  if (el && composer(el)) return true;
  var a = document.activeElement;
  return !!(a && a !== el && composer(a) && formless(a));
}
// WHAT THE OWNER IS SAYING YES TO (DIVE-4982). A button label is not an answer to
// "OK?": measured on a Gmail send, the ask read `"Send (Ctrl-Enter) Send". OK?`,
// with no recipient, no subject and no text. So before the step, the page is read
// for what the step will act on — in the form or dialog around the button, the
// document if there is none:
//   send     to (every address in a To/Cc/Bcc field or recipient chip; with a
//            chip on the page, chips and input values only), subject,
//            first_line of the body
//   pay      payee (a field that names one, else the site), amount (a price on
//            the button, else on a "total" line, else the first on the page)
//   publish  text, the first 280 characters of the composer
//   delete   item: the row, list item or dialog heading the button belongs to
// It is a READ of well-known shapes, not an understanding of the page: a field it
// does not recognise is missing from the payload, and bin/browser then says the
// page did not show it — it never fills the gap with the button's label.
// In the page, so it closes over nothing.
function _payloadIn(arg) {
  function norm(x) { return String(x || '').replace(/\s+/g, ' ').trim(); }
  function text(n) { return n ? norm(n.innerText || n.textContent || n.value || '') : ''; }
  function all(root, q) { try { return Array.prototype.slice.call(root.querySelectorAll(q)); } catch (e) { return []; } }
  var el = null;
  try { el = arg.sel ? document.querySelector(arg.sel) : null; } catch (e) { el = null; }
  if (!el && arg.op === 'press') el = document.activeElement || null;
  var root = (el && el.closest && el.closest('form,[role=dialog],dialog')) || document;
  var first = function (q) { var n = all(root, q); for (var i = 0; i < n.length; i++) { var v = text(n[i]); if (v) return v; } return ''; };
  var out = {};
  if (arg.cls === 'send') {
    // A chip's `email` attribute is the address. The field around it is not: in
    // Gmail its text is the chip's glued to the hover card's, `user@x.comLoading...`,
    // and no pattern can split `com` from `comLoading`. So with any [email] node in
    // the form, the addresses are those attributes and input values only; a field's
    // text is read only on a page with no [email] node at all.
    var to = [], seen = {}, chips = all(root, '[email]').length > 0;
    all(root, '[email],input[name=to],input[name=cc],input[name=bcc],textarea[name=to],[aria-label^="To"],[aria-label^="Cc"],[aria-label^="Bcc"]').forEach(function (n) {
      var v = (n.getAttribute && n.getAttribute('email')) || n.value || (chips ? '' : text(n));
      (String(v || '').match(/[^\s<>,;"'()]+@[^\s<>,;"'()]+/g) || []).forEach(function (a) { if (!seen[a]) { seen[a] = 1; to.push(a); } });
    });
    if (to.length) out.to = to;
    var subj = first('input[name=subject],input[name=subjectbox],[aria-label="Subject"],input[placeholder="Subject"]');
    if (subj) out.subject = subj;
    var body = all(root, '[aria-label="Message Body"],[aria-label="Message body"],textarea[name=body],[role=textbox][contenteditable=true],[contenteditable=true],textarea');
    for (var i = 0; i < body.length; i++) {
      var raw = String(body[i].innerText || body[i].value || body[i].textContent || '');
      var line = raw.split(/\r?\n/).map(norm).filter(Boolean)[0] || '';
      if (line) { out.first_line = line.slice(0, 200); break; }
    }
  } else if (arg.cls === 'pay') {
    var money = /(?:[$€£¥₽₹]|\b(?:USD|EUR|GBP|RUB|INR|JPY|CAD|AUD)\b)\s?\d(?:[\d.,]*\d)?|\d(?:[\d.,]*\d)?\s?(?:[$€£¥₽₹]|\b(?:USD|EUR|GBP|RUB|INR|JPY|CAD|AUD)\b)/;
    var m = text(el).match(money);
    if (!m) { var lines = String((root.innerText || root.textContent || '')).split(/\r?\n/);
      for (var j = 0; j < lines.length && !m; j++) if (/total/i.test(lines[j])) m = lines[j].match(money);
      if (!m) m = String(root.innerText || root.textContent || '').match(money); }
    if (m) out.amount = norm(m[0]);
    var payee = first('[aria-label*="payee" i],[data-payee],[name=payee]');
    out.payee = payee || String((document.location && document.location.hostname) || '');
  } else if (arg.cls === 'publish') {
    var t = first('[role=textbox],[contenteditable=true],textarea');
    if (t) out.text = t.slice(0, 280);
  } else if (arg.cls === 'delete') {
    var item = el && el.closest ? el.closest('tr,li,[role=row],[role=listitem],article') : null;
    var name = item ? text(item) : first('[role=dialog] h1,[role=dialog] h2,dialog h1,dialog h2,[role=dialog] [role=heading]');
    if (name) out.item = name.slice(0, 160);
  }
  return out;
}

// Bidi and control characters out of anything an owner reads (DIVE-4982): the
// live Send label carried U+202A/U+202C, which can turn what is displayed around
// the shortcut into something else; C0/C1 can move a terminal's cursor.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
function cleanText(x) {
  return String(x == null ? '' : x).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
}
function cleanPayload(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  for (const [k, v] of Object.entries(p)) {
    if (Array.isArray(v)) { const a = v.map(cleanText).filter(Boolean); if (a.length) out[k] = a; }
    else { const c = cleanText(v); if (c) out[k] = c; }
  }
  return out;
}

async function stepRisk(page, step, sel) {
  if (!step || (step.op !== 'click' && step.op !== 'press')) return null;
  let cls = null, label = '';
  if (step.op === 'press') {
    const key = String(step.key || '');
    if (!/(^|\+)Enter$/i.test(key)) return null;
    if (/(Control|Meta|Ctrl|Cmd)\+/i.test(key)) { cls = 'send'; label = key; }
    else if (/^Enter$/i.test(key)) {
      let composer = false;
      try { composer = (await page.evaluate(_composerIn, { sel, op: step.op, composerOf: true })) === true; } catch (e) { composer = false; }
      if (composer) { cls = 'send'; label = `${key} in a composer with no form`; }
    }
  }
  if (!cls) {
    const refName = isRef(step.selector) ? refBody(step.selector).replace(/^[^/]*\//, '').replace(/#\d+$/, '') : '';
    let live = '';
    try { live = await page.evaluate(_labelIn, { sel, op: step.op, riskOf: true }); } catch (e) { live = ''; }
    label = [refName, live].filter(Boolean).join(' | ').slice(0, 200);
    cls = classifyLabel(label);
  }
  if (!cls) return null;
  let payload = {};
  try { payload = await page.evaluate(_payloadIn, { sel, op: step.op, cls, payloadOf: true }); } catch (e) { payload = {}; }
  return { cls, label: cleanText(label), payload: cleanPayload(payload) };
}

// ---- A TARGET THAT IS NOT THERE: ONE RETRY, ON ONE PICKED ELEMENT ------------
//
// Measured on a hotel site: `act` step 2, `click ref=button/Decline`, failed
// "matches nothing on this page". The consent banner's button was there, under
// another accessible name, and the agent had to snapshot, read and send the whole
// act again. So a step whose ref matches nothing gets ONE retry, on one element
// picked for it:
//   reflex   when the box has it configured: `5dive reflex pick-ref` (DIVE-4929)
//            on the page's interactive tree, taken at confidence >= 0.9 only,
//            reached through bin/browser `_reflex-pick` and so through _reflex_cli.
//   by name  otherwise, and when reflex errors: the ONE element of the ref's own
//            role whose name equals the ref's (any case, whitespace trimmed),
//            contains it, or is contained in it. Two, and there is no pick.
// Reflex answering "none", or under 0.9, IS an answer: the step fails as it did,
// and the failure says what reflex said.
//
// NEVER A STEP THAT PAYS, POSTS, SENDS OR DELETES. The owner's yes, and the
// policy that let a kind through, cover the step as written; a retargeted Send is
// another send. stepRisk reads it (the ref's own name, the picked element's live
// label), and so does pick-ref's review_required; such a step fails as it did,
// naming the suggestion.
//
// WHAT LEAVES THE BOX is what pick-ref sends: the intent, the op, the interactive
// tree's roles and names. A value goes as `{value}`: pick-ref never shows the
// model the value, and argv is readable by every seat on the box.
//
// A REF MISS ONLY. A CSS selector that matches nothing fails by timing out, and a
// timeout is not a miss the executor can tell from a slow page.
const REPICK_MIN_CONFIDENCE = 0.9;
const REPICK_OP = { click: 'click', fill: 'fill', type: 'fill', select: 'select',
  press: 'press', wait_for: 'wait_for', upload: 'upload' };
const SELF_BROWSER = path.join(__dirname, '..', 'bin', 'browser');

function refParts(ref) {  // 'button/Decline#2' -> { role: 'button', name: 'Decline' }
  const role = ref.split('/')[0];
  return { role, name: ref.slice(role.length + 1).replace(/#\d+$/, '') };
}

// The by-name tier: EVERY node that qualifies, so the caller can see there were two.
function nameMatches(nodes, ref) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const { role, name } = refParts(ref);
  const want = norm(name);
  if (!want) return [];
  return (nodes || []).filter((n) => {
    const have = norm(n.name);
    return n.role === role && have !== '' && (have === want || have.includes(want) || want.includes(have));
  });
}

// bin/browser `_reflex-pick`, the tree on stdin. Never throws: anything that is
// not its one line of JSON is {reflex:"error"}, and the name match decides.
function reflexPick(site, args, tree, { timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    let out = '', child = null, timer = null;
    const done = (r) => { clearTimeout(timer); resolve(r); };
    try { child = cp.spawn(SELF_BROWSER, ['_reflex-pick', site, ...args], { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (e) { return resolve({ reflex: 'error', why: e.message }); }
    timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* already gone */ } }, timeoutMs);
    child.on('error', (e) => done({ reflex: 'error', why: e.message }));
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      let r = null;
      try { r = JSON.parse(out.trim().split('\n').pop()); } catch (e) { r = null; }
      done(code === 0 && r && typeof r === 'object' ? r : { reflex: 'error', why: `_reflex-pick exited ${code}` });
    });
    child.stdin.on('error', () => { /* it exited before reading the tree; its exit says why */ });
    child.stdin.end(JSON.stringify(tree));
  });
}

// What both step loops call instead of resolveStepSelector: { sel, retry }. `retry`
// is null, or the start of the line the loop ends with "ok" or "failed". With no
// retry the miss is thrown as it always was, its message extended by what reflex
// said, so a miss on step one is still "nothing ran". `n` is the step's number.
async function resolveOrRepick(page, step, n, opts = {}) {
  let miss;
  try { return { sel: await resolveStepSelector(page, step, opts), retry: null }; }
  catch (e) { if (!e.refMiss || !REPICK_OP[step.op]) throw e; miss = e; }
  const failAs = (why) => { miss.message += why; return miss; };
  const from = step.selector;
  const { role, name } = refParts(refBody(from));
  const op = REPICK_OP[step.op];
  const intent = (typeof step.intent === 'string' && step.intent.trim()
    ? step.intent.trim() : (name ? `${role} named ${name}` : role)).slice(0, 200);
  const args = [`--op=${op}`, `--intent=${intent}`];
  if (op === 'fill' || op === 'select') args.push('--value={value}');
  if (op === 'press') args.push(`--key=${step.key}`);
  if (op === 'upload') args.push('--path={path}');
  let url = '', site = '';
  try { url = String(await page.url()); site = new URL(url).hostname; } catch (e) { site = ''; }
  const tree = { url, nodes: (miss.nodes || []).filter((x) => INTERACTIVE.includes(x.role)) };
  const r = site ? await reflexPick(site, args, tree) : { reflex: 'error', why: 'the page has no host name' };

  let pick;
  if (r.reflex === 'ok' && !(r.error && r.error !== 'no_candidates')) {
    const conf = typeof r.confidence === 'number' ? r.confidence : null;
    if (!r.ref) throw failAs(' Reflex proposed no element for it.');
    if (conf === null || conf < REPICK_MIN_CONFIDENCE) {
      throw failAs(` Reflex suggested ref=${r.ref} at confidence ${conf}, under ${REPICK_MIN_CONFIDENCE}, so it was not retried.`);
    }
    pick = { ref: r.ref, line: `reflex picked ref=${r.ref} (conf ${conf})`,
             said: `Reflex picked ref=${r.ref} (conf ${conf})`, review: r.review_required === true };
  } else {
    // Off: the name match alone, and a miss it cannot settle reads exactly as before.
    const why = r.reflex === 'off' ? ''
      : ` Reflex could not pick one (${cleanText(r.why || r.error || 'no answer').slice(0, 160)}).`;
    const hits = nameMatches(miss.nodes, refBody(from));
    if (hits.length !== 1) throw failAs(why);
    pick = { ref: hits[0].ref, line: `name match picked ref=${hits[0].ref}`,
             said: `${why ? `${why.trim()} ` : ''}A name match picked ref=${hits[0].ref}`, review: false };
  }
  let sel;
  try { sel = await resolveRef(page, REF_PREFIX + pick.ref); }
  catch (e) { if (!e.refMiss) throw e; throw failAs(` ${pick.said}, and that matches nothing either.`); }
  const risk = pick.review ? { cls: 'pay, post, send or delete' } : await stepRisk(page, step, sel);
  if (risk) {
    throw failAs(` ${pick.said}, and it was not retried: this step would ${risk.cls}, and a step that pays, ` +
      'posts, sends or deletes is never retargeted — the owner\'s yes covers the step as written.');
  }
  return { sel, retry: `step ${n}: ${from} matched nothing; ${pick.line}; retried: ` };
}

// ---- READY, NOT SETTLED (DIVE-4983) -----------------------------------------
//
// A settle is a guess at how long a page takes, and on a web app it is the wrong
// guess. Gmail answers domcontentloaded with its loading splash: `snapshot
// --interactive` on the inbox printed 4 nodes (help-centre links, "Try reloading
// the page") with rc 0, twice, and the loaded inbox was never captured by any
// verb. The caller usually knows what the real page has — `[role=main]`, a
// Compose button — so the capture can wait for the page to SAY it is ready.
//
// THE TARGET, in three shapes:
//   ref=<role>/<name>[#n]  the ref `snapshot` prints; ready when the walk lists it
//   text=<words>           ready when the visible text contains it (any case)
//   anything else          a CSS selector with a rendered match — and a bare word
//                          that matches no element (`Compose`) is also looked for
//                          as visible text, because that is what the caller meant
//
// In the page, so it closes over nothing (page.evaluate serialises it).
function _visibleIn(arg) {
  var t = String(arg.target || '');
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').toLowerCase(); }
  function shown(el) {
    var r = el.getClientRects ? el.getClientRects() : null;
    if (!r || !r.length) return false;
    var st = el.ownerDocument.defaultView.getComputedStyle(el);
    return !(st && (st.display === 'none' || st.visibility === 'hidden'));
  }
  var body = document.body;
  var text = norm(body ? (body.innerText || body.textContent) : '');
  if (arg.mode === 'text') return text.indexOf(norm(t)) >= 0;
  var els = null;
  try { els = document.querySelectorAll(t); } catch (e) { els = null; }
  if (els) for (var i = 0; i < els.length; i++) if (shown(els[i])) return true;
  return text.indexOf(norm(t)) >= 0;
}

// The text a person would read on the page right now: the rendered body, plus
// every live region (toasts, `role=alert`, `aria-live`) whether or not its
// styling hides it from innerText — a toast is exactly the text `--expect` is
// usually written against, and it is there for a few seconds only.
function _textIn() {
  var parts = [];
  var b = document.body;
  if (b) parts.push(b.innerText || b.textContent || '');
  var live = document.querySelectorAll('[aria-live],[role=alert],[role=status],[role=log]');
  for (var i = 0; i < live.length; i++) parts.push(live[i].textContent || '');
  return parts.join('\n').replace(/[ \t]+/g, ' ');
}

// The ONE element a verify is graded on (DIVE-4984): a Sent list is read at its
// newest row, so an older message with the same subject further down cannot
// stand in for the one just sent. The first match in document order, or null —
// and null is a miss, never "grade the whole page instead".
function _scopeIn(arg) {
  var el = null;
  try { el = document.querySelector(String(arg.scope || '')); } catch (e) { el = null; }
  if (!el) return null;
  return { html: String(el.outerHTML || ''),
           text: String(el.innerText || el.textContent || '').replace(/[ \t]+/g, ' ') };
}

async function visibleNow(page, target) {
  if (isRef(target)) {
    const want = refBody(target);
    const { nodes } = await walk(page, {});
    return nodes.some((n) => n.ref === want);
  }
  const text = target.startsWith('text=');
  return !!(await page.evaluate(_visibleIn,
    { target: text ? target.slice(5) : target, mode: text ? 'text' : 'auto', visibleOf: true }));
}

// Poll until the target is visible, for at most `timeoutMs`. NEVER THROWS on a
// miss: the page as it stands is still captured, and the caller is told
// `met:false` and flags the capture partial — "it never came" is information,
// and an exception here would throw the evidence away with it. Time is counted
// the way probeRequest counts it, in the waits actually asked for.
async function waitForVisible(page, target, { timeoutMs = 30000, pollMs = 250 } = {}) {
  const t = String(target || '');
  let waited = 0;
  for (;;) {
    let ok = false;
    try { ok = await visibleNow(page, t); } catch (e) { ok = false; }  // mid-navigation: look again
    if (ok) return { target: t, met: true, waited_ms: waited };
    if (waited >= timeoutMs) return { target: t, met: false, waited_ms: waited };
    const step = Math.min(pollMs, Math.max(1, timeoutMs - waited));
    await page.waitForTimeout(step);
    waited += step;
  }
}

// `--expect` as an EARLY EXIT, never as the verdict. bin/browser still greps
// what comes back (grep -E, one engine, like the probe's markers), so a pattern
// JS reads differently only costs the full window, never a wrong answer.
function expectRe(p) {
  if (typeof p !== 'string' || !p) return null;
  try { return new RegExp(p, 'i'); }
  catch (e) { const l = p.toLowerCase(); return { test: (s) => String(s).toLowerCase().includes(l) }; }
}

// THE RE-READ AFTER AN ACT (DIVE-4943). The executor's "step ok" says a click
// was dispatched, not what the page did with it. So after the last step the page
// is read again — where it ended up, its title, its document — and that, not the
// step log, is what bin/browser grades `--expect` against. It is read from the
// page as it now stands, never by navigating: a reload would throw away the very
// draft or cart the act just built.
//
// ...AND READ AGAIN UNTIL --expect MATCHES, for a few seconds (DIVE-4983). A
// "Message sent" toast arrives after the click; the one read taken at the settle
// missed it, and `act` printed NOT VERIFIED on a mail that was in the Sent folder.
// The read that matched is the one returned, so the page.html and page.png that
// ship are the instant the toast was on screen. `waitFor` is `--wait-for`, and
// `walk` adds the refs, so an act leaves the same triple a snapshot does.
// `scope` (DIVE-4984) narrows the read to one element: `run`'s in-session verify.
async function pageAfter(page, { settleMs = 0, waitFor = null, waitTimeoutMs = 30000,
                                 expect = null, expectWaitMs = 0, pollMs = 250, walk: walkOpts = null,
                                 scope = null } = {}) {
  const waited = waitFor ? await waitForVisible(page, waitFor, { timeoutMs: waitTimeoutMs, pollMs }) : null;
  if (settleMs > 0) { try { await page.waitForTimeout(settleMs); } catch (e) { /* the read still runs */ } }
  const readNow = async () => {
    const o = { url: '', title: '', html: '', text: '' };
    try { o.url = String(await page.url()); } catch (e) { /* recorded empty */ }
    try { o.title = String(await page.title()); } catch (e) { /* recorded empty */ }
    if (scope) {
      // SCOPED (DIVE-4984): the document and the text are that one element's, so
      // what bin/browser greps cannot reach past it. Not found reads as empty.
      let hit = null;
      try { hit = await page.evaluate(_scopeIn, { scope, scopeOf: true }); } catch (e) { hit = null; }
      o.html = hit ? String(hit.html || '') : '';
      o.text = hit ? String(hit.text || '') : '';
      o.scope = { selector: scope, found: !!hit };
      return o;
    }
    try { o.html = String(await page.content()); } catch (e) { /* recorded empty */ }
    try { o.text = String(await page.evaluate(_textIn, { textOf: true }) || ''); } catch (e) { /* recorded empty */ }
    return o;
  };
  const re = expectRe(expect);
  let out = await readNow(), polled = 0;
  while (re && !re.test(out.text) && !re.test(out.html) && polled < expectWaitMs) {
    const step = Math.min(pollMs, expectWaitMs - polled);
    try { await page.waitForTimeout(step); } catch (e) { break; }
    polled += step;
    out = await readNow();
  }
  if (walkOpts) {
    try { out.nodes = (await walk(page, { interactiveOnly: !!walkOpts.interactiveOnly })).nodes; }
    catch (e) { out.nodes = null; }
  }
  if (waited) out.wait_for = waited;
  if (re) out.expect_polled_ms = polled;
  return out;
}

// The line bin/browser keys on. One line, a fixed prefix, JSON after it, so the
// refusal can name the ask without a second parser for prose.
const NEEDS_OWNER_PREFIX = '5dive-needs-owner: ';
const E_NEEDS_OWNER = 73;
// ...and the line for a step the owner's POLICY allowed without asking (DIVE-4982):
// the step runs, and bin/browser writes it to the owner's log.
const OWNER_ALLOWED_PREFIX = '5dive-owner-allowed: ';

// ...and the line for THE STEP THAT FAILED (DIVE-4990), from both loops alike: an
// `act` whose step 2 failed printed "verified" because --expect matched the page
// the goto left, and the failure named no step. bin/browser keys on this line to
// fail the run whatever --expect matched, and to say which step it was.
const STEP_FAILED_PREFIX = '5dive-step-failed: ';
function failedStep(index, step, e) {
  const where = `step ${index} (${step.op})`;
  let error = String((e && e.message) || e || 'failed').split('\n')[0].trim();
  if (error.startsWith(`${where}: `)) error = error.slice(where.length + 2);
  return { index, op: step.op, selector: step.selector || null, error: error.replace(/\.$/, '') };
}

// ---- WHERE A GOTO LANDED (DIVE-4991) ----------------------------------------
//
// A cold `act` of a Booking search URL landed on the undated city page every
// time, a URL copied from a real browser included, and the next step's failure
// ("a step failed, the executor exited 1") was all anyone saw. The served
// browser, same profile and same URL, landed on the results. So after every goto
// both loops compare the URL asked for with the one the page is on, and say so.
//
// THE BASE TEST, no model: redirected when the PATH changed, or when more than
// half of the requested query keys are gone. Only the fragment changing, or the
// same path with params ADDED (a tracking id), is the page that was asked for.
// A trailing slash is not a different page either.
function redirectWhy(requested, landed) {
  let a, b;
  try { a = new URL(requested); b = new URL(landed); } catch (e) { return null; }
  const trim = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  if (trim(a.pathname) !== trim(b.pathname)) return `path ${a.pathname} became ${b.pathname}`;
  const asked = [...new Set(a.searchParams.keys())];
  const gone = asked.filter((k) => !b.searchParams.has(k));
  if (asked.length && gone.length * 2 > asked.length) {
    return `${gone.length} of ${asked.length} query keys dropped: ${gone.slice(0, 5).join(' ')}`;
  }
  return null;
}

// THE OPTIONAL TIER: `5dive reflex landing`, only where bin/browser found reflex
// configured, because this is where page text leaves the box. Reached through
// bin/browser `_reflex-landing` (and so through _reflex_cli, like every reflex
// call). Never throws: anything that is not its one line of JSON is an error,
// and on an error the base verdict stands. Its own names, required in place, so
// no other section's top-level `path` or `cp` can collide with them.
const LANDING_BROWSER = require('path').join(__dirname, '..', 'bin', 'browser');
const LANDING_SPAWN = require('child_process').spawn;
const REFLEX_TIMEOUT_MS = Number(process.env.FIVEDIVE_BROWSER_REFLEX_TIMEOUT_MS || 60000);
function reflexLanding(site, state) {
  return new Promise((resolve) => {
    let child, out = '', over = false;
    const done = (r) => { if (!over) { over = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ }
      done({ reflex: 'error', why: 'reflex did not answer in time' }); }, REFLEX_TIMEOUT_MS);
    try { child = LANDING_SPAWN(LANDING_BROWSER, ['_reflex-landing', site], { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (e) { return done({ reflex: 'error', why: e.message }); }
    child.on('error', (e) => done({ reflex: 'error', why: e.message }));
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      let r = null; try { r = JSON.parse(out.trim().split('\n').pop()); } catch (e) { r = null; }
      done(code === 0 && r && typeof r === 'object' ? r : { reflex: 'error', why: `_reflex-landing exited ${code}` });
    });
    child.stdin.on('error', () => { /* it answers or it does not; close decides */ });
    child.stdin.end(JSON.stringify(state));
  });
}

// One goto's landing, for either loop. `landing` is what bin/browser put in the
// plan: {site, reflex, retry}. Returns the line to print (or ''), `loginWall`
// (the message to fail with, or ''), and `retry` — true only when the caller
// allowed it AND the page was redirected. Never throws: a page that cannot say
// where it is has not been shown to be somewhere else.
async function checkLanding(page, requested, landing, { mayRetry = false } = {}) {
  const out = { line: '', loginWall: '', retry: false };
  let landed = '';
  try { landed = String(await page.url()); } catch (e) { return out; }
  let why = redirectWhy(requested, landed);
  let host = '';
  try { host = new URL(landed).hostname; } catch (e) { host = ''; }
  const site = (landing && landing.site) || host;
  if (landing && landing.reflex && site) {
    let title = '', text = '';
    try { title = String(await page.title()); } catch (e) { title = ''; }
    try { text = String(await page.evaluate(_textIn, { textOf: true }) || ''); } catch (e) { text = ''; }
    const r = await reflexLanding(site, { requested_url: requested, landed_url: landed, landed_title: title,
      page_excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 300) });
    const conf = Number(r.confidence) || 0;
    if (r.reflex === 'ok' && r.choice === 'login_wall') {
      out.loginWall = `the page is a login wall (reflex, ${conf}): log in first: 5dive browser auth ${site}`;
      return out;
    }
    if (r.reflex === 'ok' && (r.choice === 'generic_page' || r.choice === 'bot_block')) {
      why = `${why ? why + '; ' : ''}reflex: ${r.choice}, ${conf}`;
    } else if (r.reflex === 'ok' && r.choice === 'answered' && conf >= 0.9 && why) {
      out.line = `landed on ${landed} (${why}), which reflex read as the page asked for (answered, ${conf}); not a redirect`;
      return out;
    }
  }
  if (!why) return out;
  out.retry = !!(mayRetry && landing && landing.retry);
  out.line = `redirected: ${requested} → ${landed} (${why})` +
    (out.retry ? '; retrying once in the served browser' : '');
  return out;
}
// The cold driver's exit when it stopped for that retry: only gotos ran, and
// bin/browser runs the whole plan again through the served browser.
const E_REDIRECTED = 71;

function render(nodes, { json = false } = {}) {
  if (json) return JSON.stringify({ nodes }, null, 2);
  const w = nodes.reduce((m, n) => Math.max(m, n.role.length), 0);
  return nodes.map((n) => {
    const nm = n.name ? ` "${n.name}"` : ' (no accessible name — it cannot be addressed by ref)';
    return `${n.role.padEnd(w)}${nm}\n${' '.repeat(w + 2)}ref=${n.ref}`;
  }).join('\n');
}

module.exports = { INTERACTIVE, pageWalk, walk, snapshot, resolveRef, resolveSelector,
  resolveRefWithin, resolveStepSelector, resolveOrRepick, nameMatches, REPICK_MIN_CONFIDENCE,
  onRef, REFIND_OPS,
  isRef, render, REF_PREFIX,
  typeDelay, typeRefusal, typeKeys, TYPE_DELAY_DEFAULT, TYPE_DELAY_MAX,
  classifyLabel, stepRisk, pageAfter, NEEDS_OWNER_PREFIX, E_NEEDS_OWNER, OWNER_ALLOWED_PREFIX,
  STEP_FAILED_PREFIX, failedStep,
  redirectWhy, checkLanding, E_REDIRECTED,
  _payloadIn, cleanText, cleanPayload,
  waitForVisible, _visibleIn, _textIn, _scopeIn };

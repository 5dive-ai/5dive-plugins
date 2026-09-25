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
// step used a ref. For `press`: Enter submits the element's form, so it is the
// label of that form's submit button; a modifier+Enter is the send/post shortcut
// on every composer that has one (X, Slack, GitHub comments), so it is refused
// as `send` without reading anything — a composer rarely carries a label that
// says so, and guessing "harmless" there is the expensive direction.
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
async function stepRisk(page, step, sel) {
  if (!step || (step.op !== 'click' && step.op !== 'press')) return null;
  if (step.op === 'press') {
    const key = String(step.key || '');
    if (!/(^|\+)Enter$/i.test(key)) return null;
    if (/(Control|Meta|Ctrl|Cmd)\+/i.test(key)) return { cls: 'send', label: key };
  }
  const refName = isRef(step.selector) ? refBody(step.selector).replace(/^[^/]*\//, '').replace(/#\d+$/, '') : '';
  let live = '';
  try { live = await page.evaluate(_labelIn, { sel, op: step.op, riskOf: true }); } catch (e) { live = ''; }
  const label = [refName, live].filter(Boolean).join(' | ').slice(0, 200);
  const cls = classifyLabel(label);
  return cls ? { cls, label } : null;
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
async function pageAfter(page, { settleMs = 0, waitFor = null, waitTimeoutMs = 30000,
                                 expect = null, expectWaitMs = 0, pollMs = 250, walk: walkOpts = null } = {}) {
  const waited = waitFor ? await waitForVisible(page, waitFor, { timeoutMs: waitTimeoutMs, pollMs }) : null;
  if (settleMs > 0) { try { await page.waitForTimeout(settleMs); } catch (e) { /* the read still runs */ } }
  const readNow = async () => {
    const o = { url: '', title: '', html: '', text: '' };
    try { o.url = String(await page.url()); } catch (e) { /* recorded empty */ }
    try { o.title = String(await page.title()); } catch (e) { /* recorded empty */ }
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

function render(nodes, { json = false } = {}) {
  if (json) return JSON.stringify({ nodes }, null, 2);
  const w = nodes.reduce((m, n) => Math.max(m, n.role.length), 0);
  return nodes.map((n) => {
    const nm = n.name ? ` "${n.name}"` : ' (no accessible name — it cannot be addressed by ref)';
    return `${n.role.padEnd(w)}${nm}\n${' '.repeat(w + 2)}ref=${n.ref}`;
  }).join('\n');
}

module.exports = { INTERACTIVE, pageWalk, walk, snapshot, resolveRef, resolveSelector,
  resolveRefWithin, resolveStepSelector, isRef, render, REF_PREFIX,
  classifyLabel, stepRisk, pageAfter, NEEDS_OWNER_PREFIX, E_NEEDS_OWNER,
  waitForVisible, _visibleIn, _textIn };

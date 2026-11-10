'use strict';
// A POPUP AN ACT OPENS IS FOLLOWED (DIVE-6392).
//
// Round 8 of the Google sign-up benchmark (cic-arm-a, browser 1.45.0): Gamma's
// page loaded with no challenge, and "Continue with Google" then did nothing the
// agent could see. The button showed pressed, no Google page came into view,
// and the retry pressed it twice more with the same result. A Google sign-in
// button usually opens the account chooser in a POPUP window (window.open, or a
// target=_blank OAuth link), and both step loops kept acting on, and re-reading,
// the page they started on. So the chooser opened in a window the agent never saw.
//
// Now each loop keeps a stack of pages: the one it started on, then each popup
// opened from the page in view. A popup is taken into view at the next step and
// before the re-read; the steps after it act in it, and the re-read is of it.
// When the popup closes (an OAuth window closes itself once the sign-in is done),
// the page that opened it is back in view. Each change is said in the act's
// output, so "nothing happened" can no longer be what a popup looks like.
//
// It changes nothing about what may be clicked. A popup's page goes through the
// same Google sign-in guard and the same owner checks as any other page, because
// the loops run those on the page in view, which is now the popup. A Cloudflare
// check in the popup is watched (the caller's onOpen), never clicked.
//
// Both step loops (bin/driver-playwright and bin/session-daemon) use this file,
// for the reason lib/aria.cjs exists: two copies of one rule drift.
//
// A WINDOW THAT IS NOT A `popup` EVENT, AND ONE THAT COMES LATE (DIVE-7680). Box
// bug 690 (exact-swallow, 1.66.6): Shopify's embedded Facebook app opens Meta's
// login from inside its cross-origin iframe, and Supliful's "Sign up with Google"
// window came after the act's wait. Both acts said `popup: null`. A window opened
// from an out-of-process iframe, or with noopener, can reach Playwright only as a
// new page of the CONTEXT, so the follower listens there too. It takes a context
// page while an act runs and for LATE_MS after its last step. Pages this code
// opens itself (a `read` tab, a new tab) are marked with mine() and never taken. One
// that arrives after the act's wait is kept, and drain() takes it before the next
// read. So the snapshot after a late popup reads the popup, not the page under it.

// How long a click or a key press gets to open a popup before the next step, or
// the re-read, goes on without one. Paid only after a click or a press, and only
// while no popup has arrived: one that arrives sooner ends the wait at once.
const WAIT_MS = () => {
  const v = Number(process.env.FIVEDIVE_BROWSER_POPUP_WAIT_MS);
  return Number.isFinite(v) && v >= 0 ? v : 1000;
};
// How long a popup gets to load its first page before it is shown as it is.
const LOAD_MS = () => Number(process.env.FIVEDIVE_BROWSER_POPUP_LOAD_MS) || 15000;
// How long after an act's last step a new page of the context still counts as a
// window the act opened (DIVE-7680). A page 'popup' event is taken at any time;
// this bounds only the context pages, which carry no opener to tie them to the act.
const LATE_MS = () => {
  const v = Number(process.env.FIVEDIVE_BROWSER_POPUP_LATE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 10000;
};

// Pages this code opened itself (ctx.newPage()): never a window an act opened.
// The context's 'page' event fires before newPage() resolves, so the follower
// looks again before it takes one (CTX_DEFER_MS, and in take()).
const ours = new WeakSet();
function mine(p) { try { if (p && typeof p === 'object') ours.add(p); } catch (e) { /* not a page */ } return p; }
const CTX_DEFER_MS = 50;

// The ops that can open a window. fill, type, select and upload do not, in any
// page measured, and charging them the wait would slow every form.
const OPENS = new Set(['click', 'press']);

function hostOf(u) {
  try { const x = new URL(String(u)); return x.host || x.href; } catch (e) { return String(u || ''); }
}
function originOf(u) {
  try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.origin : null; } catch (e) { return null; }
}
function isClosed(p) {
  try { return typeof p.isClosed === 'function' && p.isClosed(); } catch (e) { return true; }
}
function urlOf(p) {
  try { return p.url(); } catch (e) { return ''; }
}

// follow(<the page the act starts on>, {log, onOpen, stepTimeout}) -> a follower.
//   .page            the page in view now
//   .sync(op, quiet) call before a step and before the re-read, with the op that
//                    ran last (or null); returns the page in view. `quiet(ms)`, when
//                    given, resolves true once the page is quiet (DIVE-6778): the wait
//                    ends then too, as a window the click opens has arrived by then
//   .settled         the last sync ended because the page went quiet, no popup came
//   .popup           what the act output names: {url, host, opener} of the popup
//                    in view, or null when the page it started on is in view
//   .pageFor(url)    the served browser's question, below
//   .home()          the page it started on back in view, popups left open
//   .use({log, onOpen}) where the next lines go: a served browser's follower
//                    outlives the request that made it
//   .stop()          stops listening
// The stub pages the harness uses may lack on/off/isClosed; each is optional.
function follow(start, opts = {}) {
  let log = () => {}, onOpen = null;
  const use = (o) => {
    log = typeof o.log === 'function' ? o.log : () => {};
    onOpen = typeof o.onOpen === 'function' ? o.onOpen : null;
  };
  use(opts);
  const stack = [start];
  const arrived = [];
  const watched = [];
  // Every page this follower has seen arrive or found already open: a window
  // opened the usual way is both a page 'popup' and a context 'page', and is
  // taken once.
  const seen = new WeakSet();
  const see = (p) => { try { seen.add(p); } catch (e) { /* not a page */ } };
  see(start);
  let wake = null, settled = false, armUntil = 0;
  const arrive = (p) => { arrived.push(p); if (wake) { const w = wake; wake = null; w(); } };
  const onPopup = (p) => { if (seen.has(p)) return; see(p); arrive(p); };
  const watch = (p) => {
    if (!p || typeof p.on !== 'function' || watched.includes(p)) return;
    watched.push(p); p.on('popup', onPopup);
  };
  watch(start);
  // THE CONTEXT, for the windows no page reports (DIVE-7680).
  let ctx = null;
  try { ctx = typeof start.context === 'function' ? start.context() : null; } catch (e) { ctx = null; }
  if (ctx && typeof ctx.on !== 'function') ctx = null;
  if (ctx) { try { for (const p of (typeof ctx.pages === 'function' ? ctx.pages() : [])) see(p); } catch (e) { /* none listed */ } }
  let deferred = 0;   // context pages still inside their CTX_DEFER_MS look
  const onCtxPage = (p) => {
    if (!p || seen.has(p) || ours.has(p)) return;
    const at = Date.now();
    deferred++;
    setTimeout(() => {
      deferred--;
      if (seen.has(p) || ours.has(p)) return;
      if (at > armUntil) { see(p); return; }   // not during an act: a tab someone else opened
      see(p); arrive(p);
    }, CTX_DEFER_MS);
  };
  if (ctx) ctx.on('page', onCtxPage);
  const arm = () => { armUntil = Date.now() + LATE_MS(); };
  const top = () => stack[stack.length - 1];

  // A popup that closed hands the view back to the page that opened it.
  const dropClosed = () => {
    while (stack.length > 1 && isClosed(top())) {
      const gone = stack.pop();
      log(`the popup (${hostOf(urlOf(gone))}) closed; back on ${hostOf(urlOf(top()))}`);
    }
  };

  const take = async (p) => {
    if (ours.has(p)) return;
    if (isClosed(p)) {
      log(`a popup opened (${hostOf(urlOf(p))}) and closed again by itself; still on ${hostOf(urlOf(top()))}`);
      return;
    }
    // Its first page, or as much of it as loaded: a popup that never finishes
    // loading is still the window the click opened, and is shown as it is.
    try { if (typeof p.waitForLoadState === 'function') await p.waitForLoadState('domcontentloaded', { timeout: LOAD_MS() }); }
    catch (e) { /* shown as it is */ }
    if (ours.has(p)) return;   // a tab this code opened, known by now
    if (isClosed(p)) {
      log(`a popup opened (${hostOf(urlOf(p))}) and closed again by itself; still on ${hostOf(urlOf(top()))}`);
      return;
    }
    if (opts.stepTimeout && typeof p.setDefaultTimeout === 'function') p.setDefaultTimeout(opts.stepTimeout);
    const opener = urlOf(top());
    watch(p);
    stack.push(p);
    log(`a popup opened: ${hostOf(urlOf(p))}, now in view (${urlOf(p)}). The steps after this act in it; ` +
      `when it closes, ${hostOf(opener)} is back in view.`);
    if (onOpen) { try { await onOpen(p); } catch (e) { /* the popup is in view whatever this says */ } }
  };

  return {
    get base() { return start; },
    get page() { return top(); },
    use,
    get popup() {
      if (stack.length < 2) return null;
      return { url: urlOf(top()), host: hostOf(urlOf(top())), opener: urlOf(stack[stack.length - 2]) };
    },
    get settled() { return settled; },
    // THE WAIT ENDS WHEN THE PAGE IS QUIET (DIVE-6778). The full second was paid after
    // every click, then the re-read settled 1.2 s more: 2.2 s of waiting on a page
    // that was done in 0.3 s. A click's window.open fires in its handler; one that
    // waits on a request first keeps that request in flight, so the page is not quiet.
    async sync(lastOp, quiet = null) {
      arm();
      dropClosed();
      const ms = OPENS.has(lastOp) ? WAIT_MS() : 0;
      let calm = false;
      if (!arrived.length && ms > 0) {
        let timer;
        await new Promise((resolve) => {
          wake = resolve; timer = setTimeout(resolve, ms);
          if (quiet) Promise.resolve(quiet(ms)).then((q) => { if (q) { calm = true; resolve(); } }, () => {});
        });
        clearTimeout(timer); wake = null;
      }
      // A context page still being looked at (it may be a tab this code opened)
      // is waited for: a quiet page must not end the wait before it is decided.
      if (deferred > 0) await new Promise((r) => setTimeout(r, CTX_DEFER_MS + 10));
      settled = calm && !arrived.length;
      while (arrived.length) await take(arrived.shift());
      dropClosed();
      arm();   // the late window runs from the act's last look, not its first
      return top();
    },
    // A window that arrived after the last sync (its wait had ended) is still
    // waiting here; the act's report and a served browser's next read take it.
    get waiting() { return arrived.length > 0; },
    // Take every window that has arrived, with no wait (DIVE-7680): the read
    // after a late popup is the popup. Returns the page in view.
    async drain() {
      dropClosed();
      while (arrived.length) await take(arrived.shift());
      dropClosed();
      return top();
    },
    // The page to use for a request on <url> in a served browser that an earlier
    // act left on a popup: the popup, while it is open and <url> is on its origin,
    // or when there is no <url> (an act that continues on the page in view);
    // otherwise null (the caller's usual page).
    pageFor(url) {
      dropClosed();
      if (stack.length < 2) return null;
      if (url == null || url === '') return top();
      const want = originOf(url);
      return want && want === originOf(urlOf(top())) ? top() : null;
    },
    home() { stack.length = 1; arrived.length = 0; return start; },
    stop() {
      for (const p of watched) {
        try { (p.off || p.removeListener).call(p, 'popup', onPopup); } catch (e) { /* gone */ }
      }
      watched.length = 0;
      if (ctx) { try { (ctx.off || ctx.removeListener).call(ctx, 'page', onCtxPage); } catch (e) { /* gone */ } }
      armUntil = 0;
    },
  };
}

module.exports = { follow, mine, OPENS, hostOf, originOf, WAIT_MS, LATE_MS };

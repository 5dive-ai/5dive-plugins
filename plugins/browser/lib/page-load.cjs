'use strict';
// HAS THE PAGE LOADED? — input mode's answer, from the window title alone
// (DIVE-7572). Input mode has no channel into the page, so the title is all it
// can read. While Chrome loads a typed address, the tab is titled with the
// ADDRESS itself, scheme and "www." dropped: on exact-swallow (browser 1.66.3,
// 2026-11-02) `snapshot amazon.co.jp https://www.amazon.co.jp/dp/B00D81RNDK`
// read the title "amazon.co.jp/dp/B00D81RNDK" 2.5 s after Enter, the tab spinner
// still turning, and returned rc 0: the error page's own title came later, so
// the refused-title stop never saw it. So a page counts as loaded once its
// title is no longer its address. (Not also "differs from the title before the
// goto": a re-read of the same page keeps its title, and its address phase can
// be shorter than a poll, so that rule would stall every repeat snapshot.)

const strip = (s) => String(s || '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\./, '');

// Is <title> what Chrome shows for <url> before the page has a title of its
// own? Case-sensitive on purpose: Chrome shows the host as the URL has it
// (lower case), and a real title that happens to be a site name is usually
// capitalised ("Amazon.co.jp", the bot interstitial's title, is a page).
function addressTitle(title, url) {
  const t = String(title || '').trim();
  if (!t || /^(new tab|untitled|about:blank|loading\.*)$/i.test(t)) return true;
  if (/\s/.test(t)) return false;   // an address has no spaces; a title nearly always does
  const st = strip(t).replace(/\/+$/, '');
  if (!st) return true;
  const su = strip(url);
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { /* not a url: compare as text */ }
  // The address as typed, Chrome's elided form of it (a prefix), or another
  // address on the same host (a redirect that has not finished loading).
  return su.startsWith(st) || (host !== '' && (st === host || st.startsWith(host + '/') || st.startsWith(host + ':')));
}

// Wait until the title says the page has loaded, then until it is quiet.
//   readTitle(): Promise<string>   the page title now
//   settled():   Promise<any>      the caller's quiet gate, run once at the end
// opts: { url, minMs, maxMs, pollMs, sleep, now }
// Returns { loaded, title, waited_ms }. Never throws for a slow page: the
// caller decides what "did not load" means for its verb.
async function untilLoaded(readTitle, settled, opts) {
  const { url, minMs = 0, maxMs = 20000, pollMs = 200 } = opts;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now || Date.now;
  const t0 = now(), end = t0 + Math.max(minMs, maxMs);
  let title = '';
  if (minMs > 0) await sleep(minMs);
  for (;;) {
    title = String(await readTitle());
    if (!addressTitle(title, url)) break;
    if (now() >= end) return { loaded: false, title, waited_ms: now() - t0 };
    await sleep(pollMs);
  }
  if (settled) await settled();
  title = String(await readTitle());
  // The quiet gate can end on a title that went back to an address (a client
  // redirect): that is still not a loaded page.
  return { loaded: !addressTitle(title, url), title, waited_ms: now() - t0 };
}

module.exports = { addressTitle, untilLoaded };

'use strict';
// THE NAMED SITE'S TAB, IN FRONT (DIVE-7257).
//
// lodar, 10-29, on chill-gorge: the sign-in link for bing.com showed the Google
// Play console. The sites of a sign-in group share ONE Chrome (every new site
// joins the group "Main"), so bing.com and Play were two tabs of one window, and
// the viewer showed the window as it was: whichever tab was last in front.
//
// When a person is shown the window for a site, a tab on that site is brought to
// the front first: the tab agents drive when it is already on the site (a check
// an agent stopped on is in that tab), else the first open tab on the site, else
// none, and the caller opens one. The other tabs are left as they are.
//
// The tab shown is then the tab agents drive (session-daemon pageOf), so the
// person watches the tab the agent's next step acts in.

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; }
}

// On the site: the same host or one under it. `www.` on the site's own URL is
// dropped, so www.bing.com and bing.com are one site either way round.
function onSite(url, host) {
  const h = hostOf(url);
  const want = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!h || !want) return false;
  return h === want || h.endsWith('.' + want);
}

function pick(pages, host, driven) {
  const open = pages.filter((p) => !(typeof p.isClosed === 'function' && p.isClosed()));
  if (driven && open.includes(driven) && onSite(driven.url(), host)) return driven;
  return open.find((p) => onSite(p.url(), host)) || null;
}

// ONE TAB PER CONNECT (DIVE-8487). The QA walk's second Connect for a site showed
// two tabs of it (and a blank one is what a fresh browser opens first). A tab
// with nothing in it, or a second tab of the same site, is never something the
// person needs to see, so before the window is shown:
//   keep   the tab pick() chose, as before
//   reuse  when no tab is on the site: a blank tab, which the caller sends to
//          the site instead of opening one more (the driven tab first)
//   close  every other blank tab and every other tab on the site
// Tabs of other sites of the group are never closed. `spare(p)` true leaves a tab
// out of all three: the daemon passes the tabs a request opened for itself (a
// status check of the site runs in one), which are neither shown nor closed.
function isBlank(url) {
  return /^(about:blank|chrome:\/\/new-?tab(-page)?\/?|chrome-search:\/\/local-ntp\/.*)?$/i.test(String(url || ''));
}

function plan(pages, host, driven, spare = () => false) {
  const open = pages.filter((p) => !(typeof p.isClosed === 'function' && p.isClosed()) && !spare(p));
  const keep = pick(open, host, driven);
  let reuse = null;
  if (!keep) {
    reuse = (driven && open.includes(driven) && isBlank(driven.url())) ? driven
      : (open.find((p) => isBlank(p.url())) || null);
  }
  const shown = keep || reuse;
  const close = open.filter((p) => p !== shown && (isBlank(p.url()) || onSite(p.url(), host)));
  return { keep, reuse, close };
}

// INPUT MODE (DIVE-7674). Plain Chrome has no channel that lists its tabs, so
// the window used to be shown as it was: Connect for business.facebook.com
// showed cjdropshipping.com, another login's live session, because CJ's input
// browser is the group's one window (box report 688). The daemon keeps the one
// fact it can know, the host it last sent this window to (its start URL, then
// every goto it typed), in be.lastHost. When that is not the site the person is
// being shown, one new tab is opened on the site's URL through the keyboard,
// and it becomes the host on record, so the next Connect opens no second tab.
// A window last sent to this site is left exactly as it is: a check an agent
// stopped on (a handoff) must be what the person sees.
//
// io: { sleep(ms), keys() (the browser holds the keyboard, or throws),
//       typeUrl(url) (address bar, url, Return) }. Not awaited for the load:
// the person must not wait on a slow site, and a tab loading is a tab on it.
async function inputFront(be, url, io) {
  const host = hostOf(url);
  if (be.lastHost && onSite(`https://${be.lastHost}/`, host)) {
    return { host, moved: false, why: 'the window is on this site already (the last page it was sent to)' };
  }
  const was = be.lastHost || '';
  await io.keys();
  const before = (await be.x.windowTitle()).window;
  await be.x.press('ctrl+t');
  let opened = false;
  for (let i = 0; i < 20 && !opened; i++) { await io.sleep(100); opened = (await be.x.windowTitle()).window !== before; }
  if (!opened) return { host, moved: false, was, why: 'no new tab opened, so nothing was loaded' };
  await io.typeUrl(url);
  be.lastHost = host;
  return { host, moved: true, opened: true, was };
}

module.exports = { hostOf, onSite, pick, isBlank, plan, inputFront };

'use strict';
// A SESSION-ONLY LOGIN SURVIVES THE BROWSER'S OWN SWAPS (DIVE-7314). A view
// re-serves a warm browser as plain Chrome, and a mode switch stops one browser
// and starts the other. Chrome deletes every cookie with no expiry when it
// starts, and DigitalOcean's login is such a cookie, so the owner's take-over of
// a signed-in automated browser opened on the login page.
//
// Rewriting the cookie file after Chrome exits is not enough: it can only keep
// a session cookie Chrome happened to write, and none was there on CI. So the
// automated browser, which can still talk to Chrome, reads its live cookies and
// sets each one with no expiry back with one, KEEP_S from now, before it closes.
// Chrome then stores them itself, encrypted as it stores any lasting cookie, and
// the next Chrome on the profile opens with the login. Only a swap asks for this:
// a real stop still ends a session-only login, as closing a browser does.
const KEEP_S = 43200;

// A host-only cookie (no leading dot) is set back by URL, so it stays host-only:
// setting it by domain would widen it to every subdomain.
function asKept(c, until) {
  const out = { name: c.name, value: c.value, expires: until, httpOnly: !!c.httpOnly, secure: !!c.secure };
  if (c.sameSite) out.sameSite = c.sameSite;
  if (c.partitionKey) out.partitionKey = c.partitionKey;
  if (String(c.domain).startsWith('.')) {
    out.domain = c.domain; out.path = c.path || '/';
  } else {
    const p = c.path || '/';
    out.url = `${c.secure ? 'https' : 'http'}://${c.domain}${p}${p.endsWith('/') ? '' : '/'}`;
  }
  return out;
}

// keepSessionCookies(ctx[, keepS]) -> how many were kept. ctx: a Playwright context.
async function keepSessionCookies(ctx, keepS = KEEP_S, now = Date.now()) {
  const all = await ctx.cookies();
  const session = all.filter((c) => c.expires === -1 || c.expires === undefined || c.expires === null);
  if (!session.length) return 0;
  const until = Math.floor(now / 1000) + keepS;
  let kept = 0;
  // One at a time: a cookie Chrome refuses must not take the others with it.
  for (const c of session) {
    try { await ctx.addCookies([asKept(c, until)]); kept++; } catch (e) { /* that one ends with the browser */ }
  }
  return kept;
}

module.exports = { keepSessionCookies, asKept, KEEP_S };

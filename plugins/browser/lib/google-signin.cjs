'use strict';
// GOOGLE'S SIGN-IN PAGES, ONE ANSWER EACH (DIVE-6228).
//
// "Sign up with Google" walks a page through accounts.google.com, and before
// this file every one of those pages met the generic sign-in guard: a URL with
// /signin/ in it is a sign-in form, refused. So the agent stopped one click
// short on every sign-up (round 1 of the Claude in Chrome head-to-head: 0 of 6),
// and not even consistently: the generic guard only runs when the site's own
// front page left the login unconfirmed, so the SAME chooser was let through on
// one attempt and refused on the next (DIVE-6214, Jamie A4g vs A4h).
//
// The rule now, and it is a pure function of (url, html), so the same page
// always gets the same answer whichever site led there:
//   allow  Google's account chooser listing a saved, signed-in account; the
//          "Continue as …" / "Sign in to <app> with Google" confirm; a consent
//          screen that asks for nothing beyond basic profile and email.
//   ask    a consent screen asking for more than that (calendar, contacts,
//          Drive, …), or Google's unverified-app warning. The owner decides.
//   allow  ALSO, since DIVE-7881 (lodar 11-07, «remove rules»): a verification
//          code or 2-step prompt (kind code: the agent gets the code itself, from
//          the site's mail in this browser or the owner's saved .2fa) and a robot
//          check (kind robot: it tries it like a person, ticks, waits, retries).
//          The owner turns either back into a stop: `gate on <site|all> code|robot`
//          (bin/browser), passed in here as `gates`.
//   stop   a password field; a code or robot check the owner gated; adding an account (Google's email box, or a chooser with no
//          signed-in account on it); Google refusing the browser; and any
//          accounts.google.com page this file does not recognise (fail closed).
//
// Used twice, and the two must never disagree: by bin/browser on the page a
// verb hands back (`node google-signin.cjs <html-file> <url>`), and by both
// step loops BEFORE each step on a Google page (stepStop), so a password is
// never typed and a wide grant is never clicked, whatever the steps say.

const STOP_PREFIX = '5dive-google-stop: ';
// DIVE-7168: a step the guard ALLOWED on Google's pages (the chooser, "Continue
// as …", a basic consent) is the agent signing in with the owner's account, and
// the owner gets one line for it. The loops print this once per act.
const GRANT_PREFIX = '5dive-google-signin: ';

const GOOGLE_HOST = /^(accounts\.google\.[a-z.]+|(?:www\.)?google\.[a-z.]+)$/i;

function hostPath(url) {
  try { const u = new URL(url); return { host: u.hostname.toLowerCase(), path: u.pathname, search: u.search, u }; }
  catch (e) { return null; }
}

// Only these pages are this file's to judge. www.google.com is only its robot
// page (/sorry/); everything else on google.com is not a sign-in at all.
function isGooglePage(url) {
  const h = hostPath(url);
  if (!h || !GOOGLE_HOST.test(h.host)) return false;
  if (h.host.startsWith('accounts.')) return true;
  return /^\/sorry(\/|$)/i.test(h.path);
}

function decode(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&rsquo;|&lsquo;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
}

// What a person could read: scripts, styles, templates and hidden blocks out,
// tags out. Google ships most of its page as script data, and a word in there
// (an invisible reCAPTCHA loader, a scope list for another step) is not on screen.
// A hidden block goes WITH EVERYTHING INSIDE IT (DIVE-6241): the old lazy regex
// stopped at the first closing tag of the same name, so a hidden <div> holding
// a nested <div> leaked the rest of its text onto the "screen".
function visibleMarkup(html) {
  return stripHidden(String(html || '').replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' '));
}
function visibleText(html) {
  const t = visibleMarkup(html).replace(/<[^>]+>/g, ' ');
  return decode(t).replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
function hiddenTag(tag) {
  const a = attrsOf(tag);
  return 'hidden' in a || a['aria-hidden'] === 'true' || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style || '');
}
// Drops each hidden element and its whole subtree, counting nesting. An element
// that never closes is KEPT: dropping to the end of the page could drop a scope
// list, and less text on a consent screen is the direction that allows.
function stripHidden(html) {
  const re = /<\/?([a-z][a-z0-9-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
  let out = '', last = 0, name = '', depth = 0, from = -1, m;
  while ((m = re.exec(html))) {
    const tag = m[0], n = m[1].toLowerCase(), closing = tag[1] === '/';
    const leaf = VOID_TAGS.has(n) || /\/>$/.test(tag);
    if (from < 0) {
      if (closing || !hiddenTag(tag)) continue;
      out += html.slice(last, m.index);
      if (leaf) { last = re.lastIndex; continue; }
      from = m.index; name = n; depth = 1;
    } else if (n === name && !leaf) {
      depth += closing ? -1 : 1;
      if (depth === 0) { from = -1; last = re.lastIndex; out += ' '; }
    }
  }
  return from >= 0 ? out + html.slice(from) : out + html.slice(last);
}

function attrsOf(tag) {
  const a = {};
  const re = /([a-z_:][-a-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gi;
  let m; const body = tag.replace(/^<[a-z0-9]+/i, '').replace(/\/?>$/, '');
  while ((m = re.exec(body))) a[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return a;
}

function hiddenInput(a) {
  return 'hidden' in a || a['aria-hidden'] === 'true' || a.tabindex === '-1' || (a.type || '').toLowerCase() === 'hidden'
    || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style || '')
    || /^hidden/i.test(a.name || '');
}

// A password box a person could type into. Google's email page carries a
// hidden one (name="hiddenPassword", aria-hidden, tabindex=-1) for password
// managers; that one is not a password prompt.
function visibleInputs(html, pred) {
  const out = [];
  const re = /<input\b[^>]*>/gi; let m;
  const src = String(html || '').replace(/<(script|template)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  while ((m = re.exec(src))) { const a = attrsOf(m[0]); if (!hiddenInput(a) && pred(a)) out.push(a); }
  return out;
}

// The accounts a chooser offers: Google tags each one with data-identifier
// (or data-email); a signed-out one is labelled "Signed out" and leads to a
// password page, so it does not count as a saved session.
function chooserAccounts(html, text) {
  const ids = new Set();
  const re = /\bdata-(?:identifier|email)\s*=\s*["']([^"']+@[^"']+)["']/gi; let m;
  while ((m = re.exec(String(html || '')))) ids.add(m[1].toLowerCase());
  if (!ids.size) { const re2 = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g; while ((m = re2.exec(text))) ids.add(m[0]); }
  const signedOut = (text.match(/\bsigned out\b/g) || []).length;
  return { count: ids.size, live: Math.max(0, ids.size - signedOut) };
}

// BASIC IS AN ALLOW-LIST; WIDE IS EVERYTHING ELSE. In the URL that is exact
// (OAuth scope names). On the screen it is Google's own wording, so the test
// is the other way round: any word for data beyond name, picture and email
// makes it wide, and a word we did not think of errs toward asking.
const BASIC_SCOPES = new Set(['openid', 'email', 'profile', 'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile', 'https://www.googleapis.com/auth/plus.me']);
const WIDE_WORDS = new RegExp('\\b(' + [
  'calendars?', 'events?', 'contacts?', 'drive', 'gmail', 'inbox', 'e-?mail messages', 'send email',
  'youtube', 'photos?', 'files?', 'documents?', 'docs', 'sheets', 'spreadsheets?', 'slides', 'presentations?',
  'tasks?', 'locations?', 'street address(?:es)?', 'phone numbers?', 'birthday', 'gender', 'age range',
  'fitness', 'health', 'payments?', 'purchases?', 'google ads', 'analytics', 'cloud platform', 'admin',
  'groups', 'google chat', 'google meet', 'classroom', 'google keep', 'books', 'google forms', 'apps script',
  'blogger', 'search console', 'tag manager', 'business profile', 'on your behalf', 'edit, create',
  'and delete', 'additional access',
].join('|') + ')\\b', 'gi');
// What a scope DOES, for a listed line whose data has no word above. Only a
// fallback, so the owner is told what the app wants ("contacts"), not a verb.
const WIDE_VERBS = /\b(manage|edit|delete|upload|download)\b/gi;

// THE SCOPES GOOGLE LISTS, AND NOTHING ELSE ON THE SCREEN (DIVE-6241). Round 2
// of the head-to-head refused Allow on Coda's consent, which asks for profile,
// email and openid only, because the app is called "Superhuman Docs" and the
// whole screen was read: "docs" is a Drive word. The app's name is the
// publisher's to choose, and the footer ("By clicking Allow…", "Make sure you
// trust…") is Google's boilerplate on every consent. So the words are read
// only between the list's header ("This will allow <app> to:", or "<app> wants
// to access your Google Account" and the account) and that footer, with every
// spelling of the app's name taken out. A layout with no header we know is
// read whole, as before: the fallback is the stricter reading, never the looser.
// Footer phrases only Google's boilerplate says, never a scope's own wording.
const LIST_END = /\b(by clicking allow|by continuing, google|make sure (?:that )?you trust|learn about the risks|you can change this and other|you can see or remove access|before using this app|review [^.]{0,40}privacy policy)\b/;
function appNames(text) {
  const out = new Set(); let m;
  const pats = [/this will allow (.{1,80}?) to\b/g, /make sure (?:that )?you trust (.{1,80}?)(?:[.!]| learn\b|$)/g,
    /sign in to (.{1,80}?) with google\b/g, /(?:^|google |choose an account )(.{1,60}?) wants (?:to access|access to|additional access)\b/g];
  for (const re of pats) while ((m = re.exec(text))) { const n = m[1].trim(); if (n && n !== 'google') out.add(n); }
  return [...out].sort((x, y) => y.length - x.length);
}
function listedScopes(text) {
  let from = -1, m;
  if ((m = /this will allow .{1,80}? to:?/.exec(text))) from = m.index + m[0].length;
  else if ((m = /wants (?:to access|access to|additional access to) your google account/.exec(text))) from = m.index + m[0].length;
  let region = text;
  if (from >= 0) {
    const rest = text.slice(from), e = rest.search(LIST_END);
    region = e > 0 ? rest.slice(0, e) : rest;
  }
  // The name only where Google frames it ("<app> will be able to", "trust <app>"),
  // never bare: an app named like a scope line ("See your Google Drive files")
  // must not erase that line from the list.
  for (const n of appNames(text)) {
    const e = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    region = region.replace(new RegExp(`\\b(?:allow|trust|to|for) ${e}\\b|\\b${e}(?:'s| will| wants| may| can| to:)`, 'g'), ' ');
  }
  return region;
}

// THE TOP-LEVEL SCOPE ITEMS, NOT THEIR DETAIL LISTS (DIVE-6247). Each scope on
// Google's consent carries an expandable detail block, "This app wants
// permission to:" and a list, and the basic profile scope's lists "See your
// gender / See your preferred languages". Round 3 stopped Tally and Pitch at a
// plain profile + email + openid consent for that one word. A detail block only
// spells out the scope line above it, and a wider scope (calendar, contacts,
// Drive) is a top-level line of its own, so dropping the blocks loses nothing.
// The block is found by Google's own lead-in; a layout without it is read whole,
// which is the stricter reading.
const DETAIL_LEAD = /^\s*<p\b[^>]*>\s*this app wants permission to\b/i;
function dropDetails(markup) {
  const re = /<\/?([a-z][a-z0-9-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
  let out = '', last = 0, name = '', depth = 0, m;
  while ((m = re.exec(markup))) {
    const tag = m[0], n = m[1].toLowerCase(), closing = tag[1] === '/';
    const leaf = VOID_TAGS.has(n) || /\/>$/.test(tag);
    if (!name) {
      if (closing || leaf || !DETAIL_LEAD.test(markup.slice(re.lastIndex, re.lastIndex + 200))) continue;
      out += markup.slice(last, m.index); name = n; depth = 1;
    } else if (n === name && !leaf) {
      depth += closing ? -1 : 1;
      if (depth === 0) { name = ''; last = re.lastIndex; out += ' '; }
    }
  }
  // A block that never closes is kept, as stripHidden keeps one: less text on a
  // consent screen is the direction that allows.
  return name ? markup : out + markup.slice(last);
}
function scopeText(html) {
  const t = dropDetails(visibleMarkup(html)).replace(/<[^>]+>/g, ' ');
  return decode(t).replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

function scopeVerdict(u, text, html) {
  const wide = [];
  const scope = u && (u.searchParams.get('scope') || '');
  for (const s of scope.split(/[\s+,]+/).filter(Boolean)) if (!BASIC_SCOPES.has(s)) wide.push(s);
  // The account's own address (…@gmail.com) is on every one of these screens.
  const listed = listedScopes(text).replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g, ' ');
  const w = [...new Set(listed.match(WIDE_WORDS) || listed.match(WIDE_VERBS) || [])];
  if (w.length) wide.push(`"${w.slice(0, 3).join('", "')}" on the screen`);
  // Google's granular consent puts a checkbox beside every scope beyond the
  // basic ones; the basic ones have none. A box inside a hidden block is beside nothing.
  if (visibleInputs(visibleMarkup(html), (a) => (a.type || '').toLowerCase() === 'checkbox').length) wide.push('a box to tick per extra permission');
  return wide;
}

function classify(url, html, gates) {
  const gated = (k) => Array.isArray(gates) && gates.includes(k);
  if (!isGooglePage(url)) return null;
  const { host, path, u } = hostPath(url);
  const text = visibleText(html);
  const r = (verdict, kind, why) => ({ verdict, kind, why });

  // ROBOT CHECKS FIRST: a challenge page often still carries the form under it.
  if (!host.startsWith('accounts.') || /\/challenge\/(recaptcha|captcha)\b/i.test(path)
      || /<iframe\b[^>]*src=["'][^"']*(recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)(?![^"']*size=invisible)|hcaptcha\.com|challenges\.cloudflare\.com)/i.test(html || '')
      || /unusual traffic|not a robot|type the text you (hear|see)/.test(text)) {
    if (gated('robot')) return r('stop', 'robot', 'Google is showing a robot check, and the owner asked to be asked first (gate robot)');
    return r('allow', 'robot', 'Google is showing a robot check. Try it like a person: tick its box, or wait a few seconds and look again; ask the owner only if it is still there after a few tries');
  }
  if (/\/signin\/(v2\/)?rejected\b/i.test(path) || /couldn't sign you in|this browser or app may not be secure/.test(text)) {
    return r('stop', 'rejected', 'Google refused to sign in from this browser');
  }
  if (/\/challenge\/pwd\b/i.test(path) || visibleInputs(html, (a) => (a.type || '').toLowerCase() === 'password').length) {
    return r('stop', 'password', 'Google is asking for a password. The agent never types one');
  }
  if (/\/challenge\//i.test(path) || /2-step verification|verification code|enter the code|check your phone|get a verification/.test(text)) {
    if (gated('code')) return r('stop', 'code', 'Google is asking for a verification code or a 2-step prompt, and the owner asked to be asked first (gate code)');
    return r('allow', 'code', "Google is asking for a verification code or a 2-step prompt. Get the code yourself and type it: the newest Google mail in this browser's mailbox, or the owner's saved authenticator (\"saved\":\"<name>.2fa\"). Only a code sent to the owner's phone, or a prompt on it, is theirs");
  }
  // GOOGLE'S OWN ERROR PAGE IS NOT A SIGN-IN STEP (DIVE-6247). Round 3's
  // Whimsical attempt ended on "400. That's an error." at the chooser's path with
  // the whole query gone, and it was read as a chooser with no saved account. It
  // still stops (nothing on it may be clicked), but says what it is and the way
  // back: the site's own Google button, never a Google link opened by hand.
  const err = /\b([45]\d\d)\. that'?s an error\b/.exec(text);
  if (err) {
    return r('stop', 'error', `Google answered with an error page (${err[1]}), not a sign-in step: the Google link was opened without what the site's button put in it. Start again from the site's own Google button`);
  }
  if (/\/(v3\/)?signin\/(v2\/)?identifier\b|\/addsession\b|\/signup\b|\/lifecycle\//i.test(path)) {
    return r('stop', 'add-account', 'Google is asking for an email address, which means adding an account here. A person does that once');
  }
  if (/\/signin\/oauth\/(v2\/)?(warning|danger)\b/i.test(path) || /hasn't verified this app|google hasn't verified/.test(text)) {
    return r('ask', 'unverified', "Google warns the app is not verified. Ask the owner; it is their call");
  }
  if (/\/signin\/oauth\/(v2\/)?(consent|consentsummary)\b|\/o\/oauth2\/(v2\/)?consent\b/i.test(path)
      || /wants to access your google account|wants additional access/.test(text)) {
    const wide = scopeVerdict(u, scopeText(html), html);
    if (wide.length) return r('ask', 'wide-consent', `Google is asking to grant more than basic profile and email (${wide.slice(0, 3).join(', ')}). Ask the owner; never click Allow on it`);
    return r('allow', 'basic-consent', 'a consent screen for basic profile and email only');
  }
  if (/accountchooser|oauthchooseaccount|selectaccount/i.test(path) || /choose an account/.test(text)) {
    const a = chooserAccounts(html, text);
    if (a.live) return r('allow', 'chooser', `Google's account chooser with ${a.live} saved account(s) signed in`);
    return r('stop', 'add-account', a.count
      ? 'every account on Google\'s chooser is signed out, so picking one leads to a password'
      : 'Google\'s chooser has no saved account to pick, only "Use another account"');
  }
  if (visibleInputs(html, (a) => (a.type || '').toLowerCase() === 'email' || /^identifier/i.test(a.id || a.name || '')).length) {
    return r('stop', 'add-account', 'Google is asking for an email address, which means adding an account here. A person does that once');
  }
  if (/\bcontinue as\b/.test(text) || (/\bsign in to\b/.test(text) && /\bwith google\b/.test(text))
      || /\/signin\/oauth\/(id|legacy)\b/i.test(path)) {
    const wide = scopeVerdict(u, scopeText(html).replace(/\bsign in to .*? with google\b/, ''), html);
    if (wide.length) return r('ask', 'wide-consent', `Google is asking to grant more than basic profile and email (${wide.slice(0, 3).join(', ')}). Ask the owner; never click Allow on it`);
    return r('allow', 'continue', 'Google\'s "Continue as …" confirm for a saved account');
  }
  return r('stop', 'unknown', 'a Google sign-in page this browser does not recognise, so it stops rather than guess');
}

// THE PAGE A BROWSER IS ALREADY ON, ASKED FOR AGAIN (DIVE-6247). An agent that
// carries on a sign-up names the page it sees, and a Google sign-in URL is two
// kilobytes long: round 3 named the chooser with its query cut short or gone,
// and re-opening that lost the flow (a 400, or a pick with no way back to the
// site). Same origin and path, and every parameter named carries the value the
// page has (or the start of it, for one cut short): the same page. Only for a
// sign-in page, where the query IS the flow; anywhere else the URL must match.
const FLOW_PATH = /[/.](log-?in|sign-?in|signin|sign_in|signup|auth|oauth2?|sso|accountchooser|consent)([/?#.]|$)/i;
function samePage(cur, want) {
  let a, b;
  try { a = new URL(cur); b = new URL(want); } catch (e) { return false; }
  if (a.href === b.href) return true;
  if (a.origin !== b.origin || a.pathname.replace(/\/+$/, '') !== b.pathname.replace(/\/+$/, '')) return false;
  if (!GOOGLE_HOST.test(a.hostname) && !FLOW_PATH.test(a.pathname)) return false;
  if (a.href.startsWith(b.href)) return true;
  for (const [k, v] of b.searchParams) {
    const have = a.searchParams.get(k);
    if (have === null || !have.startsWith(v)) return false;
  }
  return true;
}

// BEFORE EACH STEP, in both loops. A goto leaves the page, and leaving is never
// the danger, so it is not checked. Everything else on a page that is not an
// allow stops the plan before that step touches it.
async function stepStop(page, s, gates) {
  if (!s || s.op === 'goto') return null;
  let url = '';
  try { url = page.url(); } catch (e) { return null; }
  if (!isGooglePage(url)) return null;
  let html = '';
  try { html = await page.content(); } catch (e) { html = ''; }
  const v = classify(url, html, gates);
  return v && v.verdict !== 'allow' ? { ...v, url } : null;
}

// THE OWNER'S RECORD (DIVE-7168). A click or a key on a Google page the guard
// allows is the sign-in itself, so the act says which account it used: the one
// the step names, else every signed-in address on the page.
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
function pageAccounts(html, text, s) {
  const ids = new Set();
  const re = /\bdata-(?:identifier|email)\s*=\s*["']([^"']+@[^"']+)["']/gi; let m;
  while ((m = re.exec(String(html || '')))) ids.add(m[1].toLowerCase());
  for (const e of String(text || '').match(EMAIL) || []) ids.add(e.toLowerCase());
  const named = JSON.stringify(s || {}).toLowerCase();
  const pick = [...ids].filter((e) => named.includes(e));
  return pick.length ? pick : [...ids];
}
async function stepGrant(page, s) {
  if (!s || !['click', 'press', 'click_at'].includes(s.op)) return null;
  let url = '';
  try { url = page.url(); } catch (e) { return null; }
  if (!isGooglePage(url)) return null;   // not Google's: nothing to record
  let html = '';
  try { html = await page.content(); } catch (e) { html = ''; }
  const v = classify(url, html);
  // A code or a robot check is a step OF the sign-in, not the account it used.
  if (!v || v.verdict !== 'allow' || v.kind === 'code' || v.kind === 'robot') return null;
  return { kind: v.kind, accounts: pageAccounts(html, visibleText(html), s) };
}

module.exports = { classify, isGooglePage, stepStop, stepGrant, pageAccounts, samePage, dropDetails, visibleText, visibleMarkup, visibleInputs, attrsOf, STOP_PREFIX, GRANT_PREFIX };

if (require.main === module) {
  // node google-signin.cjs <html-file> <url>  ->  one JSON line, or nothing when
  // the URL is not a Google sign-in page.
  // node google-signin.cjs --same-page <url-the-browser-is-on> <url-asked-for>  ->  exit 0 or 1
  if (process.argv[2] === '--same-page') process.exit(samePage(process.argv[3] || '', process.argv[4] || '') ? 0 : 1);
  const fs = require('fs');
  // [<gates-json>]: the kinds the owner gated for this site (DIVE-7881), e.g. '["robot"]'.
  const [file, url, gj] = process.argv.slice(2);
  let html = '', gates = [];
  try { html = fs.readFileSync(file, 'utf8'); } catch (e) { html = ''; }
  try { gates = JSON.parse(gj || '[]'); } catch (e) { gates = []; }
  const v = classify(url || '', html, gates);
  if (v) process.stdout.write(JSON.stringify(v) + '\n');
}

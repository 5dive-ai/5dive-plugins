'use strict';
// WHAT THE PAGE SHOWS, NOT WHAT ITS SOURCE MENTIONS (DIVE-6241).
//
// Two guards in bin/browser decided from a grep of the whole document, and a
// document is mostly script data a person never sees. Round 2 of the Claude in
// Chrome head-to-head measured both misfiring on sign-ups:
//
//   challenge  tally.so was stopped as "presenting a security challenge" while
//              the same profile rendered it normally. Its front page ships its
//              whole i18n table as script data, "login.two-factor-step.title"
//              among it, and the default challenge marker matches "two-factor"
//              anywhere. So the default marker's match is now a CANDIDATE, and
//              this page check decides: a robot widget a person could see, a
//              challenge title, a code box, or a challenge URL. A site's own
//              adapter marker is reviewed for that site and still decides alone.
//
//   signin     a sign-up that redirects to the site's own login page
//              (pitch.com -> auth.pitch.com/login) was refused as a sign-in page
//              before the agent could see its "Continue with Google" button. Such
//              a page is handed back when that button is on it AND no password
//              box, no code box and no robot check is. The Google pages that
//              follow are lib/google-signin.cjs's, which still stops at every one.
//
// Pure functions of (html, url): the same page always gets the same answer.

const { visibleText, visibleMarkup, visibleInputs, attrsOf } = require('./google-signin.cjs');

const CHALLENGE_TITLE = /(captcha|prove your humanity|are you a robot|just a moment|verify you are human|access denied|attention required|security check|performing security verification)/i;
// Phrases only a check itself says, never a product page describing its features.
const CHALLENGE_TEXT = /\b(verify you are (?:a )?human|i'?m not a robot|prove your humanity|unusual traffic from your|checking (?:if the site connection is secure|your browser)|performing security verification|complete the security check)\b/;
const CHALLENGE_PATH = /(\/checkpoint\/challenge|two-factor|verify-your-identity|\/2fa\b|\/mfa\b|\/otp\b)/i;
// Not cf-turnstile: that is a container the SITE names, and tally.so/signup
// renders one 0 px high with its token already filled (measured 2026-10-14).
// A Turnstile a person must click draws in a closed shadow root no DOM shows;
// Cloudflare's full-page check is caught by its title and its own ids below.
const WIDGET_CLASS = /(^|\s)(g-recaptcha|h-captcha|cf-challenge)(\s|$)/i;
const WIDGET_ID = /^(cf-challenge|challenge-form|challenge-running|challenge-stage)\b/i;
const CODE_INPUT = (a) => /one-time-code/i.test(a.autocomplete || '')
  || /(^|[-_])(otp|totp|2fa|mfa|two-?factor|verification-?code|app_otp)([-_]|$)/i.test(`${a.name || ''} ${a.id || ''}`.trim());

function title(html) {
  const m = /<title[^>]*>([^<]{0,200})/i.exec(String(html || ''));
  return m ? m[1].trim() : '';
}
function pathOf(url) { try { return new URL(url).pathname; } catch (e) { return ''; } }

// An element a person could see that is a robot check: the widget's own
// markup (not marked invisible), or its frame.
function robotWidget(markup) {
  const re = /<([a-z][a-z0-9-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi; let m;
  while ((m = re.exec(markup))) {
    const a = attrsOf(m[0]), tag = m[1].toLowerCase();
    const invisible = /invisible/i.test(`${a['data-size'] || ''} ${a.class || ''}`);
    if (tag === 'iframe') {
      const src = a.src || '';
      if (/challenges\.cloudflare\.com/i.test(src)) return 'a Cloudflare check frame';
      if (/recaptcha\/(api2|enterprise)\/(anchor|bframe)/i.test(src) && !/size=invisible/i.test(src)) return 'a reCAPTCHA frame';
      if (/hcaptcha\.com/i.test(src) && !/invisible/i.test(src)) return 'an hCaptcha frame';
      continue;
    }
    if (invisible) continue;
    if (WIDGET_CLASS.test(a.class || '')) return `a ${(a.class.match(WIDGET_CLASS) || [])[2]} widget`;
    if (WIDGET_ID.test(a.id || '')) return `#${a.id}`;
    if (tag === 'form' && CHALLENGE_PATH.test(a.action || '')) return `a form posting to ${a.action}`;
  }
  return '';
}

// challenge(html, url) -> { challenge: bool, kind, why }
//   kind (DIVE-7881): robot (a robot widget, a check's title or words) or code (a
//   code box, a 2-step / identity-check URL). The agent clears both by default;
//   the owner's gate turns one back into a stop (see verify below).
function challenge(html, url) {
  const t = title(html);
  if (CHALLENGE_TITLE.test(t)) return { challenge: true, kind: 'robot', why: `the page title is "${t.slice(0, 80)}"` };
  const p = pathOf(url || '');
  if (p && CHALLENGE_PATH.test(p)) return { challenge: true, kind: 'code', why: `the page is at ${p}` };
  const markup = visibleMarkup(html);
  const w = robotWidget(markup);
  if (w) return { challenge: true, kind: /^a form posting to /.test(w) ? 'code' : 'robot', why: `the page shows ${w}` };
  if (visibleInputs(markup, CODE_INPUT).length) return { challenge: true, kind: 'code', why: 'the page asks for a one-time code' };
  const m = visibleText(html).match(CHALLENGE_TEXT);
  if (m) return { challenge: true, kind: 'robot', why: `the page says "${m[0]}"` };
  return { challenge: false, why: 'the marker matched only text a person does not see (script data, a hidden or invisible element)' };
}

// A SIGN-IN CHECK THE AGENT CLEARS ITSELF (DIVE-7881). lodar 2026-11-07, after
// a head agent refused five times to open the box's Gmail for Discord's «Verify
// by Email»: «clicker wont check email», «remove rules». A code box, a 2-step
// prompt, an "we emailed you a link" step and a robot check are handed back to
// the agent to clear (read the site's mail, type the code, tick the box, wait),
// unless the owner gated that kind for the site.
// verify(html, url, gates) -> { verdict: 'offer'|'stop'|'none', kind, why }
//   offer  a code/email step or a robot check, not gated: the agent's to clear
//   stop   the same, gated by the owner; or a password box (never typed unless
//          the owner saved it)
//   none   none of these: the caller's own verdict stands
const EMAIL_STEP = /\b(check your (?:e-?mail|inbox)|we(?:'ve| have)? (?:just )?(?:sent|emailed) (?:you )?(?:a|an|the) (?:\d-digit )?(?:code|link|e-?mail|verification)|verify (?:by|your|with) e-?mail|new login location|confirm (?:it'?s|it is) you|verification (?:code|e-?mail|link)|enter the code|2-step verification)\b/;
function verify(html, url, gates) {
  const gated = (k) => Array.isArray(gates) && gates.includes(k);
  const markup = visibleMarkup(html);
  if (visibleInputs(markup, (a) => (a.type || '').toLowerCase() === 'password').length) {
    return { verdict: 'stop', kind: 'password', why: 'the page shows a password box' };
  }
  let c = challenge(html, url);
  if (!c.challenge) {
    const m = visibleText(html).match(EMAIL_STEP);
    if (!m) return { verdict: 'none', kind: 'none', why: 'the page shows no code box, verification step or robot check' };
    c = { challenge: true, kind: 'code', why: `the page says "${m[0]}"` };
  }
  if (gated(c.kind)) return { verdict: 'stop', kind: c.kind, why: `${c.why}, and the owner asked to be asked first (gate ${c.kind})` };
  return { verdict: 'offer', kind: c.kind, why: c.why };
}

// signin(html, url) -> { verdict: 'offer'|'stop'|'none', kind, why }
//   offer  the page offers "Continue with Google" (kind google-button), or is the
//          site's terms step (kind terms), and asks for nothing the agent must
//          not give: hand it back for that one click.
//   stop   it offers the button but also shows a password box, a code box or a
//          robot check: still the hard stop.
//   none   no Google button and no terms box: the generic sign-in refusal stands.
const GOOGLE_BUTTON = /\b(continue|sign ?in|sign ?up|log ?in|login|signup|register|get started)\s+(with|using|via)\s+google\b/;
// A PROVIDER BUTTON NAMED ONLY "Google" (DIVE-6247): coda.io's sign-up lands on
// id.superhuman.com, "Continue to Superhuman Docs" over three buttons that say
// just Google, Microsoft and Apple. Round 3 refused that page, so the agent took
// its URL into the public profile, which has no Google session, and met Google's
// email box. A button or link whose whole visible text is "Google" is the same
// offer as "Continue with Google".
function googleOnlyButton(markup) {
  const re = /<(button|a)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi; let m;
  while ((m = re.exec(markup))) {
    if (m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase() === 'google') return true;
  }
  return false;
}
// THE SITE'S OWN TERMS STEP OF A SIGN-UP (DIVE-6317). After Google's consent,
// pitch.com sends a new account to login.pitch.com/consent-and-privacy: "We take
// your privacy seriously", one box that reads "I agree to the Terms of Use,
// Privacy Policy, and Data Processing Agreement", and Continue. Its host starts
// with "login.", so the generic URL guard refused it as a sign-in page and told
// the agent the owner had to log in, twice in round 5. Ticking the site's own
// terms box while creating the account the job names IS the sign-up; it is not a
// grant like a Google scope, and it is not one of the owner's four (pay, publish,
// send, delete). It is handed back as `terms` when a box a person can see sits
// next to words agreeing to terms or a privacy policy, and no password box, code
// box or robot check is on the page.
const TERMS_AGREE = /\bi (?:have read and |hereby )?(?:agree|accept|consent)\b[^.]{0,120}?\b(terms|privacy policy|conditions|data processing agreement)\b/;
function termsBox(markup, text) {
  const m = text.match(TERMS_AGREE);
  if (!m) return '';
  const box = visibleInputs(markup, (a) => (a.type || '').toLowerCase() === 'checkbox').length
    || /<[a-z][a-z0-9-]*\b[^>]*\brole=["']?checkbox\b/i.test(markup);
  return box ? m[0].slice(0, 100) : '';
}
function signin(html, url) {
  const text = visibleText(html);
  const markup = visibleMarkup(html);
  const m = text.match(GOOGLE_BUTTON);
  const b = m ? `"${m[0]}"` : googleOnlyButton(markup) ? 'a button that says just "Google"' : '';
  const terms = b ? '' : termsBox(markup, text);
  if (!b && !terms) return { verdict: 'none', kind: 'no-google', why: 'the page offers no "Continue with Google" and no terms box to agree to' };
  if (visibleInputs(markup, (a) => (a.type || '').toLowerCase() === 'password').length) {
    return { verdict: 'stop', kind: 'password', why: 'the page shows a password box' };
  }
  const c = challenge(html, url);
  if (c.challenge) return { verdict: 'stop', kind: 'challenge', why: c.why };   // verify() hands a code/robot back
  if (terms) return { verdict: 'offer', kind: 'terms', why: `the page is the site's terms step, a box by "${terms}", and shows no password box, code box or robot check` };
  return { verdict: 'offer', kind: 'google-button', why: `the page offers ${b} and shows no password box, code box or robot check` };
}

module.exports = { challenge, signin, verify };

if (require.main === module) {
  // node page-check.cjs challenge|signin|verify <html-file> [<url>] [<gates-json>] -> one JSON line
  const fs = require('fs');
  const [mode, file, url, gj] = process.argv.slice(2);
  let html = '', gates = [];
  try { html = fs.readFileSync(file, 'utf8'); } catch (e) { html = ''; }
  try { gates = JSON.parse(gj || '[]'); } catch (e) { gates = []; }
  const fn = mode === 'signin' ? signin : mode === 'challenge' ? challenge : mode === 'verify' ? verify : null;
  if (!fn) { process.stderr.write('usage: page-check.cjs challenge|signin|verify <html-file> [<url>] [<gates-json>]\n'); process.exit(64); }
  process.stdout.write(JSON.stringify(fn(html, url || '', gates)) + '\n');
}

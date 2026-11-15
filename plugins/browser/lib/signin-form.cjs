#!/usr/bin/env node
'use strict';
// A SIGN-IN FORM, NOT ANY PASSWORD BOX (DIVE-8523).
//
// The generic guard read a bare `type=password` or `autocomplete=current-password`
// anywhere in the page as "this is a sign-in form". wappi.pro's signed-in cabinet
// (box report 1004, 2026-11-15) carries a change-password dialog —
// change-password-current|new|repeat, the first with autocomplete=current-password —
// plus a hidden name=fake_pass anti-autofill decoy, and no login form. Every
// `act` on it was refused as signed out while the session was fine.
//
// A password input counts as a sign-in only when it is VISIBLE (not inside a
// hidden element, not an aria-hidden / tabindex=-1 / display:none decoy) and it
// is not part of a change or set-password form:
//   - its own autocomplete is new-password, or its id/name says change, new,
//     repeat, confirm, retype, fake or old;
//   - or it shares a <form> with such a field (current + new = change password).
// A visible form posting to a login/session/auth path is still a sign-in form.
// The URL test (GENERIC_SIGNIN_URL in bin/browser) is the caller's and is
// untouched: wappi signed out lands on /login and is still refused.
//
// Pure function of the html. Usage: signin-form.cjs <html-file> -> prints
// `signin` or `none` (exit 0), then a line naming why.
const fs = require('fs');
const { visibleMarkup, attrsOf } = require('./google-signin.cjs');

const CHANGE_WORD = /(change|repeat|confirm|retype|re-?enter|fake|decoy)/i;
const CHANGE_PART = /(^|[-_.[\s])(new|old|again|verify)([-_.\]\s]|pass|pwd|$)|^(new|old)|(pass(word)?|pwd)[-_.]?(2|again|new|old)$/i;
const LOGIN_ACTION = /(log-?in|sign-?in|sign_in|\/session|\/auth)/i;

function decoy(a) {
  return 'hidden' in a || a['aria-hidden'] === 'true' || a.tabindex === '-1' || 'disabled' in a
    || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style || '')
    || /^hidden/i.test(a.name || '');
}

function changeField(a) {
  if (/new-password/i.test(a.autocomplete || '')) return true;
  return [a.id, a.name].some((v) => v && (CHANGE_WORD.test(v) || CHANGE_PART.test(v)));
}

// Each <form> (its attributes) and each password <input> with the index of the
// <form> it sits in (-1 for none). Chrome's DOM never nests a form in a form.
function scan(markup) {
  const forms = [], inputs = [];
  const re = /<(\/?)(form|input)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
  let m, form = -1;
  while ((m = re.exec(markup))) {
    const closing = m[1] === '/', tag = m[2].toLowerCase();
    if (tag === 'form') {
      if (closing) form = -1;
      else { form = forms.length; forms.push(attrsOf(m[0])); }
      continue;
    }
    const a = attrsOf(m[0]);
    if ((a.type || '').toLowerCase() === 'password') inputs.push({ a, form, tag: m[0] });
  }
  return { forms, inputs };
}

function classify(html) {
  const { forms, inputs } = scan(visibleMarkup(html));
  const pws = inputs.filter((p) => !decoy(p.a));
  // A form holding a change/set-password field is that form, whatever it posts to
  // (an /auth/change-password action is not a sign-in).
  const changeForms = new Set(pws.filter((p) => p.form >= 0 && changeField(p.a)).map((p) => p.form));
  const posting = forms.findIndex((a, i) => !changeForms.has(i) && a.action && LOGIN_ACTION.test(a.action));
  if (posting >= 0) return { signin: true, why: `a form posting to ${forms[posting].action.slice(0, 60)}` };
  const login = pws.find((p) => !changeField(p.a) && !changeForms.has(p.form));
  if (login) return { signin: true, why: `a password box (${login.tag.slice(0, 80)})` };
  if (pws.length) return { signin: false, why: `${pws.length} password box(es), all of a change or set-password form` };
  return { signin: false, why: 'no visible password box and no form posting to a sign-in' };
}

module.exports = { classify, changeField };

if (require.main === module) {
  let html = '';
  try { html = fs.readFileSync(process.argv[2] || 0, 'utf8'); } catch (e) { process.stdout.write('signin\ncould not read the page\n'); process.exit(0); }
  const r = classify(html);
  process.stdout.write(`${r.signin ? 'signin' : 'none'}\n${r.why}\n`);
}

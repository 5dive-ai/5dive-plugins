#!/usr/bin/env node
'use strict';
// THE GENERIC LOGIN CHECK (DIVE-5388) — for a connected site no adapter covers.
//
// Every site a customer types is adapterless, and `status` used to stop at
// "UNKNOWN (no adapter)": 7 of 13 connected sites on chill-gorge (2026-10-02)
// had no check at all. This reads the one thing almost every site puts in the
// same place in both states: the HEADER. A signed-out header offers "Log in",
// "Sign in" or "Sign up"; a signed-in one offers an avatar or a menu instead.
//
//   out   a password field / a form posting to a login path anywhere on the
//         page, or a Log in / Sign in / Sign up control (a link, a button, or
//         an element with role=button) inside <header>, <nav>, role=banner or
//         role=navigation — its whole text or its aria-label, not a sentence
//         that merely contains the words ("Sign up for our newsletter" is not
//         a sign-in control; "Log out" is not either).
//   in    a header/nav region WITH controls in it, and none of them is one of
//         those. Positive evidence that the page rendered its chrome and chose
//         not to offer a sign-in — never "the page loaded" (see
//         community/wiki/browser-status-certifies-what-it-cannot-classify.md).
//   none  neither is decidable: no header or nav with any control in it (a
//         single-page shell that has not painted, an identifier-only sign-in
//         step, a bare interstitial). The caller stamps `unknown`.
//
// Usage: generic-login.cjs <html-file>  -> prints out|in|none (exit 0), and on
// `out` a second line naming what matched. Challenge pages are the CALLER's to
// classify first, with its own (adapter or default) marker: a challenge page
// often carries a sign-in form, and this must never be the one to decide it.
const fs = require('fs');

const SIGNIN_TEXT = new RegExp('^(?:' + [
  'log ?in', 'login', 'sign ?in', 'signin', 'sign ?up', 'signup',
  'log ?in ?(?:/|or|&|and) ?sign ?up', 'sign ?in ?(?:/|or|&|and) ?(?:sign ?up|register|join)',
  'sign ?up ?(?:/|or|&|and) ?(?:log ?in|sign ?in)', 'register', 'create (?:an )?account',
  // The sites on chill-gorge that are not English (juejin.cn) and the commonest others.
  '登录', '登入', '注册', '登录 ?/ ?注册', '登录 ?\\| ?注册', 'ログイン', '로그인',
  'iniciar sesión', 'anmelden', 'se connecter', 'connexion', 'accedi', 'entrar', 'войти',
].join('|') + ')[\\s›»→>!.]*$', 'i');

const PASSWORD = /<input\b[^>]*\btype\s*=\s*["']?password|autocomplete\s*=\s*["']?current-password|<form\b[^>]*\baction\s*=\s*["'][^"']*(?:log-?in|sign-?in|sign_in|\/session|\/auth)/i;

function strip(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');
}

function text(s) {
  return s.replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
}

function attr(tag, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

const hidden = (tag) => /\shidden(?:[\s>=]|$)/i.test(tag) || attr(tag, 'aria-hidden') === 'true'
  || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attr(tag, 'style') || '');

// The body of every header/nav/banner/navigation element, each up to ITS close
// tag, counting nested elements of the same name. No parser: the probe reads a
// dumped DOM, which Chrome has already normalised. A region nested inside one
// already taken is part of that one.
const REGION = /<(header|nav)\b[^>]*>|<([a-z][a-z0-9-]*)\b[^>]*\brole\s*=\s*["']?(?:banner|navigation)\b[^>]*>/gi;
function regions(doc) {
  const out = [];
  REGION.lastIndex = 0;
  let m;
  while ((m = REGION.exec(doc))) {
    const name = (m[1] || m[2]).toLowerCase();
    const from = m.index + m[0].length;
    const tagRe = new RegExp('<(/?)' + name + '\\b[^>]*>', 'gi');
    tagRe.lastIndex = from;
    let depth = 1, t, end = doc.length;
    while ((t = tagRe.exec(doc))) {
      depth += t[1] ? -1 : 1;
      if (!depth) { end = t.index; break; }
    }
    if (!hidden(m[0])) out.push(doc.slice(from, end));
    REGION.lastIndex = Math.max(end, from);
  }
  return out;
}

function controls(region) {
  const out = [];
  const re = /<(a|button)\b([^>]*)>([\s\S]*?)<\/\1\s*>|<([a-z][a-z0-9-]*)\b([^>]*\brole\s*=\s*["']?button\b[^>]*)>([\s\S]*?)<\/\4\s*>/gi;
  let m;
  while ((m = re.exec(region))) {
    const open = '<' + (m[1] || m[4]) + (m[2] ?? m[5]) + '>';
    if (hidden(open)) continue;
    out.push({ text: text(m[3] ?? m[6]), label: attr(open, 'aria-label') || attr(open, 'title') || '' });
  }
  return out;
}

function classify(html) {
  const doc = strip(html);
  const pw = PASSWORD.exec(doc);
  if (pw) return { verdict: 'out', why: `a sign-in form on the page (${pw[0].slice(0, 60)})` };
  const found = regions(doc);
  let any = 0;
  for (const r of found) {
    for (const c of controls(r)) {
      any++;
      for (const s of [c.text, c.label]) {
        if (s && SIGNIN_TEXT.test(s)) return { verdict: 'out', why: `a "${s.slice(0, 40)}" control in the page header` };
      }
    }
  }
  return any ? { verdict: 'in', why: `${any} header control(s), none of them a sign-in` } : { verdict: 'none', why: 'no header or navigation with controls in it' };
}

module.exports = { classify, SIGNIN_TEXT };

if (require.main === module) {
  let html = '';
  try { html = fs.readFileSync(process.argv[2] || 0, 'utf8'); } catch (e) { process.stdout.write('none\ncould not read the page\n'); process.exit(0); }
  const r = classify(html);
  process.stdout.write(`${r.verdict}\n${r.why}\n`);
}

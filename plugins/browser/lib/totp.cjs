'use strict';
// DIVE-5336 — the owner's authenticator code, typed by the box at a 2FA prompt.
//
// WHAT THIS IS, AND THE LINE IT DOES NOT CROSS. The owner chose to save the
// SEED behind a site's authenticator QR (the base32 secret an app like Google
// Authenticator scans) on this box. With it, the box computes the same 6-digit
// code the owner's phone shows (RFC 6238) and types it where the site asks for
// it. That is the owner logging in as themselves. It is NOT a captcha solver and
// not an "are you human" bypass: a challenge that is a bot check still goes to a
// person (the 2026-09-30 browser direction), and nothing here looks for one.
//
// THE SEED AND THE CODE NEVER LEAVE THIS PROCESS. The seed lives in one file,
// 0600, inside the site's 0700 profile directory, so `forget` takes it with the
// login and no seat that cannot read the profile can read it. Nothing below
// returns, logs or throws a message containing either: every result names the
// FIELD it typed into, never what it typed. The model reads the result line; a
// code in it would be a code in a transcript.
//
// ONE FILE FOR BOTH EXECUTORS, for proxy.cjs's reason: the cold driver and the
// warm session must not be able to disagree about which field is the code box
// or which host may receive it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = '.5dive-totp';
const STEP_S = 30, DIGITS = 6;
// A code with less than this left is not typed: the site would receive it in
// the next window and refuse it. Waiting for the next one costs at most this.
const MIN_LEFT_S = 5;

function seedFile(profile) { return path.join(profile, FILE); }

// RFC 4648 base32, as authenticator apps write it: case-insensitive, spaces and
// `=` padding ignored. Returns null on anything else rather than guessing — a
// half-decoded seed produces codes that are wrong forever, silently.
function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0; const out = [];
  for (const c of clean) {
    val = (val << 5) | A.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

// RFC 6238 over RFC 4226, HMAC-SHA1, 30 s, 6 digits: the parameters every
// consumer authenticator uses. A site with other parameters ships them in an
// otpauth:// URI, and `totp set` refuses those rather than storing a seed whose
// codes would never be accepted.
function codeAt(seed, ms) {
  const counter = Math.floor(ms / 1000 / STEP_S);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', seed).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

// FAIL CLOSED ON THE FILE, as _audit does on the directory: a seed another uid
// can read is a second authenticator in somebody else's hands. Absent -> null
// (no seed saved: the caller behaves exactly as before this file existed).
function readSeed(profile) {
  const f = seedFile(profile);
  let st;
  try { st = fs.lstatSync(f); } catch (e) { return null; }
  if (!st.isFile()) throw new Error(`${f} is not a regular file — refusing to read a seed through it`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${f} is readable by other users (mode ${(st.mode & 0o777).toString(8)}) — refusing to use it. Save it again: 5dive browser totp set <site>`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${f} is not owned by this seat — refusing to use it`);
  const seed = base32Decode(fs.readFileSync(f, 'utf8'));
  if (!seed || seed.length < 10) throw new Error(`${f} does not hold a usable authenticator seed. Save it again: 5dive browser totp set <site>`);
  return seed;
}

// The code box, most specific first. `one-time-code` is the HTML standard's
// own name for it; the rest are the names real sites give the field (GitHub
// app_totp / app_otp, Google totpPin, Microsoft otc, generic otp/2fa/mfa). A
// bare "code" input counts only when it also says it is numeric or 6 long —
// a promo-code or zip-code box must never receive an authenticator code.
const FIELDS = [
  'input[autocomplete="one-time-code"]',
  'input#app_totp', 'input[name="app_otp"]', 'input[name="totpPin"]', 'input[name="otc"]',
  'input[name*="totp" i]', 'input[id*="totp" i]',
  'input[name*="otp" i]', 'input[id*="otp" i]',
  'input[name*="2fa" i]', 'input[id*="2fa" i]', 'input[name*="mfa" i]', 'input[id*="mfa" i]',
  'input[name*="code" i][inputmode="numeric"]', 'input[name*="code" i][maxlength="6"]',
  'input[id*="code" i][inputmode="numeric"]', 'input[id*="code" i][maxlength="6"]',
];

async function findField(page) {
  for (const sel of FIELDS) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      const ok = await el.isVisible().catch(() => false) && await el.isEditable().catch(() => false);
      if (!ok) continue;
      const type = String(await el.getAttribute('type').catch(() => '') || '').toLowerCase();
      if (type && !['text', 'tel', 'number', 'password'].includes(type)) continue;
      return { loc: el, sel };
    }
  }
  return null;
}

// The page may receive the code only if it is the site the seed belongs to.
// A seed saved for github.com typed into a page some redirect landed on is a
// live second factor handed to a stranger; this is the check that stops it.
function hostAllowed(url, base) {
  let h;
  try { h = new URL(url).hostname.toLowerCase(); } catch (e) { return false; }
  const b = String(base || '').toLowerCase().replace(/^www\./, '');
  return !!b && (h === b || h.endsWith('.' + b));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Load `url` in `page`, find the code box, type the current code, submit.
// Returns {filled, field?, url, why?} — never the code. Throws only when the
// seed file itself is unusable (that message names the file, not its bytes).
async function fill(page, profile, { url, base, settleMs = 1500, now = Date.now } = {}) {
  const seed = readSeed(profile);
  if (!seed) return { filled: false, why: 'no-seed', url: url || page.url() };
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (settleMs > 0) await page.waitForTimeout(Math.min(settleMs, 3000));
  const at = page.url();
  if (!hostAllowed(at, base)) return { filled: false, why: 'foreign-host', url: at };
  const f = await findField(page);
  if (!f) return { filled: false, why: 'no-field', url: at };
  const left = STEP_S - Math.floor(now() / 1000) % STEP_S;
  if (left < MIN_LEFT_S) await sleep(left * 1000 + 250);
  await f.loc.fill('');
  await f.loc.pressSequentially(codeAt(seed, now()), { delay: 60 });
  await f.loc.press('Enter');
  if (settleMs > 0) await page.waitForTimeout(settleMs);
  return { filled: true, field: f.sel, url: page.url() };
}

module.exports = { FILE, STEP_S, DIGITS, FIELDS, seedFile, base32Decode, codeAt, readSeed, hostAllowed, findField, fill };

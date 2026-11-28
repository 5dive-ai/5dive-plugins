#!/usr/bin/env node
'use strict';
// DIVE-9500: agents skipped pages they could have opened. On poke-two over 7 days
// (2026-11-21..28), 38 WebFetch/curl page fetches came back blocked (403, a
// Cloudflare check, a JavaScript-only page, a timeout) and 20 of them were dropped
// with no browser try. This hook tells the agent at that moment, in one line.
//
// Rules: no network, no files, a regex on the tool's own result. Silent when the
// page came back. Silent for API calls (an auth header, an api.* host) and for
// local addresses, where a browser is not the answer.

const HINT = (url) =>
  `This page needs a real browser: run 5dive browser read ${url} (or the matching verb).`;

// A page that is a wall, not the content. Checked only on the head of the result.
const WALL = new RegExp([
  '<title>\\s*just a moment\\.\\.\\.',
  'attention required! \\| cloudflare',
  'challenges\\.cloudflare\\.com',
  'cf-chl-',
  'checking your browser before',
  'enable javascript and cookies to continue',
  'you need to enable javascript',
  'please (turn on|enable) javascript',
  '(page|site|app|content) (requires?|needs?) javascript',
  'javascript (is )?(disabled|required)',
  'verify you are (a )?human',
  'are you a robot',
  'unusual traffic from your (computer|network)',
  'access to this page has been denied',
  'sorry, you have been blocked',
].join('|'), 'i');

const BLOCK_CODE = /^(401|403|407|429|5\d\d)$/;
const NET_FAIL = /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|timed? ?out|timeout of \d+ms exceeded)\b/i;
const URL_RE = /https?:\/\/[^\s'"<>|\\`)]+/g;

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
}

function isLocal(h) {
  return !h || /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$)/.test(h) ||
    /\.(local|internal|localhost)$/.test(h);
}

function str(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? (x.text ?? '') : String(x))).join('\n');
  if (typeof v === 'object') return [v.stdout, v.stderr, v.result, v.output, v.content].filter((x) => typeof x === 'string').join('\n');
  return String(v);
}

// WebFetch. PostToolUse carries {code, result}; a network failure arrives as
// PostToolUseFailure with an `error` string.
function webfetch(input) {
  const url = String(input.tool_input?.url ?? '');
  const h = hostOf(url);
  if (isLocal(h)) return null;
  if (input.hook_event_name === 'PostToolUseFailure') {
    const err = str(input.error);
    if (/InputValidationError|permission|not allowed|denied by/i.test(err) && !/\b(401|403|429)\b/.test(err)) return null;
    if (/\b(401|403|407|429|50[0-9])\b/.test(err) || NET_FAIL.test(err) || WALL.test(err)) return HINT(url);
    return null;
  }
  const r = input.tool_response;
  const code = r && typeof r === 'object' && r.code != null ? String(r.code) : '';
  if (BLOCK_CODE.test(code)) return HINT(url);
  const text = str(r).slice(0, 4000);
  if (/^the server returned http (401|403|407|429|5\d\d)\b/i.test(text.trim())) return HINT(url);
  if (WALL.test(text)) return HINT(url);
  return null;
}

// Bash. Only when the command runs curl or wget on a web URL and it is not an
// API call; then look at what came back. A bare 5xx status from curl (-I, or
// -f's "(22) ... error: 503") is left alone: that is a server being down or a health probe, and a browser does not
// fix it (a block page served with a 5xx is still caught by WALL).
function shell(input) {
  const cmd = String(input.tool_input?.command ?? '');
  if (!/(^|[\s;&|(`$])(curl|wget)\s/.test(cmd)) return null;
  if (/-H\s*['"]?(authorization|x-api-key|private-token|cookie)\s*:|\bBearer\s/i.test(cmd)) return null;
  if (/(^|\s)(-u|--user|--oauth2-bearer)\s/.test(cmd)) return null;
  const page = (u) => { const h = hostOf(u); return !/[$`{}]/.test(u) && !isLocal(h) && !/^api\./.test(h); };
  const urls = [...new Set((cmd.match(URL_RE) || []).map((u) => u.replace(/[.,;]+$/, '')).filter(page))];
  if (!urls.length) return null;
  const out = (input.hook_event_name === 'PostToolUseFailure' ? str(input.error) : str(input.tool_response)).slice(0, 4000);
  if (!out) return null;
  const m = WALL.exec(out) ||
    /^HTTP\/[\d.]+ (401|403|407|429)\b/m.exec(out) ||
    /curl: \(22\) The requested URL returned error: (401|403|407|429)\b/.exec(out) ||
    /curl: \(28\)|ERROR (401|403|407|429)\b/.exec(out) ||
    // curl -w '%{http_code}' printing a block code at the start of a line.
    (/http_code/.test(cmd) ? /^(401|403|429)\b/m.exec(out) : null);
  if (!m) return null;
  if (urls.length === 1) return HINT(urls[0]);
  // Several pages in one command (a loop): name the one on the failing line,
  // never the first one, which may well have loaded.
  const ls = out.lastIndexOf('\n', m.index) + 1;
  const le = out.indexOf('\n', m.index);
  const onLine = (out.slice(ls, le < 0 ? undefined : le).match(URL_RE) || []).map((u) => u.replace(/[.,;]+$/, '')).find(page);
  return HINT(onLine || '<url>');
}

function nudge(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.tool_name === 'WebFetch') return webfetch(input);
  if (input.tool_name === 'Bash') return shell(input);
  return null;
}

module.exports = { nudge, HINT };

if (require.main === module) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { buf += c; });
  process.stdin.on('end', () => {
    let line = null;
    try { line = nudge(JSON.parse(buf)); } catch { line = null; }
    if (line) {
      const ev = JSON.parse(buf).hook_event_name === 'PostToolUseFailure' ? 'PostToolUseFailure' : 'PostToolUse';
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ev, additionalContext: line } }));
    }
    process.exit(0);
  });
}

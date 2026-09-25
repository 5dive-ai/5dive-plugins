'use strict';
// DIVE-4951 — the seat's own proxy, read at launch by BOTH launch sites
// (bin/driver-playwright and bin/session-daemon).
//
// WHY THIS EXISTS. Some sites refuse a datacenter IP outright ("Request blocked by
// network security"), and a 5dive box is a datacenter IP. The customer's fix is
// their own residential proxy, and every paid one hands out a URL with a username
// and password in it. Chrome's --proxy-server cannot carry those — it takes
// host:port and then pops an auth prompt nobody is there to answer. Playwright's
// `proxy: {server, username, password}` answers the challenge itself, which is
// why the setting reaches Chrome through the launch options and never as an arg.
//
// ONE PARSER, SHARED, unlike launchArgs(): that refusal is a security claim kept
// as two literal copies on purpose. This is the opposite case — two parsers that
// could disagree would send the served browser and the cold run out through two
// different routes, and a site that sees a login move between IPs ends it.
//
// THE FILE IS A CREDENTIAL. `5dive browser proxy set` writes it 0600 into the
// seat's own 0700 profile root, next to (not inside) the site profiles. Nothing
// here echoes it: every message below names the FILE, never its contents, and the
// `server` handed to Playwright is scheme://host:port with the userinfo stripped.
const fs = require('fs');
const path = require('path');

const FILE = '.5dive-proxy';

// A profile is <root>/<seat>/<site>, so the seat's setting is one level up. The
// same rule holds for the public profile and for every site the seat owns.
function proxyFile(profile) {
  return path.join(path.dirname(profile), FILE);
}

// Returns undefined when nothing is set — and the caller then adds NO `proxy` key
// at all, so an unset box launches byte-for-byte as it did before this file.
// Throws an Error whose message never contains the setting, for a file that is
// there and cannot be used: FAIL CLOSED. Going out direct when the person asked
// for their proxy is the route the setting exists to avoid, and it moves the
// login to a new IP without anybody having chosen that.
function launchProxy(profile) {
  const f = proxyFile(profile);
  let raw;
  try {
    raw = fs.readFileSync(f, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return undefined;
    throw new Error(`the proxy setting at ${f} could not be read (${e && e.code}). ` +
      `Refusing to go out without it; fix it with \`5dive browser proxy set\` or remove it with \`5dive browser proxy clear\`.`);
  }
  const line = raw.split('\n').map(s => s.trim()).find(s => s && !s.startsWith('#'));
  if (!line) return undefined;
  let u;
  try { u = new URL(line); } catch (e) { u = null; }
  const scheme = u && u.protocol.replace(/:$/, '');
  if (!u || !['http', 'https', 'socks5', 'socks4'].includes(scheme) || !u.hostname) {
    throw new Error(`the proxy setting at ${f} is not a scheme://[user:pass@]host:port URL. ` +
      `Refusing to go out without it; fix it with \`5dive browser proxy set\` or remove it with \`5dive browser proxy clear\`.`);
  }
  const out = { server: `${u.protocol}//${u.host}` };
  if (u.username) out.username = decodeURIComponent(u.username);
  if (u.password) out.password = decodeURIComponent(u.password);
  return out;
}

module.exports = { FILE, proxyFile, launchProxy };

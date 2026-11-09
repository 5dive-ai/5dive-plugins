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

// HOW THE ROUTE REACHES CHROME (DIVE-7643). Two ways, chosen by whether the
// proxy carries a login:
//
// - WITH a login: Playwright's `proxy` option, the only way to answer the
//   proxy's auth challenge (the header above). Only http(s) gets here: `proxy
//   set` refuses a login on socks.
// - WITHOUT one: a plain `--proxy-server=scheme://host:port` arg, as input mode
//   has done since DIVE-7476. Handing a socks5 proxy to Playwright's option
//   makes Playwright add `--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE
//   <proxy host>"`, and a headed Chrome answers that flag with its yellow
//   "You are using an unsupported command-line flag" bar across every window
//   the customer sees and every screenshot an agent takes. The flag was a DNS
//   guard, and it is not needed: Chrome's own socks5 resolves the hostname AT
//   the proxy, so the page still leaves from the proxy's IP. Do not replace it
//   with --test-type to hide the bar: that switches off other warnings too.
//   `<-loopback>` keeps what Playwright's option did, so localhost goes through
//   the proxy too and the route does not change for any page.
//
// Returns { args, option }: args to append to the launch args, and the keys to
// spread into the launch options. Unset → no args and no key, byte-for-byte
// the launch from before DIVE-4951.
function launchRoute(via) {
  if (!via) return { args: [], option: {} };
  if (via.username || via.password) return { args: [], option: { proxy: via } };
  return { args: [`--proxy-server=${via.server}`, '--proxy-bypass-list=<-loopback>'], option: {} };
}

module.exports = { FILE, proxyFile, launchProxy, launchRoute };

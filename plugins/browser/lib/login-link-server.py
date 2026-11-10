#!/usr/bin/env python3
"""The login-link server for a SELF-HOSTED box (DIVE-6219). Standard library only.

A hosted 5dive box answers https://<its 5dive domain>/browser/viewer/<site>/<nonce>
through shelld. A self-hosted box has no shelld and no domain, so a Connect tap
there had no link to send. This is the smallest server that can answer that one
URL, written for this repo (it is not shelld and copies none of it). It runs as
the box seat on 127.0.0.1 only, behind a TLS front that forwards it nothing but
/browser/viewer/*, and it answers four shapes and 404s everything else:

  GET  /browser/viewer/<site>/<nonce>          the page (it redeems NOTHING: a
                                               link preview or a prefetch that
                                               fetches the URL must not spend it)
  POST /browser/viewer/<site>/<nonce>/redeem   the page's script: redeems the
                                               ticket through `5dive browser
                                               viewer-redeem` (nonce on stdin), and
                                               answers the VNC password and a
                                               one-use socket path. Its body may
                                               carry the page's size {"w","h"}: a
                                               phone gets the browser window fitted
                                               to it for the view (DIVE-6646)
  GET  /browser/viewer/<site>/<nonce>/ws/<tok> the websocket, spliced byte for byte
                                               onto the viewer's own loopback bridge
  POST /browser/viewer/<site>/<nonce>/done/<d> the page's Done (DIVE-7675): root finishes
                                               the ask through `_connect view-done`
                                               with the bind this link was redeemed
                                               under. <d> is one-use and was handed
                                               only to the page that redeemed it
  GET  /browser/viewer/assets/...              page.js and the box's noVNC files

The ticket's rules (one use, expiry, session bind, sha256-only storage) are all
enforced by viewer-redeem, not here. What this adds: the bind is the one root
registered for the site at the owner's tap (root writes it, this reads it), a
redeem must come from the page on the link's own origin, and the socket token is
one-use and dies with the ticket.
"""
import http.server
import json
import os
import re
import secrets
import select
import socket
import subprocess
import sys
import threading
import time

HOST = os.environ.get("LINK_HOST", "")
PORT = int(os.environ.get("LINK_PORT", "3111"))
BIND_DIR = os.environ.get("LINK_BIND_DIR", "/var/lib/5dive/browser-link/binds")
NOVNC_DIR = os.environ.get("LINK_NOVNC_DIR", "/usr/share/novnc")
PAGE_DIR = os.environ.get("LINK_PAGE_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "login-link"))
# The redeem command, as argv. The site and the session are appended; the nonce
# goes on stdin, because viewer-redeem refuses a nonce in argv.
REDEEM = json.loads(os.environ.get("LINK_REDEEM_CMD", '["/usr/local/bin/5dive", "browser", "viewer-redeem"]'))
# The viewer's Done (DIVE-7675): root's half, the same grant a Telegram tap uses.
# Its words ride stdin, NUL-separated, so the bind never sits in the process table.
DONE = json.loads(os.environ.get("LINK_DONE_CMD", '["sudo", "-n", "/usr/local/bin/5dive", "browser", "_connect"]'))
DONE_TTL = 7200         # as long as root keeps the ask's Done (CONNECT_DONE_TTL)

SITE = r"[A-Za-z0-9._-]{1,64}"
NONCE = r"[0-9a-f]{64}"
RE_PAGE = re.compile(rf"^/browser/viewer/({SITE})/({NONCE})/?$")
RE_REDEEM = re.compile(rf"^/browser/viewer/({SITE})/({NONCE})/redeem$")
RE_DONE = re.compile(rf"^/browser/viewer/({SITE})/({NONCE})/done/([0-9a-f]{{64}})$")
RE_WS = re.compile(rf"^/browser/viewer/({SITE})/({NONCE})/ws/([0-9a-f]{{64}})$")
RE_ASSET = re.compile(r"^/browser/viewer/assets/(page\.js|viewer-ui\.js|novnc/[A-Za-z0-9._/-]{1,200})$")
# Debian's novnc package links its vendored libraries out to these.
ALLOWED_ASSET_ROOTS = ("/usr/share/novnc", "/usr/share/javascript", "/usr/share/nodejs")
TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html; charset=utf-8",
         ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
         ".json": "application/json", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
         ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".oga": "audio/ogg"}

_tokens = {}            # token -> (site, nonce, "127.0.0.1", port, expires_at)
_dones = {}             # done handle -> (site, nonce, bind, expires_at)
_lock = threading.Lock()

# The same layout as the hosted viewer (shelld's viewerPage, DIVE-7223): a 44-px
# bar with the site, one line of help, Type and Paste; the box's screen under it.
# page.js labels the bar in the viewer's language and wires it (viewer-ui.js).
# {site} is RE_PAGE's match, so it holds no markup.
PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:,">
<title>{site}</title>
<style>
 html,body{margin:0;height:100%;background:#0b0d10;color:#e6e8eb;
  font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;overscroll-behavior:none}
 #bar{padding:10px 14px;border-bottom:1px solid #232830;display:flex;gap:10px;align-items:center;
  height:23px;white-space:nowrap}
 #bar b{font-weight:600;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
 #note{color:#9aa4b2;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
 #pastebox{flex:1 0 150px;display:flex;gap:6px}
 #pastebox[hidden],#note[hidden]{display:none}
 /* With the field open, Type has done its job: its room keeps Paste on a phone-wide bar. */
 #pastebox:not([hidden])~#type{display:none}
 /* 16px, not the bar's 14: a phone zooms the page in on a focused field with smaller text (DIVE-7379). */
 #pastein{flex:1;min-width:0;background:#15191f;color:inherit;border:1px solid #2e3540;border-radius:6px;
  padding:1px 8px;font:inherit;font-size:16px;line-height:19px}
 #bar button{background:#1f2630;color:inherit;border:1px solid #2e3540;border-radius:6px;padding:1px 12px;
  font:inherit;line-height:19px;cursor:pointer}
 #bar button:disabled{opacity:.45;cursor:default}
 #bar #done{background:#1d6b41;border-color:#2b8a57;font-weight:600}
 #done[hidden]{display:none}
 #msg a{color:#7cc4ff}
 #screen{position:absolute;inset:44px 0 0 0;background:#000}
 #msg{position:absolute;inset:44px 0 0 0;display:grid;place-content:center;text-align:center;padding:24px}
</style></head>
<body><div id="bar"><b id="site">{site}</b>
 <span id="note"></span>
 <form id="pastebox" hidden><input id="pastein" type="text" autocomplete="off" autocapitalize="off"
  autocorrect="off" spellcheck="false"><button type="submit"></button></form>
 <button id="type" type="button" disabled></button>
 <button id="paste" type="button" disabled></button>
 <button id="done" type="button" disabled></button></div>
<div id="screen"></div>
<div id="msg">…</div>
<script type="module" src="/browser/viewer/assets/page.js"></script>
</body></html>
"""


def bind_for(site):
    """The bind root registered for <site> at the owner's tap, if it is live."""
    try:
        with open(os.path.join(BIND_DIR, site)) as f:
            kv = dict(l.rstrip("\n").split("=", 1) for l in f if "=" in l)
    except OSError:
        return None
    b, e = kv.get("bind", ""), kv.get("expires_at", "")
    if not re.fullmatch(r"[0-9a-f]{32}", b) or not e.isdigit() or int(e) <= time.time():
        return None
    return b, int(e)


def client_size(raw):
    """The page's own size from the redeem body, as viewer-redeem's --client."""
    try:
        j = json.loads(raw or b"{}")
        w, h = j.get("w"), j.get("h")
    except (ValueError, AttributeError):
        return ""
    if not all(isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= 9999 for v in (w, h)):
        return ""
    return "%dx%d" % (w, h)


def sweep():
    now = time.time()
    with _lock:
        for k in [k for k, v in _tokens.items() if v[4] <= now]:
            del _tokens[k]
        for k in [k for k, v in _dones.items() if v[3] <= now]:
            del _dones[k]


class H(http.server.BaseHTTPRequestHandler):
    server_version = "5dive-login-link"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # Never log a path or a request line: both carry the nonce.
    def log_message(self, fmt, *a):
        pass

    def log_request(self, code="-", size="-"):
        sys.stderr.write("%s %s\n" % (self.command, code))

    def send(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.send_header("referrer-policy", "no-referrer")
        self.send_header("x-content-type-options", "nosniff")
        self.send_header("x-frame-options", "DENY")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def nf(self):
        self.send(404, "not found\n")

    def path_only(self):
        return self.path.split("?", 1)[0]

    def do_HEAD(self):
        self.nf()

    def do_GET(self):
        p = self.path_only()
        m = RE_PAGE.match(p)
        if m:
            return self.send(200, PAGE.replace("{site}", m.group(1)), "text/html; charset=utf-8", {
                "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self'; "
                                           "style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; "
                                           "form-action 'none'; frame-ancestors 'none'"})
        m = RE_ASSET.match(p)
        if m:
            return self.asset(m.group(1))
        m = RE_WS.match(p)
        if m:
            return self.ws(*m.groups())
        self.nf()

    def own_page(self):
        # Only the page on the link's own origin may spend the link: a form or a
        # fetch from any other origin carries a different Origin and is refused.
        return bool(HOST) and self.headers.get("origin") == "https://" + HOST and self.headers.get("x-5dive-viewer") == "1"

    def do_POST(self):
        d = RE_DONE.match(self.path_only())
        if d:
            return self.done(*d.groups())
        m = RE_REDEEM.match(self.path_only())
        if not m:
            return self.nf()
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(min(n, 4096)) if n else b""
        if not self.own_page():
            return self.send(403, "refused: a login link is redeemed only by its own page\n")
        site, nonce = m.groups()
        b = bind_for(site)
        if not b:
            return self.send(410, json.dumps({"error": "this login link is not live any more. Ask your agent for a new one."}), "application/json")
        bind, exp = b
        argv = REDEEM + [site, "--nonce=-", "--session=" + bind]
        client = client_size(raw)
        if client:
            argv.append("--client=" + client)
        try:
            r = subprocess.run(argv, input=nonce + "\n",
                               capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            return self.send(503, json.dumps({"error": "the box could not open the login screen. Ask your agent for a new link."}), "application/json")
        kv = dict(l.split("=", 1) for l in r.stdout.splitlines() if "=" in l)
        tm = re.fullmatch(r"127\.0\.0\.1:([0-9]{1,5})", kv.get("target", ""))
        if r.returncode != 0 or not tm or not kv.get("password"):
            why = (r.stderr.strip().splitlines() or ["this login link is not valid"])[-1]
            why = re.sub(r"^[^:]{1,40}: ", "", why)[:300]
            return self.send(403, json.dumps({"error": why}), "application/json")
        sweep()
        tok = secrets.token_hex(32)
        dtok = secrets.token_hex(32)
        with _lock:
            _tokens[tok] = (site, nonce, "127.0.0.1", int(tm.group(1)), exp)
            _dones[dtok] = (site, nonce, bind, time.time() + DONE_TTL)
        out = {"password": kv["password"], "ws": "/browser/viewer/%s/%s/ws/%s" % (site, nonce, tok),
               "done": "/browser/viewer/%s/%s/done/%s" % (site, nonce, dtok)}
        for k in ("fit", "screen"):
            if re.fullmatch(r"[0-9]{1,4}x[0-9]{1,4}", kv.get(k, "")):
                out[k] = kv[k]
        self.send(200, json.dumps(out), "application/json")

    def done(self, site, nonce, dtok):
        n = int(self.headers.get("content-length") or 0)
        if n:
            self.rfile.read(min(n, 4096))
        if not self.own_page():
            return self.send(403, "refused: Done is pressed only on its own page\n")
        with _lock:
            d = _dones.pop(dtok, None)          # one use, whatever root answers
        if not d or d[0] != site or d[1] != nonce or d[3] <= time.time():
            return self.send(410, json.dumps({"result": "gone"}), "application/json")
        try:
            r = subprocess.run(DONE, input="view-done\0%s\0%s\0" % (site, d[2]),
                               capture_output=True, text=True, timeout=170)
        except (OSError, subprocess.TimeoutExpired):
            return self.send(503, json.dumps({"result": "error"}), "application/json")
        kv = dict(l.split("=", 1) for l in r.stdout.splitlines() if "=" in l)
        res = kv.get("result", "")
        if r.returncode != 0 or res not in ("saved", "notyet", "carryon", "gone"):
            return self.send(503, json.dumps({"result": "error"}), "application/json")
        out = {"result": res}
        # The way back in is a link to this same server, for this same site.
        if res == "notyet" and re.fullmatch(r"https://%s/browser/viewer/%s/[0-9a-f]{64}" % (re.escape(HOST), re.escape(site)), kv.get("again", "")):
            out["again"] = kv["again"]
        self.send(200, json.dumps(out), "application/json")

    def asset(self, rel):
        if rel in ("page.js", "viewer-ui.js"):
            path, roots = os.path.join(PAGE_DIR, rel), (os.path.realpath(PAGE_DIR),)
        else:
            path = os.path.join(NOVNC_DIR, rel[len("novnc/"):])
            roots = tuple(os.path.realpath(r) for r in (NOVNC_DIR,) + ALLOWED_ASSET_ROOTS)
        real = os.path.realpath(path)
        if not any(real == r or real.startswith(r + os.sep) for r in roots) or not os.path.isfile(real):
            return self.nf()
        try:
            with open(real, "rb") as f:
                body = f.read()
        except OSError:
            return self.nf()
        self.send(200, body, TYPES.get(os.path.splitext(real)[1].lower(), "application/octet-stream"))

    def ws(self, site, nonce, tok):
        if (self.headers.get("upgrade") or "").lower() != "websocket":
            return self.nf()
        with _lock:
            t = _tokens.pop(tok, None)          # one use, whatever happens next
        if not t or t[0] != site or t[1] != nonce or t[4] <= time.time():
            return self.send(403, "refused\n")
        try:
            up = socket.create_connection((t[2], t[3]), timeout=10)
        except OSError:
            return self.send(502, "the login screen is not running any more\n")
        # Re-send the upgrade to the viewer's own websocket bridge, then splice.
        head = ["GET / HTTP/1.1", "Host: 127.0.0.1:%d" % t[3]]
        for k, v in self.headers.items():
            if k.lower() in ("host", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "via", "cookie", "origin"):
                continue
            head.append("%s: %s" % (k, v))
        up.sendall(("\r\n".join(head) + "\r\n\r\n").encode("latin-1"))
        self.close_connection = True
        self.wfile.flush()
        splice(self.connection, up, t[4])


def splice(a, b, until):
    a.setblocking(True)
    b.setblocking(True)
    try:
        while time.time() < until:
            r, _, _ = select.select([a, b], [], [], 5)
            for s in r:
                d = s.recv(65536)
                if not d:
                    return
                (b if s is a else a).sendall(d)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.close()
            except OSError:
                pass


class S(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    if not HOST:
        sys.exit("LINK_HOST is not set: run `sudo 5dive browser login-link enable`")
    srv = S(("127.0.0.1", PORT), H)
    if os.environ.get("LINK_PORT_FILE"):
        with open(os.environ["LINK_PORT_FILE"], "w") as f:
            f.write(str(srv.server_address[1]))
    srv.serve_forever()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Find the port Wireless debugging picked: the open TCP ports on one host.

After a restart an Android phone forgets adb's fixed port 5555, and when the
owner switches Wireless debugging back on it listens on a new random port. That
port used to be read off the phone's screen by the owner and sent to the agent.
It is found here instead: every port in the phone's ephemeral range is tried
at once, a few hundred at a time, without waiting for each.

  ports.py <host> [<lo>-<hi>]   prints one open port per line
  exit 0  the host answered (the list may be empty: nothing is listening)
  exit 3  the host never answered: off, asleep, or off Tailscale
"""
import errno
import os
import selectors
import socket
import sys
import time

BATCH = 400          # under the usual 1024 open-file limit
WAIT = float(os.environ.get("FIVEDIVE_PHONE_SCAN_WAIT", "1.5"))
ANSWERED = {0, errno.ECONNREFUSED, errno.ECONNRESET}  # a refusal is an answer: the host is up


def scan(host, lo, hi):
    family, _, _, _, addr = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)[0]
    found, answered = [], 0
    ports = range(lo, hi + 1)
    for start in range(0, len(ports), BATCH):
        sel = selectors.DefaultSelector()
        for port in ports[start:start + BATCH]:
            s = socket.socket(family, socket.SOCK_STREAM)
            s.setblocking(False)
            rc = s.connect_ex((addr[0], port) + tuple(addr[2:]))
            if rc in (errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EAGAIN, 0):
                sel.register(s, selectors.EVENT_WRITE, port)
            else:
                answered += rc in ANSWERED
                s.close()
        deadline = time.monotonic() + WAIT
        while sel.get_map():
            left = deadline - time.monotonic()
            if left <= 0:
                break
            for key, _ in sel.select(left):
                err = key.fileobj.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
                if err == 0:
                    found.append(key.data)
                answered += err in ANSWERED
                sel.unregister(key.fileobj)
                key.fileobj.close()
        for key in list(sel.get_map().values()):
            key.fileobj.close()
        sel.close()
        if start == 0 and answered == 0:
            break  # a whole batch and not one refusal: nobody is there
    return found, answered > 0


def main(argv):
    if len(argv) not in (2, 3):
        print(__doc__.strip().split("\n\n")[-1], file=sys.stderr)
        return 2
    lo, hi = 32768, 60999  # the Linux ephemeral range Android draws the port from
    if len(argv) == 3:
        lo, hi = (int(x) for x in argv[2].split("-", 1))
    try:
        found, up = scan(argv[1], lo, hi)
    except OSError as e:
        print(f"ports: {e}", file=sys.stderr)
        return 3
    for port in found:
        print(port)
    return 0 if up else 3


if __name__ == "__main__":
    sys.exit(main(sys.argv))

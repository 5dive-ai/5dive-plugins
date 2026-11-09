"""Build a Microsoft Teams app package for one agent (DIVE-7658).

The package is what the office's IT uploads in the Teams admin center: a zip of
manifest.json, a 192x192 colour icon (the agent's face) and a 32x32 outline icon.
Standard library only: Pillow is used for the face when present, else a plain PNG
face is read by the standard library. Without a face the colour icon is a plain tile.

    python3 -I package.py --out=<zip> --app-id=<guid> --name=<shown name>
        --role=<one line> [--avatar=<image>] [--endpoint=<https url>]

DIVE-8022: the one-sign-in path makes the bot with Microsoft's CLI, which takes the
two icons as files. --icons-dir writes color.png and outline.png there, only when
the agent has a face (no face: nothing, and Teams shows its own tile).

    python3 -I package.py --icons-dir=<dir> --avatar=<image>
"""

import argparse
import io
import json
import struct
import sys
import uuid
import zipfile
import zlib
from urllib.parse import urlparse

MANIFEST_SCHEMA = "https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json"


def png(width, height, pixel):
    """A minimal RGBA PNG; pixel(x, y) -> (r, g, b, a)."""
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(pixel(x, y))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def outline_icon():
    """32x32: a white ring on transparent, as Teams requires for the outline icon."""
    def px(x, y):
        d = ((x - 15.5) ** 2 + (y - 15.5) ** 2) ** 0.5
        return (255, 255, 255, 255) if 11 <= d <= 14 else (0, 0, 0, 0)
    return png(32, 32, px)


def tile_icon():
    """192x192 plain tile, used when there is no face to show."""
    return png(192, 192, lambda x, y: (40, 52, 120, 255))


def png_pixels(data, limit=4096):
    """Decode a plain PNG with the standard library: 8-bit, not interlaced, grey,
    RGB, palette, grey+alpha or RGBA. Returns (width, height, rows of RGBA
    tuples), or None for anything else. Boxes have no Pillow (DIVE-8022)."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    pos, idat, plte, trns, hdr = 8, [], None, None, None
    while pos + 8 <= len(data):
        n, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        pos += 12 + n
        if kind == b"IHDR":
            hdr = struct.unpack(">IIBBBBB", body)
        elif kind == b"PLTE":
            plte = body
        elif kind == b"tRNS":
            trns = body
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            break
    if not hdr:
        return None
    w, h, depth, ct, _, _, interlace = hdr
    chans = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(ct)
    if depth != 8 or interlace or not chans or not (0 < w <= limit and 0 < h <= limit) or (ct == 3 and not plte):
        return None
    raw = zlib.decompress(b"".join(idat))
    stride = w * chans
    if len(raw) < h * (stride + 1):
        return None
    prev = bytearray(stride)
    rows = []
    for y in range(h):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        if f == 1:
            for i in range(chans, stride):
                line[i] = (line[i] + line[i - chans]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                left = line[i - chans] if i >= chans else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - chans] if i >= chans else 0
                b = prev[i]
                c = prev[i - chans] if i >= chans else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        elif f != 0:
            return None
        prev = line
        if ct == 6:
            rows.append([tuple(line[i:i + 4]) for i in range(0, stride, 4)])
        elif ct == 2:
            rows.append([tuple(line[i:i + 3]) + (255,) for i in range(0, stride, 3)])
        elif ct == 4:
            rows.append([(line[i], line[i], line[i], line[i + 1]) for i in range(0, stride, 2)])
        elif ct == 0:
            rows.append([(v, v, v, 255) for v in line])
        else:
            rows.append([tuple(plte[3 * v:3 * v + 3]) + ((trns[v] if trns and v < len(trns) else 255),) for v in line])
    return w, h, rows


def face_icon(path):
    """192x192 PNG of the image's centre square, or None when it cannot be read."""
    try:
        from PIL import Image  # optional
    except Exception:
        Image = None
    if Image is not None:
        try:
            im = Image.open(path).convert("RGBA")
            side = min(im.size)
            left, top = (im.width - side) // 2, (im.height - side) // 2
            im = im.crop((left, top, left + side, top + side)).resize((192, 192))
            buf = io.BytesIO()
            im.save(buf, "PNG")
            return buf.getvalue()
        except Exception:
            return None
    try:
        with open(path, "rb") as f:
            data = f.read(32 * 1024 * 1024 + 1)
        got = png_pixels(data) if len(data) <= 32 * 1024 * 1024 else None
    except Exception:
        return None
    if not got:
        return None
    w, h, rows = got
    side = min(w, h)
    left, top = (w - side) // 2, (h - side) // 2
    step = side / 192.0

    def px(x, y):  # the average of the source pixels this output pixel covers
        x0, y0 = left + int(x * step), top + int(y * step)
        x1, y1 = max(x0 + 1, left + int((x + 1) * step)), max(y0 + 1, top + int((y + 1) * step))
        acc, n = [0, 0, 0, 0], 0
        for yy in range(y0, y1):
            r = rows[yy]
            for xx in range(x0, x1):
                p = r[xx]
                acc[0] += p[0]; acc[1] += p[1]; acc[2] += p[2]; acc[3] += p[3]
                n += 1
        return tuple(v // n for v in acc)
    return png(192, 192, px)


def clip(s, n):
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def manifest(app_id, name, role, endpoint):
    domains = []
    host = urlparse(endpoint).hostname if endpoint else None
    if host:
        domains.append(host)
    return {
        "$schema": MANIFEST_SCHEMA,
        "manifestVersion": "1.17",
        "version": "1.0.0",
        # The app id is its own GUID, derived from the bot id so a rebuilt
        # package UPDATES the uploaded app instead of adding a second one.
        "id": str(uuid.uuid5(uuid.NAMESPACE_URL, "5dive-teams:" + app_id.lower())),
        "developer": {
            "name": "5dive",
            "websiteUrl": "https://5dive.com",
            "privacyUrl": "https://5dive.com/privacy",
            "termsOfUseUrl": "https://5dive.com/terms",
        },
        "name": {"short": clip(name, 30), "full": clip(name + " - " + role, 100)},
        "description": {
            "short": clip(role, 80),
            "full": clip(
                name + " is an AI teammate that runs on your company's own server. "
                "Message it like a colleague. Messages go between Microsoft Teams and that server only.",
                4000,
            ),
        },
        "icons": {"color": "color.png", "outline": "outline.png"},
        "accentColor": "#283478",
        "bots": [
            {
                "botId": app_id,
                "scopes": ["personal"],
                "supportsFiles": True,
                "isNotificationOnly": False,
            }
        ],
        "permissions": ["identity", "messageTeamMembers"],
        "validDomains": domains,
    }


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="")
    ap.add_argument("--icons-dir", default="")
    ap.add_argument("--app-id", default="")
    ap.add_argument("--name", default="")
    ap.add_argument("--role", default="AI teammate")
    ap.add_argument("--avatar", default="")
    ap.add_argument("--endpoint", default="")
    a = ap.parse_args(argv)
    if a.icons_dir:
        face = face_icon(a.avatar) if a.avatar else None
        if face:
            with open(a.icons_dir + "/color.png", "wb") as f:
                f.write(face)
            with open(a.icons_dir + "/outline.png", "wb") as f:
                f.write(outline_icon())
        print("icons: face=" + ("yes" if face else "no"))
        return 0
    if not (a.out and a.app_id and a.name):
        ap.error("--out, --app-id and --name are required")
    color = (face_icon(a.avatar) if a.avatar else None) or tile_icon()
    m = manifest(a.app_id, a.name, a.role, a.endpoint)
    with zipfile.ZipFile(a.out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(m, indent=2, ensure_ascii=False))
        z.writestr("color.png", color)
        z.writestr("outline.png", outline_icon())
    print("package: " + a.out + " (" + m["name"]["short"] + ", face=" + ("yes" if color != tile_icon() else "no") + ")")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

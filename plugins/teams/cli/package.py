"""Build a Microsoft Teams app package for one agent (DIVE-7658).

The package is what the office's IT uploads in the Teams admin center: a zip of
manifest.json, a 192x192 colour icon (the agent's face) and a 32x32 outline icon.
Standard library only, with Pillow used when present for the face; without it, or
without a face, the colour icon is a plain tile with the agent's initial.

    python3 -I package.py --out=<zip> --app-id=<guid> --name=<shown name>
        --role=<one line> [--avatar=<image>] [--endpoint=<https url>]
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


def face_icon(path):
    try:
        from PIL import Image  # optional
    except Exception:
        return None
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
    ap.add_argument("--out", required=True)
    ap.add_argument("--app-id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--role", default="AI teammate")
    ap.add_argument("--avatar", default="")
    ap.add_argument("--endpoint", default="")
    a = ap.parse_args(argv)
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

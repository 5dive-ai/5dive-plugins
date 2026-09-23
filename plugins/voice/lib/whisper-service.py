#!/usr/bin/env python3
# Warm faster-whisper HTTP server. Loads the model once at startup and handles
# transcribe requests over HTTP — much faster than spawning the CLI per call.
#
# POST /transcribe   {"path": "/abs/path", "language": "en"?}
# GET  /health       {"ok": true, "model": "..."}
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
HOST = os.environ.get("WHISPER_HOST", "127.0.0.1")
PORT = int(os.environ.get("WHISPER_PORT", "8765"))

print(f"[whisper] loading model={MODEL_NAME} compute={COMPUTE_TYPE} device={DEVICE}", flush=True)
model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
print(f"[whisper] ready on {HOST}:{PORT}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("[whisper] " + (fmt % args) + "\n")

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "model": MODEL_NAME})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            return self._json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "invalid json"})
        path = data.get("path")
        if not path or not os.path.isabs(path):
            return self._json(400, {"error": "path must be absolute"})
        if not os.path.isfile(path):
            return self._json(404, {"error": "file not found"})
        try:
            segments, info = model.transcribe(
                path,
                language=data.get("language"),
                vad_filter=True,
            )
            out_segments = []
            parts = []
            for s in segments:
                parts.append(s.text)
                out_segments.append({"start": s.start, "end": s.end, "text": s.text})
            return self._json(200, {
                "text": "".join(parts).strip(),
                "language": info.language,
                "duration": info.duration,
                "segments": out_segments,
            })
        except Exception as e:
            return self._json(500, {"error": str(e)})


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()

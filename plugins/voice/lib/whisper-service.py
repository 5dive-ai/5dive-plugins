#!/usr/bin/env python3
# Warm faster-whisper HTTP server. Loads the model once at startup and handles
# transcribe requests over HTTP — much faster than spawning the CLI per call.
#
# POST /transcribe   {"path": "/abs/path", "language": "en"?, "beam_size": 1?}
# GET  /health       {"ok": true, "model": "...", "accepts": [...]}
#
# `language` skips detection and `beam_size` 1 is greedy decoding; both are the
# owner's opt-in (stt_language / stt_fast, DIVE-5869). Unset, whisper detects
# the language and searches 5 beams, as it always has.
import json
import os
import sys
import traceback
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

# The request fields this build honours. `5dive voice` reads it from /health to
# tell an owner whose running service predates them that fast mode is not on
# until the service restarts onto new code.
ACCEPTS = ["path", "language", "beam_size"]
DEFAULT_BEAM_SIZE = 5
try:
    from faster_whisper.tokenizer import _LANGUAGE_CODES as LANGUAGES
except Exception:  # a faster-whisper that moved the table: skip the check
    LANGUAGES = None


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
            return self._json(200, {"ok": True, "model": MODEL_NAME, "accepts": ACCEPTS})
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
        beam_size = data.get("beam_size", DEFAULT_BEAM_SIZE)
        if isinstance(beam_size, bool) or not isinstance(beam_size, int) or not 1 <= beam_size <= 10:
            return self._json(400, {"error": "beam_size must be an integer from 1 to 10"})
        language = data.get("language") or None
        if language is not None and LANGUAGES is not None and language not in LANGUAGES:
            # A pinned code whisper does not know would fail every note. Hear it
            # with detection instead, and leave the reason in the journal.
            sys.stderr.write(f"[whisper] unknown language {language!r}: detecting instead\n")
            language = None
        try:
            segments, info = model.transcribe(
                path,
                language=language,
                beam_size=beam_size,
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
            # The journal gets the traceback and the caller gets the exception's
            # name: a bare str(e) on a 500 is how PyAV 19's dropped keyword read
            # as "whisper 500s" with no cause anywhere (DIVE-5398).
            traceback.print_exc()
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()

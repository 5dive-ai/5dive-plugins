"""5dive app platform adapter (Hermes plugin).

Carries the 5dive web and mobile chat to a Hermes agent on a 5dive box.

The box's dashboard bridge (``plugins/dashboard/server.ts --runtime=hermes``)
owns everything that talks to 5dive: it takes each chat message from the
control plane, transcribes voice notes, fetches uploads, and acknowledges
delivery. It leaves one JSON file per message in a spool directory, and this
adapter is the other end of that spool:

    <spool>/inbox/<id>.json            written by the bridge, read here
      {"id": "...", "text": "...",
       "route": {"source": "dashboard", "chat_id": "dashboard", "voice": true},
       "image_path": "/abs/path/on/this/box",      # optional upload
       "received_at": "2026-10-30T23:00:00Z"}

    <spool>/outbox/dashboard/<id>.json written here, sent to the chat by the bridge
      {"source": "dashboard", "chat_id": "dashboard", "text": "...",
       "files": ["/abs/path"], "voice": true}

Both sides write a temp name first and rename it to ``*.json``, so a reader
never sees half a file. The spool is created mode 0700 for the agent's own
user: anyone who can write into it is that user, which is why the adapter
needs no token of its own.

Configuration (env, read at construct time; env wins over config.yaml extra):

    FIVEDIVE_SPOOL_DIR        the spool directory (required)
    FIVEDIVE_ALLOWED_USERS    senders allowed in; the bridge sends as 5dive-app
    FIVEDIVE_ALLOW_ALL_USERS  allow every sender in the spool
"""

import asyncio
import json
import logging
import mimetypes
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)

logger = logging.getLogger(__name__)

PLATFORM_NAME = "fivedive"
# The one sender the bridge writes as. The chat has a single owner, the person
# signed in to 5dive; which seat they talk to is already decided by whose spool
# the message landed in.
SENDER_ID = "5dive-app"
POLL_SECONDS = 0.5
# Matches the web chat's own reply cap (plugins/dashboard/replycap.ts).
MAX_MESSAGE_LENGTH = 16000
_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"}
_AUDIO_EXT = {".ogg", ".oga", ".opus", ".mp3", ".m4a", ".wav", ".webm"}


# -- spool I/O (no gateway state, so tests drive it directly) -----------------


def spool_dir(extra: Optional[Dict[str, Any]] = None) -> str:
    return (os.getenv("FIVEDIVE_SPOOL_DIR") or (extra or {}).get("spool_dir") or "").strip()


def inbox_dir(spool: str) -> str:
    return os.path.join(spool, "inbox")


def outbox_dir(spool: str) -> str:
    return os.path.join(spool, "outbox", "dashboard")


def take_inbox(spool: str) -> List[Dict[str, Any]]:
    """Read and remove every complete message waiting in the inbox, oldest first.

    A file is removed before its message is handed on, so a gateway restart
    never answers the same message twice. A file that is not a valid message
    is removed too and logged; leaving it would make every poll trip on it.
    """
    d = inbox_dir(spool)
    try:
        names = sorted(n for n in os.listdir(d) if n.endswith(".json") and not n.startswith("."))
    except FileNotFoundError:
        return []
    out: List[Dict[str, Any]] = []
    for name in names:
        full = os.path.join(d, name)
        try:
            with open(full, encoding="utf-8") as f:
                raw = f.read()
        except FileNotFoundError:
            continue
        try:
            os.unlink(full)
        except FileNotFoundError:
            continue
        try:
            msg = json.loads(raw)
        except ValueError:
            logger.warning("[5dive] dropped an unreadable inbox file %s", name)
            continue
        route = msg.get("route") if isinstance(msg, dict) else None
        text = str(msg.get("text") or "").strip() if isinstance(msg, dict) else ""
        if not isinstance(route, dict) or route.get("source") != "dashboard" or not (text or msg.get("image_path")):
            logger.warning("[5dive] dropped an incomplete inbox file %s", name)
            continue
        out.append(msg)
    return out


def write_outbox(spool: str, chat_id: str, text: str, files: Optional[List[str]] = None, voice: bool = False) -> str:
    """Leave one reply for the bridge to send. Returns the reply's id."""
    d = outbox_dir(spool)
    os.makedirs(d, mode=0o700, exist_ok=True)
    reply_id = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    body: Dict[str, Any] = {"source": "dashboard", "chat_id": chat_id or "dashboard", "text": text}
    if files:
        body["files"] = files
    if voice:
        body["voice"] = True
    tmp = os.path.join(d, f".{reply_id}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps(body) + "\n")
    os.replace(tmp, os.path.join(d, f"{reply_id}.json"))
    return reply_id


def classify_upload(path: str) -> Tuple[MessageType, str]:
    ext = os.path.splitext(path)[1].lower()
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    if ext in _IMAGE_EXT:
        return MessageType.PHOTO, mime
    if ext in _AUDIO_EXT:
        return MessageType.VOICE, mime
    return MessageType.DOCUMENT, mime


def check_requirements() -> bool:
    return bool(spool_dir())


def validate_config(config) -> bool:
    return bool(spool_dir(getattr(config, "extra", None)))


def is_connected(config) -> bool:
    return validate_config(config)


class FiveDiveAdapter(BasePlatformAdapter):
    """The 5dive app chat, through the box's local spool."""

    MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform(PLATFORM_NAME))
        self._spool = spool_dir(config.extra)
        self._poll_task: Optional[asyncio.Task] = None
        # A voice note is answered by voice: the first reply after one is
        # marked so the bridge speaks it, the way the web chat does for Claude.
        self._voice_pending: Dict[str, bool] = {}

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not self._spool:
            logger.warning("[%s] FIVEDIVE_SPOOL_DIR not set", self.name)
            return False
        os.makedirs(inbox_dir(self._spool), mode=0o700, exist_ok=True)
        os.makedirs(outbox_dir(self._spool), mode=0o700, exist_ok=True)
        self._mark_connected()
        self._poll_task = asyncio.create_task(self._poll())
        logger.info("[%s] Connected - reading %s", self.name, inbox_dir(self._spool))
        return True

    async def disconnect(self) -> None:
        self._mark_disconnected()
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
            self._poll_task = None

    async def _poll(self) -> None:
        while self._running:
            try:
                for msg in take_inbox(self._spool):
                    await self._on_message(msg)
            except asyncio.CancelledError:
                return
            except Exception as e:  # one bad message must not stop the chat
                logger.error("[%s] inbox error: %s", self.name, e)
            await asyncio.sleep(POLL_SECONDS)

    def event_for(self, msg: Dict[str, Any]) -> MessageEvent:
        route = msg["route"]
        chat_id = str(route.get("chat_id") or "dashboard")
        source = self.build_source(
            chat_id=chat_id,
            chat_name="5dive app",
            chat_type="dm",
            user_id=SENDER_ID,
            user_name="5dive app",
        )
        try:
            ts = datetime.fromisoformat(str(msg.get("received_at")).replace("Z", "+00:00"))
        except ValueError:
            ts = datetime.now(tz=timezone.utc)
        kind, media_urls, media_types = MessageType.TEXT, [], []
        upload = msg.get("image_path")
        if isinstance(upload, str) and upload:
            kind, mime = classify_upload(upload)
            media_urls, media_types = [upload], [mime]
        if route.get("voice"):
            self._voice_pending[chat_id] = True
        return MessageEvent(
            text=str(msg.get("text") or ""),
            message_type=kind,
            source=source,
            message_id=str(msg.get("id") or uuid.uuid4().hex),
            raw_message=msg,
            timestamp=ts,
            media_urls=media_urls,
            media_types=media_types,
        )

    async def _on_message(self, msg: Dict[str, Any]) -> None:
        await self.handle_message(self.event_for(msg))

    def _reply(self, chat_id: str, text: str, files: Optional[List[str]] = None) -> SendResult:
        try:
            voice = self._voice_pending.pop(chat_id, False)
            reply_id = write_outbox(self._spool, chat_id, text, files, voice=voice)
            return SendResult(success=True, message_id=reply_id)
        except OSError as e:
            logger.error("[%s] could not write a reply: %s", self.name, e)
            return SendResult(success=False, error=str(e))

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if not content.strip():
            return SendResult(success=True, message_id=None)
        return self._reply(chat_id, content[: self.MAX_MESSAGE_LENGTH])

    async def send_document(self, chat_id: str, file_path: str, caption: Optional[str] = None,
                            file_name: Optional[str] = None, reply_to: Optional[str] = None,
                            metadata: Optional[Dict[str, Any]] = None, **kwargs) -> SendResult:
        return self._reply(chat_id, caption or os.path.basename(file_path), [file_path])

    async def send_image_file(self, chat_id: str, image_path: str, caption: Optional[str] = None,
                              reply_to: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None,
                              **kwargs) -> SendResult:
        return self._reply(chat_id, caption or os.path.basename(image_path), [image_path])

    async def send_voice(self, chat_id: str, audio_path: str, caption: Optional[str] = None,
                         reply_to: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None,
                         **kwargs) -> SendResult:
        return self._reply(chat_id, caption or os.path.basename(audio_path), [audio_path])

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        # The bridge shows the chat's own "working" state; nothing to send.
        pass

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": "5dive app", "type": "dm", "chat_id": chat_id}


def _env_enablement() -> Optional[dict]:
    spool = spool_dir()
    if not spool:
        return None
    return {"spool_dir": spool, "home_channel": {"chat_id": "dashboard", "name": "5dive app"}}


async def _standalone_send(pconfig, chat_id: str, message: str, *, thread_id: Optional[str] = None,
                           media_files: Optional[List[str]] = None, force_document: bool = False) -> Dict[str, Any]:
    """Out-of-process send (cron, send_message): the spool needs no live adapter."""
    spool = spool_dir(getattr(pconfig, "extra", None))
    if not spool:
        return {"error": "5dive standalone send: FIVEDIVE_SPOOL_DIR not set"}
    try:
        reply_id = write_outbox(spool, chat_id or "dashboard", message[:MAX_MESSAGE_LENGTH], media_files or None)
    except OSError as e:
        return {"error": f"5dive standalone send failed: {e}"}
    return {"success": True, "platform": PLATFORM_NAME, "chat_id": chat_id or "dashboard", "message_id": reply_id}


def register(ctx) -> None:
    """Plugin entry point - called by the Hermes plugin system at startup."""
    ctx.register_platform(
        name=PLATFORM_NAME,
        label="5dive app",
        adapter_factory=lambda cfg: FiveDiveAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["FIVEDIVE_SPOOL_DIR"],
        install_hint="Runs on a 5dive box: the dashboard bridge creates the spool (https://5dive.ai)",
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="FIVEDIVE_HOME_CHANNEL",
        standalone_sender_fn=_standalone_send,
        allowed_users_env="FIVEDIVE_ALLOWED_USERS",
        allow_all_env="FIVEDIVE_ALLOW_ALL_USERS",
        max_message_length=MAX_MESSAGE_LENGTH,
        emoji="💬",
        pii_safe=True,
        allow_update_command=True,
        platform_hint=(
            "You are talking with your owner in the 5dive app chat (web and mobile). "
            "Markdown renders. A message starting with \"[voice note]\" was spoken: "
            "answer it in one to three short sentences with no lists, links or code, "
            "because your answer is spoken back. To share a file, send it as a document."
        ),
    )

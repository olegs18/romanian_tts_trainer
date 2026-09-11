#!/usr/bin/env python3
"""Phrase TTS Trainer: local browser app with Edge TTS and mnemonic images."""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import hashlib
import ipaddress
import json
import mimetypes
import os
import re
import socket
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent

def load_local_env(path: Path) -> None:
    """Load simple KEY=VALUE pairs from .env without an extra dependency."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value

load_local_env(ROOT / ".env")

STATIC_DIR = ROOT / "static"
CACHE_DIR = ROOT / "cache"
AUDIO_CACHE_DIR = CACHE_DIR / "audio"
IMAGE_CACHE_DIR = CACHE_DIR / "images"
VOICE_CACHE_FILE = CACHE_DIR / "voices-learning.json"

HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_BODY_BYTES = 18 * 1024 * 1024
CLOUDFLARE_ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
CLOUDFLARE_API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
CLOUDFLARE_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell"
CLOUDFLARE_IMAGE_STEPS = 4
CLOUDFLARE_RESPONSE_LIMIT = 24 * 1024 * 1024
GENERATED_IMAGE_SIZE = 300
CLOUDFLARE_MODEL_URL = "https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/"
USER_AGENT = "PhraseTTSTrainer/2.2 (local language-learning app)"

SUPPORTED_LOCALES = {
    "ro-RO": "Румынский (Румыния)",
    "en-US": "Английский (США)",
    "en-GB": "Английский (Великобритания)",
}

DEFAULT_PHRASES = [
    ["Bună ziua.", "Добрый день.", "people greeting hello daytime"],
    ["Mă numesc Oleh.", "Меня зовут Олег.", "man introducing himself handshake"],
    ["Sunt din…", "Я из…", "person pointing to map origin hometown"],
    ["Acum locuiesc în Moldova.", "Сейчас я живу в Молдове.", "person house Moldova map"],
    ["Sunt programator web.", "Я веб-программист.", "web developer coding laptop"],
    ["Lucrez cu WordPress și WooCommerce.", "Я работаю с WordPress и WooCommerce.", "WordPress WooCommerce developer laptop"],
    ["Învăț limba română pentru viața de zi cu zi.", "Я учу румынский для повседневной жизни.", "person studying Romanian language everyday conversation"],
    ["Vorbesc puțin românește.", "Я немного говорю по-румынски.", "shy person speaking conversation"],
    ["Înțeleg mai bine decât vorbesc.", "Я понимаю лучше, чем говорю.", "listening understanding speaking difficulty conversation"],
    ["Nu am înțeles.", "Я не понял.", "confused person question mark"],
    ["Vă rog, vorbiți mai rar.", "Пожалуйста, говорите медленнее.", "conversation asking speak slowly hand gesture"],
    ["Puteți repeta, vă rog?", "Можете повторить?", "person asking repeat conversation listening"],
    ["Ce înseamnă…?", "Что означает…?", "dictionary meaning question mark"],
    ["Cum se spune… în română?", "Как сказать… по-румынски?", "Romanian dictionary translation conversation"],
]

FALLBACK_VOICES = [
    {"ShortName": "ro-RO-AlinaNeural", "Gender": "Female", "Locale": "ro-RO"},
    {"ShortName": "ro-RO-EmilNeural", "Gender": "Male", "Locale": "ro-RO"},
    {"ShortName": "en-US-JennyNeural", "Gender": "Female", "Locale": "en-US"},
    {"ShortName": "en-US-GuyNeural", "Gender": "Male", "Locale": "en-US"},
    {"ShortName": "en-GB-SoniaNeural", "Gender": "Female", "Locale": "en-GB"},
    {"ShortName": "en-GB-RyanNeural", "Gender": "Male", "Locale": "en-GB"},
]

ALLOWED_IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}

CACHE_LOCK = threading.Lock()


def stable_hash(*parts: str) -> str:
    data = "\0".join(parts).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def signed_percent(value: int) -> str:
    return f"{value:+d}%"


def signed_hz(value: int) -> str:
    return f"{value:+d}Hz"


def clamp_int(value: Any, minimum: int, maximum: int, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def clean_text(value: Any, max_length: int) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:max_length]


def default_image_query(text: str, translation: str, explicit_query: str = "") -> str:
    """Return the visual idea supplied by the lesson or a useful fallback."""
    if explicit_query.strip():
        return explicit_query.strip()[:300]
    for ro, _ru, query in DEFAULT_PHRASES:
        if text.strip() == ro:
            return query
    return (translation or text).strip()[:300]


def mnemonic_image_prompt(text: str, translation: str, visual_hint: str) -> str:
    """Turn a short lesson hint into a vivid, text-free mnemonic image prompt."""
    meaning = clean_text(translation, 700) or clean_text(text, 500)
    hint = default_image_query(text, translation, visual_hint)
    return (
        "Create a vivid surreal mnemonic photograph for memorizing a foreign-language expression. "
        f"Meaning of the expression: {meaning}. Visual association: {hint}. "
        "Show one instantly understandable scene with one dominant action, exaggerated scale, "
        "strong emotion and a memorable unexpected object. The association matters more than "
        "physical realism. Square composition, centered subject, clean background, high contrast, "
        "photorealistic lighting. No letters, words, captions, subtitles, logos or watermarks."
    )[:2048]


class AudioService:
    def __init__(self, cache_dir: Path = AUDIO_CACHE_DIR):
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def cache_path(self, text: str, voice: str, rate: int, pitch: int) -> Path:
        key = stable_hash("edge-tts-v1", text, voice, str(rate), str(pitch))
        return self.cache_dir / f"{key}.mp3"

    async def _synthesize(self, text: str, voice: str, rate: int, pitch: int, output: Path) -> None:
        try:
            import edge_tts
        except ImportError as exc:
            raise RuntimeError("Не установлен edge-tts. Выполните: pip install -r requirements.txt") from exc

        communicator = edge_tts.Communicate(
            text,
            voice,
            rate=signed_percent(rate),
            volume="+0%",
            pitch=signed_hz(pitch),
        )
        await communicator.save(str(output))

    def get_or_create(self, text: str, voice: str, rate: int, pitch: int) -> tuple[Path, bool]:
        target = self.cache_path(text, voice, rate, pitch)
        if target.exists() and target.stat().st_size > 0:
            return target, True

        with CACHE_LOCK:
            if target.exists() and target.stat().st_size > 0:
                return target, True
            fd, tmp_name = tempfile.mkstemp(prefix="tts-", suffix=".mp3", dir=self.cache_dir)
            os.close(fd)
            tmp = Path(tmp_name)
            try:
                asyncio.run(self._synthesize(text, voice, rate, pitch, tmp))
                if not tmp.exists() or tmp.stat().st_size == 0:
                    raise RuntimeError("TTS вернул пустой аудиофайл")
                tmp.replace(target)
            finally:
                tmp.unlink(missing_ok=True)
        return target, False


class VoiceService:
    def __init__(self, cache_file: Path = VOICE_CACHE_FILE):
        self.cache_file = cache_file
        self.cache_file.parent.mkdir(parents=True, exist_ok=True)

    async def _fetch(self) -> list[dict[str, Any]]:
        try:
            import edge_tts
        except ImportError as exc:
            raise RuntimeError("Не установлен edge-tts") from exc
        voices = await edge_tts.list_voices()
        return [voice for voice in voices if voice.get("Locale") in SUPPORTED_LOCALES]

    def get_voices(self) -> tuple[list[dict[str, str]], str | None]:
        error: str | None = None
        try:
            voices = asyncio.run(self._fetch())
            if voices:
                compact = [
                    {
                        "ShortName": str(v.get("ShortName", "")),
                        "Gender": str(v.get("Gender", "")),
                        "Locale": str(v.get("Locale", "")),
                    }
                    for v in voices
                    if v.get("ShortName")
                ]
                locale_order = {locale: index for index, locale in enumerate(SUPPORTED_LOCALES)}
                compact.sort(key=lambda item: (locale_order.get(item["Locale"], 999), item["ShortName"]))
                self.cache_file.write_text(json.dumps(compact, ensure_ascii=False, indent=2), encoding="utf-8")
                return compact, None
        except Exception as exc:
            error = str(exc)

        if self.cache_file.exists():
            try:
                cached = json.loads(self.cache_file.read_text(encoding="utf-8"))
                if isinstance(cached, list) and cached:
                    return cached, error
            except (OSError, json.JSONDecodeError):
                pass
        return FALLBACK_VOICES, error


class WebImageService:
    """Generate or import one active image per study phrase."""

    def __init__(self, cache_dir: Path = IMAGE_CACHE_DIR):
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def phrase_key(self, text: str) -> str:
        return stable_hash("phrase-image-v2", text.strip())

    def key(self, text: str, translation: str, query: str) -> str:
        """Legacy query-bound key kept for compatibility with older caches/tests."""
        return stable_hash("openverse-selection-v1", text, translation, query)

    def manifest_path(self, text: str, translation: str = "", query: str = "") -> Path:
        del translation, query
        return self.cache_dir / f"{self.phrase_key(text)}.json"

    def legacy_manifest_path(self, text: str, translation: str, query: str) -> Path:
        return self.cache_dir / f"{self.key(text, translation, query)}.json"

    @property
    def cloudflare_configured(self) -> bool:
        return bool(CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN)

    @property
    def cloudflare_endpoint(self) -> str:
        account_id = urllib.parse.quote(CLOUDFLARE_ACCOUNT_ID, safe="")
        model = urllib.parse.quote(CLOUDFLARE_IMAGE_MODEL, safe="@/-._")
        return f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}"

    @staticmethod
    def _cloudflare_error(payload: Any) -> str:
        if isinstance(payload, dict):
            errors = payload.get("errors")
            if isinstance(errors, list):
                messages = [clean_text(item.get("message"), 400) for item in errors if isinstance(item, dict)]
                messages = [message for message in messages if message]
                if messages:
                    return "; ".join(messages)
            message = clean_text(payload.get("message"), 400)
            if message:
                return message
        return "Cloudflare вернул ошибку без пояснения"

    @staticmethod
    def _extract_cloudflare_image(payload: Any) -> bytes:
        if not isinstance(payload, dict):
            raise RuntimeError("Cloudflare Workers AI вернул неожиданный ответ")
        if payload.get("success") is False:
            raise RuntimeError(f"Cloudflare Workers AI: {WebImageService._cloudflare_error(payload)}")

        result = payload.get("result", payload)
        encoded: Any = result.get("image") if isinstance(result, dict) else result
        if not isinstance(encoded, str) or not encoded.strip():
            raise RuntimeError("Cloudflare Workers AI не вернул изображение")
        encoded = encoded.strip()
        if encoded.startswith("data:"):
            comma = encoded.find(",")
            encoded = encoded[comma + 1:] if comma >= 0 else ""
        encoded = re.sub(r"\s+", "", encoded)
        try:
            image_bytes = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise RuntimeError("Cloudflare Workers AI вернул повреждённое изображение") from exc
        if not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
            raise RuntimeError("Cloudflare Workers AI вернул пустое или слишком большое изображение")
        return image_bytes

    @staticmethod
    def _detect_image_type(data: bytes) -> tuple[str, str]:
        if data.startswith(b"\xff\xd8\xff"):
            return "image/jpeg", ".jpg"
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png", ".png"
        if data.startswith((b"GIF87a", b"GIF89a")):
            return "image/gif", ".gif"
        if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
            return "image/webp", ".webp"
        raise RuntimeError("Cloudflare Workers AI вернул файл неизвестного формата")

    def _request_cloudflare_image(self, prompt: str) -> bytes:
        if not self.cloudflare_configured:
            raise ValueError(
                "Генерация не настроена: добавьте CLOUDFLARE_ACCOUNT_ID и CLOUDFLARE_API_TOKEN в файл .env"
            )
        body = json.dumps({"prompt": prompt, "steps": CLOUDFLARE_IMAGE_STEPS}).encode("utf-8")
        request = urllib.request.Request(
            self.cloudflare_endpoint,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {CLOUDFLARE_API_TOKEN}",
                "Content-Type": "application/json",
                "Accept": "application/json, image/*",
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                content_type = response.headers.get_content_type().lower()
                raw = response.read(CLOUDFLARE_RESPONSE_LIMIT + 1)
        except urllib.error.HTTPError as exc:
            raw_error = exc.read(8192)
            try:
                payload = json.loads(raw_error)
                message = self._cloudflare_error(payload)
            except (json.JSONDecodeError, UnicodeDecodeError):
                message = raw_error.decode("utf-8", errors="replace").strip()[:400] or exc.reason
            raise RuntimeError(f"Cloudflare Workers AI: HTTP {exc.code}: {message}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Не удалось подключиться к Cloudflare Workers AI: {exc.reason}") from exc

        if len(raw) > CLOUDFLARE_RESPONSE_LIMIT:
            raise RuntimeError("Ответ Cloudflare Workers AI слишком большой")
        if content_type in ALLOWED_IMAGE_TYPES:
            image_bytes = raw
        else:
            try:
                payload = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                raise RuntimeError("Cloudflare Workers AI вернул некорректный ответ") from exc
            image_bytes = self._extract_cloudflare_image(payload)
        self._detect_image_type(image_bytes)
        return image_bytes

    @staticmethod
    def _resize_generated_image(image_bytes: bytes) -> bytes:
        try:
            from PIL import Image, ImageOps, UnidentifiedImageError
        except ImportError as exc:
            raise RuntimeError("Не установлен Pillow. Выполните: pip install -r requirements.txt") from exc
        try:
            with Image.open(BytesIO(image_bytes)) as source:
                source.load()
                if source.width * source.height > 32_000_000:
                    raise RuntimeError("Сгенерированное изображение слишком большое")
                normalized = ImageOps.exif_transpose(source).convert("RGB")
                card = ImageOps.fit(
                    normalized,
                    (GENERATED_IMAGE_SIZE, GENERATED_IMAGE_SIZE),
                    method=Image.Resampling.LANCZOS,
                )
                output = BytesIO()
                card.save(output, format="JPEG", quality=88, optimize=True)
                return output.getvalue()
        except (UnidentifiedImageError, OSError) as exc:
            raise RuntimeError("Cloudflare Workers AI вернул повреждённое изображение") from exc

    def generate(self, text: str, translation: str, visual_hint: str) -> dict[str, Any]:
        visual_hint = default_image_query(text, translation, visual_hint)
        prompt = mnemonic_image_prompt(text, translation, visual_hint)
        generated = self._request_cloudflare_image(prompt)
        image_bytes = self._resize_generated_image(generated)
        return self._store(
            text,
            image_bytes,
            ".jpg",
            {
                "source_type": "cloudflare",
                "title": visual_hint,
                "source": "Cloudflare Workers AI",
                "source_url": CLOUDFLARE_MODEL_URL,
                "query": visual_hint,
                "prompt": prompt,
                "model": CLOUDFLARE_IMAGE_MODEL,
            },
        )

    @staticmethod
    def _validate_remote_url(url: str) -> None:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise RuntimeError("Некорректный URL изображения")
        host = parsed.hostname.lower()
        if host in {"localhost", "localhost.localdomain"}:
            raise RuntimeError("Локальные URL запрещены")
        try:
            addresses = socket.getaddrinfo(
                host,
                parsed.port or (443 if parsed.scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            )
        except socket.gaierror as exc:
            raise RuntimeError("Не удалось определить адрес сервера изображения") from exc
        for address in addresses:
            ip = ipaddress.ip_address(address[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved:
                raise RuntimeError("Небезопасный адрес изображения")

    @staticmethod
    def _validate_image_signature(data: bytes, content_type: str) -> None:
        valid = {
            "image/jpeg": data.startswith(b"\xff\xd8\xff"),
            "image/png": data.startswith(b"\x89PNG\r\n\x1a\n"),
            "image/gif": data.startswith((b"GIF87a", b"GIF89a")),
            "image/webp": len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP",
        }
        if not valid.get(content_type, False):
            raise RuntimeError("Содержимое файла не похоже на заявленный формат изображения")

    def _download_image(self, url: str) -> tuple[bytes, str, str]:
        self._validate_remote_url(url)
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "image/*"})
        service = self

        class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                service._validate_remote_url(newurl)
                return super().redirect_request(req, fp, code, msg, headers, newurl)

        opener = urllib.request.build_opener(SafeRedirectHandler())
        try:
            with opener.open(request, timeout=45) as response:
                final_url = response.geturl()
                self._validate_remote_url(final_url)
                content_type = response.headers.get_content_type().lower()
                if content_type not in ALLOWED_IMAGE_TYPES:
                    raise RuntimeError(f"Неподдерживаемый тип изображения: {content_type}")
                announced = response.headers.get("Content-Length")
                if announced:
                    try:
                        if int(announced) > MAX_IMAGE_BYTES:
                            raise RuntimeError("Изображение слишком большое")
                    except ValueError:
                        pass
                data = response.read(MAX_IMAGE_BYTES + 1)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"Не удалось скачать изображение: HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Не удалось скачать изображение: {exc.reason}") from exc
        if len(data) > MAX_IMAGE_BYTES:
            raise RuntimeError("Изображение слишком большое")
        if not data:
            raise RuntimeError("Получен пустой файл изображения")
        self._validate_image_signature(data, content_type)
        return data, ALLOWED_IMAGE_TYPES[content_type], final_url

    def _decode_data_url(self, data_url: str) -> tuple[bytes, str, str]:
        if not isinstance(data_url, str):
            raise ValueError("Изображение не передано")
        match = re.fullmatch(
            r"data:(image/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)",
            data_url.strip(),
            flags=re.IGNORECASE,
        )
        if not match:
            raise ValueError("Поддерживаются только JPEG, PNG, WebP и GIF")
        content_type = match.group(1).lower()
        encoded = re.sub(r"\s+", "", match.group(2))
        try:
            data = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("Некорректные base64-данные изображения") from exc
        if not data:
            raise ValueError("Получен пустой файл изображения")
        if len(data) > MAX_IMAGE_BYTES:
            raise ValueError("Изображение слишком большое")
        self._validate_image_signature(data, content_type)
        return data, ALLOWED_IMAGE_TYPES[content_type], content_type

    def _remove_active_locked(self, text: str) -> None:
        key = self.phrase_key(text)
        manifest = self.cache_dir / f"{key}.json"
        if manifest.exists():
            try:
                metadata = json.loads(manifest.read_text(encoding="utf-8"))
                filename = metadata.get("filename")
                if isinstance(filename, str):
                    target = self.cache_dir / Path(filename).name
                    if target.parent == self.cache_dir:
                        target.unlink(missing_ok=True)
            except (OSError, json.JSONDecodeError):
                pass
            manifest.unlink(missing_ok=True)
        for old in self.cache_dir.glob(f"{key}.*"):
            old.unlink(missing_ok=True)

    def _store(
        self,
        text: str,
        image_bytes: bytes,
        extension: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        key = self.phrase_key(text)
        with CACHE_LOCK:
            self._remove_active_locked(text)
            target = self.cache_dir / f"{key}{extension}"
            fd, tmp_name = tempfile.mkstemp(prefix="phrase-image-", suffix=extension, dir=self.cache_dir)
            try:
                with os.fdopen(fd, "wb") as fh:
                    fh.write(image_bytes)
                Path(tmp_name).replace(target)
            finally:
                Path(tmp_name).unlink(missing_ok=True)

            stored = {
                "filename": target.name,
                "version": hashlib.sha256(image_bytes).hexdigest()[:16],
                "source_type": clean_text(metadata.get("source_type"), 50) or "unknown",
                "title": clean_text(metadata.get("title"), 500),
                "creator": clean_text(metadata.get("creator"), 500),
                "creator_url": clean_text(metadata.get("creator_url"), 2000),
                "license": clean_text(metadata.get("license"), 100),
                "license_version": clean_text(metadata.get("license_version"), 100),
                "license_url": clean_text(metadata.get("license_url"), 2000),
                "source": clean_text(metadata.get("source"), 100),
                "source_url": clean_text(metadata.get("source_url"), 2000),
                "original_filename": clean_text(metadata.get("original_filename"), 500),
                "query": clean_text(metadata.get("query"), 300),
                "prompt": clean_text(metadata.get("prompt"), 2048),
                "model": clean_text(metadata.get("model"), 200),
            }
            self.manifest_path(text).write_text(
                json.dumps(stored, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        return self.lookup(text, "", "") or {}

    def import_data_url(
        self,
        text: str,
        data_url: str,
        source_type: str,
        original_filename: str = "",
    ) -> dict[str, Any]:
        if source_type not in {"clipboard", "file"}:
            raise ValueError("Некорректный источник локального изображения")
        image_bytes, extension, _content_type = self._decode_data_url(data_url)
        return self._store(
            text,
            image_bytes,
            extension,
            {
                "source_type": source_type,
                "original_filename": original_filename,
            },
        )

    def import_url(self, text: str, source_url: str) -> dict[str, Any]:
        source_url = clean_text(source_url, 4000)
        if not source_url:
            raise ValueError("Не указана ссылка на изображение")
        image_bytes, extension, final_url = self._download_image(source_url)
        return self._store(
            text,
            image_bytes,
            extension,
            {
                "source_type": "url",
                "source_url": final_url,
            },
        )

    def _lookup_manifest(self, manifest: Path) -> dict[str, Any] | None:
        if not manifest.exists():
            return None
        try:
            metadata = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        filename = metadata.get("filename")
        if not isinstance(filename, str) or not re.fullmatch(r"[0-9a-f]{64}\.(?:jpg|png|webp|gif)", filename):
            return None
        target = self.cache_dir / filename
        if not target.exists() or target.stat().st_size <= 0:
            return None
        result = dict(metadata)
        result.setdefault("source_type", "legacy")
        result.setdefault("version", str(target.stat().st_mtime_ns))
        result["url"] = f"/cache/images/{filename}"
        return result

    def lookup(self, text: str, translation: str, query: str) -> dict[str, Any] | None:
        active = self._lookup_manifest(self.manifest_path(text))
        if active:
            return active

        # Compatibility with images selected by v1.1, which were bound to the search query.
        legacy = self._lookup_manifest(self.legacy_manifest_path(text, translation, query))
        if not legacy:
            return None

        legacy_path = self.cache_dir / legacy["filename"]
        try:
            data = legacy_path.read_bytes()
        except OSError:
            return None
        extension = legacy_path.suffix.lower()
        migrated = dict(legacy)
        migrated["source_type"] = migrated.get("source_type") or "legacy"
        migrated["query"] = migrated.get("query") or query
        return self._store(text, data, extension, migrated)

    def delete(self, text: str, translation: str, query: str) -> bool:
        deleted = False
        with CACHE_LOCK:
            key = self.phrase_key(text)
            manifest = self.cache_dir / f"{key}.json"
            if manifest.exists():
                self._remove_active_locked(text)
                deleted = True

            legacy_manifest = self.legacy_manifest_path(text, translation, query)
            if legacy_manifest.exists():
                try:
                    metadata = json.loads(legacy_manifest.read_text(encoding="utf-8"))
                    filename = metadata.get("filename")
                    if isinstance(filename, str):
                        (self.cache_dir / Path(filename).name).unlink(missing_ok=True)
                except (OSError, json.JSONDecodeError):
                    pass
                legacy_manifest.unlink(missing_ok=True)
                deleted = True
        return deleted


AUDIO_SERVICE = AudioService()
VOICE_SERVICE = VoiceService()
IMAGE_SERVICE = WebImageService()


class TrainerHandler(BaseHTTPRequestHandler):
    server_version = "PhraseTTSTrainer/2.2"

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")

    def _json(self, data: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message: str, status: HTTPStatus = HTTPStatus.BAD_REQUEST) -> None:
        self._json({"ok": False, "error": message}, status)

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Некорректный Content-Length") from exc
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("Некорректный размер запроса")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("Ожидался JSON") from exc
        if not isinstance(data, dict):
            raise ValueError("Ожидался JSON-объект")
        return data

    def _serve_file(self, path: Path, cache_control: str = "no-cache") -> None:
        try:
            resolved = path.resolve(strict=True)
        except FileNotFoundError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        allowed_roots = [STATIC_DIR.resolve(), CACHE_DIR.resolve()]
        if not any(resolved == root or root in resolved.parents for root in allowed_roots):
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        content_type = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
        data = resolved.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache_control)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        path = unquote(urlparse(self.path).path)
        if path == "/":
            self._serve_file(STATIC_DIR / "index.html")
            return
        if path == "/api/status":
            self._json({
                "ok": True,
                "image": {
                    "provider": "Cloudflare Workers AI + manual import",
                    "configured": IMAGE_SERVICE.cloudflare_configured,
                    "requires_key": True,
                    "max_bytes": MAX_IMAGE_BYTES,
                    "cloudflare": {
                        "configured": IMAGE_SERVICE.cloudflare_configured,
                        "model": CLOUDFLARE_IMAGE_MODEL,
                        "output_size": GENERATED_IMAGE_SIZE,
                    },
                },
                "defaults": DEFAULT_PHRASES,
            })
            return
        if path == "/api/voices":
            voices, warning = VOICE_SERVICE.get_voices()
            self._json({
                "ok": True,
                "voices": voices,
                "locales": [
                    {"code": code, "label": label}
                    for code, label in SUPPORTED_LOCALES.items()
                ],
                "warning": warning,
            })
            return
        if path.startswith("/static/"):
            self._serve_file(STATIC_DIR / path.removeprefix("/static/"))
            return
        if path.startswith("/cache/audio/"):
            filename = Path(path).name
            if not re.fullmatch(r"[0-9a-f]{64}\.mp3", filename):
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self._serve_file(AUDIO_CACHE_DIR / filename, "public, max-age=31536000, immutable")
            return
        if path.startswith("/cache/images/"):
            filename = Path(path).name
            if not re.fullmatch(r"[0-9a-f]{64}\.(?:jpg|png|webp|gif)", filename):
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self._serve_file(IMAGE_CACHE_DIR / filename, "public, max-age=31536000, immutable")
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            data = self._read_json()
            if path == "/api/audio":
                self._handle_audio(data)
            elif path == "/api/image/generate":
                self._handle_image_generate(data)
            elif path == "/api/image/lookup":
                self._handle_image_lookup(data)
            elif path == "/api/image/import":
                self._handle_image_import(data)
            elif path == "/api/image/delete":
                self._handle_image_delete(data)
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
        except ValueError as exc:
            self._error(str(exc))
        except RuntimeError as exc:
            self._error(str(exc), HTTPStatus.BAD_GATEWAY)
        except Exception as exc:
            self._error(f"Внутренняя ошибка: {exc}", HTTPStatus.INTERNAL_SERVER_ERROR)

    def _handle_audio(self, data: dict[str, Any]) -> None:
        text = clean_text(data.get("text"), 500)
        voice = clean_text(data.get("voice"), 100)
        rate = clamp_int(data.get("rate"), -50, 100, 0)
        pitch = clamp_int(data.get("pitch"), -100, 100, 0)
        if not text:
            raise ValueError("Пустая фраза")
        if not voice:
            raise ValueError("Не выбран голос")
        target, cached = AUDIO_SERVICE.get_or_create(text, voice, rate, pitch)
        self._json({"ok": True, "url": f"/cache/audio/{target.name}", "cached": cached})

    def _image_args(self, data: dict[str, Any]) -> tuple[str, str, str]:
        text = clean_text(data.get("text"), 500)
        translation = clean_text(data.get("translation"), 1000)
        explicit_query = clean_text(data.get("query"), 300)
        if not text:
            raise ValueError("Пустая фраза")
        return text, translation, default_image_query(text, translation, explicit_query)

    def _handle_image_generate(self, data: dict[str, Any]) -> None:
        text, translation, query = self._image_args(data)
        selected = IMAGE_SERVICE.generate(text, translation, query)
        self._json({"ok": True, "query": query, "image": selected})

    def _handle_image_lookup(self, data: dict[str, Any]) -> None:
        text, translation, query = self._image_args(data)
        selected = IMAGE_SERVICE.lookup(text, translation, query)
        self._json({"ok": True, "found": bool(selected), "query": query, "image": selected})

    def _handle_image_import(self, data: dict[str, Any]) -> None:
        text, _translation, _query = self._image_args(data)
        mode = clean_text(data.get("mode"), 30)
        if mode == "url":
            selected = IMAGE_SERVICE.import_url(text, clean_text(data.get("source_url"), 4000))
        elif mode in {"clipboard", "file"}:
            selected = IMAGE_SERVICE.import_data_url(
                text,
                data.get("data_url", ""),
                mode,
                clean_text(data.get("filename"), 500),
            )
        else:
            raise ValueError("Неизвестный способ добавления изображения")
        self._json({"ok": True, "image": selected})

    def _handle_image_delete(self, data: dict[str, Any]) -> None:
        text, translation, query = self._image_args(data)
        deleted = IMAGE_SERVICE.delete(text, translation, query)
        self._json({"ok": True, "deleted": deleted})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local phrase TTS trainer")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-browser", action="store_true", help="do not open the browser automatically")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not (1 <= args.port <= 65535):
        raise SystemExit("Порт должен быть в диапазоне 1..65535")

    server = ThreadingHTTPServer((HOST, args.port), TrainerHandler)
    url = f"http://{HOST}:{args.port}"
    print(f"Phrase TTS Trainer: {url}")
    print("Остановка: Ctrl+C")
    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

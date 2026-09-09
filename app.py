#!/usr/bin/env python3
"""Romanian TTS Trainer: local browser app with Edge TTS and flexible image sources."""

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
import uuid
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
VOICE_CACHE_FILE = CACHE_DIR / "voices-ro-RO.json"

HOST = "127.0.0.1"
DEFAULT_PORT = 8765
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_BODY_BYTES = 18 * 1024 * 1024
OPENVERSE_ENDPOINT = "https://api.openverse.org/v1/images/"
GOOGLE_CSE_ENDPOINT = "https://customsearch.googleapis.com/customsearch/v1"
GOOGLE_CSE_API_KEY = os.environ.get("GOOGLE_CSE_API_KEY", "").strip()
GOOGLE_CSE_ID = os.environ.get("GOOGLE_CSE_ID", "").strip()
USER_AGENT = "RomanianTTSTrainer/2.0 (local language-learning app)"

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
]

ALLOWED_IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}

CACHE_LOCK = threading.Lock()
SEARCH_LOCK = threading.Lock()
SEARCH_SESSIONS: dict[str, dict[str, dict[str, Any]]] = {}


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
    """Build a conservative fallback query when the user did not provide one."""
    if explicit_query.strip():
        return explicit_query.strip()[:300]
    for ro, _ru, query in DEFAULT_PHRASES:
        if text.strip() == ro:
            return query
    return (translation or text).strip()[:300]


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
        return [voice for voice in voices if voice.get("Locale") == "ro-RO"]

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
                compact.sort(key=lambda item: item["ShortName"])
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
    """Search Openverse and store one active image per Romanian phrase."""

    def __init__(self, cache_dir: Path = IMAGE_CACHE_DIR, endpoint: str = OPENVERSE_ENDPOINT):
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.endpoint = endpoint

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

    def _request_json(self, url: str) -> dict[str, Any]:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Openverse: HTTP {exc.code}: {body[:300]}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Не удалось подключиться к Openverse: {exc.reason}") from exc
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError("Openverse вернул некорректный JSON") from exc
        if not isinstance(parsed, dict):
            raise RuntimeError("Openverse вернул неожиданный ответ")
        return parsed

    @staticmethod
    def _candidate(item: dict[str, Any]) -> dict[str, Any] | None:
        candidate_id = clean_text(item.get("id"), 200)
        thumbnail = clean_text(item.get("thumbnail"), 2000)
        original_url = clean_text(item.get("url"), 2000)
        preview_url = thumbnail or original_url
        if not candidate_id or not preview_url:
            return None
        return {
            "id": candidate_id,
            "title": clean_text(item.get("title"), 500) or "Без названия",
            "creator": clean_text(item.get("creator"), 500) or "Не указан",
            "creator_url": clean_text(item.get("creator_url"), 2000),
            "license": clean_text(item.get("license"), 100) or "unknown",
            "license_version": clean_text(item.get("license_version"), 100),
            "license_url": clean_text(item.get("license_url"), 2000),
            "source": clean_text(item.get("source"), 100),
            "source_url": clean_text(item.get("foreign_landing_url"), 2000),
            "thumbnail": preview_url,
            "original_url": original_url,
            "provider": "openverse",
        }

    @staticmethod
    def _google_candidate(item: dict[str, Any]) -> dict[str, Any] | None:
        image = item.get("image") if isinstance(item.get("image"), dict) else {}
        original_url = clean_text(item.get("link"), 4000)
        thumbnail = clean_text(image.get("thumbnailLink"), 4000)
        if not original_url and not thumbnail:
            return None
        context_url = clean_text(image.get("contextLink"), 4000)
        title = clean_text(item.get("title"), 500) or "Без названия"
        display_link = clean_text(item.get("displayLink"), 500)
        return {
            "id": stable_hash("google-image", original_url or thumbnail),
            "title": title,
            "creator": display_link,
            "creator_url": context_url,
            "license": "",
            "license_version": "",
            "license_url": "",
            "source": "google",
            "source_url": context_url,
            "thumbnail": thumbnail or original_url,
            "original_url": original_url or thumbnail,
            "provider": "google",
        }

    @property
    def google_configured(self) -> bool:
        return bool(GOOGLE_CSE_API_KEY and GOOGLE_CSE_ID)

    def search_openverse(self, query: str, count: int = 12) -> list[dict[str, Any]]:
        query = clean_text(query, 300)
        if not query:
            raise ValueError("Пустой поисковый запрос для картинки")
        count = max(1, min(20, count))
        params = urllib.parse.urlencode({"q": query, "page_size": count})
        payload = self._request_json(f"{self.endpoint}?{params}")
        results = payload.get("results")
        if not isinstance(results, list):
            raise RuntimeError("Openverse не вернул список изображений")
        candidates = []
        for item in results:
            if not isinstance(item, dict):
                continue
            candidate = self._candidate(item)
            if candidate:
                candidates.append(candidate)
        return candidates

    def search_google(self, query: str, count: int = 10) -> list[dict[str, Any]]:
        if not self.google_configured:
            raise ValueError("Google Images API не настроен: нужны GOOGLE_CSE_API_KEY и GOOGLE_CSE_ID")
        count = max(1, min(10, count))
        params = urllib.parse.urlencode({
            "key": GOOGLE_CSE_API_KEY,
            "cx": GOOGLE_CSE_ID,
            "q": query,
            "searchType": "image",
            "num": count,
            "safe": "active",
        })
        payload = self._request_json(f"{GOOGLE_CSE_ENDPOINT}?{params}")
        items = payload.get("items", [])
        if not isinstance(items, list):
            raise RuntimeError("Google Custom Search не вернул список изображений")
        candidates = []
        for item in items:
            if not isinstance(item, dict):
                continue
            candidate = self._google_candidate(item)
            if candidate:
                candidates.append(candidate)
        return candidates

    def search(self, query: str, count: int = 12, provider: str = "auto") -> tuple[list[dict[str, Any]], str]:
        query = clean_text(query, 300)
        if not query:
            raise ValueError("Пустой поисковый запрос для картинки")
        provider = clean_text(provider, 30).lower() or "auto"
        if provider == "auto":
            provider = "google" if self.google_configured else "openverse"
        if provider == "google":
            return self.search_google(query, min(count, 10)), "google"
        if provider == "openverse":
            return self.search_openverse(query, count), "openverse"
        raise ValueError("Неизвестный поисковый провайдер")

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
            }
            self.manifest_path(text).write_text(
                json.dumps(stored, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        return self.lookup(text, "", "") or {}

    def select(self, text: str, translation: str, query: str, candidate: dict[str, Any]) -> dict[str, Any]:
        del translation
        urls = []
        for value in (candidate.get("original_url"), candidate.get("thumbnail")):
            url = clean_text(value, 4000)
            if url and url not in urls:
                urls.append(url)
        if not urls:
            raise RuntimeError("У выбранного результата нет URL изображения")
        last_error = None
        for image_url in urls:
            try:
                image_bytes, extension, _final_url = self._download_image(image_url)
                break
            except RuntimeError as exc:
                last_error = exc
        else:
            raise last_error or RuntimeError("Не удалось скачать выбранное изображение")
        return self._store(
            text,
            image_bytes,
            extension,
            {
                "source_type": clean_text(candidate.get("provider"), 30) or "openverse",
                "title": candidate.get("title"),
                "creator": candidate.get("creator"),
                "creator_url": candidate.get("creator_url"),
                "license": candidate.get("license"),
                "license_version": candidate.get("license_version"),
                "license_url": candidate.get("license_url"),
                "source": candidate.get("source"),
                "source_url": candidate.get("source_url"),
                "query": query,
            },
        )

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
        result.setdefault("source_type", "openverse")
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
        migrated["source_type"] = migrated.get("source_type") or "openverse"
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


def remember_search(candidates: list[dict[str, Any]]) -> str:
    token = uuid.uuid4().hex
    with SEARCH_LOCK:
        if len(SEARCH_SESSIONS) >= 100:
            oldest = next(iter(SEARCH_SESSIONS))
            SEARCH_SESSIONS.pop(oldest, None)
        SEARCH_SESSIONS[token] = {candidate["id"]: candidate for candidate in candidates}
    return token


def get_search_candidate(token: str, candidate_id: str) -> dict[str, Any] | None:
    with SEARCH_LOCK:
        return SEARCH_SESSIONS.get(token, {}).get(candidate_id)


class TrainerHandler(BaseHTTPRequestHandler):
    server_version = "RomanianTTSTrainer/2.0"

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
                    "provider": "Google Images (optional) + Openverse + manual import",
                    "configured": True,
                    "requires_key": False,
                    "max_bytes": MAX_IMAGE_BYTES,
                    "google": {"configured": IMAGE_SERVICE.google_configured},
                },
                "defaults": DEFAULT_PHRASES,
            })
            return
        if path == "/api/voices":
            voices, warning = VOICE_SERVICE.get_voices()
            self._json({"ok": True, "voices": voices, "warning": warning})
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
            elif path == "/api/image/search":
                self._handle_image_search(data)
            elif path == "/api/image/select":
                self._handle_image_select(data)
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

    def _handle_image_search(self, data: dict[str, Any]) -> None:
        _text, _translation, query = self._image_args(data)
        provider = clean_text(data.get("provider"), 30) or "auto"
        candidates, resolved_provider = IMAGE_SERVICE.search(query, 12, provider)
        token = remember_search(candidates)
        self._json({"ok": True, "query": query, "provider": resolved_provider, "token": token, "results": candidates})

    def _handle_image_select(self, data: dict[str, Any]) -> None:
        text, translation, query = self._image_args(data)
        token = clean_text(data.get("token"), 100)
        candidate_id = clean_text(data.get("candidate_id"), 200)
        candidate = get_search_candidate(token, candidate_id)
        if not candidate:
            raise ValueError("Результат поиска устарел. Выполните поиск картинки ещё раз.")
        selected = IMAGE_SERVICE.select(text, translation, query, candidate)
        self._json({"ok": True, "image": selected})

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
    parser = argparse.ArgumentParser(description="Local Romanian TTS trainer")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-browser", action="store_true", help="do not open the browser automatically")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not (1 <= args.port <= 65535):
        raise SystemExit("Порт должен быть в диапазоне 1..65535")

    server = ThreadingHTTPServer((HOST, args.port), TrainerHandler)
    url = f"http://{HOST}:{args.port}"
    print(f"Romanian TTS Trainer: {url}")
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

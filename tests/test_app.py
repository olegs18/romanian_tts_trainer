import base64
import json
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import AsyncMock, patch

from PIL import Image

import app


class HelpersTest(unittest.TestCase):
    def test_fallback_voices_cover_romanian_and_english_locales(self):
        self.assertEqual(
            {voice["Locale"] for voice in app.FALLBACK_VOICES},
            {"ro-RO", "en-US", "en-GB"},
        )
        names = {voice["ShortName"] for voice in app.FALLBACK_VOICES}
        self.assertTrue({
            "ro-RO-AlinaNeural",
            "en-US-JennyNeural",
            "en-GB-SoniaNeural",
        }.issubset(names))

    def test_voice_service_keeps_supported_locales_in_selector_order(self):
        voices = [
            {"ShortName": "en-GB-RyanNeural", "Gender": "Male", "Locale": "en-GB"},
            {"ShortName": "en-US-GuyNeural", "Gender": "Male", "Locale": "en-US"},
            {"ShortName": "ro-RO-EmilNeural", "Gender": "Male", "Locale": "ro-RO"},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            service = app.VoiceService(Path(tmp) / "voices.json")
            with patch.object(service, "_fetch", new=AsyncMock(return_value=voices)):
                selected, warning = service.get_voices()

        self.assertIsNone(warning)
        self.assertEqual([voice["Locale"] for voice in selected], ["ro-RO", "en-US", "en-GB"])

    def test_stable_hash_is_stable_and_sensitive(self):
        self.assertEqual(app.stable_hash("a", "b"), app.stable_hash("a", "b"))
        self.assertNotEqual(app.stable_hash("a", "b"), app.stable_hash("ab"))

    def test_signed_values(self):
        self.assertEqual(app.signed_percent(0), "+0%")
        self.assertEqual(app.signed_percent(-20), "-20%")
        self.assertEqual(app.signed_hz(5), "+5Hz")

    def test_default_image_query_uses_curated_default(self):
        self.assertEqual(
            app.default_image_query("Nu am înțeles.", "Я не понял."),
            "confused person question mark",
        )

    def test_explicit_image_query_wins(self):
        self.assertEqual(
            app.default_image_query("Nu am înțeles.", "Я не понял.", "surprised confused man"),
            "surprised confused man",
        )

    def test_audio_cache_key_changes_with_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = app.AudioService(Path(tmp))
            a = service.cache_path("Bună ziua.", "ro-RO-AlinaNeural", 0, 0)
            b = service.cache_path("Bună ziua.", "ro-RO-AlinaNeural", -20, 0)
            self.assertNotEqual(a, b)
            self.assertEqual(a.suffix, ".mp3")

    def test_active_image_is_bound_to_phrase_not_query(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = app.WebImageService(Path(tmp))
            a = service.manifest_path("Ce înseamnă?", "Что означает?", "dictionary question")
            b = service.manifest_path("Ce înseamnă?", "Что означает?", "confused person")
            self.assertEqual(a, b)

    def test_mnemonic_prompt_uses_meaning_hint_and_forbids_text(self):
        prompt = app.mnemonic_image_prompt(
            "Puteți repeta, vă rog?",
            "Можете повторить, пожалуйста?",
            "giant parrot pressing a repeat button",
        )
        self.assertIn("Можете повторить", prompt)
        self.assertIn("giant parrot", prompt)
        self.assertIn("No letters", prompt)

    def test_cloudflare_payload_image_is_decoded(self):
        expected = b"\x89PNG\r\n\x1a\n" + b"generated"
        payload = {"success": True, "result": {"image": base64.b64encode(expected).decode("ascii")}}
        self.assertEqual(app.WebImageService._extract_cloudflare_image(payload), expected)

    def test_cloudflare_configuration_requires_both_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = app.WebImageService(Path(tmp))
            with patch.object(app, "CLOUDFLARE_ACCOUNT_ID", "account"), \
                 patch.object(app, "CLOUDFLARE_API_TOKEN", "token"):
                self.assertTrue(service.cloudflare_configured)
                self.assertIn("/accounts/account/ai/run/@cf/black-forest-labs/flux-1-schnell", service.cloudflare_endpoint)
            with patch.object(app, "CLOUDFLARE_API_TOKEN", ""):
                self.assertFalse(service.cloudflare_configured)

    def test_generated_image_is_resized_and_stored_as_300_square(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = app.WebImageService(Path(tmp))
            source = BytesIO()
            Image.new("RGB", (640, 480), "#7bdca2").save(source, format="PNG")
            with patch.object(service, "_request_cloudflare_image", return_value=source.getvalue()):
                selected = service.generate("Nu am înțeles.", "Я не понял.", "confused man and question mark")

            self.assertEqual(selected["source_type"], "cloudflare")
            self.assertEqual(selected["model"], app.CLOUDFLARE_IMAGE_MODEL)
            self.assertEqual(selected["query"], "confused man and question mark")
            target = Path(tmp) / selected["filename"]
            with Image.open(target) as generated:
                self.assertEqual(generated.size, (300, 300))
                self.assertEqual(generated.format, "JPEG")

    def test_clipboard_data_url_is_stored_and_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = app.WebImageService(Path(tmp))
            png = b"\x89PNG\r\n\x1a\n" + b"test-image"
            data_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
            selected = service.import_data_url("Nu am înțeles.", data_url, "clipboard")
            self.assertEqual(selected["source_type"], "clipboard")
            self.assertTrue(selected["url"].endswith(".png"))

            found = service.lookup("Nu am înțeles.", "Я не понял.", "another query")
            self.assertEqual(found["source_type"], "clipboard")
            self.assertEqual(found["url"], selected["url"])

    def test_file_import_preserves_original_filename(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = app.WebImageService(Path(tmp))
            jpeg = b"\xff\xd8\xff" + b"fake-jpeg"
            data_url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
            selected = service.import_data_url("Bună ziua.", data_url, "file", "hello.jpg")
            self.assertEqual(selected["source_type"], "file")
            self.assertEqual(selected["original_filename"], "hello.jpg")

    def test_url_import_uses_downloaded_final_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = app.WebImageService(Path(tmp))
            png = b"\x89PNG\r\n\x1a\n" + b"url-image"
            with patch.object(
                service,
                "_download_image",
                return_value=(png, ".png", "https://cdn.example.org/final.png"),
            ):
                selected = service.import_url("Mă numesc Oleh.", "https://example.org/image.png")
            self.assertEqual(selected["source_type"], "url")
            self.assertEqual(selected["source_url"], "https://cdn.example.org/final.png")

    def test_invalid_declared_image_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = app.WebImageService(Path(tmp))
            bad = "data:image/png;base64," + base64.b64encode(b"<html>not png</html>").decode("ascii")
            with self.assertRaises(RuntimeError):
                service.import_data_url("Bună ziua.", bad, "clipboard")

    def test_delete_removes_active_image(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = app.WebImageService(Path(tmp))
            gif = b"GIF89a" + b"fake-gif"
            data_url = "data:image/gif;base64," + base64.b64encode(gif).decode("ascii")
            service.import_data_url("Puteți repeta, vă rog?", data_url, "clipboard")
            self.assertIsNotNone(service.lookup("Puteți repeta, vă rog?", "", "q"))
            self.assertTrue(service.delete("Puteți repeta, vă rog?", "", "q"))
            self.assertIsNone(service.lookup("Puteți repeta, vă rog?", "", "q"))

    def test_replacing_image_changes_cache_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = app.WebImageService(Path(tmp))
            first = b"\x89PNG\r\n\x1a\n" + b"first-image"
            second = b"\x89PNG\r\n\x1a\n" + b"second-image"
            first_url = "data:image/png;base64," + base64.b64encode(first).decode("ascii")
            second_url = "data:image/png;base64," + base64.b64encode(second).decode("ascii")

            old = service.import_data_url("Bună ziua.", first_url, "clipboard")
            new = service.import_data_url("Bună ziua.", second_url, "clipboard")

            self.assertEqual(old["url"], new["url"])
            self.assertNotEqual(old["version"], new["version"])
if __name__ == "__main__":
    unittest.main()

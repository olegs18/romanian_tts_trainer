import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app


class HelpersTest(unittest.TestCase):
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

    def test_openverse_candidate_normalization(self):
        candidate = app.WebImageService._candidate({
            "id": "abc",
            "title": "Confused person",
            "creator": "Jane",
            "license": "by",
            "license_version": "4.0",
            "thumbnail": "https://example.org/thumb.jpg",
            "url": "https://example.org/original.jpg",
            "foreign_landing_url": "https://example.org/page",
        })
        self.assertEqual(candidate["id"], "abc")
        self.assertEqual(candidate["license"], "by")
        self.assertEqual(candidate["thumbnail"], "https://example.org/thumb.jpg")

    def test_search_uses_openverse_results(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = app.WebImageService(Path(tmp))
            fake = {"results": [{
                "id": "1",
                "title": "A",
                "thumbnail": "https://example.org/a.jpg",
                "url": "https://example.org/a-full.jpg",
            }]}
            with patch.object(service, "_request_json", return_value=fake):
                results, provider = service.search("confused person", 12, "openverse")
            self.assertEqual(provider, "openverse")
            self.assertEqual(len(results), 1)
            self.assertEqual(results[0]["id"], "1")

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


    def test_google_candidate_normalization(self):
        candidate = app.WebImageService._google_candidate({
            "title": "Greeting",
            "link": "https://example.org/full.jpg",
            "displayLink": "example.org",
            "image": {
                "thumbnailLink": "https://example.org/thumb.jpg",
                "contextLink": "https://example.org/page",
            },
        })
        self.assertEqual(candidate["provider"], "google")
        self.assertEqual(candidate["original_url"], "https://example.org/full.jpg")
        self.assertEqual(candidate["source_url"], "https://example.org/page")

    def test_auto_search_falls_back_to_openverse_without_google_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = app.WebImageService(Path(tmp))
            fake = {"results": [{
                "id": "1",
                "title": "A",
                "thumbnail": "https://example.org/a.jpg",
                "url": "https://example.org/a-full.jpg",
            }]}
            with patch.object(service, "_request_json", return_value=fake), \
                 patch.object(app, "GOOGLE_CSE_API_KEY", ""), \
                 patch.object(app, "GOOGLE_CSE_ID", ""):
                results, provider = service.search("hello", 5, "auto")
            self.assertEqual(provider, "openverse")
            self.assertEqual(len(results), 1)


if __name__ == "__main__":
    unittest.main()

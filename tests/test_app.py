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

    def test_image_key_changes_with_query(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = app.WebImageService(Path(tmp))
            a = service.key("Ce înseamnă?", "Что означает?", "dictionary question")
            b = service.key("Ce înseamnă?", "Что означает?", "confused person")
            self.assertNotEqual(a, b)

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

    def test_lookup_reads_cached_selection_and_attribution(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = app.WebImageService(Path(tmp))
            text, translation, query = "Bună ziua.", "Добрый день.", "people greeting"
            key = service.key(text, translation, query)
            image = Path(tmp) / f"{key}.jpg"
            image.write_bytes(b"fake-jpg")
            manifest = service.manifest_path(text, translation, query)
            manifest.write_text(json.dumps({
                "filename": image.name,
                "creator": "Jane",
                "license": "by",
                "source_url": "https://example.org/page",
            }), encoding="utf-8")
            selected = service.lookup(text, translation, query)
            self.assertEqual(selected["creator"], "Jane")
            self.assertEqual(selected["url"], f"/cache/images/{image.name}")

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
                results = service.search("confused person", 12)
            self.assertEqual(len(results), 1)
            self.assertEqual(results[0]["id"], "1")


if __name__ == "__main__":
    unittest.main()

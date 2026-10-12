from __future__ import annotations

import asyncio
import base64
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from agent_runtime.config import load_agent_config
from agent_runtime.errors import RuntimeConfigurationError
from agent_runtime.local_image_generator import LocalAgentImageGenerator, _decode_image, _reference_images
from tests.test_local_executors import settings, write_settings


def pixels() -> bytes:
    buffer = BytesIO()
    Image.new("RGBA", (4, 3), (10, 20, 30, 40)).save(buffer, format="PNG")
    return buffer.getvalue()


class LocalImageGeneratorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        load_agent_config.cache_clear()
        self.addCleanup(load_agent_config.cache_clear)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.value = settings(self.root, image="cli:codex")
        self.value["capabilities"]["cli:codex"].update(imageGeneration="available", imageInput="text_only")
        write_settings(self.root, self.value)
        self.generator = LocalAgentImageGenerator(self.root)
        self.env = patch.dict(os.environ, {"FRAMEFLOW_NODE_PATH": sys.executable}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def worker(self, source):
        folder = self.root / "web"
        folder.mkdir(exist_ok=True)
        (folder / "local-agent-image-worker.mjs").write_text(source)

    def image_worker(self, response):
        self.worker("import json,sys,pathlib\nr=json.load(sys.stdin)\npathlib.Path('captured.json').write_text(json.dumps(r))\nprint(" + repr(json.dumps(response)) + ")\n")

    async def test_text_only_agent_returns_real_pixels_save_compatible_with_pipelines(self):
        reference = self.root / "ref.png"
        reference.write_bytes(pixels())
        self.image_worker({"image": {"mimeType": "image/png", "data": base64.b64encode(pixels()).decode()}})
        prompt = "a ship $(touch never) `never`"
        result = await self.generator.generate_single_image(prompt, [reference], size="1024x768", aspect_ratio="4:3")
        self.assertEqual((result.fmt, result.ext), ("pil", "png"))
        self.assertEqual(result.data.getpixel((0, 0)), (10, 20, 30, 40))
        saved = self.root / "result.png"
        result.save(str(saved))
        with Image.open(saved) as image:
            self.assertEqual(image.size, (4, 3))
        captured = json.loads((self.root / "captured.json").read_text())
        self.assertEqual(captured["prompt"], prompt)
        self.assertEqual(captured["referenceImages"], [{"mimeType": "image/png", "data": base64.b64encode(pixels()).decode()}])
        self.assertEqual(captured["expectedVersion"], "1.2.3")
        self.assertEqual(captured["aspectRatio"], "4:3")
        self.assertEqual(captured["size"], "1024x768")
        self.assertFalse((self.root / "never").exists())

    async def test_unconfirmed_generation_fails_before_worker_and_never_falls_back_to_api(self):
        self.worker("raise AssertionError('must not launch')")
        self.value["capabilities"]["cli:codex"]["imageGeneration"] = "unknown"
        write_settings(self.root, self.value)
        with patch("asyncio.create_subprocess_exec", side_effect=AssertionError("no process")), self.assertRaises(RuntimeConfigurationError) as caught:
            await self.generator.generate_single_image("ship")
        self.assertEqual(caught.exception.code, "image_generation_capability_unconfirmed")

    async def test_urls_text_and_fake_pixels_never_count_as_generated_images(self):
        for response in ({"text": "done", "url": "https://private.invalid/image.png"},
                         {"image": {"mimeType": "image/png", "data": "https://private.invalid/image.png"}},
                         {"image": {"mimeType": "image/png", "data": base64.b64encode(b"not an image").decode()}},
                         {"image": {"mimeType": "image/jpeg", "data": base64.b64encode(pixels()).decode()}},
                         {"image": {"mimeType": "text/plain", "data": base64.b64encode(pixels()).decode()}}):
            self.image_worker(response)
            with self.subTest(response=response), self.assertRaises(RuntimeConfigurationError) as caught:
                await self.generator.generate_single_image("ship")
            self.assertEqual(caught.exception.code, "executor_invalid_image")
            self.assertNotIn("private.invalid", str(caught.exception))

    async def test_worker_errors_hide_diagnostics_and_bound_stdout(self):
        self.image_worker({"error": {"code": "local_agent_image_missing", "message": "PRIVATE_TOKEN"}})
        with self.assertRaises(RuntimeConfigurationError) as caught:
            await self.generator.generate_single_image("ship")
        self.assertEqual(caught.exception.code, "local_agent_image_missing")
        self.assertNotIn("PRIVATE_TOKEN", str(caught.exception))
        self.worker("import sys,json\njson.load(sys.stdin)\nsys.stdout.write('x'*1024)\n")
        with patch("agent_runtime.local_image_generator.MAX_IMAGE_WORKER_OUTPUT_BYTES", 100), self.assertRaises(RuntimeConfigurationError) as caught:
            await self.generator.generate_single_image("ship")
        self.assertEqual(caught.exception.code, "executor_output_limit")

    def test_reference_and_result_limits_apply_before_loading_large_images(self):
        reference = self.root / "ref.png"
        reference.write_bytes(pixels())
        with patch("agent_runtime.local_image_generator.MAX_IMAGES", 1), self.assertRaises(RuntimeConfigurationError):
            _reference_images([reference, reference])
        with patch("agent_runtime.local_image_generator.MAX_IMAGE_BYTES", 8), self.assertRaises(RuntimeConfigurationError):
            _reference_images([reference])
        with patch("agent_runtime.local_image_generator.MAX_TOTAL_IMAGE_BYTES", 8), self.assertRaises(RuntimeConfigurationError):
            _reference_images([reference])
        payload = {"mimeType": "image/png", "data": base64.b64encode(pixels()).decode()}
        with patch("agent_runtime.local_image_generator.MAX_OUTPUT_PIXELS", 4), self.assertRaises(RuntimeConfigurationError):
            _decode_image(payload)
        with patch("agent_runtime.local_image_generator.MAX_IMAGE_BYTES", 8), self.assertRaises(RuntimeConfigurationError):
            _decode_image(payload)

    async def test_timeout_and_cancellation_terminate_worker_process_group(self):
        self.worker("import json,sys,time,signal,pathlib\njson.load(sys.stdin)\ndef stop(*args):\n pathlib.Path('terminated').write_text('done')\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\npathlib.Path('started').write_text('ready')\nwhile True: time.sleep(.01)\n")
        task = asyncio.create_task(self.generator.generate_single_image("ship"))
        for _ in range(100):
            if (self.root / "started").exists():
                break
            await asyncio.sleep(.01)
        self.assertTrue((self.root / "started").exists())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue((self.root / "terminated").exists())
        (self.root / "terminated").unlink()
        with patch("agent_runtime.local_image_generator.IMAGE_EXECUTOR_TIMEOUT_SECONDS", .1), self.assertRaises(RuntimeConfigurationError) as caught:
            await self.generator.generate_single_image("ship")
        self.assertEqual(caught.exception.code, "executor_timeout")
        self.assertTrue((self.root / "terminated").exists())


if __name__ == "__main__":
    unittest.main()

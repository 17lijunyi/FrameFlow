import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

import main_director
from agent_runtime.director_runtime import (
    DirectorError, build_video_generator, capabilities_from_config_path,
    director_capabilities, run_director_request,
)
from agent_runtime.config import load_agent_config


class DirectorRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        load_agent_config.cache_clear()
        self.addCleanup(load_agent_config.cache_clear)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.session = self.root / ".working_dir" / "project-1"
        self.session.mkdir(parents=True)
        self.config = self.root / "configs" / "agent.local.yaml"
        self.config.parent.mkdir()
        self.config.write_text("video:\n  model: google/veo-3.1-fast\n  base_url: https://openrouter.ai/api/v1\n  api_key: fake-video-key\n")
        self.environment = patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def request(self, operation="render"):
        output_dir = self.session / "artifacts" / "director" / "job-1"
        return {"operation": operation, "repoRoot": str(self.root), "sessionId": "project-1",
                "sessionDir": str(self.session), "outputDir": str(output_dir),
                "outputPath": str(output_dir / "render.mp4"), "configPath": str(self.config),
                "shot": {"id": "shot-1", "prompt": "海边的小船", "duration": 8},
                "settings": {"style": "纪实摄影", "aspectRatio": "9:16", "resolution": "1080p"}}

    async def test_render_passes_real_parameters_and_only_uses_video_factory(self):
        first, last = self.session / "first.png", self.session / "last.png"
        for path in (first, last):
            Image.new("RGB", (8, 8), "red").save(path)
        captured = {}
        class Output:
            def save(self, path):
                Path(path).write_bytes(b"fake-generated-video")
        class Generator:
            async def generate_single_video(self, **kwargs):
                captured.update(kwargs)
                captured["env_duration"] = os.environ["VIMAX_OPENROUTER_VIDEO_DURATION"]
                captured["env_resolution"] = os.environ["VIMAX_OPENROUTER_VIDEO_RESOLUTION"]
                kwargs["progress"]("video_task_created", "unsafe-provider-details", {"api_key": "do-not-return"})
                return Output()
        def factory(config):
            captured["config_keys"] = set(config)
            return Generator()
        request = self.request()
        request["shot"].update(firstFrame=str(first), lastFrame=str(last))
        events = []
        with patch.dict(os.environ, {"VIMAX_OPENROUTER_VIDEO_DURATION": "8"}):
            result = await run_director_request(request, repo_root=self.root, emit=events.append,
                                                generator_factory=factory, video_probe=lambda path: 5.9)
            self.assertEqual(os.environ["VIMAX_OPENROUTER_VIDEO_DURATION"], "8")
            self.assertNotIn("VIMAX_OPENROUTER_VIDEO_RESOLUTION", os.environ)
        self.assertEqual(captured["config_keys"], {"model", "base_url", "api_key", "api_provider"})
        self.assertEqual(captured["reference_image_paths"], [str(first), str(last)])
        self.assertEqual(captured["duration"], 8)
        self.assertEqual(captured["resolution"], "1080p")
        self.assertEqual(captured["aspect_ratio"], "9:16")
        self.assertEqual(captured["env_duration"], "8")
        self.assertEqual(captured["env_resolution"], "1080p")
        self.assertIn("纪实摄影", captured["prompt"])
        self.assertEqual(result["duration"], 5.9)
        self.assertEqual(Path(result["path"]).read_bytes(), b"fake-generated-video")
        self.assertNotIn("unsafe-provider", json.dumps(events))
        self.assertNotIn("do-not-return", json.dumps(events))

    async def test_actual_openrouter_payload_honors_request_duration_ratio_resolution_and_frames(self):
        first = self.session / "frame.png"
        Image.new("RGB", (8, 8), "blue").save(first)
        captured = {}
        async def post(_url, **kwargs):
            captured.update(kwargs["payload"])
            return 200, {"id": "fake-job", "polling_url": "/videos/fake-job"}
        async def get(_url, **kwargs):
            return 200, {"status": "completed", "unsigned_urls": ["https://example.invalid/fake.mp4"]}
        async def download(_url, **kwargs):
            return 200, b"fake-video"
        async def sleep(_seconds):
            return None
        request = self.request()
        request["shot"]["duration"] = 6
        request["settings"]["resolution"] = "720p"
        request["shot"]["firstFrame"] = str(first)
        with patch("tools.video_generator_openrouter_api._post_json", post), \
             patch("tools.video_generator_openrouter_api._get_json", get), \
             patch("tools.video_generator_openrouter_api._get_bytes", download), \
             patch("tools.video_generator_openrouter_api.asyncio.sleep", sleep):
            await run_director_request(request, repo_root=self.root, video_probe=lambda path: 6)
        self.assertEqual(captured["duration"], 6)
        self.assertEqual(captured["aspect_ratio"], "9:16")
        self.assertEqual(captured["resolution"], "720p")
        self.assertEqual(captured["frame_images"][0]["frame_type"], "first_frame")

    def test_capabilities_are_config_only_and_do_not_expose_key(self):
        with patch("agent_runtime.director_runtime.build_video_generator", side_effect=AssertionError("must not instantiate")):
            capabilities = capabilities_from_config_path(self.config, repo_root=self.root)
        self.assertTrue(capabilities["supported"])
        self.assertTrue(capabilities["firstLastFrame"])
        self.assertFalse(capabilities["multiReference"])
        self.assertFalse(capabilities["comfyUI"])
        self.assertEqual(capabilities["durations"], [4, 6, 8])
        self.assertEqual(capabilities["aspectRatios"], ["16:9", "9:16"])
        self.assertEqual(capabilities["resolutions"], ["720p", "1080p"])
        self.assertNotIn("fake-video-key", json.dumps(capabilities))
        self.assertFalse(director_capabilities({"model": "veo3.1-fast", "base_url": "https://yunwu.ai"})["supported"])
        self.assertEqual(director_capabilities({"model": "doubao-seedance-i2v", "base_url": "https://yunwu.ai"})["durations"], [5, 10])

    async def test_known_veo_invalid_combinations_are_rejected_before_provider_initialization(self):
        first = self.session / "first.png"
        Image.new("RGB", (8, 8), "blue").save(first)
        cases = [({"duration": 5}, {}), ({"duration": 6}, {"resolution": "1080p"}),
                 ({"duration": 8}, {"aspectRatio": "1:1"}), ({"duration": 8}, {"resolution": "480p"}),
                 ({"duration": 6, "firstFrame": str(first), "lastFrame": str(first)}, {"resolution": "720p"})]
        for shot, settings in cases:
            request = self.request()
            request["shot"].update(shot)
            request["settings"].update(settings)
            with self.subTest(shot=shot, settings=settings), \
                 patch("agent_runtime.director_runtime.build_video_generator", side_effect=AssertionError("no paid request")), \
                 self.assertRaises(DirectorError) as caught:
                await run_director_request(request, repo_root=self.root)
            self.assertEqual(caught.exception.code, "unsupported_video_settings")

    def test_unknown_openrouter_model_options_are_explicitly_unverified(self):
        capabilities = director_capabilities({"model": "other/video-model", "base_url": "https://openrouter.ai/api/v1"})
        self.assertFalse(capabilities["modelOptionsKnown"])
        self.assertTrue(capabilities["providerValidatesModelOptions"])
        self.assertIn("视频服务验证", capabilities["notice"])

    def test_wan_capabilities_are_exact_model_single_frame_silent_and_source_ratio(self):
        capabilities = director_capabilities({"model": "wan2.6-i2v-flash", "base_url": "https://dashscope.aliyuncs.com/api/v1"})
        self.assertTrue(capabilities["supported"])
        self.assertEqual(capabilities["provider"], "aliyun")
        self.assertEqual(capabilities["durations"], list(range(2, 16)))
        self.assertEqual(capabilities["defaultDuration"], 5)
        self.assertEqual(capabilities["resolutions"], ["720p", "1080p"])
        self.assertTrue(capabilities["firstFrame"])
        self.assertFalse(capabilities["promptOnly"])
        self.assertFalse(capabilities["firstLastFrame"])
        self.assertEqual(capabilities["maxImages"], 1)
        self.assertFalse(capabilities["audio"])
        self.assertTrue(capabilities["aspectRatioFromImage"])
        self.assertTrue(capabilities["modelOptionsKnown"])
        for model in ("wan2.6-i2v", "wan2.6-i2v-flash-preview", "WAN2.6-I2V-FLASH", "wan-unknown"):
            with self.subTest(model=model):
                self.assertFalse(director_capabilities({"api_provider": "aliyun", "model": model})["supported"])

    def test_wan_factory_uses_silent_five_second_defaults_without_text_or_image_models(self):
        config = {"api_provider": "aliyun", "model": "wan2.6-i2v-flash", "base_url": "https://dashscope.aliyuncs.com/api/v1", "api_key": "fake-wan-key"}
        with patch("tools.render_backend._instantiate", return_value="wan-video-only") as instantiate:
            self.assertEqual(build_video_generator(config), "wan-video-only")
        self.assertEqual(instantiate.call_count, 1)
        self.assertEqual(instantiate.call_args.args[0], {
            "class_path": "tools.video_generator_wan_api.VideoGeneratorWanAPI",
            "init_args": {"api_key": "fake-wan-key", "model": "wan2.6-i2v-flash", "base_url": "https://dashscope.aliyuncs.com/api/v1", "duration": 5, "resolution": "720p", "audio": False},
        })

    async def test_wan_rejects_missing_first_tail_invalid_duration_and_resolution_before_provider(self):
        self.config.write_text("video:\n  api_provider: aliyun\n  api_key: fake-wan-key\n")
        first = self.session / "first.png"
        Image.new("RGB", (240, 240), "blue").save(first)
        cases = [({}, {}, "invalid_frames"),
                 ({"firstFrame": str(first), "lastFrame": str(first)}, {}, "invalid_frames"),
                 ({"firstFrame": str(first), "duration": 1}, {}, "unsupported_video_settings"),
                 ({"firstFrame": str(first), "duration": 16}, {}, "unsupported_video_settings"),
                 ({"firstFrame": str(first)}, {"resolution": "480p"}, "unsupported_video_settings")]
        for shot, settings, code in cases:
            request = self.request()
            request["shot"].update(shot)
            request["settings"].update(settings)
            with self.subTest(shot=shot, settings=settings), \
                 patch("agent_runtime.director_runtime.build_video_generator", side_effect=AssertionError("no paid request")), \
                 self.assertRaises(DirectorError) as caught:
                await run_director_request(request, repo_root=self.root)
            self.assertEqual(caught.exception.code, code)
        self.assertFalse(Path(self.request()["outputDir"]).exists())

    async def test_wan_uses_dedicated_key_and_defaults_to_five_seconds_with_source_ratio(self):
        self.config.write_text("llm:\n  api_key: private-other-service\nvideo:\n  api_provider: aliyun\n")
        first = self.session / "first.png"
        Image.new("RGB", (320, 240), "blue").save(first)
        request = self.request()
        del request["shot"]["duration"]
        request["shot"]["firstFrame"] = str(first)
        request["settings"].update(resolution="720p", aspectRatio="9:16")
        with self.assertRaises(DirectorError) as caught:
            await run_director_request(request, repo_root=self.root)
        self.assertEqual(caught.exception.code, "missing_video_api_key")
        captured = {}
        class Output:
            def save(self, path):
                Path(path).write_bytes(b"fake-wan-video")
        class Generator:
            async def generate_single_video(self, **kwargs):
                captured.update(kwargs)
                return Output()
        def factory(config):
            captured["config"] = config
            return Generator()
        with patch.dict(os.environ, {"DASHSCOPE_API_KEY": "dedicated-wan-test-key"}):
            result = await run_director_request(request, repo_root=self.root, generator_factory=factory, video_probe=lambda path: 5)
        self.assertEqual(captured["config"]["model"], "wan2.6-i2v-flash")
        self.assertEqual(captured["config"]["base_url"], "https://dashscope.aliyuncs.com/api/v1")
        self.assertEqual(captured["config"]["api_key"], "dedicated-wan-test-key")
        self.assertEqual(captured["duration"], 5)
        self.assertEqual(captured["resolution"], "720p")
        self.assertEqual(captured["reference_image_paths"], [str(first)])
        self.assertEqual(Path(result["path"]).read_bytes(), b"fake-wan-video")

    async def test_actual_wan_factory_sends_silent_video_with_single_first_frame(self):
        self.config.write_text("video:\n  api_provider: aliyun\n  model: wan2.6-i2v-flash\n  api_key: fake-wan-key\n")
        first = self.session / "first.png"
        Image.new("RGB", (320, 240), "blue").save(first)
        request = self.request()
        request["shot"].update(firstFrame=str(first), duration=5)
        request["settings"].update(resolution="720p", aspectRatio="9:16")
        captured = []
        async def json_request(_session, method, url, **kwargs):
            captured.append((method, url, kwargs))
            return {"output": {"task_id": "offline-wan-task", "task_status": "SUCCEEDED", "video_url": "https://media.example.test/output.mp4"}}
        async def download(url, _timeout):
            self.assertEqual(url, "https://media.example.test/output.mp4")
            return b"offline-wan-video"
        with patch("tools.video_generator_wan_api._json_request", json_request), \
             patch("tools.video_generator_wan_api._download", download):
            result = await run_director_request(request, repo_root=self.root, video_probe=lambda path: 5)
        self.assertEqual(len(captured), 1)
        method, url, options = captured[0]
        self.assertEqual(method, "POST")
        self.assertEqual(url, "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis")
        self.assertEqual(options["headers"]["Authorization"], "Bearer fake-wan-key")
        self.assertEqual(options["payload"]["model"], "wan2.6-i2v-flash")
        self.assertEqual(options["payload"]["parameters"]["duration"], 5)
        self.assertEqual(options["payload"]["parameters"]["resolution"], "720P")
        self.assertIs(options["payload"]["parameters"]["audio"], False)
        self.assertNotIn("aspect_ratio", options["payload"]["parameters"])
        self.assertTrue(options["payload"]["input"]["img_url"].startswith("data:image/png;base64,"))
        self.assertEqual(Path(result["path"]).read_bytes(), b"offline-wan-video")

    async def test_wan_validation_explains_how_to_fix_input_before_any_request(self):
        self.config.write_text("video:\n  api_provider: aliyun\n  api_key: fake-wan-key\n")
        first = self.session / "too-small.png"
        Image.new("RGB", (8, 8), "blue").save(first)
        request = self.request()
        request["shot"]["firstFrame"] = str(first)
        with patch("tools.video_generator_wan_api._json_request", side_effect=AssertionError("no paid request")), \
             self.assertRaises(DirectorError) as caught:
            await run_director_request(request, repo_root=self.root)
        self.assertIn("240–8000", str(caught.exception))
        self.assertEqual(list(Path(request["outputDir"]).iterdir()), [])
        with self.assertRaises(DirectorError) as caught:
            build_video_generator({"api_provider": "aliyun", "model": "wan2.6-i2v-flash", "base_url": "http://invalid.test", "api_key": "fake-wan-key"})
        self.assertEqual(caught.exception.code, "wan_video_config")
        self.assertEqual(caught.exception.action, "open_settings")
        self.assertIn("HTTPS", str(caught.exception))

    async def test_wan_retains_safe_recovery_message_but_hides_unknown_provider_errors(self):
        from tools.video_generator_wan_api import WanVideoError
        self.config.write_text("video:\n  api_provider: aliyun\n  api_key: fake-wan-key\n")
        first = self.session / "first.png"
        Image.new("RGB", (240, 240), "blue").save(first)
        request = self.request()
        request["shot"]["firstFrame"] = str(first)
        for error in (WanVideoError("视频已生成，请在百炼控制台下载结果，避免重复生成。"), RuntimeError("private-provider-details")):
            class Broken:
                async def generate_single_video(self, **kwargs):
                    raise error
            with self.subTest(error=type(error).__name__), self.assertRaises(DirectorError) as caught:
                await run_director_request(request, repo_root=self.root, generator_factory=lambda config: Broken())
            self.assertEqual(caught.exception.code, "wan_video_failed" if isinstance(error, WanVideoError) else "video_generation_failed")
            self.assertNotIn("private-provider", str(caught.exception))
            if isinstance(error, WanVideoError):
                self.assertIn("避免重复生成", str(caught.exception))

    def test_video_only_factory_does_not_initialize_image_or_llm(self):
        config = {"model": "google/veo-3.1-fast", "base_url": "https://openrouter.ai/api/v1", "api_key": "fake"}
        with patch("tools.render_backend._instantiate", return_value="video-only") as instantiate:
            self.assertEqual(build_video_generator(config), "video-only")
        self.assertEqual(instantiate.call_count, 1)
        self.assertIn("video_generator_openrouter", instantiate.call_args.args[0]["class_path"])

    async def test_image_key_does_not_replace_missing_video_key(self):
        self.config.write_text("image:\n  api_key: private-image\n")
        with self.assertRaises(DirectorError) as caught:
            await run_director_request(self.request(), repo_root=self.root)
        self.assertEqual(caught.exception.code, "missing_video_api_key")
        self.assertEqual(caught.exception.action, "open_settings")
        self.assertNotIn("private", str(caught.exception))

    def test_director_uses_shared_key_without_initializing_text_models(self):
        from agent_runtime.director_runtime import _video_config
        self.config.write_text("llm:\n  api_key: shared-test-key\nimage:\n  api_key: image-key\n")
        with patch("agent_runtime.vimax_adapters._build_chat_model", side_effect=AssertionError("no text model")):
            self.assertEqual(_video_config(self.config)["api_key"], "shared-test-key")
        with patch.dict(os.environ, {"VIMAX_VIDEO_API_KEY": "video-env", "VIMAX_LLM_API_KEY": "llm-env", "VIMAX_API_KEY": "api-env"}):
            self.assertEqual(_video_config(self.config)["api_key"], "video-env")
        with patch.dict(os.environ, {"VIMAX_LLM_API_KEY": "llm-env", "VIMAX_API_KEY": "api-env"}):
            self.assertEqual(_video_config(self.config)["api_key"], "llm-env")

    def test_explicit_video_protocol_honors_custom_gateway_and_known_model_limits(self):
        for provider, model, path in (("openrouter", "google/veo-3.1-fast", "video_generator_openrouter"),
                                      ("yunwu", "doubao-seedance-i2v", "video_generator_doubao_seedance")):
            config = {"api_provider": provider, "model": model, "base_url": "https://relay.example.test/proxy/v1", "api_key": "test"}
            with self.subTest(provider=provider), patch("tools.render_backend._instantiate", return_value="fake") as instantiate:
                self.assertEqual(build_video_generator(config), "fake")
            section = instantiate.call_args.args[0]
            self.assertIn(path, section["class_path"])
            self.assertEqual(section["init_args"]["base_url"], config["base_url"])
            self.assertTrue(director_capabilities(config)["modelOptionsKnown"])
        self.assertFalse(director_capabilities({"api_provider": "other", "model": "google/veo-3.1-fast", "base_url": "https://openrouter.ai/api/v1"})["supported"])

    async def test_seedance_requests_use_configured_gateway_for_create_and_poll(self):
        from tools.video_generator_doubao_seedance_yunwu_api import VideoGeneratorDoubaoSeedanceYunwuAPI
        requests = []
        class Response:
            status = 200
            def __init__(self, data):
                self.data = data
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            async def json(self):
                return self.data
        class Session:
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            def post(self, url, **kwargs):
                requests.append(("post", url))
                return Response({"id": "fake-task"})
            def get(self, url, **kwargs):
                requests.append(("get", url))
                return Response({"status": "succeeded", "content": {"video_url": "https://media.test/fake.mp4"}})
        generator = VideoGeneratorDoubaoSeedanceYunwuAPI(api_key="test", base_url="https://relay.test/proxy/v1")
        with patch("tools.video_generator_doubao_seedance_yunwu_api.aiohttp.ClientSession", return_value=Session()):
            result = await generator.generate_single_video("ship", [])
        self.assertEqual(result.data, "https://media.test/fake.mp4")
        self.assertEqual(requests, [("post", "https://relay.test/proxy/volc/v1/contents/generations/tasks"),
                                    ("get", "https://relay.test/proxy/volc/v1/contents/generations/tasks/fake-task")])

    async def test_director_rejects_agent_video_role_without_checking_other_capabilities(self):
        folder = self.root / ".vimax"
        folder.mkdir()
        (folder / "role-executors.json").write_text(json.dumps({"schemaVersion": 1, "roles": {
            "assistant": "api", "script": "inherit", "storyboard": "inherit", "vision": "api", "image": "image_api", "video": "cli:codex"},
            "executors": {"cli:codex": {"id": "cli:codex", "kind": "cli", "agentId": "codex", "fingerprint": "fake"}}, "capabilities": {}}))
        with patch("agent_runtime.director_runtime.build_video_generator", side_effect=AssertionError("no paid request")), self.assertRaises(DirectorError) as caught:
            await run_director_request(self.request(), repo_root=self.root)
        self.assertEqual(caught.exception.code, "video_executor_unsupported")

    async def test_template_placeholders_use_default_capabilities_and_require_real_video_key(self):
        self.config.write_text("video:\n  model: <YOUR_VIDEO_MODEL>\n  base_url: <YOUR_BASE_URL>\n  api_key: <YOUR_API_KEY>\n")
        capabilities = capabilities_from_config_path(self.config, repo_root=self.root)
        self.assertTrue(capabilities["supported"])
        self.assertEqual(capabilities["provider"], "openrouter")
        self.assertEqual(capabilities["model"], "google/veo-3.1-fast")
        with self.assertRaises(DirectorError) as caught:
            await run_director_request(self.request(), repo_root=self.root)
        self.assertEqual(caught.exception.code, "missing_video_api_key")

    async def test_frame_path_traversal_and_symlinks_are_rejected(self):
        outside = self.root / "outside.png"
        Image.new("RGB", (8, 8), "blue").save(outside)
        link = self.session / "link.png"
        link.symlink_to(outside)
        for path in (outside, link, self.session / ".." / ".." / "outside.png"):
            request = self.request()
            request["shot"]["firstFrame"] = str(path)
            with self.subTest(path=path), self.assertRaises(DirectorError) as caught:
                await run_director_request(request, repo_root=self.root)
            self.assertEqual(caught.exception.code, "invalid_path")

    async def test_output_and_clip_paths_cannot_escape_current_project(self):
        request = self.request()
        request["outputPath"] = str(self.root / "outside.mp4")
        with self.assertRaises(DirectorError):
            await run_director_request(request, repo_root=self.root)
        outside = self.root / "clip.mp4"
        outside.write_bytes(b"fake-video")
        request = self.request("export")
        request["clips"] = [{"path": str(outside)}]
        with self.assertRaises(DirectorError):
            await run_director_request(request, repo_root=self.root)
        request = self.request()
        output_dir = Path(request["outputDir"])
        output_dir.mkdir(parents=True)
        output_dir.rmdir()
        output_dir.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(DirectorError):
            await run_director_request(request, repo_root=self.root)

    async def test_last_frame_without_first_and_fractional_duration_are_rejected(self):
        request = self.request()
        request["shot"]["lastFrame"] = "unused.png"
        with self.assertRaises(DirectorError) as caught:
            await run_director_request(request, repo_root=self.root)
        self.assertEqual(caught.exception.code, "invalid_frames")
        for duration in (0, 31, 4.5, float("nan"), True):
            request = self.request()
            request["shot"]["duration"] = duration
            with self.subTest(duration=duration), self.assertRaises(DirectorError) as caught:
                await run_director_request(request, repo_root=self.root)
            self.assertEqual(caught.exception.code, "invalid_duration")

    async def test_invalid_yaml_and_provider_errors_are_public_safe_and_leave_no_partial_file(self):
        self.config.write_text("video:\n  api_key: [fake-private-key\n")
        with self.assertRaises(DirectorError) as caught:
            await run_director_request(self.request(), repo_root=self.root)
        self.assertNotIn("fake-private-key", str(caught.exception))
        self.config.write_text("video:\n  api_key: fake-video-key\n")
        class Broken:
            async def generate_single_video(self, **kwargs):
                raise RuntimeError("authorization=private-provider-key raw response")
        with self.assertRaises(DirectorError) as caught:
            await run_director_request(self.request(), repo_root=self.root, generator_factory=lambda config: Broken())
        self.assertEqual(caught.exception.code, "video_generation_failed")
        self.assertNotIn("private", str(caught.exception))
        self.assertEqual(list(Path(self.request()["outputDir"]).iterdir()), [])

    async def test_offline_merge_preserves_audio_order_and_normalizes_different_canvases(self):
        import numpy as np
        from moviepy import AudioClip, ColorClip, VideoFileClip
        first, second = self.session / "a.mp4", self.session / "b.mp4"
        audio = AudioClip(lambda t: 0.2 * np.sin(2 * np.pi * 440 * t), duration=0.5, fps=44100)
        a = ColorClip((64, 32), color=(240, 0, 0), duration=0.5).with_audio(audio)
        b = ColorClip((32, 64), color=(0, 0, 240), duration=0.25)
        try:
            a.write_videofile(str(first), fps=24, codec="libx264", audio_codec="aac", logger=None)
            b.write_videofile(str(second), fps=24, codec="libx264", logger=None)
        finally:
            a.close()
            b.close()
            audio.close()
        request = self.request("export")
        request["settings"] = {"aspectRatio": "16:9", "resolution": "480p"}
        request["clips"] = [{"path": str(first), "duration": 99}, {"path": str(second), "duration": 99}]
        # Export does not read keys, instantiate generators, or use requested shot durations.
        self.config.unlink()
        with patch("agent_runtime.director_runtime.build_video_generator", side_effect=AssertionError("offline export")):
            result = await run_director_request(request, repo_root=self.root)
        with VideoFileClip(result["path"]) as clip:
            self.assertEqual(tuple(clip.size), (854, 480))
            self.assertAlmostEqual(clip.duration, 0.75, delta=0.1)
            self.assertIsNotNone(clip.audio)
            self.assertGreater(float(np.abs(clip.audio.get_frame(0.123)).max()), 0.02)
            self.assertGreater(clip.get_frame(0.1)[240, 427, 0], 180)
            self.assertGreater(clip.get_frame(0.6)[240, 427, 2], 180)
        self.assertEqual([path.name for path in Path(result["path"]).parent.iterdir()], ["render.mp4"])

    async def test_cli_emits_one_safe_error_and_no_traceback(self):
        request_file = self.root / "request.json"
        request_file.write_text("{}")
        stdout, stderr = io.StringIO(), io.StringIO()
        class UnsafeProviderError(RuntimeError):
            code = 502
        with patch("agent_runtime.director_runtime.run_director_request", side_effect=UnsafeProviderError("secret-provider-response")), \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = await main_director.amain(["--request", str(request_file)])
        event = json.loads(stdout.getvalue())
        self.assertEqual(code, 1)
        self.assertEqual(event["type"], "error")
        self.assertNotIn("secret-provider", stdout.getvalue())
        self.assertEqual(stderr.getvalue(), "")

    async def test_cli_preserves_progress_result_and_missing_key_action(self):
        request_file = self.root / "request.json"
        request_file.write_text("{}")
        async def fake_request(request, *, emit):
            print("raw provider diagnostic")
            emit({"type": "progress", "message": "正在生成", "progress": 25})
            return {"type": "result", "operation": "render", "path": "project/render.mp4", "duration": 8}
        stdout = io.StringIO()
        with patch("agent_runtime.director_runtime.run_director_request", fake_request), contextlib.redirect_stdout(stdout):
            code = await main_director.amain(["--request", str(request_file)])
        self.assertEqual(code, 0)
        self.assertEqual([json.loads(line)["type"] for line in stdout.getvalue().splitlines()], ["progress", "result"])
        stdout = io.StringIO()
        with patch("agent_runtime.director_runtime.run_director_request", side_effect=DirectorError("missing_video_api_key", "请配置视频密钥", "open_settings")), \
             contextlib.redirect_stdout(stdout):
            code = await main_director.amain(["--request", str(request_file)])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(stdout.getvalue())["action"], "open_settings")


if __name__ == "__main__":
    unittest.main()

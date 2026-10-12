import asyncio
import base64
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import aiohttp
from PIL import Image

from interfaces.video_output import VideoOutput
from tools.video_generator_wan_api import VideoGeneratorWanAPI, WanVideoError, WanVideoValidationError


MODULE = "tools.video_generator_wan_api"
SECRET = "sk-offline-test-secret"


class FakeContent:
    def __init__(self, data):
        self.data = data

    async def iter_chunked(self, size):
        yield self.data


class FakeResponse:
    def __init__(self, status=200, payload=None, data=b"offline-mp4", error=None):
        self.status = status
        self.payload = payload
        self.error = error
        self.content_length = len(data)
        self.content = FakeContent(data)

    async def __aenter__(self):
        if self.error:
            raise self.error
        return self

    async def __aexit__(self, *args):
        return False

    async def json(self, **kwargs):
        return self.payload


class FakeHTTP:
    """Exercise the actual HTTP helper path; no request can leave this fake."""
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.sessions = []

    def session(self, **session_kwargs):
        owner = self
        session_id = len(self.sessions)
        self.sessions.append(session_kwargs)

        class Session:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            def request(self, method, url, **kwargs):
                owner.calls.append({"method": method, "url": url, "session_id": session_id, **kwargs})
                if not owner.responses:
                    raise AssertionError("Unexpected HTTP request")
                return owner.responses.pop(0)

            def get(self, url, **kwargs):
                return self.request("GET", url, **kwargs)

        return Session()


def pending():
    return FakeResponse(payload={"output": {"task_id": "test-task-1", "task_status": "PENDING"}})


def complete(url="https://output.example.test/result.mp4?signature=private"):
    return FakeResponse(payload={"output": {"task_id": "test-task-1", "task_status": "SUCCEEDED", "video_url": url}})


class WanVideoGeneratorTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.frame = Path(self.temp.name) / "frame.png"
        Image.new("RGB", (320, 240), "blue").save(self.frame)
        self.env = patch.dict(os.environ, {"VIMAX_VIDEO_POLL_INTERVAL_SECONDS": "0"}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    async def generate(self, http, *, generator=None, **kwargs):
        generator = generator or VideoGeneratorWanAPI(SECRET)
        kwargs.setdefault("reference_image_paths", [str(self.frame)])
        with patch(f"{MODULE}.aiohttp.ClientSession", http.session):
            return await generator.generate_single_video(**kwargs)

    async def test_default_request_is_single_720p_five_second_silent_task(self):
        http = FakeHTTP([pending(), complete(), FakeResponse()])
        events = []
        result = await self.generate(http, prompt="慢慢推近", progress=lambda *args: events.append(args))
        self.assertIsInstance(result, VideoOutput)
        self.assertEqual((result.fmt, result.ext, result.data), ("bytes", "mp4", b"offline-mp4"))
        create, poll, download = http.calls
        self.assertEqual(create["url"], "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis")
        self.assertEqual(create["headers"]["X-DashScope-Async"], "enable")
        self.assertEqual(create["headers"]["Authorization"], f"Bearer {SECRET}")
        self.assertFalse(create["allow_redirects"])
        payload = create["json"]
        self.assertEqual(payload["model"], "wan2.6-i2v-flash")
        self.assertEqual(payload["parameters"], {"duration": 5, "resolution": "720P", "audio": False,
                                                 "prompt_extend": False, "shot_type": "single"})
        data_url = payload["input"]["img_url"]
        self.assertTrue(data_url.startswith("data:image/png;base64,"))
        self.assertEqual(base64.b64decode(data_url.partition(",")[2]), self.frame.read_bytes())
        self.assertEqual(poll["url"], "https://dashscope.aliyuncs.com/api/v1/tasks/test-task-1")
        self.assertFalse(poll["allow_redirects"])
        self.assertNotEqual(download["session_id"], create["session_id"])
        self.assertNotIn("headers", download)
        self.assertFalse(download["allow_redirects"])
        self.assertNotIn("headers", http.sessions[download["session_id"]])
        self.assertIn("video_task_created", [event[0] for event in events])
        self.assertNotIn(SECRET, repr(events))
        self.assertNotIn("signature", repr(events))

    async def test_workspace_and_legacy_base_urls_normalize_without_duplicate_api_path(self):
        for base in ("https://dashscope.aliyuncs.com", "https://dashscope.aliyuncs.com/api/v1/",
                     "https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1",
                     "https://workspace-123.ap-southeast-1.maas.aliyuncs.com"):
            with self.subTest(base=base):
                http = FakeHTTP([pending(), complete(), FakeResponse()])
                await self.generate(http, generator=VideoGeneratorWanAPI(SECRET, base_url=base))
                origin = base.split("/api/v1")[0].rstrip("/")
                self.assertEqual(http.calls[1]["url"], f"{origin}/api/v1/tasks/test-task-1")

    async def test_overrides_duration_resolution_but_never_assumes_aspect_ratio(self):
        http = FakeHTTP([pending(), complete(), FakeResponse()])
        await self.generate(http, duration=2, resolution="1080p", aspect_ratio="9:16")
        payload = http.calls[0]["json"]
        self.assertEqual(payload["parameters"]["duration"], 2)
        self.assertEqual(payload["parameters"]["resolution"], "1080P")
        self.assertFalse(payload["parameters"]["audio"])
        self.assertNotIn("aspect_ratio", payload["parameters"])
        self.assertNotIn("aspect_ratio", payload)

    async def test_pending_and_running_then_success_never_repeat_post(self):
        http = FakeHTTP([pending(), FakeResponse(payload={"output": {"task_status": "RUNNING"}}), complete(), FakeResponse()])
        await self.generate(http)
        self.assertEqual([c["method"] for c in http.calls], ["POST", "GET", "GET", "GET"])

    async def test_no_first_frame_and_last_frame_reject_before_network(self):
        for paths, message in (([], "需要一张首帧"), ([str(self.frame)] * 2, "不支持尾帧")):
            with self.subTest(paths=paths):
                http = FakeHTTP([])
                with self.assertRaisesRegex(ValueError, message):
                    await self.generate(http, reference_image_paths=paths)
                self.assertFalse(http.calls)

    async def test_invalid_dimensions_reject_before_network(self):
        for dimensions in ((239, 240), (240, 239), (8001, 240), (240, 8001)):
            with self.subTest(dimensions=dimensions):
                Image.new("RGB", dimensions).save(self.frame)
                http = FakeHTTP([])
                with self.assertRaisesRegex(ValueError, "240–8000"):
                    await self.generate(http)
                self.assertFalse(http.calls)

    async def test_transparent_image_rejected_without_discarding_alpha(self):
        Image.new("RGBA", (320, 240), (255, 0, 0, 127)).save(self.frame)
        http = FakeHTTP([])
        with self.assertRaisesRegex(ValueError, "透明通道"):
            await self.generate(http)
        self.assertFalse(http.calls)

    async def test_invalid_or_missing_image_uses_safe_readable_errors(self):
        for path in (Path(self.temp.name) / "secret-file-not-present.png", self.frame):
            self.frame.write_bytes(b"not-an-image")
            with self.subTest(path=path):
                with self.assertRaises(ValueError) as caught:
                    await self.generate(FakeHTTP([]), reference_image_paths=[str(path)])
                self.assertNotIn(str(path), str(caught.exception))

    async def test_oversized_image_rejected_before_post(self):
        http = FakeHTTP([])
        with patch(f"{MODULE}.MAX_IMAGE_BYTES", 10):
            with self.assertRaisesRegex(ValueError, "20 MB"):
                await self.generate(http)
        self.assertFalse(http.calls)

    async def test_duration_and_resolution_are_not_silently_upgraded(self):
        for values in ({"duration": 1}, {"duration": 16}, {"duration": 2.5}, {"duration": True},
                       {"duration": float("inf")}, {"resolution": "480p"}, {"resolution": "4K"}):
            with self.subTest(values=values):
                http = FakeHTTP([])
                with self.assertRaises(ValueError):
                    await self.generate(http, **values)
                self.assertFalse(http.calls)

    def test_unrecognized_models_are_not_auto_replaced(self):
        for model in ("wan2.6-i2v", "wan2.7-i2v", ""):
            with self.subTest(model=model):
                with self.assertRaisesRegex(ValueError, "不会自动更换"):
                    VideoGeneratorWanAPI(SECRET, model=model)

    def test_invalid_urls_cannot_redirect_key_via_userinfo_or_query(self):
        for url in ("http://dashscope.aliyuncs.com", "https://user:pass@dashscope.aliyuncs.com",
                    "https://dashscope.aliyuncs.com?key=secret", "https://dashscope.aliyuncs.com/compatible-mode/v1",
                    "https://dashscope.aliyuncs.com:bad", "", None):
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    VideoGeneratorWanAPI(SECRET, base_url=url)

    async def test_create_timeout_does_not_repeat_paid_post(self):
        http = FakeHTTP([FakeResponse(error=asyncio.TimeoutError(SECRET))])
        with self.assertRaisesRegex(WanVideoError, "任务可能已创建") as caught:
            await self.generate(http)
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertEqual(len(http.calls), 1)

    async def test_auth_failure_does_not_expose_response_or_retry(self):
        http = FakeHTTP([FakeResponse(status=401, payload={"code": "InvalidApiKey", "message": SECRET})])
        with self.assertRaisesRegex(WanVideoError, "鉴权失败") as caught:
            await self.generate(http)
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertEqual(len(http.calls), 1)

    async def test_authenticated_redirect_rejected(self):
        http = FakeHTTP([FakeResponse(status=302, payload={"message": SECRET, "location": "https://external.invalid"})])
        with self.assertRaises(WanVideoError):
            await self.generate(http)
        self.assertFalse(http.calls[0]["allow_redirects"])
        self.assertEqual(len(http.calls), 1)

    async def test_failed_cancelled_and_unknown_status_end_without_retry(self):
        for status in ("FAILED", "CANCELED", "UNKNOWN", "UNEXPECTED"):
            with self.subTest(status=status):
                http = FakeHTTP([pending(), FakeResponse(payload={"output": {"task_status": status, "message": SECRET}})])
                with self.assertRaises(WanVideoError) as caught:
                    await self.generate(http)
                self.assertNotIn(SECRET, str(caught.exception))
                self.assertEqual(len(http.calls), 2)

    async def test_moderation_failure_is_sanitized(self):
        http = FakeHTTP([pending(), FakeResponse(payload={"output": {"task_status": "FAILED", "code": "DataInspectionFailed", "message": SECRET}})])
        with self.assertRaisesRegex(WanVideoError, "内容审核") as caught:
            await self.generate(http)
        self.assertNotIn(SECRET, str(caught.exception))

    async def test_poll_connection_error_preserves_existing_job_and_never_reposts(self):
        http = FakeHTTP([pending(), FakeResponse(error=aiohttp.ClientConnectionError(SECRET))])
        with self.assertRaisesRegex(WanVideoError, "云端任务可能仍在运行") as caught:
            await self.generate(http)
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertEqual(len(http.calls), 2)

    async def test_cancel_propagates_immediately_without_resubmitting(self):
        http = FakeHTTP([pending(), FakeResponse(error=asyncio.CancelledError())])
        events = []
        with self.assertRaises(asyncio.CancelledError):
            await self.generate(http, progress=lambda *args: events.append(args))
        self.assertEqual(len(http.calls), 2)
        self.assertEqual(events[-1][0], "video_cancelled")
        self.assertIn("仍可能运行", events[-1][1])

    async def test_actual_task_cancel_interrupts_poll_wait(self):
        http = FakeHTTP([pending()])
        created = asyncio.Event()

        def progress(stage, message, metadata):
            if stage == "video_task_created":
                created.set()

        with patch.dict(os.environ, {"VIMAX_VIDEO_POLL_INTERVAL_SECONDS": "15"}):
            task = asyncio.create_task(self.generate(http, progress=progress))
            await asyncio.wait_for(created.wait(), 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 1)
        self.assertEqual(len(http.calls), 1)

    async def test_validation_errors_can_be_displayed_by_runtime_without_raw_exceptions(self):
        with self.assertRaises(WanVideoValidationError) as caught:
            await self.generate(FakeHTTP([]), reference_image_paths=[])
        self.assertIsInstance(caught.exception, WanVideoError)
        self.assertIsInstance(caught.exception, ValueError)
        self.assertFalse(VideoGeneratorWanAPI.supports_last_frame)

    async def test_malformed_success_response_never_resubmits(self):
        for payload in ({}, [], {"output": {"task_status": "PENDING"}}):
            with self.subTest(payload=payload):
                http = FakeHTTP([FakeResponse(payload=payload)])
                with self.assertRaises(WanVideoError):
                    await self.generate(http)
                self.assertEqual(len(http.calls), 1)

    async def test_overall_poll_deadline_expires_without_another_request(self):
        http = FakeHTTP([pending()])
        with patch.dict(os.environ, {"VIMAX_VIDEO_QUERY_TIMEOUT_SECONDS": "0.001", "VIMAX_VIDEO_POLL_INTERVAL_SECONDS": "15"}):
            with self.assertRaisesRegex(WanVideoError, "云端任务可能仍在运行"):
                await self.generate(http)
        self.assertEqual(len(http.calls), 1)

    async def test_download_failure_tells_user_to_recover_existing_video(self):
        http = FakeHTTP([pending(), complete(), FakeResponse(status=403, payload={"message": SECRET})])
        with self.assertRaisesRegex(WanVideoError, "避免重复生成") as caught:
            await self.generate(http)
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertNotIn("headers", http.calls[-1])

    async def test_output_url_never_reuses_api_credentials_even_same_origin(self):
        http = FakeHTTP([pending(), complete("https://dashscope.aliyuncs.com/result.mp4"), FakeResponse()])
        await self.generate(http)
        self.assertNotIn("headers", http.calls[-1])

    async def test_malformed_task_id_cannot_change_authenticated_poll_origin(self):
        http = FakeHTTP([FakeResponse(payload={"output": {"task_id": "https://attacker.invalid/", "task_status": "PENDING"}})])
        with self.assertRaisesRegex(WanVideoError, "有效任务编号"):
            await self.generate(http)
        self.assertEqual(len(http.calls), 1)

    async def test_unsafe_output_url_rejected_without_fetch(self):
        for url in ("file:///private/file", "https://user:pass@output.example.test/video", None):
            with self.subTest(url=url):
                http = FakeHTTP([pending(), complete(url)])
                with self.assertRaisesRegex(WanVideoError, "视频地址无效"):
                    await self.generate(http)
                self.assertEqual(len(http.calls), 2)


if __name__ == "__main__":
    unittest.main()

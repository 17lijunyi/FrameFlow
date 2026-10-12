import asyncio
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import unittest
from unittest.mock import patch

import main_video_editor
from agent_runtime.video_edit import (
    VideoEditError, _capture_probe, _ffmpeg, probe_video_metadata,
    run_video_editor_request, validate_edit_segments,
)


class SegmentValidationTests(unittest.TestCase):
    clips = [{"sourceId": "red", "duration": 2}, {"sourceId": "blue", "duration": 3}]

    def test_order_fractional_ranges_and_repeated_sources_are_preserved(self):
        value = [{"sourceId": "blue", "start": .25, "end": 1.5},
                 {"sourceId": "red", "start": 0, "end": .5}, {"sourceId": "blue", "start": 2, "end": 3}]
        self.assertEqual(validate_edit_segments(value, self.clips), value)

    def test_invalid_ids_bounds_types_and_extra_fields_are_rejected(self):
        rows = [{"sourceId": "invented", "start": 0, "end": 1}, {"sourceId": "red", "start": -.1, "end": 1},
                {"sourceId": "red", "start": 0, "end": 2.1}, {"sourceId": "red", "start": 1, "end": 1},
                {"sourceId": "red", "start": 0, "end": .01}, {"sourceId": "red", "start": True, "end": 1},
                {"sourceId": "red", "start": 0, "end": float("inf")}, {"sourceId": "red", "start": 0, "end": float("nan")},
                {"sourceId": "red", "start": 0, "end": 10 ** 1000},
                {"sourceId": "red", "start": "0", "end": 1}, {"sourceId": "red", "start": 0, "end": 1, "prompt": "new"}]
        for row in rows:
            with self.subTest(row=row), self.assertRaises(VideoEditError) as caught:
                validate_edit_segments([row], self.clips)
            self.assertEqual(caught.exception.code, "invalid_edit_plan")

    def test_segment_count_and_total_duration_have_hard_limits(self):
        for value in (None, [], [{"sourceId": "red", "start": 0, "end": 1}] * 101,
                      [{"sourceId": "long", "start": 0, "end": 1000}] * 2):
            with self.subTest(value=value), self.assertRaises(VideoEditError):
                validate_edit_segments(value, [*self.clips, {"sourceId": "long", "duration": 3600}])


class VideoEditorRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name).resolve()
        self.session = self.root / ".working_dir/project-1"
        self.session.mkdir(parents=True)
        self.source = self.session / "source.mp4"
        self.source.write_bytes(b"original-source")
        self.environment = patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def request(self, operation="render"):
        return {"operation": operation, "repoRoot": str(self.root), "sessionDir": str(self.session),
                "path": str(self.source), "clips": [{"sourceId": "source-1", "path": str(self.source), "name": "原素材", "description": "镜头描述", "duration": 99999}],
                "segments": [{"sourceId": "source-1", "start": .25, "end": 1.5}],
                "settings": {"aspectRatio": "16:9", "resolution": "720p"},
                "outputPath": str(self.session / "video-editor/job-1/render.mp4")}

    @staticmethod
    async def probe(path):
        return {"duration": 2.5, "width": 64, "height": 32, "hasAudio": False}

    @staticmethod
    async def renderer(clips, segments, output, **kwargs):
        output.write_bytes(b"independent-video")
        return 1.25

    async def test_probe_returns_safe_real_metadata_and_has_no_api_dependency(self):
        with patch("agent_runtime.config.load_agent_config", side_effect=AssertionError("no API config")), \
             patch("agent_runtime.local_executors.run_local_executor", side_effect=AssertionError("no model")):
            result = await run_video_editor_request(self.request("probe"), repo_root=self.root, metadata_probe=self.probe)
        self.assertEqual(result, {"type": "result", "operation": "probe", "duration": 2.5, "width": 64, "height": 32, "hasAudio": False})
        self.assertEqual(list(self.session.iterdir()), [self.source])

    async def test_render_reprobes_duration_and_preserves_source(self):
        async def renderer(clips, segments, output, **kwargs):
            self.assertEqual(clips[0]["duration"], 2.5)
            self.assertFalse(clips[0]["hasAudio"])
            return await self.renderer(clips, segments, output, **kwargs)
        events = []
        with patch("agent_runtime.config.load_agent_config", side_effect=AssertionError("no API config")), \
             patch("agent_runtime.local_executors.run_local_executor", side_effect=AssertionError("no model")):
            result = await run_video_editor_request(self.request(), repo_root=self.root, metadata_probe=self.probe, renderer=renderer, emit=events.append)
        self.assertEqual(result["operation"], "render")
        self.assertEqual(result["segments"], self.request()["segments"])
        self.assertEqual(Path(result["path"]).read_bytes(), b"independent-video")
        self.assertEqual(self.source.read_bytes(), b"original-source")
        self.assertEqual([entry.name for entry in Path(result["path"]).parent.iterdir()], ["render.mp4"])
        self.assertEqual(events[-1]["progress"], 100)

    async def test_declared_duration_cannot_expand_plan_beyond_real_stream(self):
        request = self.request()
        request["segments"][0]["end"] = 3
        with self.assertRaises(VideoEditError) as caught:
            await run_video_editor_request(request, repo_root=self.root, metadata_probe=self.probe, renderer=self.renderer)
        self.assertEqual(caught.exception.code, "invalid_edit_plan")
        self.assertFalse(Path(request["outputPath"]).parent.exists())

    async def test_source_change_during_probe_is_rejected(self):
        async def changed(path):
            path.write_bytes(b"changed-source")
            return await self.probe(path)
        for operation in ("probe", "render"):
            with self.subTest(operation=operation), self.assertRaises(VideoEditError) as caught:
                await run_video_editor_request(self.request(operation), repo_root=self.root, metadata_probe=changed)
            self.assertEqual(caught.exception.code, "source_changed")

    async def test_source_change_during_render_removes_partial_output(self):
        async def changed(clips, segments, output, **kwargs):
            output.write_bytes(b"new-output")
            self.source.write_bytes(b"changed-source")
            return 1.25
        request = self.request()
        with self.assertRaises(VideoEditError) as caught:
            await run_video_editor_request(request, repo_root=self.root, metadata_probe=self.probe, renderer=changed)
        self.assertEqual(caught.exception.code, "source_changed")
        self.assertEqual(list(Path(request["outputPath"]).parent.iterdir()), [])

    async def test_invalid_paths_symlinks_and_outside_output_are_rejected(self):
        outside = self.root / "outside.mp4"
        outside.write_bytes(b"outside")
        link = self.session / "link.mp4"
        link.symlink_to(outside)
        for source in (str(outside), str(link), "https://example.test/remote.mp4", "../../outside.mp4"):
            request = self.request()
            request["clips"][0]["path"] = source
            with self.subTest(source=source), self.assertRaises(VideoEditError):
                await run_video_editor_request(request, repo_root=self.root, metadata_probe=self.probe)
        for output in (self.root / "result.mp4", self.session / "artifacts/director/job/render.mp4", self.session / "video-editor/render.mp4", self.session / "video-editor/job-1/result.mov"):
            request = self.request()
            request["outputPath"] = str(output)
            with self.subTest(output=output), self.assertRaises(VideoEditError):
                await run_video_editor_request(request, repo_root=self.root, metadata_probe=self.probe)

    async def test_duplicate_source_ids_source_count_and_settings_are_rejected(self):
        for update in ({"clips": self.request()["clips"] * 2}, {"clips": []}, {"clips": [{**self.request()["clips"][0], "sourceId": f"source-{index}"} for index in range(21)]},
                       {"settings": {"aspectRatio": "21:9", "resolution": "720p"}}, {"settings": {"aspectRatio": [], "resolution": "720p"}},
                       {"settings": {"aspectRatio": "16:9", "resolution": "480p"}}, {"operation": "edit"}):
            with self.subTest(update=update), self.assertRaises(VideoEditError):
                await run_video_editor_request({**self.request(), **update}, repo_root=self.root, metadata_probe=self.probe)

    async def test_existing_result_and_racing_result_are_never_overwritten(self):
        request = self.request()
        output = Path(request["outputPath"])
        output.parent.mkdir(parents=True)
        output.write_bytes(b"older-export")
        with self.assertRaises(VideoEditError) as caught:
            await run_video_editor_request(request, repo_root=self.root, metadata_probe=self.probe)
        self.assertEqual(caught.exception.code, "invalid_output")
        output.unlink()
        async def racing(clips, segments, temporary, **kwargs):
            output.write_bytes(b"racing-export")
            temporary.write_bytes(b"new-output")
            return 1.25
        with self.assertRaises(VideoEditError) as caught:
            await run_video_editor_request(request, repo_root=self.root, metadata_probe=self.probe, renderer=racing)
        self.assertEqual(caught.exception.code, "invalid_output")
        self.assertEqual(output.read_bytes(), b"racing-export")
        self.assertEqual([entry.name for entry in output.parent.iterdir()], ["render.mp4"])

    async def test_cancellation_removes_partial_output_and_preserves_original(self):
        ready = asyncio.Event()
        async def blocked(clips, segments, output, **kwargs):
            output.write_bytes(b"partial")
            ready.set()
            await asyncio.Event().wait()
        request = self.request()
        task = asyncio.create_task(run_video_editor_request(request, repo_root=self.root, metadata_probe=self.probe, renderer=blocked))
        await ready.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(list(Path(request["outputPath"]).parent.iterdir()), [])
        self.assertEqual(self.source.read_bytes(), b"original-source")

    async def test_probe_and_encoding_children_terminate_on_cancellation(self):
        for execute in (_ffmpeg, _capture_probe):
            marker = self.root / f"{execute.__name__}.pid"
            code = "import os,time; from pathlib import Path; Path(__import__('sys').argv[1]).write_text(str(os.getpid())); time.sleep(30)"
            task = asyncio.create_task(execute([sys.executable, "-c", code, str(marker)]))
            for _ in range(200):
                if marker.exists():
                    break
                await asyncio.sleep(.01)
            self.assertTrue(marker.exists())
            pid = int(marker.read_text())
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    async def test_probe_rejects_overlong_or_invalid_real_metadata(self):
        for duration, width in ((3601, 64), (float("nan"), 64), (0, 64), (2, 9000)):
            payload = {"streams": [{"codec_type": "video", "duration": str(duration), "width": width, "height": 32}]}
            async def capture(command):
                return 0, json.dumps(payload).encode(), b""
            with self.subTest(duration=duration, width=width), patch("agent_runtime.video_edit._capture_probe", capture), \
                 patch("agent_runtime.video_edit._ffprobe_executable", return_value="fake-ffprobe"), self.assertRaises(VideoEditError) as caught:
                await probe_video_metadata(self.source)
            self.assertEqual(caught.exception.code, "invalid_video")

    async def test_cli_sigterm_cancels_probe_and_its_child(self):
        marker = self.root / "probe.pid"
        binary = self.root / "fake-ffprobe"
        binary.write_text(f"#!{Path(sys.executable).resolve()}\nimport os,time\nfrom pathlib import Path\nPath({str(marker)!r}).write_text(str(os.getpid()))\ntime.sleep(30)\n")
        binary.chmod(0o755)
        request = self.root / "request.json"
        request.write_text(json.dumps(self.request("probe")))
        code = ("import asyncio,functools; from pathlib import Path; import agent_runtime.video_edit as v; import main_video_editor as m; "
                f"v.run_video_editor_request=functools.partial(v.run_video_editor_request,repo_root=Path({str(self.root)!r})); "
                f"raise SystemExit(asyncio.run(m.amain(['--request',{str(request)!r}])))")
        process = await asyncio.create_subprocess_exec(sys.executable, "-c", code, env={**os.environ, "FRAMEFLOW_FFPROBE": str(binary)}, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            for _ in range(800):
                if marker.exists():
                    break
                if process.returncode is not None:
                    stdout, stderr = await process.communicate()
                    self.fail(f"probe exited before ready: {stdout!r} {stderr!r}")
                await asyncio.sleep(.01)
            self.assertTrue(marker.exists())
            os.kill(process.pid, signal.SIGTERM)
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=5)
            self.assertEqual(process.returncode, 130)
            self.assertEqual(json.loads(stdout)["code"], "cancelled")
            self.assertEqual(stderr, b"")
            with self.assertRaises(ProcessLookupError):
                os.kill(int(marker.read_text()), 0)
            self.assertEqual(self.source.read_bytes(), b"original-source")
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    async def test_cli_strict_json_progress_and_safe_errors(self):
        request = self.root / "request.json"
        for value in ('{"operation":"probe","operation":"render"}', '{"segments":[{"start":NaN}]}'):
            request.write_text(value)
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = await main_video_editor.amain(["--request", str(request)])
            self.assertEqual(code, 1)
            self.assertEqual(json.loads(stdout.getvalue())["code"], "invalid_request")
        request.write_text("{}")
        async def fake(request, *, emit):
            print("private-file-diagnostic")
            emit({"type": "progress", "progress": 50})
            return {"type": "result", "operation": "render", "path": "output.mp4", "duration": 1}
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch("agent_runtime.video_edit.run_video_editor_request", fake), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = await main_video_editor.amain(["--request", str(request)])
        self.assertEqual(code, 0)
        self.assertEqual([json.loads(line)["type"] for line in stdout.getvalue().splitlines()], ["progress", "result"])
        self.assertNotIn("private", stdout.getvalue())
        self.assertEqual(stderr.getvalue(), "")
        stdout = io.StringIO()
        with patch("agent_runtime.video_edit.run_video_editor_request", side_effect=RuntimeError("private-provider-secret")), contextlib.redirect_stdout(stdout):
            code = await main_video_editor.amain(["--request", str(request)])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(stdout.getvalue())["code"], "video_edit_failed")
        self.assertNotIn("secret", stdout.getvalue())

    async def test_real_ffprobe_and_ffmpeg_preserve_order_colors_audio_and_originals(self):
        import numpy as np
        from moviepy import AudioClip, ColorClip, VideoFileClip
        red, blue = self.session / "red.mp4", self.session / "blue.mp4"
        audio = AudioClip(lambda t: .2 * np.sin(2 * np.pi * 440 * t), duration=.5, fps=44100)
        a = ColorClip((64, 32), color=(240, 0, 0), duration=.5).with_audio(audio)
        b = ColorClip((32, 64), color=(0, 0, 240), duration=.5)
        try:
            a.write_videofile(str(red), fps=24, codec="libx264", audio_codec="aac", logger=None)
            b.write_videofile(str(blue), fps=24, codec="libx264", logger=None)
        finally:
            a.close(); b.close(); audio.close()
        original = [hashlib.sha256(path.read_bytes()).hexdigest() for path in (red, blue)]
        metadata = await probe_video_metadata(red)
        self.assertAlmostEqual(metadata["duration"], .5, delta=.03)
        self.assertTrue(metadata["hasAudio"])
        request = self.request()
        request["clips"] = [{"sourceId": "red", "path": str(red), "name": "红", "description": "红色画面", "duration": 99},
                            {"sourceId": "blue", "path": str(blue), "name": "蓝", "description": "蓝色画面", "duration": 99}]
        request["segments"] = [{"sourceId": "blue", "start": .125, "end": .375}, {"sourceId": "red", "start": 0, "end": .25}]
        result = await run_video_editor_request(request, repo_root=self.root)
        with VideoFileClip(result["path"]) as video:
            self.assertEqual(tuple(video.size), (1280, 720))
            self.assertAlmostEqual(video.duration, .5, delta=.01)
            self.assertEqual(video.fps, 30)
            self.assertGreater(video.get_frame(.1)[360, 640, 2], 180)
            self.assertGreater(video.get_frame(.4)[360, 640, 0], 180)
            self.assertIsNotNone(video.audio)
            self.assertLess(float(np.abs(video.audio.get_frame(.08)).max()), .01)
            self.assertGreater(float(np.abs(video.audio.get_frame(.39)).max()), .01)
        self.assertEqual(original, [hashlib.sha256(path.read_bytes()).hexdigest() for path in (red, blue)])
        self.assertAlmostEqual(result["duration"], .5, delta=.000001)
        self.assertEqual([entry.name for entry in Path(result["path"]).parent.iterdir()], ["render.mp4"])
        with patch("agent_runtime.video_edit._ffprobe_executable", return_value=None):
            fallback = await probe_video_metadata(red)
        self.assertEqual(fallback["backend"], "bundled_ffmpeg")
        self.assertAlmostEqual(fallback["duration"], metadata["duration"], delta=.02)
        # Repeated minimum-length cuts must retain every segment, without adding
        # one rounding frame per cut. Total time is rounded up only once.
        request["outputPath"] = str(self.session / "video-editor/short-segments/render.mp4")
        request["segments"] = [{"sourceId": source, "start": 0, "end": .04} for source in ("blue", "red", "blue", "red")]
        short = await run_video_editor_request(request, repo_root=self.root)
        short_metadata = await probe_video_metadata(short["path"])
        if short_metadata["backend"] == "ffprobe":
            self.assertAlmostEqual(short["duration"], 5 / 30, delta=.000001)
        else:
            self.assertEqual(short_metadata["backend"], "bundled_ffmpeg")
            # FFmpeg's text probe reports duration rounded to centiseconds.
            self.assertLess(abs(short["duration"] - 5 / 30), .005)
        self.assertGreaterEqual(short["duration"], .16)
        self.assertLess(short["duration"] - .16, 1 / 30)
        with VideoFileClip(short["path"]) as video:
            self.assertEqual(video.fps, 30)
            self.assertAlmostEqual(video.duration, 5 / 30, delta=.01)
            for time, channel in ((.02, 2), (.08, 0), (.115, 2), (.15, 0)):
                self.assertGreater(video.get_frame(time)[360, 640, channel], 180)


if __name__ == "__main__":
    unittest.main()

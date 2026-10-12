import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from interfaces import Camera, ShotBriefDescription, ShotDescription
from interfaces.video_output import VideoOutput
from pipelines.script2video_pipeline import Script2VideoPipeline, _group_shots_into_cameras
from tools.video_generator_wan_api import WanVideoError


class FlakyCameraImageGenerator:
    def __init__(self):
        self.calls = 0

    async def construct_camera_tree(self, cameras, shot_descs):
        self.calls += 1
        if self.calls == 1:
            return ["not-a-camera"]
        return cameras


class Script2VideoPipelineGuardTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def shot(idx, variation="large"):
        return ShotDescription(idx=idx, is_last=idx == 1, cam_idx=0, visual_desc="镜头", variation_type=variation,
                               variation_reason="明显变化", ff_desc="开始", ff_vis_char_idxs=[], lf_desc="结束",
                               lf_vis_char_idxs=[], motion_desc="向前移动", audio_desc="无声")

    async def test_first_frame_backend_renders_medium_and_large_shots_without_generating_or_waiting_for_tail_frames(self):
        with tempfile.TemporaryDirectory() as tmp:
            class FirstFrameGenerator:
                supports_last_frame = False
                generate_single_video = AsyncMock(side_effect=lambda **kwargs: VideoOutput("bytes", "mp4", b"offline-video"))

            generator = FirstFrameGenerator()
            pipeline = Script2VideoPipeline(object(), object(), generator, tmp)
            shots = [self.shot(0, "medium"), self.shot(1, "large")]
            briefs = [ShotBriefDescription.model_validate(shot.model_dump()) for shot in shots]
            for shot in shots:
                pipeline.shot_desc_events[shot.idx] = asyncio.Event()
                folder = Path(tmp) / "shots" / str(shot.idx)
                folder.mkdir(parents=True)
                (folder / "shot_description.json").write_text(json.dumps(shot.model_dump()), encoding="utf-8")
                # Stale tails from another backend must not be sent to Wan.
                (folder / "last_frame.png").write_bytes(b"unused-tail")
            (Path(tmp) / "shots" / "0" / "first_frame.png").write_bytes(b"first-frame")
            (Path(tmp) / "final_video.mp4").write_bytes(b"cached-concat")
            pipeline.design_storyboard = AsyncMock(return_value=briefs)
            pipeline.construct_camera_tree = AsyncMock(return_value=[Camera(idx=0, active_shot_idxs=[0, 1])])
            generated_frames = []

            async def generate_frame(**kwargs):
                idx, frame_type = kwargs["shot_idx"], kwargs["frame_type"]
                generated_frames.append((idx, frame_type))
                (Path(tmp) / "shots" / str(idx) / f"{frame_type}.png").write_bytes(b"frame")
                pipeline.frame_events[idx][frame_type].set()

            pipeline.generate_frame_for_single_shot = generate_frame
            events = []
            result = await asyncio.wait_for(pipeline(script="剧本", user_requirement="", style="", characters=[],
                                                     character_portraits_registry={}, quiet=True,
                                                     progress=lambda *args: events.append(args)), 2)
            self.assertEqual(Path(result), Path(tmp) / "final_video.mp4")
            self.assertEqual(generated_frames, [(1, "first_frame")])
            self.assertEqual(generator.generate_single_video.await_count, 2)
            for call in generator.generate_single_video.await_args_list:
                self.assertEqual(len(call.kwargs["reference_image_paths"]), 1)
                self.assertTrue(call.kwargs["reference_image_paths"][0].endswith("first_frame.png"))
            for idx in (0, 1):
                self.assertEqual(set(pipeline.frame_events[idx]), {"first_frame"})
                self.assertEqual((Path(tmp) / "shots" / str(idx) / "video.mp4").read_bytes(), b"offline-video")
            self.assertTrue(any(stage == "video_frame_mode" and metadata.get("mode") == "first_frame"
                                for stage, _, metadata in events))

    async def test_existing_backend_still_waits_for_and_submits_tail_frame(self):
        with tempfile.TemporaryDirectory() as tmp:
            class ExistingGenerator:
                generate_single_video = AsyncMock(return_value=VideoOutput("bytes", "mp4", b"video"))

            generator = ExistingGenerator()
            pipeline = Script2VideoPipeline(object(), object(), generator, tmp)
            folder = Path(tmp) / "shots" / "0"
            folder.mkdir(parents=True)
            pipeline.frame_events[0] = {"first_frame": asyncio.Event(), "last_frame": asyncio.Event()}
            pipeline.frame_events[0]["first_frame"].set()
            task = asyncio.create_task(pipeline.generate_video_for_single_shot(self.shot(0)))
            await asyncio.sleep(0)
            generator.generate_single_video.assert_not_awaited()
            pipeline.frame_events[0]["last_frame"].set()
            await asyncio.wait_for(task, 1)
            self.assertEqual(generator.generate_single_video.call_args.kwargs["reference_image_paths"],
                             [str(folder / "first_frame.png"), str(folder / "last_frame.png")])

    async def test_paid_video_error_is_not_retried_by_clip_or_camera_transition(self):
        with tempfile.TemporaryDirectory() as tmp:
            class FirstFrameGenerator:
                supports_last_frame = False
                generate_single_video = AsyncMock(side_effect=WanVideoError("任务可能已创建，请检查百炼控制台。"))

            generator = FirstFrameGenerator()
            pipeline = Script2VideoPipeline(object(), object(), generator, tmp)
            pipeline.frame_events[0] = {"first_frame": asyncio.Event()}
            pipeline.frame_events[0]["first_frame"].set()
            with self.assertRaises(WanVideoError):
                await asyncio.wait_for(pipeline.generate_video_for_single_shot(self.shot(0)), 1)
            self.assertEqual(generator.generate_single_video.await_count, 1)
            generator.generate_single_video.reset_mock()
            with self.assertRaises(WanVideoError):
                await asyncio.wait_for(pipeline.camera_image_generator.generate_transition_video("镜头一", "镜头二", "first.png"), 1)
            self.assertEqual(generator.generate_single_video.await_count, 1)

    def test_group_shots_into_cameras_does_not_use_camera_idx_as_list_index(self):
        shots = [
            ShotDescription(idx=0, is_last=False, cam_idx=2, visual_desc="a", variation_type="small", variation_reason="same", ff_desc="a", ff_vis_char_idxs=[], lf_desc="a", lf_vis_char_idxs=[], motion_desc="a", audio_desc="none"),
            ShotDescription(idx=1, is_last=True, cam_idx=5, visual_desc="b", variation_type="small", variation_reason="same", ff_desc="b", ff_vis_char_idxs=[], lf_desc="b", lf_vis_char_idxs=[], motion_desc="b", audio_desc="none"),
            ShotDescription(idx=2, is_last=True, cam_idx=2, visual_desc="c", variation_type="small", variation_reason="same", ff_desc="c", ff_vis_char_idxs=[], lf_desc="c", lf_vis_char_idxs=[], motion_desc="c", audio_desc="none"),
        ]
        cameras = _group_shots_into_cameras(shots)
        self.assertEqual([camera.idx for camera in cameras], [2, 5])
        self.assertEqual(cameras[0].active_shot_idxs, [0, 2])
        self.assertEqual(cameras[1].active_shot_idxs, [1])

    async def test_plan_text_artifacts_retries_bad_camera_tree_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            pipeline = Script2VideoPipeline(chat_model=object(), image_generator=object(), video_generator=object(), working_dir=tmp)
            pipeline.camera_image_generator = FlakyCameraImageGenerator()

            async def design_storyboard(script, characters, user_requirement, quiet=False):
                return [{"idx": 0, "is_last": True, "cam_idx": 3, "visual_desc": "wide shot", "audio_desc": "waves"}]

            async def decompose_visual_descriptions(shot_brief_descriptions, characters, quiet=False):
                return [{"idx": 0, "is_last": True, "cam_idx": 3, "visual_desc": "wide shot", "variation_type": "small", "variation_reason": "simple", "ff_desc": "start", "ff_vis_char_idxs": [], "lf_desc": "end", "lf_vis_char_idxs": [], "motion_desc": "walk", "audio_desc": "waves"}]

            pipeline.design_storyboard = design_storyboard
            pipeline.decompose_visual_descriptions = decompose_visual_descriptions
            events = []
            result = await pipeline.plan_text_artifacts(
                "script",
                "req",
                "style",
                characters=[{"idx": 0, "identifier_in_scene": "Man", "is_visible": True, "static_features": "adult", "dynamic_features": "coat"}],
                progress=lambda stage, message, metadata=None: events.append(stage),
                quiet=True,
            )

            self.assertEqual(pipeline.camera_image_generator.calls, 2)
            self.assertIn("construct_camera_tree_retry", events)
            self.assertEqual(result["camera_tree"][0].idx, 3)
            self.assertTrue((Path(tmp) / "camera_tree.json").exists())


if __name__ == "__main__":
    unittest.main()

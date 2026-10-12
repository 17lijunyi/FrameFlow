from __future__ import annotations

import asyncio
from datetime import datetime
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import json
import logging
import os
from pathlib import Path
from typing import Any
from uuid import uuid4

from langchain.chat_models import init_chat_model
from langchain_openai import OpenAIEmbeddings
from tenacity import RetryError

from interfaces import CharacterInScene
from agents.event_extractor import EventExtractor
from agents.global_information_planner import GlobalInformationPlanner
from agents.novel_compressor import NovelCompressor
from agents.scene_extractor import SceneExtractor
from pipelines.novel2movie_pipeline import Novel2MoviePipeline
from pipelines.idea2video_pipeline import Idea2VideoPipeline
from pipelines.script2video_pipeline import Script2VideoPipeline
from tools.image_generator_nanobanana_yunwu_api import ImageGeneratorNanobananaYunwuAPI
from tools.image_generator_openrouter_api import ImageGeneratorOpenRouterAPI
from tools.reranker_bge_silicon_api import RerankerBgeSiliconapi
from tools.video_generator_openrouter_api import VideoGeneratorOpenRouterAPI
from tools.video_generator_veo_yunwu_api import VideoGeneratorVeoYunwuAPI

from .config import embedding_api_key, embedding_base_url, embedding_model, embedding_model_provider, image_api_key, image_base_url, image_model, image_provider, llm_api_key, llm_base_url, llm_model, llm_model_provider, reranker_api_key, reranker_base_url, reranker_model, video_api_key, video_base_url, video_model, video_provider
from .models import ToolResult
from .errors import RuntimeConfigurationError
from .local_executors import RoleExecutors, RoutedChatModel
from .local_image_generator import LocalAgentImageGenerator
from .config import image_num_candidates, novel_retrieval_mode
from utils.image_selection import DEFAULT_IMAGE_CANDIDATES
from .tools import ToolArgumentSchema, ToolRuntimeContext, ToolSpec


class _UnavailableGenerator:
    async def generate_single_image(self, *args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("文本规划阶段不能使用图像生成器")

    async def generate_single_video(self, *args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("文本规划阶段不能使用视频生成器")


def build_vimax_adapter_specs(workspace_root: str | Path, session_index: Any) -> list[ToolSpec]:
    adapter = ViMaxAdapters(Path(workspace_root), session_index)
    return [
        ToolSpec(
            name="vimax_narrative_planning",
            description=(
                "Create or revise ViMax structured text artifacts for the active session. "
                "Idea mode writes story, characters, script, and scene-level storyboard/shot_decomposition/camera_tree under idea2video/scene_<idx>/. "
                "Script mode writes characters, storyboard, shot_decomposition, and camera_tree under script2video/. "
                "Pass the active session_id from prompt context when the user is working in the selected project. An empty active session is initialized in place; a different source on a non-empty session creates a new session instead of overwriting existing artifacts. If idea/script/revision_target are omitted and the active session has an idea, continue that session and fill missing structured text artifacts. "
                "It does not generate keyframes, video clips, or final video. Call this before revising storyboard/shots when those artifacts do not exist."
            ),
            handler=adapter.vimax_narrative_planning,
            schema={
                "session_id": ToolArgumentSchema(str, required=False, default=""),
                "idea": ToolArgumentSchema(str, required=False, default=""),
                "script": ToolArgumentSchema(str, required=False, default=""),
                "user_requirement": ToolArgumentSchema(str, required=False, default=""),
                "style": ToolArgumentSchema(str, required=False, default=""),
                "revision_target": ToolArgumentSchema(str, required=False, default=""),
                "revision_instruction": ToolArgumentSchema(str, required=False, default=""),
            },
        ),
        ToolSpec(
            name="vimax_novel_planning",
            description=(
                "Create ViMax structured text artifacts from a novel or novel excerpt. "
                "This writes novel2video/novel, events, relevant_chunks, scenes, and global_information text artifacts. "
                "Use this when the user provides long prose, a novel excerpt, or asks for novel-to-video planning. Pass the active session_id when the user is working in a selected empty project. "
                "It does not generate character portraits, scene videos, or final video."
            ),
            handler=adapter.vimax_novel_planning,
            schema={
                "session_id": ToolArgumentSchema(str, required=False, default=""),
                "novel_text": ToolArgumentSchema(str, required=True),
                "user_requirement": ToolArgumentSchema(str, required=False, default=""),
                "style": ToolArgumentSchema(str, required=False, default=""),
            },
        ),
        ToolSpec(
            name="vimax_render_video",
            description=(
                "Render keyframes, video clips, and final video for the active ViMax session. "
                "This checks that structured text artifacts exist before rendering and reports missing dependencies instead of pretending render started."
            ),
            handler=adapter.vimax_render_video,
            schema={
                "session_id": ToolArgumentSchema(str, required=False, default=""),
                "mode": ToolArgumentSchema(str, required=False, default="foreground"),
                "force": ToolArgumentSchema(bool, required=False, default=False),
            },
        ),
    ]


class ViMaxAdapters:
    def __init__(self, workspace_root: Path, session_index: Any) -> None:
        self.workspace_root = workspace_root.resolve()
        self.session_index = session_index

    async def vimax_narrative_planning(self, args: dict[str, Any], runtime: ToolRuntimeContext | None = None) -> ToolResult:
        idea = str(args.get("idea", "") or "").strip()
        script = str(args.get("script", "") or "").strip()
        user_requirement = str(args.get("user_requirement", "") or "").strip()
        requested_style = str(args.get("style", "") or "").strip()
        style = requested_style
        session = self._resolve_session(str(args.get("session_id", "") or ""), idea=idea, script=script, user_requirement=user_requirement, style=requested_style)
        session_id = session["session_id"]
        working_dir = self.session_index.working_dir(session_id)
        idea_dir = working_dir / "idea2video"
        script_dir = working_dir / "script2video"
        idea_dir.mkdir(parents=True, exist_ok=True)
        script_dir.mkdir(parents=True, exist_ok=True)

        if not idea and not script:
            revision_target = str(args.get("revision_target") or "").strip()
            if revision_target:
                return await self._revise_narrative_artifact(session_id, working_dir, revision_target, str(args.get("revision_instruction") or "").strip(), runtime)
            session_idea = str(session.get("idea") or "").strip()
            if session_idea:
                idea = session_idea
                user_requirement = user_requirement or str(session.get("user_requirement") or "").strip()
                style = requested_style or str(session.get("style") or "").strip() or "Cinematic, coherent, 16:9"
            else:
                return ToolResult("vimax_narrative_planning", False, "请提供 idea、script、修改目标，或打开已有创意的项目来规划文本。", {"error_type": "missing_input", "session_id": session_id})

        style = style or str(session.get("style") or "").strip() or "Cinematic, coherent, 16:9"
        self._update_session_metadata(session_id, idea="", user_requirement="", style=style)

        try:
            self.session_index.update_stage(session_id, "narrative_planning", "正在生成结构化文本")
            if runtime:
                runtime.emit_progress("正在启动文本规划", stage="starting", metadata={"session_id": session_id})
                await asyncio.sleep(0)
            generated_before = self.session_index.artifact_checklist(session_id)
            if runtime:
                runtime.emit_progress("正在初始化文本模型", stage="initializing_llm", metadata={"session_id": session_id, "timeout_seconds": _llm_request_timeout_seconds(), "max_tokens": _narrative_max_tokens()})
                await asyncio.sleep(0)
            chat_model = _build_role_chat_model(self.workspace_root, "script")
            if runtime:
                runtime.emit_progress("文本模型已就绪", stage="chat_model_ready", metadata={"session_id": session_id})
                await asyncio.sleep(0)
            dummy = _UnavailableGenerator()
            # Do not globally redirect stdout/stderr while the JSONL CLI is streaming events.
            # The adapter exposes pipeline progress through explicit tool_progress events instead.
            if idea:
                idea_pipeline = Idea2VideoPipeline(chat_model=chat_model, image_generator=dummy, video_generator=dummy, working_dir=str(idea_dir))
                _configure_pipeline_roles(idea_pipeline, self.workspace_root)
                if runtime:
                    runtime.emit_progress("创意工作流已就绪", stage="idea_pipeline_ready", metadata={"session_id": session_id})
                    await asyncio.sleep(0)
                story = await _run_planning_step(
                    "正在根据创意创作故事",
                    "develop_story",
                    idea_pipeline.develop_story(idea=idea, user_requirement=user_requirement, quiet=True),
                    runtime,
                    {"session_id": session_id},
                )
                characters = await _run_planning_step(
                    "正在从故事提取角色",
                    "extract_characters",
                    idea_pipeline.extract_characters(story=story, quiet=True),
                    runtime,
                    {"session_id": session_id},
                )
                scene_scripts = await _run_planning_step(
                    "正在根据故事编写场景剧本",
                    "write_script",
                    idea_pipeline.write_script_based_on_story(story=story, user_requirement=user_requirement, quiet=True),
                    runtime,
                    {"session_id": session_id},
                )
                for idx, scene_script in enumerate(scene_scripts if isinstance(scene_scripts, list) else [scene_scripts]):
                    scene_dir = idea_dir / f"scene_{idx}"
                    scene_text = scene_script if isinstance(scene_script, str) else json.dumps(scene_script, ensure_ascii=False, indent=2)
                    script_pipeline = Script2VideoPipeline(chat_model=chat_model, image_generator=dummy, video_generator=dummy, working_dir=str(scene_dir))
                    _configure_pipeline_roles(script_pipeline, self.workspace_root)
                    await _run_planning_step(
                        f"正在规划场景 {idx} 的分镜与镜头",
                        "plan_scene",
                        script_pipeline.plan_text_artifacts(script=scene_text, user_requirement=user_requirement, style=style, characters=characters, progress=_pipeline_progress(runtime, session_id, scene_index=idx), quiet=True),
                        runtime,
                        {"session_id": session_id, "scene_index": idx},
                    )
            else:
                (script_dir / "script.txt").write_text(script, encoding="utf-8")
                script_pipeline = Script2VideoPipeline(chat_model=chat_model, image_generator=dummy, video_generator=dummy, working_dir=str(script_dir))
                _configure_pipeline_roles(script_pipeline, self.workspace_root)
                if runtime:
                    runtime.emit_progress("剧本工作流已就绪", stage="script_pipeline_ready", metadata={"session_id": session_id})
                    await asyncio.sleep(0)
                await _run_planning_step(
                    "正在根据剧本规划分镜与镜头",
                    "plan_script",
                    script_pipeline.plan_text_artifacts(script=script, user_requirement=user_requirement, style=style, progress=_pipeline_progress(runtime, session_id), quiet=True),
                    runtime,
                    {"session_id": session_id},
                )
        except Exception as exc:
            unwrapped = _unwrap_retry_error(exc)
            error_text = str(unwrapped) if isinstance(unwrapped, RuntimeConfigurationError) else str(exc)
            self.session_index.update_stage(session_id, "error", f"文本规划失败：{error_text}")
            checklist = self.session_index.artifact_checklist(session_id)
            payload = {
                "session_id": session_id,
                "working_dir": str(working_dir.relative_to(self.workspace_root)),
                "error_type": "recoverable_planning_step_failed",
                "retryable": True,
                "error": error_text,
                "present": [path for path, present in checklist.items() if present],
                "missing": [path for path, present in checklist.items() if not present],
            }
            payload.update(_configuration_error_metadata(unwrapped))
            if runtime:
                runtime.emit_progress("文本规划失败，已保留生成的部分内容", stage="planning_failed", metadata=payload)
            return ToolResult("vimax_narrative_planning", False, f"文本规划失败：{error_text}", payload)

        checklist = self.session_index.artifact_checklist(session_id)
        generated = [path for path, present in checklist.items() if present and not generated_before.get(path)]
        reused = [path for path, present in checklist.items() if present and generated_before.get(path)]
        ready_for_render = _ready_for_render(checklist)
        self.session_index.update_stage(session_id, "narrative_planned", "结构化文本规划完成" if ready_for_render else "结构化文本规划部分完成")
        if runtime:
            runtime.emit_progress("文本规划完成", stage="completed", metadata={"ready_for_render": ready_for_render})
        payload = {
            "session_id": session_id,
            "working_dir": str(working_dir.relative_to(self.workspace_root)),
            "generated": generated,
            "reused": reused,
            "missing": [path for path, present in checklist.items() if not present],
            "ready_for_render": ready_for_render,
        }
        return ToolResult("vimax_narrative_planning", True, json.dumps(payload, ensure_ascii=False, indent=2), payload)

    async def _revise_narrative_artifact(self, session_id: str, working_dir: Path, revision_target: str, revision_instruction: str, runtime: ToolRuntimeContext | None = None) -> ToolResult:
        if not revision_instruction:
            self.session_index.update_stage(session_id, "error", "修改失败：缺少 revision_instruction")
            return ToolResult("vimax_narrative_planning", False, "提供 revision_target 时需要填写 revision_instruction。", {"error_type": "missing_revision_instruction", "session_id": session_id, "revision_target": revision_target})
        try:
            target_path = _resolve_artifact_path(working_dir, revision_target)
        except ValueError as exc:
            self.session_index.update_stage(session_id, "error", f"修改失败：{exc}")
            return ToolResult("vimax_narrative_planning", False, str(exc), {"error_type": "invalid_revision_target", "session_id": session_id, "revision_target": revision_target})
        if not target_path.exists():
            self.session_index.update_stage(session_id, "error", f"修改失败：目标文件不存在：{revision_target}")
            return ToolResult("vimax_narrative_planning", False, f"修改目标文件不存在：{revision_target}", {"error_type": "dependency_missing", "session_id": session_id, "revision_target": revision_target})
        try:
            self.session_index.update_stage(session_id, "narrative_planning", "正在修改结构化文本")
            if runtime:
                runtime.emit_progress("正在修改结构化文本", stage="revising", metadata={"session_id": session_id, "revision_target": revision_target})
            role = "storyboard" if target_path.name in {"storyboard.json", "shot_decomposition.json", "camera_tree.json"} else "script"
            chat_model = _build_role_chat_model(self.workspace_root, role)
            before = target_path.read_text(encoding="utf-8")
            revised = await _revise_artifact_with_llm(chat_model, target_path.relative_to(working_dir).as_posix(), before, revision_instruction)
            if target_path.suffix == ".json":
                try:
                    revised_payload = json.loads(revised)
                except json.JSONDecodeError as exc:
                    self.session_index.update_stage(session_id, "error", f"修改失败：输出的 JSON 无效：{exc}")
                    return ToolResult("vimax_narrative_planning", False, f"修改输出不是有效的 JSON：{exc}", {"error_type": "invalid_revision_json", "session_id": session_id, "revision_target": revision_target})
                revised = json.dumps(revised_payload, ensure_ascii=False, indent=2)
            target_path.write_text(revised, encoding="utf-8")
        except Exception as exc:
            self.session_index.update_stage(session_id, "error", f"修改失败：{exc}")
            unwrapped = _unwrap_retry_error(exc)
            if isinstance(unwrapped, RuntimeConfigurationError):
                return ToolResult("vimax_narrative_planning", False, str(unwrapped), {"session_id": session_id, **_configuration_error_metadata(unwrapped)})
            raise

        stale = _stale_keys_for_revision(target_path.relative_to(working_dir).as_posix())
        if stale:
            self.session_index.mark_stale(session_id, stale)
        self.session_index.append_log("revisions", {"session_id": session_id, "target": target_path.relative_to(working_dir).as_posix(), "instruction": revision_instruction, "stale": stale, "before_preview": before[:500], "after_preview": revised[:500]})
        checklist = self.session_index.artifact_checklist(session_id)
        ready_for_render = _ready_for_render(checklist)
        self.session_index.update_stage(session_id, "narrative_planned" if ready_for_render else "narrative_planning", "结构化文本已修改")
        payload = {
            "session_id": session_id,
            "working_dir": str(working_dir.relative_to(self.workspace_root)),
            "generated": [],
            "reused": [path for path, present in checklist.items() if present],
            "revised": [target_path.relative_to(working_dir).as_posix()],
            "missing": [path for path, present in checklist.items() if not present],
            "stale": stale,
            "ready_for_render": ready_for_render,
            "revision_target": target_path.relative_to(working_dir).as_posix(),
        }
        return ToolResult("vimax_narrative_planning", True, json.dumps(payload, ensure_ascii=False, indent=2), payload)

    async def vimax_novel_planning(self, args: dict[str, Any], runtime: ToolRuntimeContext | None = None) -> ToolResult:
        novel_text = str(args.get("novel_text", "") or "").strip()
        user_requirement = str(args.get("user_requirement", "") or "").strip()
        style = str(args.get("style", "") or "").strip() or "Cinematic, coherent, 16:9"
        if not novel_text:
            return ToolResult("vimax_novel_planning", False, "小说规划需要提供 novel_text。", {"error_type": "missing_input"})

        session_id_arg = str(args.get("session_id", "") or "").strip()
        session = self._resolve_session(session_id_arg, idea=novel_text, script="", user_requirement=user_requirement, style=style)
        session_id = session["session_id"]
        working_dir = self.session_index.working_dir(session_id)
        novel_dir = working_dir / "novel2video"
        novel_dir.mkdir(parents=True, exist_ok=True)
        generated_before = self.session_index.artifact_checklist(session_id)

        try:
            _preflight_novel_retrieval(self.workspace_root)
            self.session_index.update_stage(session_id, "novel_planning", "正在生成小说结构化文本")
            if runtime:
                runtime.emit_progress("正在启动小说改编", stage="starting", metadata={"session_id": session_id})
                await asyncio.sleep(0)
            pipeline = _build_novel_pipeline(novel_dir)
            await _run_planning_step(
                "Planning novel structured text artifacts",
                "novel_plan_text_artifacts",
                pipeline.plan_text_artifacts(
                    novel_text=novel_text,
                    user_requirement=user_requirement,
                    style=style,
                    progress=_pipeline_progress(runtime, session_id),
                    quiet=True,
                ),
                runtime,
                {"session_id": session_id},
            )
        except Exception as exc:
            unwrapped = _unwrap_retry_error(exc)
            error_text = str(unwrapped) if isinstance(unwrapped, RuntimeConfigurationError) else str(exc)
            self.session_index.update_stage(session_id, "error", f"小说改编失败：{error_text}")
            return ToolResult("vimax_novel_planning", False, error_text, {"error_type": "exception", "session_id": session_id, **_configuration_error_metadata(unwrapped)})

        checklist = self.session_index.artifact_checklist(session_id)
        generated = [path for path, present in checklist.items() if path.startswith("novel2video/") and present and not generated_before.get(path)]
        reused = [path for path, present in checklist.items() if path.startswith("novel2video/") and present and generated_before.get(path)]
        missing = [path for path, present in checklist.items() if path.startswith("novel2video/") and not present]
        ready = _novel_text_ready(checklist)
        self.session_index.update_stage(session_id, "novel_planned" if ready else "novel_planning", "小说结构化文本规划完成" if ready else "小说结构化文本规划部分完成")
        if runtime:
            runtime.emit_progress("小说改编规划完成", stage="completed", metadata={"session_id": session_id, "ready_for_scene_render": False})
        payload = {
            "session_id": session_id,
            "working_dir": str(working_dir.relative_to(self.workspace_root)),
            "generated": generated,
            "reused": reused,
            "missing": missing,
            "ready_for_scene_render": False,
        }
        return ToolResult("vimax_novel_planning", True, json.dumps(payload, ensure_ascii=False, indent=2), payload)

    async def vimax_render_video(self, args: dict[str, Any], runtime: ToolRuntimeContext | None = None) -> ToolResult:
        session_id = str(args.get("session_id", "") or "").strip()
        session = self.session_index.get(session_id) if session_id else self.session_index.active()
        if session is None:
            return ToolResult("vimax_render_video", False, "请先打开需要生成视频的项目。", {"error_type": "missing_session"})
        session_id = session["session_id"]
        checklist = self.session_index.artifact_checklist(session_id)
        missing = _missing_render_dependencies(checklist)
        working_dir = self.session_index.working_dir(session_id)
        if missing:
            payload = {"error_type": "dependency_missing", "missing": missing, "session_id": session_id}
            _write_render_status(working_dir, status="dependency_missing", payload=payload)
            return ToolResult("vimax_render_video", False, f"缺少所需内容：{', '.join(missing)}", payload)

        self.session_index.update_stage(session_id, "rendering", "正在生成视频")
        _write_render_status(working_dir, status="rendering", payload={"session_id": session_id, "render_started": True, "render_completed": False})
        try:
            # Validate vision before constructing paid media providers or generating
            # character portraits/candidates. Unknown is never silently text-only.
            executors = RoleExecutors(self.workspace_root)
            executors.preflight_vision()
            executors.preflight_image()
            executors.preflight_video()
            chat_model = _build_role_chat_model(self.workspace_root, "script")
            image_generator = _build_image_generator(self.workspace_root)
            video_generator = _build_video_generator(self.workspace_root)
            num_image_candidates = image_num_candidates(self.workspace_root)
            if runtime:
                runtime.emit_progress("正在启动视频生成", stage="rendering", metadata={"session_id": session_id})
            if _idea_mode_ready(checklist):
                idea_pipeline = Idea2VideoPipeline(chat_model=chat_model, image_generator=image_generator, video_generator=video_generator, working_dir=str(working_dir / "idea2video"), num_image_candidates=num_image_candidates)
                _configure_pipeline_roles(idea_pipeline, self.workspace_root)
                with _suppress_pipeline_output():
                    final_video = await idea_pipeline(idea=str(session.get("idea", "")), user_requirement=str(session.get("user_requirement", "")), style=str(session.get("style", "")), quiet=True, progress=_pipeline_progress(runtime, session_id))
                self.session_index.update_stage(session_id, "rendered", "最终视频已生成")
                payload = {"session_id": session_id, "render_mode": "idea2video", "render_started": True, "render_completed": True, "final_video_path": str(Path(final_video).relative_to(self.workspace_root)), "missing": []}
                _write_render_status(working_dir, status="rendered", payload=payload)
                return ToolResult("vimax_render_video", True, json.dumps(payload, ensure_ascii=False, indent=2), payload)
            if _script_mode_ready(checklist):
                script_dir = working_dir / "script2video"
                script_text = _load_script_text(working_dir)
                characters = _load_characters(script_dir / "characters.json")
                pipeline = Script2VideoPipeline(chat_model=chat_model, image_generator=image_generator, video_generator=video_generator, working_dir=str(script_dir), num_image_candidates=num_image_candidates)
                _configure_pipeline_roles(pipeline, self.workspace_root)
                with _suppress_pipeline_output():
                    final_video = await pipeline(script=script_text, user_requirement=str(session.get("user_requirement", "")), style=str(session.get("style", "")), characters=characters, quiet=True, progress=_pipeline_progress(runtime, session_id))
                self.session_index.update_stage(session_id, "rendered", "最终视频已生成")
                payload = {"session_id": session_id, "render_mode": "script2video", "render_started": True, "render_completed": True, "final_video_path": str(Path(final_video).relative_to(self.workspace_root)), "missing": []}
                _write_render_status(working_dir, status="rendered", payload=payload)
                return ToolResult("vimax_render_video", True, json.dumps(payload, ensure_ascii=False, indent=2), payload)
            if _novel_mode_ready(checklist):
                novel_dir = working_dir / "novel2video"
                pipeline = _build_novel_render_pipeline(novel_dir, chat_model, image_generator, video_generator, num_image_candidates=num_image_candidates)
                with _suppress_pipeline_output():
                    render_result = await pipeline.render_video_artifacts(style=str(session.get("style", "")), user_requirement=str(session.get("user_requirement", "")), quiet=True, progress=_pipeline_progress(runtime, session_id))
                scene_videos_dir = Path(render_result["scene_videos_dir"])
                self.session_index.update_stage(session_id, "novel_scene_rendered", "小说场景视频已生成")
                payload = {
                    "session_id": session_id,
                    "render_mode": "novel2video",
                    "render_started": True,
                    "render_completed": True,
                    "scene_render_completed": True,
                    "final_video_path": None,
                    "scene_videos_dir": str(scene_videos_dir.relative_to(self.workspace_root)),
                    "scene_video_dirs": [str(Path(path).relative_to(self.workspace_root)) for path in render_result.get("scene_video_dirs", [])],
                    "scene_count": render_result.get("scene_count", 0),
                    "missing": [],
                }
                _write_render_status(working_dir, status="rendered", payload=payload)
                return ToolResult("vimax_render_video", True, json.dumps(payload, ensure_ascii=False, indent=2), payload)
        except Exception as exc:
            unwrapped = _unwrap_retry_error(exc)
            error_text = _sanitize_error_text(str(unwrapped))
            wrapped_error_text = _sanitize_error_text(str(exc))
            self.session_index.update_stage(session_id, "error", f"视频生成失败：{error_text}")
            checklist = self.session_index.artifact_checklist(session_id)
            payload = {
                "error_type": "render_failed",
                "retryable": _is_retryable_render_error(unwrapped),
                "session_id": session_id,
                "error": error_text,
                "wrapped_error": wrapped_error_text,
                "present": [path for path, present in checklist.items() if present],
                "missing": [path for path, present in checklist.items() if not present],
            }
            payload.update(_configuration_error_metadata(unwrapped))
            _write_render_status(working_dir, status="error", payload=payload)
            if runtime:
                runtime.emit_progress("视频生成失败，已保留生成的部分内容", stage="render_failed", metadata=payload)
            return ToolResult("vimax_render_video", False, f"视频生成失败：{error_text}", payload)
        payload = {"error_type": "dependency_missing", "session_id": session_id}
        _write_render_status(working_dir, status="dependency_missing", payload=payload)
        return ToolResult("vimax_render_video", False, "当前项目没有匹配的视频生成模式。", payload)

    def _resolve_session(self, session_id: str, *, idea: str, script: str, user_requirement: str, style: str) -> dict[str, Any]:
        requested_source = idea or script
        if session_id:
            session = self.session_index.get(session_id)
            if session is None:
                session = self.session_index.create(idea=requested_source, user_requirement=user_requirement, style=style, session_id=session_id)
            elif requested_source and _is_new_source_for_session(session, requested_source):
                session = self.session_index.create(idea=requested_source, user_requirement=user_requirement, style=style)
            else:
                self.session_index.set_active(session_id)
        else:
            if requested_source:
                active = self.session_index.active()
                if active is not None and self._session_is_empty(active):
                    session = self.session_index.set_active(active["session_id"])
                else:
                    session = self.session_index.create(idea=requested_source, user_requirement=user_requirement, style=style)
            else:
                session = self.session_index.active() or self.session_index.create(idea=requested_source, user_requirement=user_requirement, style=style)
        self._update_session_metadata(session["session_id"], idea=requested_source, user_requirement=user_requirement, style=style)
        return self.session_index.get(session["session_id"]) or session

    def _session_is_empty(self, session: dict[str, Any]) -> bool:
        if str(session.get("idea") or "").strip():
            return False
        session_id = str(session.get("session_id") or "").strip()
        if not session_id:
            return False
        return not any(self.session_index.artifact_checklist(session_id).values())

    def _update_session_metadata(self, session_id: str, *, idea: str, user_requirement: str, style: str) -> None:
        data = self.session_index.load()
        record = data.get("sessions", {}).get(session_id)
        if not isinstance(record, dict):
            return
        if idea and not record.get("idea"):
            record["idea"] = idea
        if user_requirement:
            record["user_requirement"] = user_requirement
        if style:
            record["style"] = style
        self.session_index.save(data)


class _DiscardStream:
    def write(self, text: str) -> int:
        return len(text)

    def flush(self) -> None:
        pass


_PIPELINE_OUTPUT_SINK = _DiscardStream()


@contextmanager
def _suppress_pipeline_output():
    previous_disable_level = logging.root.manager.disable
    logging.disable(logging.WARNING)
    try:
        with redirect_stdout(_PIPELINE_OUTPUT_SINK), redirect_stderr(_PIPELINE_OUTPUT_SINK):
            yield
    finally:
        logging.disable(previous_disable_level)


def _narrative_step_timeout_seconds() -> float:
    raw = os.environ.get("VIMAX_NARRATIVE_STEP_TIMEOUT_SECONDS", "900")
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 900.0


async def _run_planning_step(
    message: str,
    stage: str,
    awaitable: Any,
    runtime: ToolRuntimeContext | None,
    metadata: dict[str, Any] | None = None,
) -> Any:
    timeout_seconds = _narrative_step_timeout_seconds()
    event_metadata = dict(metadata or {})
    event_metadata["timeout_seconds"] = timeout_seconds
    if runtime:
        runtime.emit_progress(message, stage=stage, metadata=event_metadata)
        await asyncio.sleep(0)
    try:
        with _suppress_pipeline_output():
            if timeout_seconds <= 0:
                return await awaitable
            return await asyncio.wait_for(awaitable, timeout=timeout_seconds)
    except asyncio.TimeoutError as exc:
        raise RuntimeError(f"{message}在 {timeout_seconds:g} 秒后超时") from exc
    except Exception as exc:
        raise RuntimeError(f"{message}失败：{exc}") from exc


def _is_new_source_for_session(session: dict[str, Any], requested_source: str) -> bool:
    current = str(session.get("idea") or "").strip()
    requested = requested_source.strip()
    if not current or not requested:
        return False
    return current != requested


def _llm_request_timeout_seconds() -> float:
    raw = os.environ.get("VIMAX_LLM_REQUEST_TIMEOUT_SECONDS", "300")
    try:
        return max(1.0, float(raw))
    except ValueError:
        return 300.0


def _narrative_max_tokens() -> int:
    raw = os.environ.get("VIMAX_NARRATIVE_MAX_TOKENS", "4096")
    try:
        return max(256, int(raw))
    except ValueError:
        return 4096


def _pipeline_progress(runtime: ToolRuntimeContext | None, session_id: str, *, scene_index: int | None = None):
    if runtime is None:
        return None

    def emit(stage: str, message: str, metadata: dict[str, Any] | None = None) -> None:
        payload = dict(metadata or {})
        payload["session_id"] = session_id
        if scene_index is not None:
            payload["scene_index"] = scene_index
        runtime.emit_progress(message, stage=stage, metadata=payload)

    return emit


def _build_chat_model(workspace_root: str | Path = ".") -> Any:
    api_key = llm_api_key(workspace_root)
    if not api_key:
        raise RuntimeError("文本规划需要配置 VIMAX_LLM_API_KEY 或 configs/agent.local.yaml 中的 llm.api_key")
    return init_chat_model(
        model=llm_model(workspace_root),
        model_provider=llm_model_provider(workspace_root),
        api_key=api_key,
        base_url=llm_base_url(workspace_root),
        timeout=_llm_request_timeout_seconds(),
        max_retries=0,
        max_completion_tokens=_narrative_max_tokens(),
    )


def _build_role_chat_model(workspace_root: str | Path, role: str) -> RoutedChatModel:
    root = Path(workspace_root).resolve()
    entry = RoleExecutors(root).resolve(role)
    api_model = None
    if entry["id"] == "api":
        api_model = _build_chat_model(root)  # Report missing keys before starting a text step.
    return RoutedChatModel(workspace_root=str(root), role=role, api_factory=lambda: api_model if api_model is not None else _build_chat_model(root))


def _configure_pipeline_roles(pipeline: Any, workspace_root: str | Path) -> None:
    storyboard = _build_role_chat_model(workspace_root, "storyboard")
    # Creating this wrapper is safe during text planning; capability checks occur
    # at render preflight and before any actual image message is dispatched.
    vision = RoutedChatModel(workspace_root=str(Path(workspace_root).resolve()), role="vision", api_factory=lambda: _build_chat_model(workspace_root))
    pipeline.storyboard_model = storyboard
    pipeline.vision_model = vision
    for name in ("storyboard_artist", "camera_image_generator"):
        agent = getattr(pipeline, name, None)
        if agent is not None:
            agent.chat_model = storyboard
    for name in ("reference_image_selector", "best_image_selector"):
        agent = getattr(pipeline, name, None)
        if agent is not None:
            agent.chat_model = vision


def _configuration_error_metadata(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, RuntimeConfigurationError):
        return {"error_type": exc.code, "code": exc.code, "action": "open_settings", "retryable": False}
    return {}


def _artifact_workspace(working_dir: Path) -> Path:
    for parent in working_dir.resolve().parents:
        if parent.name == ".working_dir":
            return parent.parent
    return Path(".").resolve()


def _build_image_generator(workspace_root: str | Path = ".") -> Any:
    entry = RoleExecutors(workspace_root).preflight_image()
    if entry["kind"] == "cli":
        return LocalAgentImageGenerator(workspace_root)
    api_key = image_api_key(workspace_root)
    model = image_model(workspace_root)
    base_url = image_base_url(workspace_root)
    provider = image_provider(workspace_root)
    if provider == "openrouter":
        return ImageGeneratorOpenRouterAPI(api_key=api_key, model=model, base_url=base_url)
    if provider == "yunwu":
        return ImageGeneratorNanobananaYunwuAPI(api_key=api_key, model=model, base_url=base_url)
    raise RuntimeConfigurationError("unsupported_image_provider", "图像 API 协议不受支持。请前往设置重新选择。")


def _build_video_generator(workspace_root: str | Path = ".") -> Any:
    RoleExecutors(workspace_root).preflight_video()
    api_key = video_api_key(workspace_root)
    model = video_model(workspace_root)
    base_url = video_base_url(workspace_root)
    provider = video_provider(workspace_root)
    if provider == "openrouter":
        return VideoGeneratorOpenRouterAPI(api_key=api_key, model=model, base_url=base_url)
    if provider == "yunwu":
        return VideoGeneratorVeoYunwuAPI(api_key=api_key, t2v_model=model, ff2v_model=model, base_url=base_url)
    if provider == "aliyun":
        from tools.video_generator_wan_api import VideoGeneratorWanAPI
        return VideoGeneratorWanAPI(api_key=api_key, model=model, base_url=base_url, duration=5, resolution="720p", audio=False)
    raise RuntimeConfigurationError("unsupported_video_provider", "视频 API 协议不受支持。请前往设置重新选择。")


class _IdentityRewriter:
    async def __call__(self, prompt: str) -> str:
        return prompt


def _preflight_novel_retrieval(workspace_root: str | Path) -> None:
    if novel_retrieval_mode(workspace_root) != "api":
        executor = RoleExecutors(workspace_root).resolve("assistant")
        if executor["id"] == "api" and not llm_api_key(workspace_root).strip():
            raise RuntimeConfigurationError("missing_llm_api_key", "小说检索沿用创作助手，需要先配置文字 API 密钥，或选择已可用的本地 Agent。")
        return
    required = (embedding_api_key(workspace_root), embedding_base_url(workspace_root),
                reranker_api_key(workspace_root), reranker_base_url(workspace_root))
    if any(not value.strip() for value in required):
        raise RuntimeConfigurationError("missing_novel_retrieval_config", "已选择专用检索 API，需要配置文本向量和检索排序服务地址与 API 密钥。请前往「小说检索」完成配置，或改为沿用创作助手。")


def _build_embedding_model(workspace_root: str | Path = ".") -> Any:
    api_key = embedding_api_key(workspace_root)
    base_url = embedding_base_url(workspace_root)
    provider = embedding_model_provider(workspace_root).strip().lower()
    if not api_key or not base_url:
        raise RuntimeError("小说规划需要配置 VIMAX_EMBEDDING_API_KEY 或 configs/agent.local.yaml 中的 embedding api_key/base_url")
    if provider != "openai":
        raise RuntimeError(f"不支持的向量模型服务商 model_provider：{provider}")
    return OpenAIEmbeddings(model=embedding_model(workspace_root), api_key=api_key, base_url=base_url)


def _build_reranker(workspace_root: str | Path = ".") -> RerankerBgeSiliconapi:
    api_key = reranker_api_key(workspace_root)
    base_url = reranker_base_url(workspace_root)
    if not api_key or not base_url:
        raise RuntimeError("小说规划需要配置 VIMAX_RERANKER_API_KEY 或 configs/agent.local.yaml 中的 reranker api_key/base_url")
    return RerankerBgeSiliconapi(api_key=api_key, base_url=base_url, model=reranker_model(workspace_root))


def _build_novel_pipeline(working_dir: Path) -> Novel2MoviePipeline:
    workspace_root = _artifact_workspace(working_dir)
    chat_model = _build_role_chat_model(workspace_root, "script")
    dummy = _UnavailableGenerator()
    return Novel2MoviePipeline(
        novel_compressor=NovelCompressor(api_key="", base_url="", chat_model="", chat_model_instance=chat_model),
        event_extractor=EventExtractor(api_key="", base_url="", chat_model="", chat_model_instance=chat_model),
        embeddings=None,
        rerank_model=None,
        scene_extractor=SceneExtractor(api_key="", base_url="", chat_model="", chat_model_instance=chat_model),
        global_information_planner=GlobalInformationPlanner(api_key="", base_url="", chat_model="", chat_model_instance=chat_model),
        image_generator=dummy,
        rewriter=_IdentityRewriter(),
        script2video_pipeline=dummy,
        working_dir=str(working_dir),
        **_novel_retrieval_options(workspace_root),
    )


def _build_novel_render_pipeline(working_dir: Path, chat_model: Any, image_generator: Any, video_generator: Any, num_image_candidates: int = DEFAULT_IMAGE_CANDIDATES) -> Novel2MoviePipeline:
    workspace_root = _artifact_workspace(working_dir)
    script_pipeline = Script2VideoPipeline(chat_model=chat_model, image_generator=image_generator, video_generator=video_generator, working_dir=str(working_dir / "videos"), num_image_candidates=num_image_candidates)
    _configure_pipeline_roles(script_pipeline, workspace_root)
    return Novel2MoviePipeline(
        novel_compressor=NovelCompressor(api_key="", base_url="", chat_model="", chat_model_instance=chat_model),
        event_extractor=EventExtractor(api_key="", base_url="", chat_model="", chat_model_instance=chat_model),
        embeddings=None,
        rerank_model=None,
        scene_extractor=SceneExtractor(api_key="", base_url="", chat_model="", chat_model_instance=chat_model),
        global_information_planner=GlobalInformationPlanner(api_key="", base_url="", chat_model="", chat_model_instance=chat_model),
        image_generator=image_generator,
        rewriter=_IdentityRewriter(),
        script2video_pipeline=script_pipeline,
        working_dir=str(working_dir),
    )


def _novel_retrieval_options(workspace_root: str | Path) -> dict[str, Any]:
    mode = novel_retrieval_mode(workspace_root)
    # CLI discovery identifies an installation, not its current underlying
    # model. Reuse local selections only within this pipeline instance.
    local_run = uuid4().hex
    def retrieval_api_factory():
        _preflight_novel_retrieval(workspace_root)
        return _build_embedding_model(workspace_root), _build_reranker(workspace_root)
    def retrieval_identity():
        if mode == "assistant":
            entry = RoleExecutors(workspace_root).resolve("assistant")
            identity = {"id": entry["id"], "fingerprint": entry["fingerprint"]}
            if entry["id"] != "api":
                identity["run"] = local_run
            return identity
        return {"embedding": [embedding_model_provider(workspace_root), embedding_base_url(workspace_root), embedding_model(workspace_root)],
                "reranker": [reranker_base_url(workspace_root), reranker_model(workspace_root)]}
    script = RoleExecutors(workspace_root).resolve("script")
    return {"retrieval_mode": mode,
            "retrieval_model_factory": lambda: _build_role_chat_model(workspace_root, "assistant"),
            "retrieval_api_factory": retrieval_api_factory,
            "retrieval_identity_factory": retrieval_identity,
            "text_identity": {"id": script["id"], "fingerprint": script["fingerprint"]}}


def _unwrap_retry_error(exc: Exception) -> Exception:
    if isinstance(exc, RetryError):
        try:
            return exc.last_attempt.exception() or exc
        except Exception:
            return exc
    return exc


def _is_retryable_render_error(exc: Exception) -> bool:
    from tools.video_generator_wan_api import WanVideoError
    # A timed-out submission may already have created a billed cloud task.
    if isinstance(exc, WanVideoError):
        return False
    if isinstance(exc, RuntimeConfigurationError):
        return False
    text = str(exc).lower()
    if isinstance(exc, AttributeError):
        return False
    if "http 403" in text or "key limit exceeded" in text or "quota" in text:
        return False
    return True


def _sanitize_error_text(text: str) -> str:
    sanitized = text
    for marker in ("workspaces/default/keys/",):
        if marker in sanitized:
            prefix, rest = sanitized.split(marker, 1)
            key_id = []
            for char in rest:
                if char.isalnum() or char in "-_":
                    key_id.append(char)
                    continue
                break
            sanitized = prefix + marker + "<redacted>" + rest[len(key_id):]
    if "sk-" in sanitized:
        prefix, rest = sanitized.split("sk-", 1)
        token = []
        for char in rest:
            if char.isalnum() or char in "-_":
                token.append(char)
                continue
            break
        sanitized = prefix + "sk-<redacted>" + rest[len(token):]
    return sanitized


def _write_render_status(working_dir: Path, *, status: str, payload: dict[str, Any]) -> None:
    working_dir.mkdir(parents=True, exist_ok=True)
    event = {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "status": status,
        **payload,
    }
    (working_dir / "render_status.json").write_text(json.dumps(event, ensure_ascii=False, indent=2), encoding="utf-8")
    with (working_dir / "render_events.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")


def _write_characters_if_missing(path: Path, characters: list[CharacterInScene]) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([character.model_dump() for character in characters], ensure_ascii=False, indent=2), encoding="utf-8")


def _load_characters(path: Path) -> list[CharacterInScene]:
    return [CharacterInScene.model_validate(item) for item in json.loads(path.read_text(encoding="utf-8"))]


def _load_script_text(working_dir: Path) -> str:
    script_text = working_dir / "script2video" / "script.txt"
    if script_text.exists():
        return script_text.read_text(encoding="utf-8")
    idea_script = working_dir / "idea2video" / "script.json"
    if idea_script.exists():
        payload = json.loads(idea_script.read_text(encoding="utf-8"))
        return json.dumps(payload, ensure_ascii=False, indent=2) if not isinstance(payload, str) else payload
    story = working_dir / "idea2video" / "story.txt"
    if story.exists():
        return story.read_text(encoding="utf-8")
    return ""


def _resolve_artifact_path(working_dir: Path, revision_target: str) -> Path:
    rel = Path(revision_target)
    if rel.is_absolute():
        raise ValueError(f"revision_target 必须使用项目 working_dir 内的相对路径：{revision_target}")
    path = (working_dir / rel).resolve()
    if path != working_dir and working_dir not in path.parents:
        raise ValueError(f"revision_target 超出项目 working_dir：{revision_target}")
    return path


async def _revise_artifact_with_llm(chat_model: Any, target: str, current_text: str, instruction: str) -> str:
    prompt = (
        "Revise this ViMax structured artifact exactly as requested. "
        "Return only the complete replacement file content, with no Markdown fences or explanation. "
        "If the file is JSON, preserve valid JSON and the existing schema shape.\n\n"
        f"Target: {target}\n"
        f"Revision instruction: {instruction}\n\n"
        "Current file content:\n"
        f"{current_text}"
    )
    if hasattr(chat_model, "ainvoke"):
        response = await chat_model.ainvoke(prompt)
    elif hasattr(chat_model, "invoke"):
        response = chat_model.invoke(prompt)
    else:
        raise RuntimeError("chat_model 不支持修改所需的 invoke/ainvoke 调用")
    content = getattr(response, "content", response)
    if isinstance(content, list):
        content = "".join(str(item.get("text", item)) if isinstance(item, dict) else str(item) for item in content)
    return _strip_markdown_fences(str(content).strip())


def _strip_markdown_fences(text: str) -> str:
    if not text.startswith("```"):
        return text
    lines = text.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines).strip()


def _stale_keys_for_revision(target: str) -> list[str]:
    if "storyboard.json" in target:
        return ["shot_descriptions", "camera_tree", "frames", "clips", "final_video"]
    if "shot_description.json" in target:
        return ["frames", "clips", "final_video"]
    if "camera_tree.json" in target:
        return ["frames", "clips", "final_video"]
    if target.endswith("script.json") or target.endswith("story.txt"):
        return ["storyboard", "shot_descriptions", "camera_tree", "frames", "clips", "final_video"]
    if target.endswith("characters.json"):
        return ["storyboard", "shot_descriptions", "frames", "clips", "final_video"]
    return ["frames", "clips", "final_video"]


def _ready_for_render(checklist: dict[str, bool]) -> bool:
    return _idea_mode_ready(checklist) or _script_mode_ready(checklist) or _novel_mode_ready(checklist)


def _missing_render_dependencies(checklist: dict[str, bool]) -> list[str]:
    if _ready_for_render(checklist):
        return []
    idea_required = ["idea2video/story.txt", "idea2video/characters.json", "idea2video/script.json", "idea2video/scene_*/storyboard.json", "idea2video/scene_*/shots/*/shot_description.json", "idea2video/scene_*/camera_tree.json"]
    script_required = ["script2video/script.txt", "script2video/characters.json", "script2video/storyboard.json", "script2video/shots/*/shot_description.json", "script2video/camera_tree.json"]
    novel_required = ["novel2video/novel/novel_compressed.txt", "novel2video/events/event_*.json", "novel2video/relevant_chunks/event_*", "novel2video/scenes/event_*/scene_*.json", "novel2video/global_information/characters/event_level/*.json", "novel2video/global_information/characters/novel_level/*.json"]
    return [f"idea mode: {path}" for path in idea_required if not checklist.get(path)] + [f"script mode: {path}" for path in script_required if not checklist.get(path)] + [f"novel mode: {path}" for path in novel_required if not checklist.get(path)]


def _idea_mode_ready(checklist: dict[str, bool]) -> bool:
    return bool(checklist.get("idea2video/story.txt") and checklist.get("idea2video/characters.json") and checklist.get("idea2video/script.json") and checklist.get("idea2video/scene_*/storyboard.json") and checklist.get("idea2video/scene_*/shots/*/shot_description.json") and checklist.get("idea2video/scene_*/camera_tree.json"))


def _novel_text_ready(checklist: dict[str, bool]) -> bool:
    return _novel_mode_ready(checklist)


def _novel_mode_ready(checklist: dict[str, bool]) -> bool:
    return bool(checklist.get("novel2video/novel/novel_compressed.txt") and checklist.get("novel2video/events/event_*.json") and checklist.get("novel2video/relevant_chunks/event_*") and checklist.get("novel2video/scenes/event_*/scene_*.json") and checklist.get("novel2video/global_information/characters/event_level/*.json") and checklist.get("novel2video/global_information/characters/novel_level/*.json"))


def _script_mode_ready(checklist: dict[str, bool]) -> bool:
    return bool(checklist.get("script2video/script.txt") and checklist.get("script2video/characters.json") and checklist.get("script2video/storyboard.json") and checklist.get("script2video/shots/*/shot_description.json") and checklist.get("script2video/camera_tree.json"))

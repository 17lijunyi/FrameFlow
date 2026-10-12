"""Direct API video generation and offline export jobs."""
from __future__ import annotations

import asyncio
import logging
import math
import os
import re
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable

import yaml

from .config import DEFAULT_WAN_VIDEO_BASE_URL, DEFAULT_WAN_VIDEO_MODEL, api_provider_from_base_url, video_api_key


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_VIDEO_MODEL = "google/veo-3.1-fast"
DEFAULT_VIDEO_URL = "https://openrouter.ai/api/v1"
RATIOS = ("16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9", "9:21")
RESOLUTIONS = ("480p", "720p", "1080p")


class DirectorError(RuntimeError):
    def __init__(self, code: str, message: str, action: str | None = None):
        super().__init__(message)
        self.code = code
        self.action = action


def _inside(value: Any, root: Path, *, required: bool = False) -> Path:
    if not isinstance(value, (str, Path)) or not str(value).strip():
        raise DirectorError("invalid_path", "项目文件路径缺失。")
    path = Path(value)
    path = (path if path.is_absolute() else root / path).resolve()
    if path == root or not path.is_relative_to(root):
        raise DirectorError("invalid_path", "文件路径必须位于当前项目内。")
    if required and not path.is_file():
        raise DirectorError("missing_file", "项目中的素材文件不存在，请重新选择。")
    return path


def _config_path(value: Any, repo_root: Path) -> Path:
    expected = repo_root / "configs" / "agent.local.yaml"
    path = expected if not value else Path(value)
    path = (path if path.is_absolute() else repo_root / path).resolve()
    if not path.is_relative_to(repo_root) or path != expected.resolve():
        raise DirectorError("invalid_config_path", "只能使用当前应用的模型配置。")
    return path


def _video_config(config_path: Path) -> dict[str, str]:
    try:
        payload = yaml.safe_load(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
    except (OSError, yaml.YAMLError):
        raise DirectorError("invalid_config", "视频配置无法读取或格式有误，请检查设置。", "open_settings") from None
    if payload is not None and not isinstance(payload, dict):
        raise DirectorError("invalid_config", "视频配置格式有误，请检查设置。", "open_settings")
    section = (payload or {}).get("video") or {}
    if not isinstance(section, dict):
        raise DirectorError("invalid_config", "视频配置格式有误，请检查设置。", "open_settings")
    def value(key: str, env_name: str, default: str = "") -> str:
        candidate = os.environ.get(env_name) or section.get(key) or default
        clean = candidate.strip() if isinstance(candidate, str) else default
        if re.fullmatch(r"<YOUR_[A-Z0-9_]+>", clean or ""):
            clean = default
        return "" if re.fullmatch(r"<YOUR_[A-Z0-9_]+>", clean or "") else clean
    provider = value("api_provider", "VIMAX_VIDEO_PROVIDER").lower()
    base_url = value("base_url", "VIMAX_VIDEO_BASE_URL", DEFAULT_WAN_VIDEO_BASE_URL if provider == "aliyun" else DEFAULT_VIDEO_URL)
    is_wan = (provider or api_provider_from_base_url(base_url)) == "aliyun"
    return {
        "model": value("model", "VIMAX_VIDEO_MODEL", DEFAULT_WAN_VIDEO_MODEL if is_wan else DEFAULT_VIDEO_MODEL),
        "base_url": base_url,
        "api_provider": provider,
        "api_key": video_api_key(config_path.parent.parent),
    }


def director_capabilities(config: dict[str, str] | None = None) -> dict[str, Any]:
    config = config or {"model": DEFAULT_VIDEO_MODEL, "base_url": DEFAULT_VIDEO_URL}
    model = config.get("model", DEFAULT_VIDEO_MODEL)
    protocol = (config.get("api_provider") or api_provider_from_base_url(config.get("base_url", DEFAULT_VIDEO_URL))).strip().lower()
    known_veo = protocol == "openrouter" and model.lower().startswith("google/veo")
    if protocol == "openrouter":
        # Public catalog: https://openrouter.ai/api/v1/videos/models
        # Veo combination limits: https://ai.google.dev/gemini-api/docs/veo
        provider, supported = "openrouter", True
        durations = [4, 6, 8] if known_veo else list(range(1, 31))
    elif protocol == "yunwu" and "seedance" in model.lower():
        provider, supported, durations = "yunwu_seedance", True, [5, 10]
    elif protocol == "aliyun" and model == DEFAULT_WAN_VIDEO_MODEL:
        provider, supported, durations = "aliyun", True, list(range(2, 16))
    else:
        provider, supported, durations = "yunwu_veo" if protocol == "yunwu" else "unsupported", False, []
    result = {
        "provider": provider, "model": model, "supported": supported,
        "durations": durations, "resolutions": (["720p", "1080p"] if known_veo else list(RESOLUTIONS)) if supported else [],
        "aspectRatios": (["16:9", "9:16"] if known_veo else list(RATIOS)) if supported else [],
        "promptOnly": supported, "firstFrame": supported, "firstLastFrame": supported,
        "maxImages": 2 if supported else 0, "multiReference": False, "comfyUI": False,
        "providerValidatesModelOptions": True,
        "modelOptionsKnown": known_veo or provider == "yunwu_seedance",
    }
    if known_veo:
        result["constraints"] = {"1080pDuration": 8, "firstLastFrameDuration": 8}
    elif provider == "aliyun":
        result.update({
            "defaultDuration": 5, "resolutions": ["720p", "1080p"],
            "promptOnly": False, "firstLastFrame": False, "maxImages": 1,
            "audio": False, "aspectRatioFromImage": True, "modelOptionsKnown": True,
            "notice": "万相 Flash 需要一张首帧图片，生成无声视频；画幅跟随首帧，项目画幅仅用于合并导出。",
        })
    elif provider == "openrouter":
        result["notice"] = "当前模型的时长、画幅和首尾帧组合由视频服务验证。"
    if not supported:
        result["reason"] = "当前视频模型尚未适配，请在设置选择 OpenRouter 视频模型、云雾 Seedance 或阿里云万相 wan2.6-i2v-flash。"
    return result


def capabilities_from_config_path(value: Any = None, *, repo_root: Path | str = REPO_ROOT) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    return director_capabilities(_video_config(_config_path(value, root)))


def _normalize_request(request: dict[str, Any], repo_root: Path) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise DirectorError("invalid_request", "导演任务需要使用 JSON 对象。")
    requested_root = request.get("repoRoot") or request.get("repo_root")
    if requested_root and Path(requested_root).resolve() != repo_root:
        raise DirectorError("invalid_path", "任务不属于当前应用目录。")
    working_root = (repo_root / ".working_dir").resolve()
    if not working_root.is_relative_to(repo_root):
        raise DirectorError("invalid_path", "项目工作目录无效。")
    session_value = request.get("sessionDir") or request.get("session_root")
    if not session_value:
        raise DirectorError("invalid_path", "请选择一个项目后再运行。")
    session = _inside(session_value, working_root)
    if not session.is_dir() or session.parent != working_root:
        raise DirectorError("invalid_path", "项目工作目录不存在。")
    session_id = request.get("sessionId")
    if session_id and str(session_id) != session.name:
        raise DirectorError("invalid_path", "项目标识与工作目录不一致。")
    operation = request.get("operation")
    if operation not in {"render", "export"}:
        raise DirectorError("invalid_operation", "请选择生成镜头或合并视频。")
    artifacts = (session / "artifacts" / "director").resolve()
    if not artifacts.is_relative_to(session):
        raise DirectorError("invalid_path", "项目输出目录无效。")
    output_value = request.get("outputPath") or request.get("output_path")
    directory_value = request.get("outputDir") or (str(Path(output_value).parent) if output_value else "")
    output_dir = _inside(directory_value, session)
    if not output_dir.is_relative_to(artifacts):
        raise DirectorError("invalid_path", "输出必须保存在当前项目的导演台目录。")
    output = _inside(output_value or (output_dir / ("render.mp4" if operation == "render" else "final.mp4")), session)
    if not output.is_relative_to(output_dir) or output.suffix.lower() != ".mp4" or output.exists():
        raise DirectorError("invalid_output", "输出路径无效或已存在，请创建新的镜头版本。")
    settings = request.get("settings") or {}
    shot = request.get("shot") or {}
    if not isinstance(settings, dict) or not isinstance(shot, dict):
        raise DirectorError("invalid_request", "镜头和输出设置格式有误。")
    ratio = settings.get("aspectRatio") or request.get("aspect_ratio") or "16:9"
    resolution = settings.get("resolution") or request.get("resolution") or "720p"
    if ratio not in RATIOS or resolution not in RESOLUTIONS:
        raise DirectorError("invalid_settings", "请选择有效的画幅和分辨率。")
    normalized = {"operation": operation, "session": session, "output_dir": output_dir, "output": output,
                  "ratio": ratio, "resolution": resolution,
                  "config_path": _config_path(request.get("configPath") or request.get("config_path"), repo_root)}
    if operation == "render":
        prompt = shot.get("prompt") or request.get("prompt") or ""
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 40_000:
            raise DirectorError("invalid_prompt", "请填写有效的镜头提示词。")
        style = settings.get("style") or ""
        if not isinstance(style, str) or len(style) > 4_000:
            raise DirectorError("invalid_settings", "风格描述过长或格式有误。")
        duration = shot.get("duration", request.get("duration", 8))
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or int(duration) != duration or not 1 <= duration <= 30:
            raise DirectorError("invalid_duration", "镜头时长必须是 1 到 30 秒的整数。")
        first = shot.get("firstFrame") or request.get("first_frame")
        last = shot.get("lastFrame") or request.get("last_frame")
        if last and not first:
            raise DirectorError("invalid_frames", "请先选择首帧，再选择尾帧。")
        frames = [_inside(value, session, required=True) for value in (first, last) if value]
        for frame in frames:
            try:
                from PIL import Image
                with Image.open(frame) as image:
                    image.verify()
            except Exception:
                raise DirectorError("invalid_frames", "首尾帧必须是可读取的项目图片。") from None
        normalized.update(prompt=prompt.strip() + (f"\n\n风格：{style.strip()}" if style.strip() else ""),
                          duration=int(duration), duration_explicit="duration" in shot or "duration" in request,
                          frames=frames)
    else:
        raw_clips = request.get("clips")
        if not isinstance(raw_clips, list) or not 1 <= len(raw_clips) <= 200:
            raise DirectorError("invalid_clips", "请选择 1 到 200 个已经生成的镜头版本。")
        clips = []
        for item in raw_clips:
            path = _inside(item.get("path") if isinstance(item, dict) else item, session, required=True)
            if path.suffix.lower() not in {".mp4", ".mov", ".webm"}:
                raise DirectorError("invalid_clips", "合并素材必须是项目中的视频文件。")
            clips.append(path)
        normalized["clips"] = clips
    return normalized


def build_video_generator(config: dict[str, str]):
    """Instantiate only a video class through the existing RenderBackend factory."""
    if not config.get("api_key"):
        raise DirectorError("missing_video_api_key", "尚未配置视频 API Key，请前往设置保存视频模型和密钥。", "open_settings")
    capabilities = director_capabilities(config)
    if not capabilities["supported"]:
        raise DirectorError("unsupported_video_provider", capabilities["reason"], "open_settings")
    from tools.render_backend import _build_rate_limiter, _instantiate
    if capabilities["provider"] == "openrouter":
        section = {"class_path": "tools.video_generator_openrouter_api.VideoGeneratorOpenRouterAPI", "init_args": {
            "api_key": config["api_key"], "model": config["model"], "base_url": config["base_url"], "app_title": "FrameFlow"}}
    elif capabilities["provider"] == "aliyun":
        section = {"class_path": "tools.video_generator_wan_api.VideoGeneratorWanAPI", "init_args": {
            "api_key": config["api_key"], "model": config["model"], "base_url": config["base_url"],
            "duration": 5, "resolution": "720p", "audio": False}}
    else:
        section = {"class_path": "tools.video_generator_doubao_seedance_yunwu_api.VideoGeneratorDoubaoSeedanceYunwuAPI", "init_args": {
            "api_key": config["api_key"], "t2v_model": config["model"], "ff2v_model": config["model"], "flf2v_model": config["model"], "base_url": config["base_url"]}}
    try:
        return _instantiate(section, _build_rate_limiter(section))
    except Exception as exc:
        if capabilities["provider"] == "aliyun":
            from tools.video_generator_wan_api import WanVideoError
            if isinstance(exc, WanVideoError):
                raise DirectorError("wan_video_config", str(exc), "open_settings") from None
        raise


@contextmanager
def _render_environment(duration: int, resolution: str):
    updates = {"VIMAX_OPENROUTER_VIDEO_DURATION": str(duration), "VIMAX_OPENROUTER_VIDEO_RESOLUTION": resolution}
    previous = {key: os.environ.get(key) for key in updates}
    os.environ.update(updates)
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def probe_video(path: Path) -> float:
    from moviepy import VideoFileClip
    with VideoFileClip(str(path)) as clip:
        duration = float(clip.duration or 0)
        if not math.isfinite(duration) or duration <= 0:
            raise DirectorError("invalid_video", "生成的视频为空或无法读取，请重新生成。")
        return duration


def _canvas_size(ratio: str, resolution: str) -> tuple[int, int]:
    a, b = (int(part) for part in ratio.split(":"))
    edge = int(resolution[:-1])
    width, height = (edge * a / b, edge) if a >= b else (edge, edge * b / a)
    return max(2, int(round(width / 2)) * 2), max(2, int(round(height / 2)) * 2)


def merge_video_clips(paths: list[Path], output: Path, *, ratio: str, resolution: str) -> float:
    """Letterbox to an even canvas; compose preserves each clip's audio."""
    from moviepy import CompositeVideoClip, VideoFileClip, concatenate_videoclips
    opened, normalized = [], []
    final = None
    target = _canvas_size(ratio, resolution)
    temporary_audio = output.with_suffix(".audio.m4a")
    try:
        for path in paths:
            clip = VideoFileClip(str(path))
            opened.append(clip)
            if not clip.duration or clip.duration <= 0:
                raise DirectorError("invalid_video", "镜头视频为空或无法读取，请重新生成。")
            scale = min(target[0] / clip.w, target[1] / clip.h)
            size = (max(2, round(clip.w * scale)), max(2, round(clip.h * scale)))
            layer = clip.resized(new_size=size).with_position(("center", "center"))
            normalized.append(CompositeVideoClip([layer], size=target, bg_color=(0, 0, 0)).with_duration(clip.duration))
        final = concatenate_videoclips(normalized, method="compose")
        final.write_videofile(str(output), codec="libx264", audio_codec="aac", fps=24,
                              preset="medium", threads=2, logger=None,
                              temp_audiofile=str(temporary_audio), remove_temp=True)
        return float(final.duration)
    finally:
        if final is not None:
            final.close()
        for clip in normalized:
            clip.close()
        for clip in opened:
            clip.close()
        temporary_audio.unlink(missing_ok=True)


async def run_director_request(request: dict[str, Any], *, repo_root: Path | str = REPO_ROOT,
                               emit: Callable[[dict[str, Any]], None] | None = None,
                               generator_factory=None, video_probe=None, merger=None) -> dict[str, Any]:
    emit = emit or (lambda event: None)
    job = _normalize_request(request, Path(repo_root).resolve())
    emit({"type": "progress", "message": "正在准备镜头素材", "progress": 5})
    config = _video_config(job["config_path"]) if job["operation"] == "render" else None
    if config is not None:
        # A director shot uses only the video role; Agent/vision declarations and
        # text/image model initialization are irrelevant to this direct job.
        from .local_executors import RoleExecutors
        from .errors import RuntimeConfigurationError
        try:
            RoleExecutors(Path(repo_root).resolve()).resolve("video")
        except RuntimeConfigurationError as exc:
            raise DirectorError(exc.code, str(exc), "open_settings") from exc
        if not config.get("api_key"):
            raise DirectorError("missing_video_api_key", "尚未配置视频 API Key，请前往设置保存视频模型和密钥。", "open_settings")
        capabilities = director_capabilities(config)
        if not capabilities["supported"]:
            raise DirectorError("unsupported_video_provider", capabilities["reason"], "open_settings")
        if not job["duration_explicit"]:
            job["duration"] = capabilities.get("defaultDuration", job["duration"])
        if not job["frames"] and not capabilities["promptOnly"]:
            raise DirectorError("invalid_frames", "当前视频模型需要一张首帧图片，请先为镜头选择首帧。")
        if len(job["frames"]) > 1 and not capabilities["firstLastFrame"]:
            raise DirectorError("invalid_frames", "当前视频模型只支持首帧图片，请移除尾帧后再生成。")
        if job["duration"] not in capabilities["durations"]:
            raise DirectorError("unsupported_video_settings", "当前视频接口不支持这个时长，请调整镜头设置。")
        if ((not capabilities.get("aspectRatioFromImage") and job["ratio"] not in capabilities["aspectRatios"])
                or job["resolution"] not in capabilities["resolutions"]):
            raise DirectorError("unsupported_video_settings", "当前视频模型不支持这个画幅或分辨率，请调整镜头设置。")
        constraints = capabilities.get("constraints", {})
        if job["resolution"] == "1080p" and constraints.get("1080pDuration") and job["duration"] != constraints["1080pDuration"]:
            raise DirectorError("unsupported_video_settings", "Veo 的 1080p 视频需要使用 8 秒时长。")
        if len(job["frames"]) == 2 and constraints.get("firstLastFrameDuration") and job["duration"] != constraints["firstLastFrameDuration"]:
            raise DirectorError("unsupported_video_settings", "Veo 的首尾帧视频需要使用 8 秒时长。")
        generator = (generator_factory or build_video_generator)(config)
    job["output_dir"].mkdir(parents=True, exist_ok=True)
    # Recheck after mkdir so preexisting directory symlinks cannot escape the project.
    if not job["output_dir"].resolve().is_relative_to(job["session"]):
        raise DirectorError("invalid_path", "项目输出目录无效。")
    handle, temporary = tempfile.mkstemp(prefix=".director-", suffix=".mp4", dir=job["output_dir"])
    os.close(handle)
    temporary = Path(temporary)
    previous_logging = logging.root.manager.disable
    logging.disable(logging.CRITICAL)
    try:
        if job["operation"] == "render":
            emit({"type": "progress", "message": "正在生成视频，通常需要数分钟", "progress": 15})
            def progress(stage, _message, _metadata=None):
                if stage == "video_task_created":
                    emit({"type": "progress", "message": "视频任务已提交，正在等待生成", "progress": 25})
                elif stage in {"video_completed", "video_download_start"}:
                    emit({"type": "progress", "message": "正在保存生成的视频", "progress": 85})
            with _render_environment(job["duration"], job["resolution"]):
                result = await generator.generate_single_video(prompt=job["prompt"],
                    reference_image_paths=[str(path) for path in job["frames"]], aspect_ratio=job["ratio"],
                    duration=job["duration"], resolution=job["resolution"], progress=progress)
                await asyncio.to_thread(result.save, str(temporary))
            duration = await asyncio.to_thread(video_probe or probe_video, temporary)
        else:
            emit({"type": "progress", "message": "正在合并当前镜头版本并保留音轨", "progress": 20})
            duration = await asyncio.to_thread(merger or merge_video_clips, job["clips"], temporary,
                                             ratio=job["ratio"], resolution=job["resolution"])
        if not temporary.is_file() or temporary.stat().st_size == 0 or not math.isfinite(duration) or duration <= 0:
            raise DirectorError("invalid_video", "视频结果为空或无法读取，请重试。")
        # A new version must never replace an existing render.
        os.link(temporary, job["output"])
        emit({"type": "progress", "message": "视频已保存", "progress": 100})
        return {"type": "result", "operation": job["operation"], "path": str(job["output"]), "duration": float(duration)}
    except DirectorError:
        raise
    except Exception as exc:
        if job["operation"] == "render" and capabilities["provider"] == "aliyun":
            from tools.video_generator_wan_api import WanVideoError
            if isinstance(exc, WanVideoError):
                raise DirectorError("wan_video_failed", str(exc)) from None
        message = "视频生成失败，请检查视频服务、模型权限和余额后重试。" if job["operation"] == "render" else "视频合并失败，请检查镜头视频是否完整后重试。"
        raise DirectorError("video_generation_failed" if job["operation"] == "render" else "video_export_failed", message) from None
    finally:
        logging.disable(previous_logging)
        temporary.unlink(missing_ok=True)

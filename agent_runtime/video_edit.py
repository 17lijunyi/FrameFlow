"""Independent, local-only video metadata probing and bounded FFmpeg editing."""
from __future__ import annotations

import asyncio
import json
import math
import os
import re
from decimal import Decimal, ROUND_CEILING
from pathlib import Path
import shutil
import tempfile
from typing import Any, Callable

MAX_INPUT_DURATION = 3600
MAX_EDIT_DURATION = 1800
MAX_SEGMENTS = 100
MIN_SEGMENT_DURATION = .04
EDIT_FPS = 30
MAX_SOURCES = 20
VIDEO_TYPES = {".mp4", ".mov", ".webm"}
RATIOS = {"16:9", "9:16", "1:1"}
RESOLUTIONS = {"720p", "1080p"}
REPO_ROOT = Path(__file__).resolve().parents[1]


class VideoEditError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _canvas_size(ratio: str, resolution: str) -> tuple[int, int]:
    if not isinstance(ratio, str) or not isinstance(resolution, str) or ratio not in RATIOS or resolution not in RESOLUTIONS:
        raise VideoEditError("invalid_settings", "请选择有效的画幅和分辨率。")
    a, b = (int(part) for part in ratio.split(":"))
    edge = int(resolution[:-1])
    width, height = (edge * a / b, edge) if a >= b else (edge, edge * b / a)
    return max(2, int(round(width / 2)) * 2), max(2, int(round(height / 2)) * 2)


def _inside(value: Any, root: Path, *, required: bool = False) -> Path:
    if not isinstance(value, (str, Path)) or not str(value).strip():
        raise VideoEditError("invalid_path", "项目文件路径缺失。")
    path = Path(value)
    path = (path if path.is_absolute() else root / path).resolve()
    if path == root or not path.is_relative_to(root):
        raise VideoEditError("invalid_path", "文件路径必须位于当前项目内。")
    if required and not path.is_file():
        raise VideoEditError("missing_file", "项目中的视频文件不存在，请重新导入。")
    return path


def validate_edit_segments(value: Any, clips: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_SEGMENTS:
        raise VideoEditError("invalid_edit_plan", "剪辑方案需要包含 1 到 100 个有效片段。")
    available = {clip["sourceId"]: clip for clip in clips}
    duration = 0.0
    segments = []
    for segment in value:
        if not isinstance(segment, dict) or set(segment) != {"sourceId", "start", "end"}:
            raise VideoEditError("invalid_edit_plan", "剪辑方案包含不支持的字段。")
        identifier, start, end = segment["sourceId"], segment["start"], segment["end"]
        if (not isinstance(identifier, str) or identifier not in available or not _valid_number(start) or not _valid_number(end)
                or not 0 <= start < end <= available[identifier]["duration"] or end - start < MIN_SEGMENT_DURATION):
            raise VideoEditError("invalid_edit_plan", "剪辑方案引用未知素材或超出视频真实时长。")
        duration += end - start
        if duration > MAX_EDIT_DURATION:
            raise VideoEditError("invalid_edit_plan", "剪辑方案总时长超过 30 分钟，请拆分任务。")
        segments.append({"sourceId": identifier, "start": float(start), "end": float(end)})
    return segments


def _normalize_request(request: Any, repo_root: Path) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise VideoEditError("invalid_request", "剪辑任务需要使用 JSON 对象。")
    requested_root = request.get("repoRoot")
    if requested_root and (not isinstance(requested_root, str) or Path(requested_root).resolve() != repo_root):
        raise VideoEditError("invalid_path", "任务不属于当前应用目录。")
    working = (repo_root / ".working_dir").resolve()
    session = _inside(request.get("sessionDir"), working)
    if not working.is_relative_to(repo_root) or not session.is_dir() or session.parent != working:
        raise VideoEditError("invalid_path", "项目工作目录无效。")
    operation = request.get("operation")
    if operation == "probe":
        path = _inside(request.get("path"), session, required=True)
        if path.suffix.lower() not in VIDEO_TYPES:
            raise VideoEditError("invalid_video", "请选择 MP4、MOV 或 WebM 视频。")
        return {"operation": operation, "session": session, "path": path}
    if operation != "render":
        raise VideoEditError("invalid_operation", "请选择读取视频信息或执行本地剪辑。")
    raw_clips = request.get("clips")
    if not isinstance(raw_clips, list) or not 1 <= len(raw_clips) <= MAX_SOURCES:
        raise VideoEditError("invalid_edit_clips", "请选择 1 到 20 个本地视频。")
    clips, identifiers = [], set()
    for item in raw_clips:
        if not isinstance(item, dict) or not isinstance(item.get("sourceId"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}", item["sourceId"]) or item["sourceId"] in identifiers:
            raise VideoEditError("invalid_edit_clips", "每个素材需包含唯一且有效的编号。")
        identifiers.add(item["sourceId"])
        path = _inside(item.get("path"), session, required=True)
        if path.suffix.lower() not in VIDEO_TYPES:
            raise VideoEditError("invalid_video", "请选择 MP4、MOV 或 WebM 视频。")
        name, description = item.get("name", ""), item.get("description", "")
        if not isinstance(name, str) or len(name) > 256 or not isinstance(description, str) or len(description) > 20_000:
            raise VideoEditError("invalid_edit_clips", "视频名称或描述格式无效。")
        clips.append({"sourceId": item["sourceId"], "path": path, "name": name, "description": description})
    settings = request.get("settings")
    if (not isinstance(settings, dict) or not isinstance(settings.get("aspectRatio"), str) or not isinstance(settings.get("resolution"), str)
            or settings["aspectRatio"] not in RATIOS or settings["resolution"] not in RESOLUTIONS):
        raise VideoEditError("invalid_settings", "请选择有效的画幅和分辨率。")
    output = _inside(request.get("outputPath"), session)
    directory = (session / "video-editor").resolve()
    if (not directory.is_relative_to(session) or output.parent.parent != directory
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}", output.parent.name)
            or output.suffix.lower() != ".mp4" or output.exists()):
        raise VideoEditError("invalid_output", "输出必须位于当前项目的独立剪辑任务目录，且不能覆盖已有文件。")
    return {"operation": operation, "session": session, "clips": clips, "segments": request.get("segments"),
            "ratio": settings["aspectRatio"], "resolution": settings["resolution"], "output": output}


def ffmpeg_executable() -> str:
    candidate = os.environ.get("FRAMEFLOW_FFMPEG") or shutil.which("ffmpeg")
    if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
        return str(Path(candidate).resolve())
    import imageio_ffmpeg
    candidate = imageio_ffmpeg.get_ffmpeg_exe()
    if Path(candidate).is_file() and os.access(candidate, os.X_OK):
        return candidate
    raise VideoEditError("ffmpeg_unavailable", "本地视频处理工具不可用，请检查项目安装。")


def _ffprobe_executable() -> str | None:
    candidates = [os.environ.get("FRAMEFLOW_FFPROBE"), shutil.which("ffprobe"),
                  "/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe",
                  str(Path(__file__).resolve().parents[1] / ".tools/ffmpeg/ffprobe")]
    return next((str(Path(item).resolve()) for item in candidates if item and Path(item).is_file() and os.access(item, os.X_OK)), None)


def _valid_number(value: Any) -> bool:
    try:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    except OverflowError:
        return False


async def _capture_probe(command: list[str]) -> tuple[int, bytes, bytes]:
    process = await asyncio.create_subprocess_exec(*command, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    async def drain(stream):
        data = bytearray()
        while chunk := await stream.read(16_384):
            data.extend(chunk)
            if len(data) > 128_000:
                raise VideoEditError("invalid_video", "视频元数据过大或无法读取。")
        return bytes(data)
    tasks = [asyncio.create_task(process.wait()), asyncio.create_task(drain(process.stdout)), asyncio.create_task(drain(process.stderr))]
    try:
        code, stdout, stderr = await asyncio.wait_for(asyncio.gather(*tasks), timeout=20)
        return code, stdout, stderr
    finally:
        if process.returncode is None:
            try:
                process.terminate()
                await asyncio.wait_for(process.wait(), timeout=.5)
            except (ProcessLookupError, asyncio.TimeoutError):
                if process.returncode is None:
                    process.kill()
                    await process.wait()
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def probe_video_metadata(path: Path | str) -> dict[str, Any]:
    """Read real local stream headers; probes terminate promptly on cancellation."""
    path = Path(path).resolve()
    if not path.is_file() or path.suffix.lower() not in VIDEO_TYPES or not 0 < path.stat().st_size <= 4 * 1024**3:
        raise VideoEditError("invalid_video", "视频素材不存在、为空、格式不受支持或超过 4 GB。")
    ffprobe = _ffprobe_executable()
    try:
        if ffprobe:
            code, stdout, _stderr = await _capture_probe([ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe",
                "-format_whitelist", "mov,matroska,webm", "-show_entries", "stream=codec_type,width,height,duration:format=duration",
                "-of", "json", str(path)])
            if code:
                raise ValueError("probe failed")
            payload = json.loads(stdout)
            streams = payload.get("streams", [])
            video = next(item for item in streams if item.get("codec_type") == "video")
            raw_duration = video.get("duration")
            if raw_duration in (None, "N/A"):
                raw_duration = payload.get("format", {}).get("duration")
            duration = float(raw_duration)
            width, height = int(video["width"]), int(video["height"])
            audio = any(item.get("codec_type") == "audio" for item in streams)
            backend = "ffprobe"
        else:
            # The bundled FFmpeg can inspect headers without a separate binary.
            _code, _stdout, stderr = await _capture_probe([ffmpeg_executable(), "-hide_banner", "-nostdin",
                "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-i", str(path)])
            from moviepy.video.io.ffmpeg_reader import FFmpegInfosParser
            info = FFmpegInfosParser(stderr.decode("utf-8", errors="replace"), str(path)).parse()
            if not info.get("video_found"):
                raise ValueError("missing video stream")
            duration = float(info["duration"])
            width, height = info["video_size"]
            audio = bool(info.get("audio_found"))
            backend = "bundled_ffmpeg"
        if not math.isfinite(duration) or not 0 < duration <= MAX_INPUT_DURATION or not 0 < width <= 8192 or not 0 < height <= 8192:
            raise ValueError("invalid metadata")
        return {"duration": duration, "width": width, "height": height, "hasAudio": audio, "backend": backend}
    except VideoEditError:
        raise
    except (OSError, ValueError, TypeError, KeyError, StopIteration, asyncio.TimeoutError):
        raise VideoEditError("invalid_video", "无法读取视频素材；每个视频需包含有效画面且不超过 60 分钟。") from None


async def _ffmpeg(command: list[str]) -> None:
    process = await asyncio.create_subprocess_exec(*command, stdin=asyncio.subprocess.DEVNULL,
                                                  stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    async def drain():
        size = 0
        while chunk := await process.stderr.read(16_384):
            size += len(chunk)
            if size > 1_000_000:
                raise VideoEditError("video_edit_failed", "视频素材返回过多编码错误，请检查素材后重试。")
    tasks = [asyncio.create_task(process.wait()), asyncio.create_task(drain())]
    try:
        # Capture bounded diagnostics without returning private paths or raw tool
        # output to the UI. ffmpeg emits only errors because -v error is used.
        await asyncio.wait_for(asyncio.gather(*tasks), timeout=600)
        if process.returncode != 0:
            raise VideoEditError("video_edit_failed", "本地剪辑编码失败，请检查视频素材后重试。")
    finally:
        if process.returncode is None:
            try:
                process.terminate()
                await asyncio.wait_for(process.wait(), timeout=.5)
            except (ProcessLookupError, asyncio.TimeoutError):
                if process.returncode is None:
                    process.kill()
                    await process.wait()
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def render_video_edit(clips: list[dict[str, Any]], segments: list[dict[str, Any]], output: Path,
                            *, ratio: str, resolution: str, emit: Callable | None = None) -> float:
    emit = emit or (lambda event: None)
    binary = ffmpeg_executable()
    width, height = _canvas_size(ratio, resolution)
    available = {clip["sourceId"]: clip for clip in clips}
    with tempfile.TemporaryDirectory(prefix=".edit-", dir=output.parent) as folder:
        directory = Path(folder)
        pieces = []
        elapsed, previous_frames = Decimal(0), 0
        for index, segment in enumerate(segments):
            clip = available[segment["sourceId"]]
            duration = segment["end"] - segment["start"]
            elapsed += Decimal(str(segment["end"])) - Decimal(str(segment["start"]))
            cumulative_frames = int((elapsed * EDIT_FPS).to_integral_value(rounding=ROUND_CEILING))
            frames = cumulative_frames - previous_frames
            previous_frames = cumulative_frames
            output_duration = frames / EDIT_FPS
            piece = directory / f"segment-{index:04d}.mp4"
            command = [binary, "-hide_banner", "-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file,pipe",
                       "-format_whitelist", "mov,matroska,webm", "-ss", f'{segment["start"]:.6f}', "-i", str(clip["path"])]
            if not clip["hasAudio"]:
                command += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
            # EOF frame timestamps can otherwise shorten a 0.25s crop by one
            # frame. Resample first, pad the tail and assign frames cumulatively so
            # rounding cannot accumulate once per segment. 30fps also keeps
            # every allowed 0.04s segment visible for at least one frame.
            video = f"[0:v:0]setpts=PTS-STARTPTS,fps={EDIT_FPS},trim=duration={duration:.6f},tpad=stop_mode=clone:stop_duration=0.1,trim=end_frame={frames},setpts=N/({EDIT_FPS}*TB),scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v]"
            audio_stream = "0:a:0" if clip["hasAudio"] else "1:a:0"
            audio = f"[{audio_stream}]atrim=duration={duration:.6f},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration={output_duration:.9f}[a]"
            command += ["-filter_complex", video + ";" + audio, "-map", "[v]", "-map", "[a]", "-t", f"{output_duration:.9f}", "-frames:v", str(frames), "-r", str(EDIT_FPS), "-fps_mode", "cfr",
                        "-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", str(piece)]
            await _ffmpeg(command)
            pieces.append((piece, output_duration))
            emit({"type": "progress", "message": "正在本地裁切与标准化音轨", "progress": 25 + 60 * (index + 1) / len(segments)})
        concat = directory / "concat.txt"
        concat.write_text("ffconcat version 1.0\n" + "".join("file '" + piece.as_posix().replace("'", "'\\''") + f"'\nduration {duration:.9f}\n" for piece, duration in pieces), encoding="utf-8")
        final_duration = previous_frames / EDIT_FPS
        # Preserve the zero-based video timestamps instead of shifting them by
        # AAC encoder priming, which otherwise adds roughly 21ms to the movie.
        await _ffmpeg([binary, "-hide_banner", "-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file,pipe", "-copyts", "-f", "concat", "-safe", "0", "-i", str(concat),
                       "-t", f"{final_duration:.9f}", "-c:v", "copy", "-af", f"apad,atrim=duration={final_duration:.9f}", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", str(output)])
        emit({"type": "progress", "message": "正在验证剪辑成片", "progress": 95})
        metadata = await probe_video_metadata(output)
        if abs(metadata["duration"] - final_duration) > 1 / EDIT_FPS:
            raise VideoEditError("video_edit_failed", "成片时长与确认方案不符，请检查视频素材后重试。")
        return metadata["duration"]


def _source_identity(path: Path) -> tuple[int, int, int, int, int]:
    try:
        info = path.stat()
        return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns
    except OSError:
        raise VideoEditError("source_changed", "处理期间原视频发生变化，请重新导入后重试。") from None


async def run_video_editor_request(request: Any, *, repo_root: Path | str = REPO_ROOT,
                                   emit: Callable | None = None, metadata_probe=None, renderer=None) -> dict[str, Any]:
    """Execute validated local operations without Agent or API dependencies."""
    emit = emit or (lambda event: None)
    job = _normalize_request(request, Path(repo_root).resolve())
    probe = metadata_probe or probe_video_metadata
    if job["operation"] == "probe":
        before = _source_identity(job["path"])
        metadata = await probe(job["path"])
        if before != _source_identity(job["path"]):
            raise VideoEditError("source_changed", "读取期间原视频发生变化，请重新导入后重试。")
        return {"type": "result", "operation": "probe", **{key: metadata[key] for key in ("duration", "width", "height", "hasAudio")}}
    for index, clip in enumerate(job["clips"]):
        clip["sourceIdentity"] = _source_identity(clip["path"])
        metadata = await probe(clip["path"])
        clip.update(duration=metadata["duration"], hasAudio=metadata["hasAudio"])
        if clip["sourceIdentity"] != _source_identity(clip["path"]):
            raise VideoEditError("source_changed", "读取期间原视频发生变化，请重新导入后重试。")
        emit({"type": "progress", "message": "正在验证素材真实时长", "progress": 5 + 10 * (index + 1) / len(job["clips"])})
    segments = validate_edit_segments(job["segments"], job["clips"])
    def verify_sources():
        if any(clip["sourceIdentity"] != _source_identity(clip["path"]) for clip in job["clips"]):
            raise VideoEditError("source_changed", "剪辑期间原视频发生变化，请重新导入后重试。")
    output = job["output"]
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.parent.resolve() != output.parent or not output.parent.resolve().is_relative_to(job["session"]):
        raise VideoEditError("invalid_path", "项目输出目录无效。")
    handle, temporary = tempfile.mkstemp(prefix=".video-editor-", suffix=".mp4", dir=output.parent)
    os.close(handle)
    temporary = Path(temporary)
    committed = False
    try:
        verify_sources()
        duration = await (renderer or render_video_edit)(job["clips"], segments, temporary,
            ratio=job["ratio"], resolution=job["resolution"], emit=emit)
        verify_sources()
        if not temporary.is_file() or temporary.stat().st_size == 0 or not _valid_number(duration) or not 0 < duration <= MAX_EDIT_DURATION + 5:
            raise VideoEditError("invalid_video", "剪辑结果为空或无法读取，请重试。")
        try:
            os.link(temporary, output)
        except FileExistsError:
            raise VideoEditError("invalid_output", "输出文件已存在，请创建新的剪辑任务。") from None
        committed = True
        verify_sources()
        emit({"type": "progress", "message": "剪辑成片已保存", "progress": 100})
        return {"type": "result", "operation": "render", "path": str(output), "duration": float(duration), "segments": segments}
    except BaseException:
        if committed:
            output.unlink(missing_ok=True)
        raise
    finally:
        temporary.unlink(missing_ok=True)

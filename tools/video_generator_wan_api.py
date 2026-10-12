"""Wan 2.6 Flash first-frame video generation via the DashScope HTTP API.

Protocol: https://help.aliyun.com/zh/model-studio/legacy-image-to-video-api-reference/
Creates exactly one paid task per call; polling/download never resubmit it.
"""

import asyncio
import base64
import io
import math
import os
import re
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import aiohttp
from PIL import Image, UnidentifiedImageError

from interfaces.video_output import VideoOutput


MODEL = "wan2.6-i2v-flash"
DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/api/v1"
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_VIDEO_BYTES = 512 * 1024 * 1024
_IMAGE_MIME = {"JPEG": "image/jpeg", "PNG": "image/png", "BMP": "image/bmp", "WEBP": "image/webp"}


class WanVideoError(RuntimeError):
    """A user-readable error containing no raw provider response or secrets."""


class WanVideoValidationError(WanVideoError, ValueError):
    """Validation that fails before any paid request is submitted."""


def _seconds(name: str, default: float, *, zero_allowed: bool = False) -> float:
    try:
        value = float(os.environ.get(name, default))
        if math.isfinite(value) and (value >= 0 if zero_allowed else value > 0):
            return value
    except (ValueError, TypeError):
        pass
    return default


def _base_url(value: str) -> str:
    try:
        parsed = urlsplit(value.strip())
        valid = (parsed.scheme == "https" and parsed.hostname and not parsed.username
                 and not parsed.password and not parsed.query and not parsed.fragment
                 and parsed.path.rstrip("/") in {"", "/api/v1"})
        # Accessing port also validates malformed port strings.
        parsed.port
    except (ValueError, AttributeError):
        valid = False
    if not valid:
        raise WanVideoValidationError("万相服务地址需为 HTTPS 域名或以 /api/v1 结尾的百炼地址。")
    return urlunsplit((parsed.scheme, parsed.netloc, "/api/v1", "", ""))


def _duration(value) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not float(value).is_integer() or not 2 <= value <= 15:
        raise WanVideoValidationError("万相 2.6 Flash 视频时长需为 2–15 秒的整数。")
    return int(value)


def _resolution(value) -> str:
    if not isinstance(value, str) or value.upper() not in {"720P", "1080P"}:
        raise WanVideoValidationError("万相 2.6 Flash 仅支持 720p 或 1080p，请选择后重试。")
    return value.upper()


def _first_frame(paths) -> str:
    if not isinstance(paths, (list, tuple)) or not paths:
        raise WanVideoValidationError("万相 2.6 Flash 需要一张首帧图片，请先添加首帧；不支持纯文本生成视频。")
    if len(paths) != 1:
        raise WanVideoValidationError("万相 2.6 Flash 只支持一张首帧图片，不支持尾帧；请移除尾帧后重试。")
    try:
        path = Path(paths[0])
        with path.open("rb") as stream:
            raw = stream.read(MAX_IMAGE_BYTES + 1)
    except (OSError, TypeError, ValueError):
        raise WanVideoValidationError("无法读取首帧图片，请重新选择本地图片。") from None
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise WanVideoValidationError("万相首帧图片不能为空，文件大小不能超过 20 MB。")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            mime = _IMAGE_MIME.get(image.format)
            if not mime or getattr(image, "is_animated", False):
                raise WanVideoValidationError("万相首帧仅支持静态 JPG、PNG、BMP 或 WebP 图片。")
            width, height = image.size
            if not (240 <= width <= 8000 and 240 <= height <= 8000):
                raise WanVideoValidationError("万相首帧图片的宽和高均需为 240–8000 像素。")
            if "A" in image.getbands() or "transparency" in image.info:
                raise WanVideoValidationError("万相首帧不支持透明通道，请先导出为不透明的 JPG 或 PNG。")
            image.verify()
    except WanVideoValidationError:
        raise
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, ValueError, SyntaxError):
        raise WanVideoValidationError("首帧图片无法解析，请重新导出为 JPG 或 PNG。") from None
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def _emit(progress, stage: str, message: str, metadata=None):
    if progress is not None:
        progress(stage, message, metadata or {})


def _provider_error(status: int, payload: dict, stage: str) -> WanVideoError:
    code = payload.get("code")
    output = payload.get("output")
    if isinstance(output, dict):
        code = output.get("code") or code
    if status in {401, 403} or code in {"InvalidApiKey", "InvalidAccessKeyId", "AccessDenied", "Forbidden"}:
        message = "万相鉴权失败，请检查百炼 API Key、模型权限与服务地域是否一致。"
    elif code in {"Arrearage", "InsufficientBalance", "QuotaExhausted", "QuotaExceeded"}:
        message = "万相额度不足，请在百炼控制台检查免费额度和账户余额。"
    elif status == 429 or str(code).startswith("Throttling"):
        message = "万相请求过于频繁，请稍后检查任务状态。"
    elif code in {"DataInspectionFailed", "InputDataInspectionFailed", "OutputDataInspectionFailed", "IPInfringementSuspect"}:
        message = "万相内容审核未通过，请调整首帧图片或画面描述。"
    elif status == 400 or code in {"InvalidParameter", "InvalidParameterValue", "InvalidInput"}:
        message = "万相请求参数未被接受，请检查首帧格式、画幅、时长和分辨率。"
    else:
        message = f"万相{stage}失败，请在百炼控制台检查任务详情。"
    return WanVideoError(message + " 本次不会自动重新提交生成任务。")


async def _json_request(session, method: str, url: str, *, headers, timeout: float, payload=None):
    # Never redirect an authenticated API request, even to another configured host.
    async with session.request(method, url, headers=headers, json=payload,
                               allow_redirects=False, timeout=aiohttp.ClientTimeout(total=timeout)) as response:
        try:
            body = await response.json(content_type=None)
        except (ValueError, aiohttp.ContentTypeError):
            raise WanVideoError("万相返回了无法解析的响应，请在百炼控制台检查任务；本次不会自动重复提交。") from None
        if not isinstance(body, dict):
            raise WanVideoError("万相返回格式无效，请在百炼控制台检查任务；本次不会自动重复提交。")
        if not 200 <= response.status < 300 or body.get("code"):
            raise _provider_error(response.status, body, "请求")
        return body


async def _download(url: str, timeout: float) -> bytes:
    try:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError
    except (ValueError, TypeError):
        raise WanVideoError("万相返回的视频地址无效，请在百炼控制台查看并下载结果。") from None
    # Separate session, with no default headers/cookies: API keys never reach output URLs.
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout),
                                    cookie_jar=aiohttp.DummyCookieJar()) as session:
        async with session.get(url, allow_redirects=False) as response:
            if response.status != 200:
                raise WanVideoError("视频已生成，但下载失败，请在百炼控制台下载结果（链接通常保留 24 小时），避免重复生成。")
            if response.content_length is not None and response.content_length > MAX_VIDEO_BYTES:
                raise WanVideoError("生成视频文件过大，请在百炼控制台下载结果。")
            data = bytearray()
            async for chunk in response.content.iter_chunked(1024 * 1024):
                data.extend(chunk)
                if len(data) > MAX_VIDEO_BYTES:
                    raise WanVideoError("生成视频文件过大，请在百炼控制台下载结果。")
            if not data:
                raise WanVideoError("万相返回的视频文件为空，请在百炼控制台查看结果。")
            return bytes(data)


class VideoGeneratorWanAPI:
    supports_last_frame = False

    def __init__(self, api_key: str, model: str = MODEL, base_url: str = DEFAULT_BASE_URL,
                 duration: int = 5, resolution: str = "720p", audio: bool = False):
        if model != MODEL:
            raise WanVideoValidationError("当前万相接入仅支持 wan2.6-i2v-flash，请选择该模型；不会自动更换模型。")
        if not isinstance(api_key, str) or not api_key.strip() or any(ch in api_key for ch in "\r\n"):
            raise WanVideoValidationError("请先在设置中填写有效的百炼 API Key。")
        if not isinstance(audio, bool):
            raise WanVideoValidationError("万相音频选项必须为 true 或 false。")
        self.api_key = api_key.strip()
        self.model = model
        self.base_url = _base_url(base_url)
        self.duration = _duration(duration)
        self.resolution = _resolution(resolution)
        self.audio = audio

    async def generate_single_video(self, prompt: str = "", reference_image_paths=None,
                                    aspect_ratio: str = "16:9", duration=None,
                                    resolution=None, progress=None, **kwargs) -> VideoOutput:
        if not isinstance(prompt, str) or len(prompt) > 1500:
            raise WanVideoValidationError("万相画面描述需为不超过 1500 字的文本。")
        seconds = _duration(self.duration if duration is None else duration)
        size = _resolution(self.resolution if resolution is None else resolution)
        # Wan follows the first-frame ratio; the shared aspect_ratio argument only
        # controls export elsewhere and is deliberately not sent or used to crop.
        frame = _first_frame(reference_image_paths)
        payload = {"model": self.model, "input": {"prompt": prompt, "img_url": frame},
                   "parameters": {"duration": seconds, "resolution": size, "audio": self.audio,
                                  "prompt_extend": False, "shot_type": "single"}}
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json",
                   "X-DashScope-Async": "enable"}
        request_timeout = _seconds("VIMAX_VIDEO_REQUEST_TIMEOUT_SECONDS", 60)
        query_timeout = _seconds("VIMAX_VIDEO_QUERY_TIMEOUT_SECONDS", 900)
        interval = _seconds("VIMAX_VIDEO_POLL_INTERVAL_SECONDS", 15, zero_allowed=True)
        metadata = {"model": self.model, "duration": seconds, "resolution": size.lower(), "audio": self.audio}
        stage = "提交"
        task_id = None
        try:
            async with aiohttp.ClientSession(cookie_jar=aiohttp.DummyCookieJar()) as session:
                _emit(progress, "video_create", "正在提交万相视频任务", metadata)
                # Do not retry: a timeout may mean the provider already accepted a paid job.
                body = await _json_request(session, "POST", f"{self.base_url}/services/aigc/video-generation/video-synthesis",
                                           headers=headers, timeout=request_timeout, payload=payload)
                output = body.get("output")
                task_id = output.get("task_id") if isinstance(output, dict) else None
                if not isinstance(task_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", task_id):
                    raise WanVideoError("万相未返回有效任务编号，请先在百炼控制台检查是否已创建任务，避免重复生成。")
                metadata = {**metadata, "task_id": task_id}
                _emit(progress, "video_task_created", "万相视频任务已提交", metadata)
                deadline = asyncio.get_running_loop().time() + query_timeout
                stage = "查询"
                while True:
                    status = output.get("task_status")
                    if status == "SUCCEEDED":
                        stage = "下载"
                        _emit(progress, "video_download_start", "正在下载万相视频结果", metadata)
                        data = await _download(output.get("video_url"), request_timeout)
                        _emit(progress, "video_completed", "万相视频已下载", metadata)
                        return VideoOutput(fmt="bytes", ext="mp4", data=data)
                    if status == "FAILED":
                        raise _provider_error(200, {"output": output}, "生成")
                    if status in {"CANCELED", "CANCELLED"}:
                        raise WanVideoError("万相视频任务已被取消。")
                    if status == "UNKNOWN":
                        raise WanVideoError("万相任务不存在或已过期，请在百炼控制台检查任务。")
                    if status not in {"PENDING", "RUNNING"}:
                        raise WanVideoError("万相任务状态无法识别，请在百炼控制台检查；本次不会自动重复提交。")
                    _emit(progress, "video_status", "万相任务排队中" if status == "PENDING" else "万相正在生成视频", {**metadata, "status": status})
                    remaining = deadline - asyncio.get_running_loop().time()
                    if remaining <= 0:
                        raise asyncio.TimeoutError
                    await asyncio.sleep(min(interval, remaining))
                    remaining = deadline - asyncio.get_running_loop().time()
                    if remaining <= 0:
                        raise asyncio.TimeoutError
                    body = await _json_request(session, "GET", f"{self.base_url}/tasks/{task_id}",
                                               headers={"Authorization": headers["Authorization"]},
                                               timeout=min(request_timeout, remaining))
                    output = body.get("output")
                    if not isinstance(output, dict):
                        raise WanVideoError("万相任务响应不完整，请在百炼控制台检查任务。")
        except asyncio.CancelledError:
            # Stop local polling immediately. A submitted cloud job may still run and bill.
            _emit(progress, "video_cancelled", "已停止本地等待；已提交的万相任务仍可能运行，请在百炼控制台查看。", metadata)
            raise
        except (asyncio.TimeoutError, aiohttp.ClientError, OSError):
            if stage == "提交":
                message = "万相提交超时或连接中断，任务可能已创建。请先在百炼控制台检查，本次不会自动重复提交。"
            elif stage == "下载":
                message = "视频已生成，但下载超时或连接中断。请在百炼控制台下载结果，避免重复生成。"
            else:
                message = "万相任务查询超时或连接中断，云端任务可能仍在运行。请在百炼控制台查看，本次不会自动重复提交。"
            raise WanVideoError(message) from None

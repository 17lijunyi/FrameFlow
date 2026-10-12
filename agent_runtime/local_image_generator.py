"""Image generation through the tools already configured in a local Agent."""
from __future__ import annotations

import asyncio
import base64
import binascii
from io import BytesIO
import json
import os
from pathlib import Path
import shutil
from typing import Any

from PIL import Image

from interfaces.image_output import ImageOutput
from .errors import RuntimeConfigurationError
from .local_executors import (
    MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TEXT_BYTES, MAX_TOTAL_IMAGE_BYTES,
    RoleExecutors, _read_output, _stop_process_group, _with_sync_cancellation,
)

IMAGE_EXECUTOR_TIMEOUT_SECONDS = 300.0
MAX_IMAGE_WORKER_OUTPUT_BYTES = 12 * 1024 * 1024
MAX_OUTPUT_PIXELS = 64_000_000
_MIME = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp", "GIF": "image/gif"}


def _reference_images(paths: list[str | Path]) -> list[dict[str, str]]:
    if len(paths) > MAX_IMAGES:
        raise RuntimeConfigurationError("executor_image_limit", "参考图数量超过限制。请减少参考图后重试。")
    images = []
    total = 0
    for raw_path in paths:
        try:
            path = Path(raw_path)
            if not path.is_file() or path.stat().st_size > MAX_IMAGE_BYTES:
                raise ValueError("invalid reference")
            with path.open("rb") as stream:
                data = stream.read(MAX_IMAGE_BYTES + 1)
            total += len(data)
            if not data or len(data) > MAX_IMAGE_BYTES or total > MAX_TOTAL_IMAGE_BYTES:
                raise ValueError("oversized reference")
            with Image.open(BytesIO(data)) as image:
                mime = _MIME.get(image.format)
                if mime is None:
                    raise ValueError("invalid format")
                image.verify()
        except (OSError, ValueError, TypeError, Image.DecompressionBombError) as exc:
            raise RuntimeConfigurationError("invalid_executor_image", "参考图无法读取或超过大小限制。请使用 PNG、JPEG、WebP 或 GIF，并缩小图片后重试。") from exc
        images.append({"mimeType": mime, "data": base64.b64encode(data).decode("ascii")})
    return images


def _decode_image(payload: Any) -> ImageOutput:
    try:
        if not isinstance(payload, dict) or payload.get("mimeType") not in _MIME.values():
            raise ValueError("missing image")
        encoded = payload.get("data")
        if not isinstance(encoded, str) or not encoded or len(encoded) > MAX_IMAGE_BYTES * 4 // 3 + 8:
            raise ValueError("invalid image data")
        data = base64.b64decode(encoded, validate=True)
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise ValueError("oversized image")
        with Image.open(BytesIO(data)) as image:
            if _MIME.get(image.format) != payload["mimeType"] or image.width * image.height > MAX_OUTPUT_PIXELS:
                raise ValueError("invalid image")
            image.load()
            output = image.convert("RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB")
    except (OSError, ValueError, TypeError, binascii.Error, Image.DecompressionBombError) as exc:
        raise RuntimeConfigurationError("executor_invalid_image", "本地 Agent 未返回可读取的图片文件。请检查生图工具配置；文字或链接不能作为生图结果。") from exc
    return ImageOutput(fmt="pil", ext="png", data=output)


class LocalAgentImageGenerator:
    def __init__(self, workspace_root: str | Path = ".") -> None:
        self.root = Path(workspace_root).resolve()

    async def generate_single_image(
        self, prompt: str, reference_image_paths: list[str | Path] | None = None,
        size: str | list[int] | tuple[int, int] | None = None, aspect_ratio: str | None = None, **kwargs: Any,
    ) -> ImageOutput:
        entry = RoleExecutors(self.root).preflight_image()
        if entry["kind"] != "cli":
            raise RuntimeConfigurationError("executor_role_mismatch", "当前图像执行者不是本地 Agent。请重新启动生成任务。")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode("utf-8")) > MAX_TEXT_BYTES:
            raise RuntimeConfigurationError("executor_prompt_limit", "本次生图文本为空或超过输入限制。请调整提示词后重试。")
        references = _reference_images(list(reference_image_paths or []))
        node = os.environ.get("FRAMEFLOW_NODE_PATH") or shutil.which("node")
        worker = self.root / "web" / "local-agent-image-worker.mjs"
        if not node or not worker.is_file():
            raise RuntimeConfigurationError("executor_runtime_unavailable", "本地生图运行环境不可用。请重启应用并检查 Node.js 安装。")
        request = {"agentId": entry["agentId"], "executablePath": entry["executablePath"],
                   "prompt": prompt, "referenceImages": references}
        if isinstance(entry.get("version"), str) and entry["version"]:
            request["expectedVersion"] = entry["version"]
        if size is not None:
            request["size"] = size
        if aspect_ratio is not None:
            request["aspectRatio"] = aspect_ratio
        process = None
        readers: list[asyncio.Task] = []
        try:
            process = await asyncio.create_subprocess_exec(
                str(node), str(worker), cwd=str(self.root), stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True,
            )
            readers = [asyncio.create_task(_read_output(process.stdout, retain=True, max_bytes=MAX_IMAGE_WORKER_OUTPUT_BYTES)),
                       asyncio.create_task(_read_output(process.stderr, retain=False))]

            async def exchange():
                process.stdin.write(json.dumps(request, ensure_ascii=False).encode("utf-8"))
                await process.stdin.drain()
                process.stdin.close()
                output, _ = await asyncio.gather(*readers)
                await process.wait()
                return output

            output = await _with_sync_cancellation(asyncio.wait_for(exchange(), IMAGE_EXECUTOR_TIMEOUT_SECONDS))
            try:
                response = json.loads(output)
            except (ValueError, UnicodeError) as exc:
                raise RuntimeConfigurationError("executor_invalid_image", "本地 Agent 未返回有效的图片结果。请检查生图工具配置后重试。") from exc
            if not isinstance(response, dict):
                raise RuntimeConfigurationError("executor_invalid_image", "本地 Agent 返回的图片结果格式无效。")
            if response.get("error") or process.returncode != 0:
                error = response.get("error")
                code = error.get("code") if isinstance(error, dict) else None
                messages = {
                    "executor_changed": "本地 Agent 版本或安装位置已改变。请前往设置重新扫描并确认生图工具。",
                    "local_agent_not_authenticated": "本地 Agent 尚未完成认证。请在对应 CLI 中登录后重试。",
                    "local_agent_identity_mismatch": "无法确认所选 CLI 身份。请前往设置重新扫描。",
                    "local_agent_interface_unavailable": "当前 CLI 版本缺少生图调用接口。请升级后重新扫描。",
                    "local_agent_timeout": "本地 Agent 生图超时。请检查工具服务后重试。",
                    "local_agent_output_limit": "本地 Agent 生图响应超过大小限制。请缩小图片后重试。",
                    "local_agent_image_missing": "本地 Agent 未生成图片文件。请确认已配置可用的生图工具。",
                    "invalid_local_agent_image_result": "本地 Agent 未返回有效图片。请检查生图工具配置。",
                }
                safe_code = code if isinstance(code, str) and code in messages else "executor_image_failed"
                raise RuntimeConfigurationError(safe_code, messages.get(safe_code, "本地 Agent 生图失败。请检查登录、生图工具和服务配置后重试。"))
            return _decode_image(response.get("image"))
        except asyncio.TimeoutError as exc:
            raise RuntimeConfigurationError("executor_timeout", "本地 Agent 生图超时。请检查生图工具服务后重试。") from exc
        except OSError as exc:
            raise RuntimeConfigurationError("executor_runtime_unavailable", "无法启动本地生图 Agent。请检查安装和连接状态。") from exc
        finally:
            if process is not None:
                await asyncio.shield(_stop_process_group(process))
            for reader in readers:
                if not reader.done():
                    reader.cancel()
            if readers:
                await asyncio.gather(*readers, return_exceptions=True)

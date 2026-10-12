"""JSONL subprocess entry point for paid render and offline export jobs."""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import io
import json
import sys
from pathlib import Path


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="FrameFlow 导演台视频任务")
    parser.add_argument("--request", help="Node 创建的 JSON 任务文件")
    parser.add_argument("--capabilities", action="store_true", help="只读查询当前视频接口能力")
    parser.add_argument("--config", help="查询能力时使用的应用配置路径")
    return parser.parse_args(argv)


async def amain(argv=None) -> int:
    args = parse_args(argv)
    stream = sys.stdout
    DirectorError = None
    def emit(event):
        print(json.dumps(event, ensure_ascii=False), file=stream, flush=True)
    try:
        from agent_runtime.director_runtime import DirectorError, capabilities_from_config_path, run_director_request
        if args.capabilities:
            emit(capabilities_from_config_path(args.config))
            return 0
        if not args.request:
            raise DirectorError("invalid_request", "缺少导演任务文件。")
        path = Path(args.request)
        try:
            if path.stat().st_size > 1_000_000:
                raise DirectorError("invalid_request", "导演任务内容过大。")
            request = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise DirectorError("invalid_request", "导演任务文件无法读取或格式有误。") from None
        # Provider and encoding libraries must not interleave stdout protocol or
        # expose upstream HTTP/config errors through stderr.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = await run_director_request(request, emit=emit)
        emit(result)
        return 0
    except Exception as exc:
        safe = DirectorError is not None and isinstance(exc, DirectorError)
        message = str(exc) if safe else "导演任务无法运行，请检查本地运行环境后重试。"
        event = {"type": "error", "code": exc.code if safe else "director_runtime_failed", "message": message}
        if safe and exc.action == "open_settings":
            event["action"] = "open_settings"
        emit(event)
        return 1


def main():
    try:
        raise SystemExit(asyncio.run(amain()))
    except KeyboardInterrupt:
        raise SystemExit(130)


if __name__ == "__main__":
    main()

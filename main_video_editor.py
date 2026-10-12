"""JSONL driver for the independent, local-only video editor."""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import io
import json
from pathlib import Path
import signal
import sys


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="FrameFlow 独立视频剪辑工具")
    parser.add_argument("--request", required=True, help="Node 创建的本地 JSON 任务文件")
    return parser.parse_args(argv)


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate field")
        value[key] = item
    return value


async def amain(argv=None) -> int:
    args = parse_args(argv)
    loop = asyncio.get_running_loop()
    running = asyncio.current_task()
    try:
        loop.add_signal_handler(signal.SIGTERM, running.cancel)
    except (NotImplementedError, RuntimeError):
        pass
    stream = sys.stdout
    def emit(event):
        print(json.dumps(event, ensure_ascii=False, allow_nan=False), file=stream, flush=True)
    from agent_runtime.video_edit import VideoEditError, run_video_editor_request
    try:
        path = Path(args.request)
        try:
            if path.stat().st_size > 1_000_000:
                raise ValueError("request too large")
            request = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_unique_object,
                parse_constant=lambda value: (_ for _ in ()).throw(ValueError("non-finite number")))
        except (OSError, UnicodeError, ValueError):
            raise VideoEditError("invalid_request", "剪辑任务文件无法读取、过大或格式有误。") from None
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = await run_video_editor_request(request, emit=emit)
        emit(result)
        return 0
    except asyncio.CancelledError:
        emit({"type": "error", "code": "cancelled", "message": "剪辑任务已取消。"})
        return 130
    except Exception as exc:
        safe = isinstance(exc, VideoEditError)
        emit({"type": "error", "code": exc.code if safe else "video_edit_failed",
              "message": str(exc) if safe else "本地视频处理失败，请检查素材和运行环境后重试。"})
        return 1
    finally:
        try:
            loop.remove_signal_handler(signal.SIGTERM)
        except (NotImplementedError, RuntimeError):
            pass


def main():
    try:
        raise SystemExit(asyncio.run(amain()))
    except (KeyboardInterrupt, asyncio.CancelledError):
        raise SystemExit(130)


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
import asyncio
import json
import re
import signal
import sys
from typing import Any, Iterable
from uuid import uuid4
from agent_runtime.errors import RuntimeConfigurationError

ORIGINAL_STDOUT = sys.stdout


def event_stdout():
    if sys.stdout.__class__.__name__ == "_DiscardStream":
        return ORIGINAL_STDOUT
    return sys.stdout


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="运行 FrameFlow 创作助手。")
    parser.add_argument("--session", default="", help="启动前启用指定的已有项目。")
    parser.add_argument("--new-session", action="store_true", help="启动前创建并启用新的空白项目。")
    parser.add_argument("--new-session-name", default="", help="新建项目的显示名称。")
    parser.add_argument("--jsonl", action="store_true", help="每行输出一个 JSON 事件。")
    parser.add_argument("--once", default="", help="执行一条提示后退出。省略此参数且标准输入不是终端时，将标准输入作为一条提示。")
    parser.add_argument("--stdin-repl", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def load_runtime():
    from agent_runtime import build_runtime

    return build_runtime(".")


def load_session_index():
    from agent_runtime.session_index import SessionIndex

    return SessionIndex(".")


def stage_label(stage: str | None) -> str:
    return {
        "created": "已创建", "narrative_planning": "正在规划文本", "narrative_planned": "文本规划完成",
        "novel_planning": "正在改编小说", "novel_planned": "小说改编完成", "rendering": "正在生成视频",
        "rendered": "视频生成完成", "running": "运行中", "completed": "已完成", "failed": "失败",
        "compact": "正在压缩上下文", "sampling_assistant": "正在思考", "executing_tools": "正在运行工具",
    }.get(stage or "", "处理中")


def print_event(event: dict[str, Any], *, jsonl: bool) -> None:
    out = event_stdout()
    if jsonl:
        print(json.dumps(event, ensure_ascii=False, default=str), file=out, flush=True)
        return
    event_type = event.get("type")
    if event_type == "turn":
        print(f"· 创作轮次：{event.get('turn_id', '')}", file=out, flush=True)
    elif event_type == "token":
        print(event.get("delta", ""), end="", file=out, flush=True)
    elif event_type == "tool_start":
        tool = event.get("tool", {})
        print(f"\n· 工具 {tool.get('name')} 已开始", file=out, flush=True)
    elif event_type == "tool_progress":
        progress = event.get("progress", {})
        tool = event.get("tool", {})
        print(f"· 工具 {tool.get('name')} {stage_label(progress.get('stage', 'running'))}：{progress.get('message', '')}", file=out, flush=True)
    elif event_type == "tool_result":
        result = event["tool_result"]
        status = "已完成" if result.get("ok") else "出错"
        print(f"· 工具 {result.get('name')} {status}", file=out, flush=True)
    elif event_type == "terminal":
        stream = event.get("stream", "stdout")
        print(f"· 终端[{stream}]：{event.get('line', '')}", file=out, flush=True)
    elif event_type == "status":
        print(f"· 状态：{stage_label(event.get('phase'))}：{event.get('message', '')}", file=out, flush=True)
    elif event_type == "session":
        session = (event.get("session") or {}).get("session") or {}
        if session:
            print(f"· 项目：{session.get('session_id')} {stage_label(session.get('stage', ''))}", file=out, flush=True)
    elif event_type == "done":
        print("", file=out, flush=True)
    elif event_type == "error":
        print(f"\n错误：{event.get('message', '')}", file=out, flush=True)


def prompt_inputs(args: argparse.Namespace) -> Iterable[str]:
    if args.once:
        yield args.once
        return
    if args.stdin_repl:
        for line in sys.stdin:
            user_input = line.strip()
            if user_input:
                yield user_input
        return
    if not sys.stdin.isatty():
        payload = sys.stdin.read().strip()
        if payload:
            yield payload
        return
    while True:
        try:
            user_input = input("› " if not args.jsonl else "")
        except EOFError:
            break
        if user_input.strip():
            yield user_input.strip()


def startup_error(message: str, *, jsonl: bool, code: str = "runtime_startup_failed", action: str | None = None) -> None:
    event: dict[str, Any] = {"type": "error", "phase": "startup", "code": code, "message": message}
    if action:
        event["action"] = action
    if jsonl:
        print_event(event, jsonl=True)
    else:
        print(f"错误：{message}", file=sys.stderr, flush=True)


async def amain(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.session and args.new_session:
        startup_error("--session 和 --new-session 不能同时使用", jsonl=args.jsonl, code="invalid_session")
        return 2
    if args.new_session_name and not args.new_session:
        startup_error("--new-session-name 需要配合 --new-session 使用", jsonl=args.jsonl, code="invalid_session")
        return 2
    if args.session or args.new_session:
        try:
            session_index = load_session_index()
            if args.new_session:
                if args.new_session_name:
                    session_index.create(project_name=args.new_session_name)
                else:
                    session_index.create()
            else:
                session_index.set_active(args.session)
        except KeyError:
            startup_error("项目标识不存在，请重新选择项目。", jsonl=args.jsonl, code="invalid_session")
            return 2
        except ValueError:
            startup_error("项目标识无效，请重新选择项目。", jsonl=args.jsonl, code="invalid_session")
            return 2
        except Exception as exc:
            startup_error(f"无法打开项目（{type(exc).__name__}）。请检查项目文件和目录权限后重试。", jsonl=args.jsonl)
            return 1
    try:
        runtime = load_runtime()
    except Exception as exc:
        code = getattr(exc, "code", "")
        if isinstance(exc, RuntimeConfigurationError):
            startup_error(str(exc), jsonl=args.jsonl, code=code, action="open_settings")
        else:
            startup_error(f"创作助手启动失败（{type(exc).__name__}）。请重启应用；如果问题持续，请检查本地运行环境。", jsonl=args.jsonl)
        return 1
    if args.jsonl and args.stdin_repl:
        print_event({"type": "ready"}, jsonl=True)
    interactive = sys.stdin.isatty() and not args.once
    if interactive and not args.jsonl:
        print("FrameFlow 创作助手已就绪。按 Ctrl+C 退出。")
    for user_input in prompt_inputs(args):
        turn_id = ""
        try:
            if user_input.strip() == "/compact":
                turn_id = f"turn-{uuid4().hex[:12]}"
                print_event({"type": "turn", "turn_id": turn_id, "turn": {"id": turn_id}}, jsonl=args.jsonl)
                print_event({"type": "status", "turn_id": turn_id, "phase": "compact", "message": "正在压缩上下文"}, jsonl=args.jsonl)
                message = await runtime.compact_history(reason="manual")
                print_event({"type": "token", "turn_id": turn_id, "delta": message}, jsonl=args.jsonl)
                print_event({"type": "done", "turn_id": turn_id, "assistant": message, "tool_results": []}, jsonl=args.jsonl)
                print_event({"type": "session", "turn_id": turn_id, "session": runtime.session_index.snapshot()}, jsonl=args.jsonl)
                continue
            async for event in runtime.stream_events(user_input):
                if event.get("turn_id"):
                    turn_id = str(event["turn_id"])
                print_event(event, jsonl=args.jsonl)
        except Exception as exc:
            # Keep the REPL alive: one failed turn must not kill the process
            # (and with it the TUI driving us over stdio).
            from agent_runtime.loop import record_runtime_diagnostic

            turn_id = turn_id or f"turn-{uuid4().hex[:12]}"
            message = "本轮创作失败。请稍后重试；如果问题持续，请检查项目文件和本地运行环境。"
            metadata = {"error_type": "runtime_turn_failed", "code": "runtime_turn_failed"}
            if isinstance(exc, RuntimeConfigurationError):
                message = f"本轮创作失败：{exc}"
                code = exc.code if isinstance(exc.code, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,79}", exc.code) else "runtime_configuration_error"
                metadata.update(code=code, action="open_settings")
            record_runtime_diagnostic(runtime.session_index, turn_id, exc, metadata["code"], phase="running_turn")
            print_event({"type": "error", "turn_id": turn_id, "message": message, "metadata": metadata,
                         "code": metadata["code"], **({"action": metadata["action"]} if "action" in metadata else {})}, jsonl=args.jsonl)
            print_event({"type": "done", "turn_id": turn_id, "assistant": "", "tool_results": []}, jsonl=args.jsonl)
    return 0


def main() -> None:
    async def supervised_main():
        loop = asyncio.get_running_loop()
        task = asyncio.current_task()
        loop.add_signal_handler(signal.SIGTERM, task.cancel)
        try:
            return await amain()
        finally:
            loop.remove_signal_handler(signal.SIGTERM)
    try:
        raise SystemExit(asyncio.run(supervised_main()))
    except asyncio.CancelledError:
        raise SystemExit(143)
    except KeyboardInterrupt:
        print("", file=sys.stderr)
        raise SystemExit(130)


if __name__ == "__main__":
    main()

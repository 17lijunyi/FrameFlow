import contextlib
import io
import json
import sys
import unittest
from unittest.mock import patch

import main_agent
from agent_runtime.errors import RuntimeConfigurationError


class FakeSessionIndex:
    def __init__(self, fail_session=False):
        self.fail_session = fail_session
        self.activated = ""
        self.created = 0
        self.project_name = ""
        self.logs = []

    def set_active(self, session_id):
        if self.fail_session:
            raise KeyError(session_id)
        self.activated = session_id

    def create(self, project_name=""):
        self.created += 1
        self.project_name = project_name
        self.activated = f"new-{self.created}"
        return {"session_id": self.activated}

    def snapshot(self):
        return {"active_session_id": self.activated, "session": {"session_id": self.activated, "stage": "created"}}

    def append_log(self, name, payload):
        self.logs.append((name, payload))


class FakeRuntime:
    def __init__(self, fail_session=False):
        self.session_index = FakeSessionIndex(fail_session=fail_session)
        self.inputs = []

    async def compact_history(self, reason="manual"):
        return "Compacted context 100 -> 50 (fallback-local)."

    async def stream_events(self, user_input):
        self.inputs.append(user_input)
        turn_id = "turn-test"
        yield {"type": "turn", "turn_id": turn_id, "turn": {"id": turn_id}}
        yield {"type": "status", "turn_id": turn_id, "phase": "sampling_assistant", "message": "Sampling assistant"}
        yield {"type": "tool_progress", "turn_id": turn_id, "tool": {"name": "fake_tool"}, "progress": {"stage": "running", "message": "working"}}
        yield {"type": "terminal", "turn_id": turn_id, "stream": "stdout", "line": "pipeline output"}
        yield {"type": "token", "turn_id": turn_id, "delta": "done"}
        yield {"type": "done", "turn_id": turn_id, "assistant": "done", "tool_results": []}
        yield {"type": "session", "turn_id": turn_id, "session": {"session": {"session_id": "s1", "stage": "narrative_planned"}}}


class MainAgentCliTests(unittest.IsolatedAsyncioTestCase):
    async def run_cli(self, argv, runtime=None, stdin_text="", session_index=None, load_runtime_side_effect=None):
        runtime = runtime or FakeRuntime()
        session_index = session_index or runtime.session_index
        stdout = io.StringIO()
        stderr = io.StringIO()
        stdin = io.StringIO(stdin_text)
        load_runtime_patch = patch.object(main_agent, "load_runtime", return_value=runtime)
        if load_runtime_side_effect is not None:
            load_runtime_patch = patch.object(main_agent, "load_runtime", side_effect=load_runtime_side_effect)
        with load_runtime_patch, \
             patch.object(main_agent, "load_session_index", return_value=session_index), \
             patch.object(sys, "stdin", stdin), \
             contextlib.redirect_stdout(stdout), \
             contextlib.redirect_stderr(stderr):
            code = await main_agent.amain(argv)
        return code, stdout.getvalue(), stderr.getvalue(), runtime

    def test_help_parser_contains_once(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), self.assertRaises(SystemExit) as ctx:
            main_agent.parse_args(["--help"])
        self.assertEqual(ctx.exception.code, 0)
        self.assertIn("--once", stdout.getvalue())

    async def test_jsonl_once_outputs_valid_events_with_turn_id(self):
        code, stdout, stderr, runtime = await self.run_cli(["--jsonl", "--once", "hello"])
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(runtime.inputs, ["hello"])
        lines = [json.loads(line) for line in stdout.splitlines()]
        self.assertTrue(lines)
        self.assertEqual({event["turn_id"] for event in lines}, {"turn-test"})
        self.assertEqual(lines[0]["type"], "turn")
        self.assertIn("terminal", [event["type"] for event in lines])
        self.assertNotIn("›", stdout)

    async def test_stdin_non_tty_is_single_prompt(self):
        code, stdout, stderr, runtime = await self.run_cli(["--jsonl"], stdin_text="from stdin\n")
        self.assertEqual(code, 0)
        self.assertEqual(runtime.inputs, ["from stdin"])
        self.assertTrue(stdout.strip())


    async def test_stdin_repl_reads_each_line_as_a_turn(self):
        code, stdout, stderr, runtime = await self.run_cli(["--jsonl", "--stdin-repl"], stdin_text="first\nsecond\n")
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(runtime.inputs, ["first", "second"])
        events = [json.loads(line) for line in stdout.splitlines()]
        self.assertEqual([event["type"] for event in events if event["type"] == "done"], ["done", "done"])
        self.assertEqual(events[0], {"type": "ready"})

    async def test_missing_key_reports_one_actionable_error_before_reading_input(self):
        code, stdout, stderr, runtime = await self.run_cli(
            ["--jsonl", "--stdin-repl"], stdin_text="test prompt\n",
            load_runtime_side_effect=RuntimeConfigurationError("missing_llm_api_key", "尚未配置文本模型 API Key。请前往设置。"),
        )
        self.assertEqual(code, 1)
        self.assertEqual(stderr, "")
        self.assertEqual(runtime.inputs, [])
        self.assertEqual([json.loads(line) for line in stdout.splitlines()], [{
            "type": "error", "phase": "startup", "code": "missing_llm_api_key",
            "message": "尚未配置文本模型 API Key。请前往设置。", "action": "open_settings",
        }])
        self.assertNotIn("Traceback", stdout)

    async def test_unexpected_startup_exception_does_not_expose_raw_exception(self):
        code, stdout, stderr, runtime = await self.run_cli(
            ["--jsonl", "--stdin-repl"], stdin_text="test prompt\n",
            load_runtime_side_effect=RuntimeError("Authorization: Bearer private-test-value"),
        )
        self.assertEqual(code, 1)
        self.assertEqual(stderr, "")
        self.assertEqual(runtime.inputs, [])
        event = json.loads(stdout)
        self.assertEqual(event["phase"], "startup")
        self.assertEqual(event["code"], "runtime_startup_failed")
        self.assertNotIn("private-test-value", stdout)
        self.assertNotIn("Traceback", stdout)

    async def test_plain_startup_failure_is_a_single_friendly_error(self):
        code, stdout, stderr, _ = await self.run_cli(
            ["--once", "hello"], load_runtime_side_effect=ImportError("sensitive diagnostic text"),
        )
        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertIn("启动失败", stderr)
        self.assertEqual(len(stderr.splitlines()), 1)
        self.assertNotIn("sensitive diagnostic text", stderr)

    async def test_jsonl_invalid_session_is_a_structured_startup_error(self):
        code, stdout, stderr, _ = await self.run_cli(
            ["--jsonl", "--stdin-repl", "--session", "missing"],
            session_index=FakeSessionIndex(fail_session=True),
            load_runtime_side_effect=AssertionError("runtime should not load"),
        )
        self.assertEqual(code, 2)
        self.assertEqual(stderr, "")
        self.assertEqual(json.loads(stdout)["code"], "invalid_session")

    async def test_session_error_is_clear_before_runtime_load(self):
        runtime = FakeRuntime()
        failing_index = FakeSessionIndex(fail_session=True)
        code, stdout, stderr, runtime = await self.run_cli(
            ["--session", "missing", "--once", "hello"],
            runtime=runtime,
            session_index=failing_index,
            load_runtime_side_effect=AssertionError("runtime should not load"),
        )
        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("项目标识不存在", stderr)
        self.assertEqual(runtime.inputs, [])


    async def test_new_session_is_created_before_runtime_load(self):
        runtime = FakeRuntime()
        session_index = FakeSessionIndex()
        code, stdout, stderr, runtime = await self.run_cli(
            ["--new-session", "--jsonl", "--once", "hello"],
            runtime=runtime,
            session_index=session_index,
        )
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(session_index.created, 1)
        self.assertEqual(session_index.activated, "new-1")
        self.assertEqual(runtime.inputs, ["hello"])

    async def test_named_new_session_passes_project_name(self):
        runtime = FakeRuntime()
        session_index = FakeSessionIndex()
        code, stdout, stderr, runtime = await self.run_cli(
            ["--new-session", "--new-session-name", "Ocean campaign", "--jsonl", "--once", "hello"],
            runtime=runtime,
            session_index=session_index,
        )
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(session_index.project_name, "Ocean campaign")
        self.assertEqual(runtime.inputs, ["hello"])

    async def test_new_session_and_session_are_mutually_exclusive(self):
        runtime = FakeRuntime()
        code, stdout, stderr, runtime = await self.run_cli(
            ["--new-session", "--session", "s1", "--once", "hello"],
            runtime=runtime,
            load_runtime_side_effect=AssertionError("runtime should not load"),
        )
        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("不能同时使用", stderr)
        self.assertEqual(runtime.inputs, [])


    async def test_compact_command_outputs_jsonl_without_llm_turn(self):
        code, stdout, stderr, runtime = await self.run_cli(["--jsonl", "--once", "/compact"])
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(runtime.inputs, [])
        events = [json.loads(line) for line in stdout.splitlines()]
        self.assertEqual([event["type"] for event in events], ["turn", "status", "token", "done", "session"])
        turn_ids = {event["turn_id"] for event in events}
        self.assertEqual(len(turn_ids), 1)
        self.assertTrue(next(iter(turn_ids)).startswith("turn-"))
        self.assertIn("Compacted context", events[2]["delta"])

    async def test_plain_mode_prints_progress_terminal_and_session(self):
        code, stdout, stderr, _ = await self.run_cli(["--once", "hello"])
        self.assertEqual(code, 0)
        self.assertIn("工具 fake_tool 运行中：working", stdout)
        self.assertIn("终端[stdout]：pipeline output", stdout)
        self.assertIn("项目：s1 文本规划完成", stdout)

    async def test_unexpected_turn_failure_is_safe_keeps_turn_id_and_repl_alive(self):
        class FailingRuntime(FakeRuntime):
            async def stream_events(self, user_input):
                if user_input == "first":
                    self.inputs.append(user_input)
                    yield {"type": "turn", "turn_id": "turn-first", "turn": {"id": "turn-first"}}
                    raise RuntimeError("PRIVATE_PROVIDER_BODY api_key=FAKE_SECRET_VALUE")
                async for event in super().stream_events(user_input):
                    yield event

        code, stdout, stderr, runtime = await self.run_cli(
            ["--jsonl", "--stdin-repl"], runtime=FailingRuntime(), stdin_text="first\nsecond\n",
        )
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(runtime.inputs, ["first", "second"])
        events = [json.loads(line) for line in stdout.splitlines()]
        error = next(event for event in events if event["type"] == "error")
        self.assertEqual(error["turn_id"], "turn-first")
        self.assertEqual(error["code"], "runtime_turn_failed")
        self.assertNotIn("action", error)
        self.assertEqual([event["turn_id"] for event in events if event["type"] == "done"], ["turn-first", "turn-test"])
        self.assertTrue(error["message"].startswith("本轮创作失败。"))
        name, diagnostic = runtime.session_index.logs[0]
        self.assertEqual(name, "runtime_errors")
        self.assertEqual(diagnostic["turn_id"], "turn-first")
        self.assertEqual(diagnostic["phase"], "running_turn")
        self.assertEqual(diagnostic["exception_type"], "RuntimeError")
        self.assertEqual(diagnostic["frames"][-1]["function"], "stream_events")
        for forbidden in ["PRIVATE_PROVIDER_BODY", "FAKE_SECRET_VALUE", "Traceback"]:
            self.assertNotIn(forbidden, stdout + stderr + json.dumps(runtime.session_index.logs))

    async def test_outer_configuration_failure_keeps_readable_message_and_settings_action(self):
        class FailingRuntime(FakeRuntime):
            async def stream_events(self, user_input):
                raise RuntimeConfigurationError("local_agent_failed", "本地执行者调用失败，请检查登录和模型服务。")
                yield  # Keep an async generator without producing an event.

        code, stdout, stderr, runtime = await self.run_cli(["--jsonl", "--once", "hello"], runtime=FailingRuntime())
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        error, done = [json.loads(line) for line in stdout.splitlines()]
        self.assertEqual(error["code"], "local_agent_failed")
        self.assertEqual(error["action"], "open_settings")
        self.assertEqual(error["message"], "本轮创作失败：本地执行者调用失败，请检查登录和模型服务。")
        self.assertEqual(error["turn_id"], done["turn_id"])
        self.assertEqual(runtime.session_index.logs[0][1]["code"], "local_agent_failed")

    async def test_failed_manual_compaction_is_safe_and_does_not_stop_repl(self):
        class FailingRuntime(FakeRuntime):
            async def compact_history(self, reason="manual"):
                raise OSError("PRIVATE_FILE_CONTENT api_key=FAKE_SECRET_VALUE")

        code, stdout, stderr, runtime = await self.run_cli(
            ["--jsonl", "--stdin-repl"], runtime=FailingRuntime(), stdin_text="/compact\nsecond\n",
        )
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(runtime.inputs, ["second"])
        events = [json.loads(line) for line in stdout.splitlines()]
        compact_turn = next(event["turn_id"] for event in events if event["type"] == "turn")
        error = next(event for event in events if event["type"] == "error")
        self.assertEqual(error["turn_id"], compact_turn)
        self.assertEqual(error["code"], "runtime_turn_failed")
        self.assertEqual(len([event for event in events if event["type"] == "done"]), 2)
        self.assertNotIn("PRIVATE_FILE_CONTENT", stdout + stderr + json.dumps(runtime.session_index.logs))
        self.assertNotIn("FAKE_SECRET_VALUE", stdout + stderr + json.dumps(runtime.session_index.logs))

    async def test_plain_turn_error_never_prints_private_exception(self):
        class FailingRuntime(FakeRuntime):
            async def stream_events(self, user_input):
                raise RuntimeError("PRIVATE_PROVIDER_BODY api_key=FAKE_SECRET_VALUE")
                yield

        code, stdout, stderr, _ = await self.run_cli(["--once", "hello"], runtime=FailingRuntime())
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertIn("本轮创作失败。", stdout)
        self.assertNotIn("PRIVATE_PROVIDER_BODY", stdout)
        self.assertNotIn("FAKE_SECRET_VALUE", stdout)

    async def test_diagnostic_write_failure_does_not_hide_public_turn_error(self):
        class FailingRuntime(FakeRuntime):
            async def stream_events(self, user_input):
                raise RuntimeError("PRIVATE_PROVIDER_BODY")
                yield

        runtime = FailingRuntime()
        with patch.object(runtime.session_index, "append_log", side_effect=PermissionError("PRIVATE_PATH")):
            code, stdout, stderr, _ = await self.run_cli(["--jsonl", "--once", "hello"], runtime=runtime)
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual([json.loads(line)["type"] for line in stdout.splitlines()], ["error", "done"])
        self.assertNotIn("PRIVATE", stdout)

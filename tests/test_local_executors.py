from __future__ import annotations

import asyncio
import base64
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import AsyncMock, Mock, patch

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from agent_runtime.errors import RuntimeConfigurationError
from agent_runtime.local_executors import (
    RoleExecutors, RoutedAssistantLLM, RoutedChatModel, api_fingerprint,
    extract_prompt_images, run_local_executor, run_sync_step, media_api_fingerprint,
)


def settings(root: Path, **roles):
    cli = {"id": "cli:codex", "kind": "cli", "agentId": "codex", "name": "Codex",
           "executablePath": sys.executable, "fingerprint": "test-installation", "version": "1.2.3",
           "adapterAvailable": True, "imageTransport": True, "imageGenerationTransport": True}
    value = {"schemaVersion": 1, "roles": {"assistant": "cli:codex", "script": "inherit", "storyboard": "inherit", "vision": "cli:codex", **roles},
             "executors": {cli["id"]: cli}, "capabilities": {cli["id"]: {"imageInput": "vision", "fingerprint": cli["fingerprint"]}}}
    path = root / ".vimax" / "role-executors.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")
    return value


def write_settings(root: Path, value):
    (root / ".vimax" / "role-executors.json").write_text(json.dumps(value), encoding="utf-8")


def image_block(data=b"test-pixels", mime="image/png"):
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}"}}


class RoleExecutorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()

    def test_missing_file_keeps_text_api_but_requires_vision_confirmation(self):
        router = RoleExecutors(self.root)
        self.assertEqual(router.resolve("script")["id"], "api")
        with self.assertRaises(RuntimeConfigurationError) as caught:
            router.preflight_vision()
        self.assertEqual(caught.exception.code, "vision_capability_unconfirmed")

    def test_independent_roles_and_inherit(self):
        settings(self.root, storyboard="api")
        router = RoleExecutors(self.root)
        self.assertEqual(router.resolve("script")["id"], "cli:codex")
        self.assertEqual(router.resolve("storyboard")["id"], "api")
        self.assertEqual(router.preflight_vision()["id"], "cli:codex")

    def test_old_settings_keep_media_api_defaults_and_video_rejects_agent(self):
        settings(self.root)
        router = RoleExecutors(self.root)
        self.assertEqual(router.resolve("image")["id"], "image_api")
        self.assertEqual(router.resolve("video")["id"], "video_api")
        for role, selected in (("video", "cli:codex"), ("image", "api"), ("script", "image_api"), ("vision", "video_api")):
            settings(self.root, **{role: selected})
            with self.subTest(role=role, selected=selected), self.assertRaises(RuntimeConfigurationError):
                router.resolve(role)

    def test_image_tool_declaration_is_independent_of_model_vision(self):
        value = settings(self.root, image="cli:codex")
        value["capabilities"]["cli:codex"].update(imageInput="text_only", imageGeneration="available")
        write_settings(self.root, value)
        self.assertEqual(RoleExecutors(self.root).preflight_image()["id"], "cli:codex")
        with self.assertRaises(RuntimeConfigurationError) as caught:
            RoleExecutors(self.root).preflight_vision()
        self.assertEqual(caught.exception.code, "vision_not_supported")
        for mutation, code in (({"imageGeneration": "unknown"}, "image_generation_capability_unconfirmed"),
                               ({"imageGeneration": "unavailable"}, "image_generation_not_supported"),
                               ({"fingerprint": "changed"}, "image_generation_capability_unconfirmed")):
            value["capabilities"]["cli:codex"].update(imageGeneration="available", fingerprint="test-installation")
            value["capabilities"]["cli:codex"].update(mutation)
            write_settings(self.root, value)
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeConfigurationError) as caught:
                RoleExecutors(self.root).preflight_image()
            self.assertEqual(caught.exception.code, code)
        value["executors"]["cli:codex"]["imageGenerationTransport"] = False
        write_settings(self.root, value)
        with self.assertRaises(RuntimeConfigurationError) as caught:
            RoleExecutors(self.root).preflight_image()
        self.assertEqual(caught.exception.code, "executor_image_generation_transport_unavailable")

    def test_media_api_fingerprint_and_preflight_follow_effective_protocol_model_address(self):
        with patch.dict(os.environ, {"VIMAX_IMAGE_PROVIDER": "openrouter", "VIMAX_IMAGE_MODEL": "自定义-image", "VIMAX_IMAGE_BASE_URL": "https://relay.test/v1",
                                    "VIMAX_VIDEO_PROVIDER": "yunwu", "VIMAX_VIDEO_MODEL": "seedance", "VIMAX_VIDEO_BASE_URL": "https://relay.test/video",
                                    "VIMAX_IMAGE_API_KEY": "test", "VIMAX_VIDEO_API_KEY": "test"}, clear=True):
            for kind, values in (("image", ["image", "openrouter", "自定义-image", "https://relay.test/v1"]),
                                 ("video", ["video", "yunwu", "seedance", "https://relay.test/video"])):
                expected = hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
                self.assertEqual(media_api_fingerprint(kind, self.root), expected)
                self.assertEqual(getattr(RoleExecutors(self.root), f"preflight_{kind}")()["fingerprint"], expected)
            with patch.dict(os.environ, {"VIMAX_IMAGE_PROVIDER": "unsupported"}):
                with self.assertRaises(RuntimeConfigurationError) as caught:
                    RoleExecutors(self.root).preflight_image()
                self.assertEqual(caught.exception.code, "unsupported_image_provider")

    def test_media_factories_select_agent_or_explicit_protocol_without_api_fallback(self):
        from agent_runtime.vimax_adapters import _build_image_generator, _build_video_generator
        from agent_runtime.local_image_generator import LocalAgentImageGenerator
        value = settings(self.root, image="cli:codex")
        value["capabilities"]["cli:codex"].update(imageGeneration="available", imageInput="text_only")
        write_settings(self.root, value)
        with patch("agent_runtime.vimax_adapters.ImageGeneratorNanobananaYunwuAPI", side_effect=AssertionError("no API fallback")), patch("agent_runtime.vimax_adapters.ImageGeneratorOpenRouterAPI", side_effect=AssertionError("no API fallback")):
            self.assertIsInstance(_build_image_generator(self.root), LocalAgentImageGenerator)
        value["roles"]["image"] = "image_api"
        write_settings(self.root, value)
        with patch.dict(os.environ, {"VIMAX_IMAGE_PROVIDER": "openrouter", "VIMAX_IMAGE_BASE_URL": "https://relay.test/v1", "VIMAX_IMAGE_API_KEY": "test",
                                    "VIMAX_VIDEO_PROVIDER": "openrouter", "VIMAX_VIDEO_BASE_URL": "https://relay.test/video", "VIMAX_VIDEO_API_KEY": "test"}, clear=True), \
             patch("agent_runtime.vimax_adapters.ImageGeneratorOpenRouterAPI", return_value="image") as image, \
             patch("agent_runtime.vimax_adapters.VideoGeneratorOpenRouterAPI", return_value="video") as video:
            self.assertEqual(_build_image_generator(self.root), "image")
            self.assertEqual(_build_video_generator(self.root), "video")
            self.assertEqual(image.call_args.kwargs["base_url"], "https://relay.test/v1")
            self.assertEqual(video.call_args.kwargs["base_url"], "https://relay.test/video")
        with patch.dict(os.environ, {"VIMAX_IMAGE_BASE_URL": "https://unknown.test", "VIMAX_IMAGE_API_KEY": "test"}, clear=True), \
             patch("agent_runtime.vimax_adapters.ImageGeneratorNanobananaYunwuAPI", side_effect=AssertionError("no unknown protocol fallback")):
            with self.assertRaises(RuntimeConfigurationError) as caught:
                _build_image_generator(self.root)
            self.assertEqual(caught.exception.code, "unsupported_image_provider")

    def test_wan_factory_uses_explicit_silent_budget_defaults_without_fallback(self):
        from agent_runtime.vimax_adapters import _build_video_generator
        from tools.video_generator_wan_api import VideoGeneratorWanAPI
        settings(self.root)
        with patch.dict(os.environ, {"VIMAX_VIDEO_PROVIDER": "aliyun", "VIMAX_VIDEO_MODEL": "wan2.6-i2v-flash",
                                     "VIMAX_VIDEO_BASE_URL": "https://workspace-test.cn-beijing.maas.aliyuncs.com/api/v1",
                                     "VIMAX_VIDEO_API_KEY": "offline-test-key"}, clear=True), \
             patch("agent_runtime.vimax_adapters.VideoGeneratorOpenRouterAPI", side_effect=AssertionError("No paid provider fallback")), \
             patch("agent_runtime.vimax_adapters.VideoGeneratorVeoYunwuAPI", side_effect=AssertionError("No paid provider fallback")):
            self.assertEqual(RoleExecutors(self.root).preflight_video()["id"], "video_api")
            generator = _build_video_generator(self.root)
        self.assertIsInstance(generator, VideoGeneratorWanAPI)
        self.assertEqual(generator.model, "wan2.6-i2v-flash")
        self.assertEqual(generator.duration, 5)
        self.assertEqual(generator.resolution, "720P")
        self.assertFalse(generator.audio)
        self.assertFalse(generator.supports_last_frame)
        self.assertEqual(generator.base_url, "https://workspace-test.cn-beijing.maas.aliyuncs.com/api/v1")

    def test_wan_preflight_rejects_other_model_or_missing_key_before_generator_construction(self):
        from agent_runtime.vimax_adapters import _build_video_generator
        settings(self.root)
        for model, key, code in (("wan2.7-i2v", "test", "unsupported_video_provider"),
                                 ("wan2.6-i2v-flash", "", "missing_video_api_key")):
            with self.subTest(model=model, key=bool(key)), \
                 patch.dict(os.environ, {"VIMAX_VIDEO_PROVIDER": "aliyun", "VIMAX_VIDEO_MODEL": model,
                                         "VIMAX_VIDEO_BASE_URL": "https://dashscope.aliyuncs.com/api/v1", "VIMAX_VIDEO_API_KEY": key}, clear=True), \
                 patch("tools.video_generator_wan_api.VideoGeneratorWanAPI", side_effect=AssertionError("Preflight must run before construction")):
                with self.assertRaises(RuntimeConfigurationError) as caught:
                    _build_video_generator(self.root)
                self.assertEqual(caught.exception.code, code)

    def test_uncertain_wan_paid_task_is_not_advertised_as_automatically_retryable(self):
        from agent_runtime.vimax_adapters import _is_retryable_render_error
        from tools.video_generator_wan_api import WanVideoError, WanVideoValidationError
        for error in (WanVideoError("万相提交超时，任务可能已创建。"),
                      WanVideoError("视频已生成，但下载失败。"),
                      WanVideoValidationError("请添加一张首帧图片。")):
            with self.subTest(error=str(error)):
                self.assertFalse(_is_retryable_render_error(error))

    def test_malformed_persisted_settings_never_fall_back_to_api(self):
        for section in ("roles", "executors", "capabilities"):
            value = settings(self.root)
            del value[section]
            write_settings(self.root, value)
            with self.subTest(section=section), self.assertRaises(RuntimeConfigurationError) as caught:
                RoleExecutors(self.root).resolve("assistant")
            self.assertEqual(caught.exception.code, "invalid_executor_settings")
        for role, bad in (("assistant", "inherit"), ("vision", "inherit"), ("script", None)):
            value = settings(self.root)
            value["roles"][role] = bad
            write_settings(self.root, value)
            with self.subTest(role=role), self.assertRaises(RuntimeConfigurationError):
                RoleExecutors(self.root).resolve(role)

    def test_pending_and_disappeared_selection_are_rejected(self):
        for mutation in ({"kind": "application"}, {"adapterAvailable": False}, {"agentId": "hermes"}, {"executablePath": str(self.root / "missing")}):
            value = settings(self.root)
            value["executors"]["cli:codex"].update(mutation)
            write_settings(self.root, value)
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeConfigurationError):
                RoleExecutors(self.root).resolve("script")
        value = settings(self.root)
        value["roles"]["script"] = "cli:missing"
        write_settings(self.root, value)
        with self.assertRaises(RuntimeConfigurationError) as caught:
            RoleExecutors(self.root).resolve("script")
        self.assertEqual(caught.exception.code, "executor_unavailable")

    def test_vision_declaration_is_bound_to_fingerprint_and_native_transport(self):
        for mutation, code in (({"imageInput": "text_only"}, "vision_not_supported"), ({"fingerprint": "old-install"}, "vision_capability_unconfirmed")):
            value = settings(self.root)
            value["capabilities"]["cli:codex"].update(mutation)
            write_settings(self.root, value)
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeConfigurationError) as caught:
                RoleExecutors(self.root).preflight_vision()
            self.assertEqual(caught.exception.code, code)
        value = settings(self.root)
        value["executors"]["cli:codex"]["imageTransport"] = False
        write_settings(self.root, value)
        with self.assertRaises(RuntimeConfigurationError) as caught:
            RoleExecutors(self.root).preflight_vision()
        self.assertEqual(caught.exception.code, "executor_image_transport_unavailable")

    def test_api_fingerprint_matches_compact_unicode_json_and_actual_environment(self):
        values = ["openai", "模型-test", "https://example.invalid/v1"]
        with patch.dict(os.environ, {"VIMAX_LLM_MODEL_PROVIDER": values[0], "VIMAX_LLM_MODEL": values[1], "VIMAX_LLM_BASE_URL": values[2]}):
            expected = hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
            self.assertEqual(api_fingerprint(self.root), expected)
            value = settings(self.root, vision="api")
            value["capabilities"]["api"] = {"imageInput": "vision", "fingerprint": expected}
            write_settings(self.root, value)
            self.assertEqual(RoleExecutors(self.root).preflight_vision()["id"], "api")
            with patch.dict(os.environ, {"VIMAX_LLM_MODEL": "another-model"}):
                with self.assertRaises(RuntimeConfigurationError):
                    RoleExecutors(self.root).preflight_vision()

    def test_external_settings_symlink_is_not_read(self):
        external = self.root / "private.json"
        external.write_text("not parsed", encoding="utf-8")
        folder = self.root / ".vimax"
        folder.mkdir()
        (folder / "role-executors.json").symlink_to(external)
        with self.assertRaises(RuntimeConfigurationError):
            RoleExecutors(self.root).resolve("assistant")

    def test_multimodal_order_is_preserved_without_base64_in_prompt(self):
        messages = [SystemMessage(content="Return JSON"), HumanMessage(content=[{"type": "text", "text": "Reference 0"}, image_block(b"reference"), {"type": "text", "text": "Candidate 0"}, image_block(b"candidate")])]
        prompt, images = extract_prompt_images(messages)
        self.assertEqual([base64.b64decode(image["data"]) for image in images], [b"reference", b"candidate"])
        self.assertLess(prompt.index("Reference 0"), prompt.index("原生图片附件 1"))
        self.assertLess(prompt.index("原生图片附件 1"), prompt.index("Candidate 0"))
        self.assertNotIn(images[0]["data"], prompt)

    def test_remote_or_invalid_image_is_rejected(self):
        for url in ("https://example.invalid/private.png", "data:image/png;base64,%%%%", "file:///private.png"):
            with self.subTest(url=url), self.assertRaises(RuntimeConfigurationError):
                extract_prompt_images([{"role": "user", "content": [{"type": "image_url", "image_url": {"url": url}}]}])

    def test_template_placeholders_and_environment_use_matching_api_defaults(self):
        from agent_runtime.config import llm_api_key, load_agent_config
        folder = self.root / "configs"
        folder.mkdir()
        (folder / "agent.local.yaml").write_text(json.dumps({"llm": {"model": "<YOUR_LLM_MODEL>", "model_provider": "<YOUR_PROVIDER>", "base_url": "<YOUR_BASE_URL>", "api_key": "<YOUR_API_KEY>"}}))
        load_agent_config.cache_clear()
        self.addCleanup(load_agent_config.cache_clear)
        with patch.dict(os.environ, {"VIMAX_LLM_MODEL": "<YOUR_MODEL>", "VIMAX_LLM_BASE_URL": "<YOUR_URL>", "VIMAX_LLM_MODEL_PROVIDER": "<YOUR_PROVIDER>", "VIMAX_LLM_API_KEY": "<YOUR_KEY>"}, clear=True):
            expected = hashlib.sha256(b'["openai","gpt-5.5","https://yunwu.ai/v1"]').hexdigest()
            self.assertEqual(api_fingerprint(self.root), expected)
            self.assertEqual(llm_api_key(self.root), "")


class LocalExecutorAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.value = settings(self.root)

    async def test_assistant_returns_only_allowed_frameflow_tool_calls(self):
        api = Mock(side_effect=AssertionError("API must not be used"))
        llm = RoutedAssistantLLM(self.root, api)
        tools = [{"type": "function", "function": {"name": "view_image"}}]
        worker = AsyncMock(return_value='{"text":"查看图片","tool_calls":[{"name":"view_image","arguments":{"path":"frame.png"}}]}')
        with patch("agent_runtime.local_executors.run_local_executor", worker):
            result = await llm.complete([{"role": "user", "content": "看图"}], tools)
        self.assertEqual(result.tool_calls[0].name, "view_image")
        self.assertEqual(result.tool_calls[0].arguments, {"path": "frame.png"})
        api.assert_not_called()
        with patch("agent_runtime.local_executors.run_local_executor", AsyncMock(return_value='{"tool_calls":[{"name":"shell","arguments":{}}]}')):
            with self.assertRaises(RuntimeConfigurationError):
                await llm.complete([], tools)

    async def test_assistant_image_round_is_delegated_to_vision_executor(self):
        self.value["roles"]["vision"] = "api"
        self.value["capabilities"]["api"] = {"imageInput": "vision", "fingerprint": api_fingerprint(self.root)}
        write_settings(self.root, self.value)
        result = object()
        api = Mock(return_value=Mock(complete=AsyncMock(return_value=result)))
        llm = RoutedAssistantLLM(self.root, api)
        messages = [{"role": "user", "content": [image_block()]}]
        with patch("agent_runtime.local_executors.run_local_executor", AsyncMock(side_effect=AssertionError("CLI must not run"))):
            self.assertIs(await llm.complete(messages, []), result)
        api.return_value.complete.assert_awaited_once_with(messages, [])

    async def test_langchain_vision_routes_native_images_and_remains_parser_compatible(self):
        from langchain_core.output_parsers import JsonOutputParser
        model = RoutedChatModel(workspace_root=str(self.root), role="storyboard", api_factory=Mock(side_effect=AssertionError("API must not run")))
        worker = AsyncMock(return_value='{"best_image_index":1,"reason":"matches"}')
        with patch("agent_runtime.local_executors.run_local_executor", worker):
            result = await (model | JsonOutputParser()).ainvoke([HumanMessage(content=[image_block(b"first"), image_block(b"second")])])
        self.assertEqual(result["best_image_index"], 1)
        self.assertEqual(len(worker.await_args.args[3]), 2)

    async def test_unknown_vision_fails_before_any_cli_or_api_request(self):
        self.value["capabilities"] = {}
        write_settings(self.root, self.value)
        api = Mock(side_effect=AssertionError("No API"))
        model = RoutedChatModel(workspace_root=str(self.root), role="script", api_factory=api)
        worker = AsyncMock()
        with patch("agent_runtime.local_executors.run_local_executor", worker), self.assertRaises(RuntimeConfigurationError) as caught:
            await model.ainvoke([HumanMessage(content=[image_block()])])
        self.assertEqual(caught.exception.code, "vision_capability_unconfirmed")
        api.assert_not_called()
        worker.assert_not_awaited()

    async def test_script_and_storyboard_are_actually_injected_into_pipeline(self):
        from agent_runtime.vimax_adapters import _build_role_chat_model, _configure_pipeline_roles
        from pipelines.script2video_pipeline import Script2VideoPipeline
        self.value["roles"]["storyboard"] = "api"
        write_settings(self.root, self.value)
        with patch("agent_runtime.vimax_adapters._build_chat_model", return_value=Mock()):
            script = _build_role_chat_model(self.root, "script")
            pipeline = Script2VideoPipeline(script, object(), object(), str(self.root / "pipeline"))
            _configure_pipeline_roles(pipeline, self.root)
        self.assertEqual(pipeline.character_extractor.chat_model.role, "script")
        self.assertEqual(pipeline.storyboard_artist.chat_model.role, "storyboard")
        self.assertEqual(pipeline.camera_image_generator.chat_model.role, "storyboard")
        self.assertEqual(pipeline.reference_image_selector.chat_model.role, "vision")
        self.assertEqual(pipeline.best_image_selector.chat_model.role, "vision")

    async def test_novel_default_injects_assistant_without_llm_or_retrieval_apis(self):
        from agent_runtime.vimax_adapters import _build_novel_pipeline
        working_dir = self.root / ".working_dir" / "session" / "novel2video"
        with ExitStack() as stack:
            factory = stack.enter_context(patch("agent_runtime.vimax_adapters._build_chat_model", side_effect=AssertionError("No LLM API")))
            embedding = stack.enter_context(patch("agent_runtime.vimax_adapters._build_embedding_model", return_value=object()))
            reranker = stack.enter_context(patch("agent_runtime.vimax_adapters._build_reranker", return_value=object()))
            pipeline = _build_novel_pipeline(working_dir)
            retrieval = pipeline.retrieval_model_factory()
        self.assertEqual(pipeline.novel_compressor.chat_model.role, "script")
        self.assertIs(pipeline.novel_compressor.chat_model, pipeline.event_extractor.chat_model)
        self.assertIs(pipeline.event_extractor.chat_model, pipeline.scene_extractor.chat_model)
        self.assertIs(pipeline.scene_extractor.chat_model, pipeline.global_information_planner.chat_model)
        self.assertEqual(pipeline.retrieval_mode, "assistant")
        self.assertEqual(retrieval.role, "assistant")
        factory.assert_not_called()
        embedding.assert_not_called()
        reranker.assert_not_called()

    async def test_render_preflight_does_not_construct_paid_media_providers(self):
        from agent_runtime.session_index import SessionIndex
        from agent_runtime.vimax_adapters import ViMaxAdapters
        index = SessionIndex(self.root)
        session = index.create(idea="test")
        adapter = ViMaxAdapters(self.root, index)
        self.value["capabilities"] = {}
        write_settings(self.root, self.value)
        with patch("agent_runtime.vimax_adapters._missing_render_dependencies", return_value=[]), patch("agent_runtime.vimax_adapters._build_image_generator") as image, patch("agent_runtime.vimax_adapters._build_video_generator") as video:
            result = await adapter.vimax_render_video({"session_id": session["session_id"]})
        self.assertFalse(result.ok)
        self.assertEqual(result.metadata["code"], "vision_capability_unconfirmed")
        self.assertEqual(result.metadata["action"], "open_settings")
        image.assert_not_called()
        video.assert_not_called()

    async def test_missing_image_tools_or_invalid_video_role_stop_before_paid_generation(self):
        from agent_runtime.session_index import SessionIndex
        from agent_runtime.vimax_adapters import ViMaxAdapters
        index = SessionIndex(self.root)
        session = index.create(idea="test")
        adapter = ViMaxAdapters(self.root, index)
        for roles, generation, code in (({"image": "cli:codex", "video": "video_api"}, "unknown", "image_generation_capability_unconfirmed"),
                                        ({"image": "cli:codex", "video": "cli:codex"}, "available", "video_executor_unsupported")):
            value = settings(self.root, **roles)
            value["capabilities"]["cli:codex"]["imageGeneration"] = generation
            write_settings(self.root, value)
            with self.subTest(roles=roles), patch("agent_runtime.vimax_adapters._missing_render_dependencies", return_value=[]), \
                 patch("agent_runtime.vimax_adapters._build_image_generator") as image, \
                 patch("agent_runtime.vimax_adapters._build_video_generator") as video:
                result = await adapter.vimax_render_video({"session_id": session["session_id"]})
            self.assertFalse(result.ok)
            self.assertEqual(result.metadata["code"], code)
            image.assert_not_called()
            video.assert_not_called()

    def fake_worker(self, source: str):
        folder = self.root / "web"
        folder.mkdir(exist_ok=True)
        (folder / "local-agent-worker.mjs").write_text(source, encoding="utf-8")

    async def test_worker_uses_json_stdin_and_expected_version_without_shell(self):
        self.fake_worker('import sys,json\nr=json.load(sys.stdin)\nprint(json.dumps({"text":json.dumps(r)}))\n')
        entry = self.value["executors"]["cli:codex"]
        prompt = 'literal $(touch never) `never` "text"'
        with patch.dict(os.environ, {"FRAMEFLOW_NODE_PATH": sys.executable}):
            response = json.loads(await run_local_executor(self.root, entry, prompt, []))
        self.assertEqual(response["prompt"], prompt)
        self.assertEqual(response["expectedVersion"], "1.2.3")
        self.assertEqual(response["executablePath"], sys.executable)
        self.assertFalse((self.root / "never").exists())

    async def test_worker_diagnostics_do_not_expose_raw_error_messages(self):
        self.fake_worker('import json,sys\njson.load(sys.stdin)\nprint(json.dumps({"error":{"code":"local_agent_interface_unavailable","message":"PRIVATE_TEST_TOKEN"}}))\nsys.exit(1)\n')
        with patch.dict(os.environ, {"FRAMEFLOW_NODE_PATH": sys.executable}), self.assertRaises(RuntimeConfigurationError) as caught:
            await run_local_executor(self.root, self.value["executors"]["cli:codex"], "test", [])
        self.assertNotIn("PRIVATE_TEST_TOKEN", str(caught.exception))
        self.assertIn("版本", str(caught.exception))

    async def test_cancellation_and_timeout_allow_worker_sigterm_cleanup(self):
        self.fake_worker('import json,sys,time,signal,pathlib\njson.load(sys.stdin)\ndef stop(*args):\n pathlib.Path("terminated").write_text("done")\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\npathlib.Path("started").write_text("ready")\nwhile True: time.sleep(.01)\n')
        entry = self.value["executors"]["cli:codex"]
        with patch.dict(os.environ, {"FRAMEFLOW_NODE_PATH": sys.executable}):
            task = asyncio.create_task(run_local_executor(self.root, entry, "test", []))
            for _ in range(100):
                if (self.root / "started").exists():
                    break
                await asyncio.sleep(.01)
            self.assertTrue((self.root / "started").exists())
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertTrue((self.root / "terminated").exists())
            (self.root / "terminated").unlink()
            with patch("agent_runtime.local_executors.EXECUTOR_TIMEOUT_SECONDS", .1), self.assertRaises(RuntimeConfigurationError) as caught:
                await run_local_executor(self.root, entry, "test", [])
            self.assertEqual(caught.exception.code, "executor_timeout")
            self.assertTrue((self.root / "terminated").exists())

    async def test_sync_novel_step_cancellation_reaches_local_worker(self):
        self.fake_worker('import json,sys,time,signal,pathlib\njson.load(sys.stdin)\ndef stop(*args):\n pathlib.Path("terminated").write_text("done")\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\npathlib.Path("started").write_text("ready")\nwhile True: time.sleep(.01)\n')
        model = RoutedChatModel(workspace_root=str(self.root), role="script", api_factory=Mock())
        with patch.dict(os.environ, {"FRAMEFLOW_NODE_PATH": sys.executable}):
            task = asyncio.create_task(run_sync_step(model.invoke, [HumanMessage(content="test")]))
            for _ in range(100):
                if (self.root / "started").exists():
                    break
                await asyncio.sleep(.01)
            self.assertTrue((self.root / "started").exists())
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            for _ in range(100):
                if (self.root / "terminated").exists():
                    break
                await asyncio.sleep(.01)
            self.assertTrue((self.root / "terminated").exists())


if __name__ == "__main__":
    unittest.main()

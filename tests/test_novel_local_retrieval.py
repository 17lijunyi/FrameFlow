import asyncio
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from interfaces import Event, Scene
from interfaces.environment import EnvironmentInScene
from agent_runtime.config import load_agent_config
from agent_runtime.session_index import SessionIndex
from agent_runtime.vimax_adapters import ViMaxAdapters, _build_novel_pipeline, _build_novel_render_pipeline, _preflight_novel_retrieval, _novel_retrieval_options
from pipelines.novel2movie_pipeline import Novel2MoviePipeline
from pipelines.novel_retrieval import AssistantNovelRetriever, NovelKeywordIndex, MAX_PROMPT_TOKENS, MAX_SOURCE_TOKENS, digest, token_upper_bound
from tests.test_novel2video_adapter import FakeCompressor, FakeEventExtractor, FakeSceneExtractor, FakeGlobalPlanner, FakeNovelPipeline, FakeKnowledgeBase, FakeReranker, write_minimal_novel_artifacts


SOURCE = "第一章 离家\n小明推开木门，背着行囊走向车站。\n第二章 海边\n小红在海边捡拾贝壳，听见远处海鸥的叫声。"
EVENT = Event(index=0, is_last=True, description="小明离家", process_chain=["小明推开木门前往车站"])


class SelectingAssistant:
    def __init__(self, *, selection=None, query=None):
        self.messages = []
        self.selection = selection
        self.query = query

    async def ainvoke(self, messages):
        self.messages.append(messages)
        payload = json.loads(messages[-1].content)
        if "candidates" not in payload:
            response = self.query if self.query is not None else {"queries": ["小明 木门 车站"]}
        else:
            response = self.selection(payload) if self.selection is not None else {"selected_ids": [payload["candidates"][0]["id"]]}
        return SimpleNamespace(content=response if isinstance(response, str) else json.dumps(response, ensure_ascii=False))


def local_pipeline(folder, model=None, **options):
    return Novel2MoviePipeline(
        novel_compressor=FakeCompressor(), event_extractor=FakeEventExtractor(),
        embeddings=None, rerank_model=None,
        scene_extractor=FakeSceneExtractor(), global_information_planner=FakeGlobalPlanner(),
        image_generator=object(), rewriter=object(), script2video_pipeline=object(), working_dir=str(folder),
        retrieval_mode="assistant", retrieval_model=model or SelectingAssistant(),
        retrieval_identity=options.pop("retrieval_identity", "assistant-one"), **options,
    )


class LocalIndexTests(unittest.TestCase):
    def test_chinese_terms_rank_matching_chapter_above_shared_words(self):
        index = NovelKeywordIndex(SOURCE)
        spans = index.search(["小明推开木门前往车站"])
        self.assertTrue(spans)
        self.assertIn("第一章", spans[0].chapter)
        self.assertIn("木门", spans[0].text)

    def test_overlapping_chunks_retain_exact_source_offsets_and_chapter_boundary(self):
        source = "第一章 起点\n" + "甲" * 900 + "\n第二章 终点\n" + "乙" * 800
        index = NovelKeywordIndex(source)
        self.assertGreater(len(index.spans), 4)
        for span in index.spans:
            self.assertEqual(span.text, source[span.start:span.end])
            self.assertLessEqual(len(span.text), 512)
            self.assertFalse("甲" in span.text and "乙" in span.text)
        self.assertEqual(index.spans[0].end - index.spans[1].start, 128)


class AssistantRetrievalTests(unittest.IsolatedAsyncioTestCase):
    async def test_assistant_orders_ids_but_cannot_write_excerpts(self):
        model = SelectingAssistant(selection=lambda payload: {"selected_ids": [candidate["id"] for candidate in reversed(payload["candidates"])]})
        retriever = AssistantNovelRetriever(SOURCE, model)
        result = await retriever.retrieve(EVENT)
        presented = json.loads(model.messages[-1][-1].content)["candidates"]
        self.assertEqual([span.id for span in result], [candidate["id"] for candidate in reversed(presented)])
        for span in result:
            self.assertEqual(span.text, SOURCE[span.start:span.end])
            self.assertIn(span.id, retriever.index.by_id)

    async def test_rejects_unknown_duplicate_empty_and_non_string_ids(self):
        selections = [
            lambda payload: {"selected_ids": ["invented-excerpt"]},
            lambda payload: {"selected_ids": [payload["candidates"][0]["id"]] * 2},
            lambda payload: {"selected_ids": []},
            lambda payload: {"selected_ids": [{"text": "伪造原文"}]},
            lambda payload: {"selected_ids": [payload["candidates"][0]["id"]], "text": "伪造原文"},
        ]
        for selection in selections:
            with self.subTest(selection=selection), self.assertRaisesRegex(RuntimeError, "小说检索"):
                await AssistantNovelRetriever(SOURCE, SelectingAssistant(selection=selection)).retrieve(EVENT)

    async def test_requires_json_and_bounded_queries(self):
        for query in ("```json\n{\"queries\":[\"小明\"]}\n```", {"queries": []}, {"queries": ["明" * 97]}, {"queries": ["小明"] * 7}, '{"queries":["小明"],"queries":["车站"]}'):
            with self.subTest(query=query), self.assertRaisesRegex(RuntimeError, "小说检索"):
                await AssistantNovelRetriever(SOURCE, SelectingAssistant(query=query)).retrieve(EVENT)

    async def test_large_event_candidates_and_final_context_are_bounded(self):
        source = "\n".join(f"第{index + 1}章\n" + "小明推开木门前往车站。" * 100 for index in range(40))
        model = SelectingAssistant(selection=lambda payload: {"selected_ids": [candidate["id"] for candidate in payload["candidates"][:8]]})
        event = EVENT.model_copy(update={"description": "木门" * 50_000, "process_chain": ["小明车站" * 50_000]})
        result = await AssistantNovelRetriever(source, model).retrieve(event)
        self.assertLessEqual(sum(token_upper_bound(span.text) for span in result), MAX_SOURCE_TOKENS)
        for messages in model.messages:
            self.assertLessEqual(sum(token_upper_bound(message.content) for message in messages), MAX_PROMPT_TOKENS)
        candidates = json.loads(model.messages[-1][-1].content)["candidates"]
        self.assertLessEqual(len(candidates), 16)
        self.assertGreater(len(candidates), 1)

    async def test_selection_is_limited_to_candidates_actually_presented(self):
        source = "\n".join(f"第{index + 1}章\n" + "小明推开木门前往车站。" * 100 for index in range(40))
        index = NovelKeywordIndex(source)
        known_but_not_presented = index.spans[-1].id
        model = SelectingAssistant(selection=lambda payload: {"selected_ids": [known_but_not_presented]})
        with self.assertRaisesRegex(RuntimeError, "片段 ID 无效"):
            await AssistantNovelRetriever(source, model).retrieve(EVENT)

    async def test_no_match_is_explicit_failure(self):
        with self.assertRaisesRegex(RuntimeError, "未找到"):
            await AssistantNovelRetriever("abcdefghijklmnopqrstuvwxyz", SelectingAssistant(query={"queries": ["不存在"]})).retrieve(EVENT)

    async def test_cancellation_propagates_while_waiting_for_assistant(self):
        started = asyncio.Event()
        async def block(messages):
            started.set()
            await asyncio.Event().wait()
        model = SimpleNamespace(ainvoke=block)
        task = asyncio.create_task(AssistantNovelRetriever(SOURCE, model).retrieve(EVENT))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_cancellation_propagates_during_candidate_selection(self):
        selecting = asyncio.Event()
        async def block_selection(messages):
            if "candidates" not in json.loads(messages[-1].content):
                return SimpleNamespace(content='{"queries":["小明木门"]}')
            selecting.set()
            await asyncio.Event().wait()
        task = asyncio.create_task(AssistantNovelRetriever(SOURCE, SimpleNamespace(ainvoke=block_selection)).retrieve(EVENT))
        await selecting.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task


class RetrievalCacheTests(unittest.IsolatedAsyncioTestCase):
    async def test_text_cache_invalidation_archives_paid_media_once_and_preserves_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pipeline = local_pipeline(tmp)
            await pipeline._retrieve_event_chunks(SOURCE, [EVENT])
            portrait = root / "character_portraits/base/portrait.png"
            portrait.parent.mkdir(parents=True)
            portrait.write_bytes(b"paid-portrait-contents")
            video = root / "videos/event_0/scene_0/final_video.mp4"
            video.parent.mkdir(parents=True)
            video.write_bytes(b"paid-video-contents")
            pipeline.retrieval_identity = "another-model"
            await pipeline._retrieve_event_chunks(SOURCE, [EVENT, EVENT.model_copy(update={"index": 1})])
            self.assertFalse((root / "videos").exists())
            self.assertFalse((root / "character_portraits").exists())
            archives = list((root / ".planning-history").iterdir())
            self.assertEqual(len(archives), 1)
            self.assertEqual((archives[0] / "character_portraits/base/portrait.png").read_bytes(), b"paid-portrait-contents")
            self.assertEqual((archives[0] / "videos/event_0/scene_0/final_video.mp4").read_bytes(), b"paid-video-contents")
            self.assertEqual(set(json.loads((archives[0] / "manifest.json").read_text())["archived_media"]), {"character_portraits", "videos"})

    def test_media_archive_failure_rolls_back_before_text_deletion(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pipeline = local_pipeline(tmp)
            for name in ("character_portraits", "videos", "scenes"):
                (root / name).mkdir()
                (root / name / "data.bin").write_bytes(name.encode())
            original_rename = Path.rename
            def fail_second_move(path, destination):
                if path == root / "videos":
                    raise OSError("simulated archive failure")
                return original_rename(path, destination)
            with patch.object(Path, "rename", fail_second_move), self.assertRaisesRegex(OSError, "archive failure"):
                pipeline._discard_text_cache(("scenes", "global_information"))
            for name in ("character_portraits", "videos", "scenes"):
                self.assertEqual((root / name / "data.bin").read_bytes(), name.encode())

    async def test_render_only_preserves_existing_media_and_does_not_retrieve(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            write_minimal_novel_artifacts(base)
            root = base / "novel2video"
            model = SelectingAssistant()
            pipeline = local_pipeline(root, model)
            portrait = root / "character_portraits/base/character_0_Hero.png"
            portrait.parent.mkdir(parents=True)
            portrait.write_bytes(b"existing-portrait")
            scene_portrait = root / "character_portraits/event_0/scene_0/character_0_Hero.png"
            scene_portrait.parent.mkdir(parents=True)
            scene_portrait.write_bytes(b"existing-scene-portrait")
            video = root / "videos/event_0/scene_0/final_video.mp4"
            video.parent.mkdir(parents=True)
            video.write_bytes(b"existing-final-video")
            class CachedVideo:
                async def __call__(self, **kwargs):
                    return str(Path(self.working_dir) / "final_video.mp4")
            pipeline.script2video_pipeline = CachedVideo()
            result = await pipeline.render_video_artifacts("cinematic", quiet=True)
            self.assertEqual(result["scene_count"], 1)
            self.assertEqual(video.read_bytes(), b"existing-final-video")
            self.assertEqual(portrait.read_bytes(), b"existing-portrait")
            self.assertFalse((root / ".planning-history").exists())
            self.assertEqual(len(model.messages), 0)

    def test_source_cache_reuses_matching_novel_but_invalidates_changed_source_or_script_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            pipeline = local_pipeline(tmp, text_identity="script-one")
            pipeline._prepare_text_cache(SOURCE)
            event_dir = Path(tmp) / "events"
            event_dir.mkdir()
            cached = event_dir / "event_0.json"
            cached.write_text("cached-event")
            pipeline._prepare_text_cache(SOURCE)
            self.assertTrue(cached.exists())
            pipeline._prepare_text_cache(SOURCE + "尾声")
            self.assertFalse(event_dir.exists())
            event_dir.mkdir()
            cached.write_text("cached-event")
            pipeline.text_identity = "script-two"
            pipeline._prepare_text_cache(SOURCE + "尾声")
            self.assertFalse(event_dir.exists())

    async def test_cache_retains_source_locations_and_reuses_only_same_model_and_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            model = SelectingAssistant()
            pipeline = local_pipeline(tmp, model)
            first = await pipeline._retrieve_event_chunks(SOURCE, [EVENT])
            second = await pipeline._retrieve_event_chunks(SOURCE, [EVENT])
            self.assertEqual(first, second)
            self.assertEqual(len(model.messages), 2)
            path = Path(tmp) / "relevant_chunks/event_0/sources.json"
            cached = json.loads(path.read_text())
            for record in cached["sources"]:
                self.assertEqual(record["text_sha256"], digest(SOURCE[record["start"]:record["end"]]))
            changed = local_pipeline(tmp, model, retrieval_identity="assistant-two")
            await changed._retrieve_event_chunks(SOURCE, [EVENT])
            self.assertEqual(len(model.messages), 4)
            await changed._retrieve_event_chunks(SOURCE, [EVENT.model_copy(update={"description": "小明前往车站"})])
            self.assertEqual(len(model.messages), 6)

    async def test_tampered_or_legacy_cache_cannot_supply_fabricated_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            model = SelectingAssistant()
            pipeline = local_pipeline(tmp, model)
            await pipeline._retrieve_event_chunks(SOURCE, [EVENT])
            path = Path(tmp) / "relevant_chunks/event_0/sources.json"
            cache = json.loads(path.read_text())
            cache["sources"][0]["text_sha256"] = digest("伪造原文")
            path.write_text(json.dumps(cache))
            output = await pipeline._retrieve_event_chunks(SOURCE, [EVENT])
            self.assertEqual(len(model.messages), 4)
            self.assertNotIn("伪造原文", output[0])
            path.unlink()
            (path.parent / "chunk_0-score_1.00.txt").write_text("伪造原文")
            output = await pipeline._retrieve_event_chunks(SOURCE, [EVENT])
            self.assertEqual(len(model.messages), 6)
            self.assertNotIn("伪造原文", output[0])

    async def test_source_and_strategy_switch_invalidate_dependent_text_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            model = SelectingAssistant()
            pipeline = local_pipeline(tmp, model)
            await pipeline._retrieve_event_chunks(SOURCE, [EVENT])
            scenes = Path(tmp) / "scenes/event_0"
            scenes.mkdir(parents=True)
            (scenes / "scene_0.json").write_text("stale")
            await pipeline._retrieve_event_chunks(SOURCE + "小明抵达车站。", [EVENT])
            self.assertFalse(scenes.exists())
            api = local_pipeline(tmp)
            api.retrieval_mode = "api"
            api.embeddings = SimpleNamespace(model="fake-embedding")
            api.rerank_model = FakeReranker()
            with patch("pipelines.novel2movie_pipeline.CacheBackedEmbeddings.from_bytes_store", return_value=object()), patch("pipelines.novel2movie_pipeline.FAISS.from_texts", return_value=FakeKnowledgeBase()):
                result = await api._retrieve_event_chunks("Hero opens a door.", [EVENT])
            self.assertEqual(result[0], {"Hero opens a door.": .95})
            self.assertEqual(len(model.messages), 4)

    async def test_cache_hit_does_not_construct_retrieval_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            pipeline = local_pipeline(tmp)
            await pipeline._retrieve_event_chunks(SOURCE, [EVENT])
            pipeline.retrieval_model = None
            pipeline.retrieval_model_factory = lambda: self.fail("cached retrieval should not construct a model")
            await pipeline._retrieve_event_chunks(SOURCE, [EVENT])

    async def test_api_cache_reuses_exact_source_without_rebuilding_vectors(self):
        with tempfile.TemporaryDirectory() as tmp:
            pipeline = local_pipeline(tmp)
            pipeline.retrieval_mode = "api"
            pipeline.embeddings = SimpleNamespace(model="fake-embedding")
            pipeline.rerank_model = FakeReranker()
            with patch("pipelines.novel2movie_pipeline.CacheBackedEmbeddings.from_bytes_store", return_value=object()), patch("pipelines.novel2movie_pipeline.FAISS.from_texts", return_value=FakeKnowledgeBase()) as vectors:
                first = await pipeline._retrieve_event_chunks("Hero opens a door.", [EVENT])
                second = await pipeline._retrieve_event_chunks("Hero opens a door.", [EVENT])
            self.assertEqual(first, second)
            vectors.assert_called_once()

    async def test_pipeline_cancellation_cancels_other_event_retrieval(self):
        with tempfile.TemporaryDirectory() as tmp:
            waiting = asyncio.Event()
            cancelled = []
            async def block(messages):
                waiting.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.append(True)
            pipeline = local_pipeline(tmp, SimpleNamespace(ainvoke=block))
            task = asyncio.create_task(pipeline._retrieve_event_chunks(SOURCE, [EVENT, EVENT.model_copy(update={"index": 1})]))
            await waiting.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertEqual(len(cancelled), 2)


class DefaultAssistantRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        load_agent_config.cache_clear()
        self.addCleanup(load_agent_config.cache_clear)

    async def test_default_no_retrieval_apis_still_runs_novel_planning(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict("os.environ", {}, clear=True):
            adapter = ViMaxAdapters(Path(tmp), SessionIndex(tmp))
            with patch("agent_runtime.vimax_adapters.RoleExecutors.resolve", return_value={"id": "local-test", "fingerprint": "fp"}), patch("agent_runtime.vimax_adapters._build_novel_pipeline", side_effect=lambda folder: FakeNovelPipeline(folder)):
                result = await adapter.vimax_novel_planning({"novel_text": SOURCE})
            self.assertTrue(result.ok)

    async def test_planning_factory_routes_only_retrieval_to_assistant_and_no_rag_models(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict("os.environ", {}, clear=True):
            model = SelectingAssistant(query={"queries": ["Hero door"]})
            folder = Path(tmp) / ".working_dir/test/novel2video"
            fake_entry = {"id": "local-test", "fingerprint": "fingerprint"}
            with patch("agent_runtime.vimax_adapters.RoleExecutors.resolve", return_value=fake_entry), \
                 patch("agent_runtime.vimax_adapters._build_role_chat_model", side_effect=lambda root, role: model) as roles, \
                 patch("agent_runtime.vimax_adapters._build_embedding_model", side_effect=AssertionError("no embedding API")), \
                 patch("agent_runtime.vimax_adapters._build_reranker", side_effect=AssertionError("no reranker API")):
                pipeline = _build_novel_pipeline(folder)
                pipeline.novel_compressor = FakeCompressor()
                pipeline.event_extractor = FakeEventExtractor()
                pipeline.scene_extractor = FakeSceneExtractor()
                pipeline.global_information_planner = FakeGlobalPlanner()
                result = await pipeline.plan_text_artifacts("Hero opens a door.", quiet=True)
            self.assertEqual([call.args[1] for call in roles.call_args_list], ["script", "assistant"])
            self.assertEqual(len(result["events"]), 1)
            self.assertEqual(len(model.messages), 2)

    async def test_unknown_cli_model_reuses_single_instance_but_refreshes_across_instances(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict("os.environ", {}, clear=True):
            model = SelectingAssistant()
            folder = Path(tmp) / ".working_dir/test/novel2video"
            with patch("agent_runtime.vimax_adapters.RoleExecutors.resolve", return_value={"id": "cli-test", "fingerprint": "same-installation"}), \
                 patch("agent_runtime.vimax_adapters._build_role_chat_model", return_value=model):
                first = _build_novel_pipeline(folder)
                await first._retrieve_event_chunks(SOURCE, [EVENT])
                await first._retrieve_event_chunks(SOURCE, [EVENT])
                self.assertEqual(len(model.messages), 2)
                second = _build_novel_pipeline(folder)
                await second._retrieve_event_chunks(SOURCE, [EVENT])
                self.assertEqual(len(model.messages), 4)

    def test_chat_api_identity_tracks_actual_model_provider_and_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            identities = []
            for model, provider, url in (("model-one", "openai", "https://first.invalid/v1"), ("model-two", "openai", "https://first.invalid/v1"), ("model-two", "anthropic", "https://second.invalid/v1")):
                with patch.dict("os.environ", {"VIMAX_LLM_MODEL": model, "VIMAX_LLM_MODEL_PROVIDER": provider, "VIMAX_LLM_BASE_URL": url}, clear=True):
                    identities.append(_novel_retrieval_options(tmp)["retrieval_identity_factory"]())
            self.assertEqual(len({identity["fingerprint"] for identity in identities}), 3)
            self.assertTrue(all(set(identity) == {"id", "fingerprint"} for identity in identities))

    async def test_full_pipeline_uses_same_assistant_path_without_vector_services(self):
        class EmptyScenes:
            async def get_next_scene(self, **kwargs):
                return Scene(idx=0, is_last=True, environment=EnvironmentInScene(slugline="EXT. STREET - DAY", description="street"), characters=[], script="A door opens.")
        class EmptyCharacters:
            async def merge_characters_across_scenes_in_event(self, **kwargs):
                return []
            def merge_characters_to_existing_characters_in_novel(self, **kwargs):
                return []
        with tempfile.TemporaryDirectory() as tmp:
            model = SelectingAssistant(query={"queries": ["Hero door"]})
            pipeline = local_pipeline(tmp, model)
            pipeline.scene_extractor = EmptyScenes()
            pipeline.global_information_planner = EmptyCharacters()
            pipeline.script2video_pipeline = SimpleNamespace()
            videos = AsyncMock()
            pipeline.script2video_pipeline = videos
            with patch("pipelines.novel2movie_pipeline.FAISS.from_texts", side_effect=AssertionError("no vector service")), contextlib.redirect_stdout(io.StringIO()):
                await pipeline("Hero opens a door.", style="cinematic")
            self.assertEqual(len(model.messages), 2)
            self.assertEqual(videos.await_count, 1)

    async def test_render_factory_does_not_read_retrieval_settings_or_models(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict("os.environ", {"VIMAX_NOVEL_RETRIEVAL_MODE": "invalid"}, clear=True):
            with patch("agent_runtime.vimax_adapters.RoleExecutors.resolve", return_value={"id": "local-test", "fingerprint": "fp"}), \
                 patch("agent_runtime.vimax_adapters.Script2VideoPipeline", return_value=SimpleNamespace()), \
                 patch("agent_runtime.vimax_adapters._configure_pipeline_roles"), \
                 patch("agent_runtime.vimax_adapters._build_embedding_model", side_effect=AssertionError("defer embedding")), \
                 patch("agent_runtime.vimax_adapters._build_reranker", side_effect=AssertionError("defer reranker")), \
                 patch("agent_runtime.vimax_adapters.novel_retrieval_mode", side_effect=AssertionError("no retrieval configuration during render")), \
                 patch("agent_runtime.vimax_adapters._build_role_chat_model", side_effect=AssertionError("defer assistant")):
                pipeline = _build_novel_render_pipeline(Path(tmp), object(), object(), object())
            self.assertIsNone(pipeline.embeddings)
            self.assertIsNone(pipeline.retrieval_model)

    def test_preflight_default_allows_missing_keys_but_explicit_api_requires_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict("os.environ", {}, clear=True), patch("agent_runtime.vimax_adapters.RoleExecutors.resolve", return_value={"id": "local-test"}):
                _preflight_novel_retrieval(tmp)
            with patch.dict("os.environ", {"VIMAX_NOVEL_RETRIEVAL_MODE": "api"}, clear=True), self.assertRaisesRegex(RuntimeError, "专用检索 API"):
                _preflight_novel_retrieval(tmp)

    async def test_missing_assistant_api_is_reported_before_script_pipeline_creation(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict("os.environ", {}, clear=True):
            adapter = ViMaxAdapters(Path(tmp), SessionIndex(tmp))
            with patch("agent_runtime.vimax_adapters._build_novel_pipeline", side_effect=AssertionError("no paid script planning")) as factory:
                result = await adapter.vimax_novel_planning({"novel_text": SOURCE})
            self.assertFalse(result.ok)
            self.assertEqual(result.metadata["code"], "missing_llm_api_key")
            self.assertEqual(result.metadata["action"], "open_settings")
            factory.assert_not_called()

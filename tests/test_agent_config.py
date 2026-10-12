import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml
from agent_runtime.errors import RuntimeConfigurationError

from agent_runtime.config import (
    api_provider_from_base_url,
    embedding_api_key,
    embedding_base_url,
    embedding_model,
    embedding_model_provider,
    image_api_key,
    image_base_url,
    image_model,
    image_num_candidates,
    image_provider,
    llm_api_key,
    llm_base_url,
    llm_model,
    llm_model_provider,
    load_agent_config,
    novel_retrieval_mode,
    reranker_api_key,
    reranker_base_url,
    reranker_model,
    video_api_key,
    video_base_url,
    video_model,
    video_provider,
)


class AgentConfigTests(unittest.TestCase):
    def setUp(self):
        load_agent_config.cache_clear()

    def tearDown(self):
        load_agent_config.cache_clear()

    def test_invalid_yaml_does_not_expose_config_contents_in_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "configs"
            config_dir.mkdir()
            (config_dir / "agent.local.yaml").write_text("llm:\n  api_key: [private-test-value\n", encoding="utf-8")
            with self.assertRaises(RuntimeConfigurationError) as caught:
                load_agent_config(tmp)
            self.assertEqual(caught.exception.code, "invalid_config")
            self.assertNotIn("private-test-value", str(caught.exception))

    def test_novel_retrieval_defaults_to_assistant_without_dedicated_services(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            self.assertEqual(novel_retrieval_mode(tmp), "assistant")

    def test_novel_retrieval_strategy_and_environment_override(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            folder = Path(tmp) / "configs"
            folder.mkdir()
            (folder / "agent.local.yaml").write_text(yaml.safe_dump({
                "novel_retrieval": {"mode": "api", "custom_limit": 12},
            }), encoding="utf-8")
            self.assertEqual(novel_retrieval_mode(tmp), "api")
            with patch.dict(os.environ, {"VIMAX_NOVEL_RETRIEVAL_MODE": "assistant"}):
                self.assertEqual(novel_retrieval_mode(tmp), "assistant")
            for value in ("", "<YOUR_RETRIEVAL_MODE>"):
                with self.subTest(value=value), patch.dict(os.environ, {"VIMAX_NOVEL_RETRIEVAL_MODE": value}):
                    self.assertEqual(novel_retrieval_mode(tmp), "api")

    def test_novel_retrieval_rejects_invalid_stored_strategy(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            folder = Path(tmp) / "configs"
            folder.mkdir()
            config_path = folder / "agent.local.yaml"
            for strategy in (None, [], "private-strategy-value", {"mode": None}, {"mode": False}, {"mode": 1}, {"mode": []}, {"mode": "private-strategy-value"}):
                with self.subTest(strategy=strategy):
                    config_path.write_text(yaml.safe_dump({"novel_retrieval": strategy}), encoding="utf-8")
                    load_agent_config.cache_clear()
                    with self.assertRaises(RuntimeConfigurationError) as caught:
                        novel_retrieval_mode(tmp)
                    self.assertEqual(caught.exception.code, "invalid_config")
                    self.assertNotIn("private-strategy-value", str(caught.exception))
            config_path.write_text(yaml.safe_dump({"novel_retrieval": {"custom_limit": 12}}), encoding="utf-8")
            load_agent_config.cache_clear()
            self.assertEqual(novel_retrieval_mode(tmp), "assistant")

    def test_novel_retrieval_rejects_invalid_environment_strategy(self):
        with tempfile.TemporaryDirectory() as tmp:
            for value in ("private-strategy-value", " api ", " "):
                with self.subTest(value=value), patch.dict(os.environ, {"VIMAX_NOVEL_RETRIEVAL_MODE": value}, clear=True):
                    with self.assertRaises(RuntimeConfigurationError) as caught:
                        novel_retrieval_mode(tmp)
                    self.assertEqual(caught.exception.code, "invalid_config")
                    self.assertNotIn("private-strategy-value", str(caught.exception))

    def test_novel_retrieval_environment_override_can_repair_invalid_stored_selection(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"VIMAX_NOVEL_RETRIEVAL_MODE": "assistant"}, clear=True):
            folder = Path(tmp) / "configs"
            folder.mkdir()
            (folder / "agent.local.yaml").write_text(yaml.safe_dump({"novel_retrieval": {"mode": "unknown"}}), encoding="utf-8")
            self.assertEqual(novel_retrieval_mode(tmp), "assistant")


    def test_reads_agent_local_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "configs"
            config_dir.mkdir()
            (config_dir / "agent.local.yaml").write_text(yaml.safe_dump({
                "llm": {"model_provider": "openai", "model": "config-llm", "base_url": "https://config.test/v1", "api_key": "config-key"},
                "image": {"model": "config-image", "base_url": "https://image.test", "api_key": "image-key"},
                "video": {"model": "config-video", "base_url": "https://openrouter.ai/api/v1", "api_key": "video-key"},
                "embedding": {"model_provider": "openai", "model": "config-embedding", "base_url": "https://embedding.test/v1", "api_key": "embedding-key"},
                "reranker": {"model": "config-reranker", "base_url": "https://reranker.test", "api_key": "reranker-key"},
            }), encoding="utf-8")
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(llm_model(tmp), "config-llm")
                self.assertEqual(llm_model_provider(tmp), "openai")
                self.assertEqual(llm_base_url(tmp), "https://config.test/v1")
                self.assertEqual(llm_api_key(tmp), "config-key")
                self.assertEqual(image_model(tmp), "config-image")
                self.assertEqual(image_base_url(tmp), "https://image.test")
                self.assertEqual(image_api_key(tmp), "image-key")
                self.assertEqual(video_model(tmp), "config-video")
                self.assertEqual(video_provider(tmp), "openrouter")
                self.assertEqual(video_base_url(tmp), "https://openrouter.ai/api/v1")
                self.assertEqual(video_api_key(tmp), "video-key")
                self.assertEqual(embedding_model_provider(tmp), "openai")
                self.assertEqual(embedding_model(tmp), "config-embedding")
                self.assertEqual(embedding_base_url(tmp), "https://embedding.test/v1")
                self.assertEqual(embedding_api_key(tmp), "embedding-key")
                self.assertEqual(reranker_model(tmp), "config-reranker")
                self.assertEqual(reranker_base_url(tmp), "https://reranker.test")
                self.assertEqual(reranker_api_key(tmp), "reranker-key")

    def test_environment_overrides_agent_local_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "configs"
            config_dir.mkdir()
            (config_dir / "agent.local.yaml").write_text(yaml.safe_dump({"llm": {"model": "config-llm", "api_key": "config-key"}}), encoding="utf-8")
            with patch.dict(os.environ, {"VIMAX_LLM_MODEL": "env-llm", "VIMAX_LLM_MODEL_PROVIDER": "openai", "VIMAX_LLM_API_KEY": "env-key", "VIMAX_VIDEO_BASE_URL": "https://openrouter.ai/api/v1", "VIMAX_EMBEDDING_MODEL": "env-embedding", "VIMAX_EMBEDDING_BASE_URL": "https://env-embedding.test/v1", "VIMAX_EMBEDDING_API_KEY": "env-embedding-key", "VIMAX_RERANKER_MODEL": "env-reranker", "VIMAX_RERANKER_BASE_URL": "https://env-reranker.test", "VIMAX_RERANKER_API_KEY": "env-reranker-key"}, clear=True):
                self.assertEqual(llm_model(tmp), "env-llm")
                self.assertEqual(llm_model_provider(tmp), "openai")
                self.assertEqual(llm_api_key(tmp), "env-key")
                self.assertEqual(video_provider(tmp), "openrouter")
                self.assertEqual(video_base_url(tmp), "https://openrouter.ai/api/v1")
                self.assertEqual(embedding_model(tmp), "env-embedding")
                self.assertEqual(embedding_base_url(tmp), "https://env-embedding.test/v1")
                self.assertEqual(embedding_api_key(tmp), "env-embedding-key")
                self.assertEqual(reranker_model(tmp), "env-reranker")
                self.assertEqual(reranker_base_url(tmp), "https://env-reranker.test")
                self.assertEqual(reranker_api_key(tmp), "env-reranker-key")

    def test_image_and_video_keys_fall_back_to_llm_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp) / "configs"
            config_dir.mkdir()
            (config_dir / "agent.local.yaml").write_text(yaml.safe_dump({"llm": {"api_key": "shared-key"}}), encoding="utf-8")
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(image_api_key(tmp), "shared-key")
                self.assertEqual(video_api_key(tmp), "shared-key")

    def test_video_provider_is_inferred_from_base_url(self):
        self.assertEqual(api_provider_from_base_url("https://openrouter.ai/api/v1"), "openrouter")
        self.assertEqual(api_provider_from_base_url("https://yunwu.ai/v1"), "yunwu")
        self.assertEqual(api_provider_from_base_url("https://example.com/v1"), "")
        self.assertEqual(api_provider_from_base_url("https://gateway.openrouter.ai/api/v1"), "openrouter")
        self.assertEqual(api_provider_from_base_url("https://relay.yunwu.ai/v1"), "yunwu")
        self.assertEqual(api_provider_from_base_url("https://openrouter.ai.example.com/v1"), "")
        self.assertEqual(api_provider_from_base_url("https://example.com/yunwu.ai?server=openrouter.ai"), "")

    def test_media_protocol_can_be_explicit_for_custom_gateways(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            folder = Path(tmp) / "configs"
            folder.mkdir()
            (folder / "agent.local.yaml").write_text(yaml.safe_dump({
                "image": {"api_provider": "openrouter", "base_url": "https://relay.test/images/v1"},
                "video": {"api_provider": "yunwu", "base_url": "https://relay.test/videos/v1"},
            }))
            self.assertEqual(image_provider(tmp), "openrouter")
            self.assertEqual(video_provider(tmp), "yunwu")
            with patch.dict(os.environ, {"VIMAX_IMAGE_PROVIDER": "yunwu", "VIMAX_VIDEO_PROVIDER": "openrouter"}):
                self.assertEqual(image_provider(tmp), "yunwu")
                self.assertEqual(video_provider(tmp), "openrouter")
            with patch.dict(os.environ, {"VIMAX_IMAGE_PROVIDER": "unknown"}):
                self.assertEqual(image_provider(tmp), "unknown")

    def test_wan_provider_inference_only_matches_official_hosts(self):
        for host in ("dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com",
                     "workspace-123.cn-beijing.maas.aliyuncs.com", "workspace-123.ap-southeast-1.maas.aliyuncs.com"):
            with self.subTest(host=host):
                self.assertEqual(api_provider_from_base_url(f"https://{host}/api/v1"), "aliyun")
        for host in ("aliyuncs.com", "dashscope.aliyuncs.com.example.com", "other.aliyuncs.com",
                     "cn-beijing.maas.aliyuncs.com", "nested.workspace.cn-beijing.maas.aliyuncs.com"):
            with self.subTest(host=host):
                self.assertEqual(api_provider_from_base_url(f"https://{host}/api/v1"), "")

    def test_wan_defaults_and_dedicated_key_never_reuse_shared_service_keys(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {
            "VIMAX_LLM_API_KEY": "private-openrouter-key", "VIMAX_API_KEY": "private-shared-key",
            "OPENROUTER_API_KEY": "private-openrouter-environment-key",
        }, clear=True):
            folder = Path(tmp) / "configs"
            folder.mkdir()
            target = folder / "agent.local.yaml"
            for video in ({"api_provider": "aliyun"}, {"base_url": "https://dashscope.aliyuncs.com/api/v1"}):
                target.write_text(yaml.safe_dump({"llm": {"api_key": "private-stored-shared-key"}, "video": video}))
                load_agent_config.cache_clear()
                with self.subTest(video=video):
                    self.assertEqual(video_provider(tmp), "aliyun")
                    self.assertEqual(video_model(tmp), "wan2.6-i2v-flash")
                    self.assertEqual(video_base_url(tmp), "https://dashscope.aliyuncs.com/api/v1")
                    self.assertEqual(video_api_key(tmp), "")
                    with patch.dict(os.environ, {"DASHSCOPE_API_KEY": "dedicated-dashscope-key"}):
                        self.assertEqual(video_api_key(tmp), "dedicated-dashscope-key")
                    with patch.dict(os.environ, {"DASHSCOPE_API_KEY": "<YOUR_API_KEY>"}):
                        self.assertEqual(video_api_key(tmp), "")
            target.write_text(yaml.safe_dump({"video": {"api_provider": "aliyun", "api_key": "stored-video-key"}}))
            load_agent_config.cache_clear()
            self.assertEqual(video_api_key(tmp), "stored-video-key")
            with patch.dict(os.environ, {"VIMAX_VIDEO_API_KEY": "dedicated-video-key", "DASHSCOPE_API_KEY": "other-key"}):
                self.assertEqual(video_api_key(tmp), "dedicated-video-key")

    def test_dashscope_key_is_not_used_for_other_video_services(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"DASHSCOPE_API_KEY": "private-wan-key"}, clear=True):
            self.assertEqual(video_provider(tmp), "openrouter")
            self.assertEqual(video_api_key(tmp), "")

    def test_default_video_model_matches_openrouter_gateway(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            self.assertEqual(video_model(tmp), "google/veo-3.1-fast")
            self.assertEqual(video_base_url(tmp), "https://openrouter.ai/api/v1")
            self.assertEqual(video_provider(tmp), "openrouter")

    def test_image_candidates_default_and_environment_override(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            self.assertEqual(image_num_candidates(tmp), 2)
            with patch.dict(os.environ, {"VIMAX_IMAGE_NUM_CANDIDATES": "1"}):
                self.assertEqual(image_num_candidates(tmp), 1)

    def test_image_candidates_use_workspace_config(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            config_dir = Path(tmp) / "configs"
            config_dir.mkdir()
            (config_dir / "agent.local.yaml").write_text("image_selection:\n  num_candidates: 3\n", encoding="utf-8")
            self.assertEqual(image_num_candidates(tmp), 3)
            with patch.dict(os.environ, {"VIMAX_IMAGE_NUM_CANDIDATES": "1"}):
                self.assertEqual(image_num_candidates(tmp), 1)

    def test_invalid_image_candidate_counts_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            for value in ("0", "-1", "1.5", "abc", ""):
                with self.subTest(value=value), patch.dict(os.environ, {"VIMAX_IMAGE_NUM_CANDIDATES": value}, clear=True):
                    with self.assertRaisesRegex(ValueError, "positive integer"):
                        image_num_candidates(tmp)


if __name__ == "__main__":
    unittest.main()

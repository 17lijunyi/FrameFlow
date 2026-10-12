from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import yaml
from utils.image_selection import image_candidate_count_from_config
from .errors import RuntimeConfigurationError

DEFAULT_LLM_MODEL = "gpt-5.5"
DEFAULT_LLM_MODEL_PROVIDER = "openai"
DEFAULT_LLM_BASE_URL = "https://yunwu.ai/v1"
DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image-preview"
DEFAULT_IMAGE_BASE_URL = "https://yunwu.ai"
DEFAULT_VIDEO_MODEL = "google/veo-3.1-fast"
DEFAULT_VIDEO_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_WAN_VIDEO_MODEL = "wan2.6-i2v-flash"
DEFAULT_WAN_VIDEO_BASE_URL = "https://dashscope.aliyuncs.com/api/v1"
DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
DEFAULT_EMBEDDING_MODEL_PROVIDER = "openai"
DEFAULT_RERANKER_MODEL = "BAAI/bge-reranker-v2-m3"


@lru_cache(maxsize=4)
def load_agent_config(workspace_root: str | Path = ".") -> dict[str, Any]:
    path = Path(workspace_root).resolve() / "configs" / "agent.local.yaml"
    if not path.exists():
        return {}
    try:
        payload = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise RuntimeConfigurationError("invalid_config", "模型配置格式有误。请前往设置检查配置，或修正 configs/agent.local.yaml 后重试。") from exc
    if not isinstance(payload, dict):
        raise RuntimeConfigurationError("invalid_config", "模型配置需要使用 YAML 配置对象。请前往设置检查配置，或修正 configs/agent.local.yaml 后重试。")
    return payload


def config_value(section: str, key: str, env_names: list[str], default: str = "", workspace_root: str | Path = ".") -> str:
    for env_name in env_names:
        value = os.environ.get(env_name)
        if value and not re.fullmatch(r"<YOUR_[A-Z0-9_]+>", value.strip()):
            return value
    section_payload = load_agent_config(workspace_root).get(section, {})
    if isinstance(section_payload, dict):
        value = section_payload.get(key)
        if isinstance(value, str) and value and not re.fullmatch(r"<YOUR_[A-Z0-9_]+>", value.strip()):
            return value
    return default


def llm_model(workspace_root: str | Path = ".") -> str:
    return config_value("llm", "model", ["VIMAX_LLM_MODEL"], DEFAULT_LLM_MODEL, workspace_root)


def llm_model_provider(workspace_root: str | Path = ".") -> str:
    return config_value("llm", "model_provider", ["VIMAX_LLM_MODEL_PROVIDER"], DEFAULT_LLM_MODEL_PROVIDER, workspace_root)


def llm_base_url(workspace_root: str | Path = ".") -> str:
    return config_value("llm", "base_url", ["VIMAX_LLM_BASE_URL"], DEFAULT_LLM_BASE_URL, workspace_root)


def llm_api_key(workspace_root: str | Path = ".") -> str:
    return config_value("llm", "api_key", ["VIMAX_LLM_API_KEY", "VIMAX_API_KEY"], "", workspace_root)


def image_model(workspace_root: str | Path = ".") -> str:
    return config_value("image", "model", ["VIMAX_IMAGE_MODEL"], DEFAULT_IMAGE_MODEL, workspace_root)


def image_base_url(workspace_root: str | Path = ".") -> str:
    return config_value("image", "base_url", ["VIMAX_IMAGE_BASE_URL"], DEFAULT_IMAGE_BASE_URL, workspace_root)


def image_api_key(workspace_root: str | Path = ".") -> str:
    return config_value("image", "api_key", ["VIMAX_IMAGE_API_KEY", "VIMAX_LLM_API_KEY", "VIMAX_API_KEY"], llm_api_key(workspace_root), workspace_root)


def image_num_candidates(workspace_root: str | Path = ".") -> int:
    return image_candidate_count_from_config(load_agent_config(workspace_root))



def embedding_model(workspace_root: str | Path = ".") -> str:
    return config_value("embedding", "model", ["VIMAX_EMBEDDING_MODEL"], DEFAULT_EMBEDDING_MODEL, workspace_root)


def novel_retrieval_mode(workspace_root: str | Path = ".") -> str:
    """Use the selected assistant by default; dedicated retrieval is explicit."""
    value = os.environ.get("VIMAX_NOVEL_RETRIEVAL_MODE")
    if not value or re.fullmatch(r"<YOUR_[A-Z0-9_]+>", value.strip()):
        payload = load_agent_config(workspace_root)
        if "novel_retrieval" not in payload:
            return "assistant"
        retrieval = payload["novel_retrieval"]
        if not isinstance(retrieval, dict):
            raise RuntimeConfigurationError("invalid_config", "小说检索配置必须是配置对象。请前往设置检查小说检索方式。")
        value = retrieval.get("mode", "assistant")
    if value not in ("assistant", "api"):
        raise RuntimeConfigurationError("invalid_config", "小说检索方式必须选择创作助手或专用检索 API。请前往设置检查小说检索方式。")
    return value


def embedding_model_provider(workspace_root: str | Path = ".") -> str:
    return config_value("embedding", "model_provider", ["VIMAX_EMBEDDING_MODEL_PROVIDER"], DEFAULT_EMBEDDING_MODEL_PROVIDER, workspace_root)


def embedding_base_url(workspace_root: str | Path = ".") -> str:
    return config_value("embedding", "base_url", ["VIMAX_EMBEDDING_BASE_URL"], "", workspace_root)


def embedding_api_key(workspace_root: str | Path = ".") -> str:
    return config_value("embedding", "api_key", ["VIMAX_EMBEDDING_API_KEY"], "", workspace_root)


def reranker_model(workspace_root: str | Path = ".") -> str:
    return config_value("reranker", "model", ["VIMAX_RERANKER_MODEL"], DEFAULT_RERANKER_MODEL, workspace_root)


def reranker_base_url(workspace_root: str | Path = ".") -> str:
    return config_value("reranker", "base_url", ["VIMAX_RERANKER_BASE_URL"], "", workspace_root)


def reranker_api_key(workspace_root: str | Path = ".") -> str:
    return config_value("reranker", "api_key", ["VIMAX_RERANKER_API_KEY"], "", workspace_root)


def video_model(workspace_root: str | Path = ".") -> str:
    default = DEFAULT_WAN_VIDEO_MODEL if video_provider(workspace_root) == "aliyun" else DEFAULT_VIDEO_MODEL
    return config_value("video", "model", ["VIMAX_VIDEO_MODEL"], default, workspace_root)


def video_base_url(workspace_root: str | Path = ".") -> str:
    explicit = config_value("video", "api_provider", ["VIMAX_VIDEO_PROVIDER"], "", workspace_root).strip().lower()
    default = DEFAULT_WAN_VIDEO_BASE_URL if explicit == "aliyun" else DEFAULT_VIDEO_BASE_URL
    return config_value("video", "base_url", ["VIMAX_VIDEO_BASE_URL"], default, workspace_root)


def video_api_key(workspace_root: str | Path = ".") -> str:
    if video_provider(workspace_root) == "aliyun":
        # A different service must never receive a shared text/OpenRouter key.
        return config_value("video", "api_key", ["VIMAX_VIDEO_API_KEY", "DASHSCOPE_API_KEY"], "", workspace_root)
    return config_value("video", "api_key", ["VIMAX_VIDEO_API_KEY", "VIMAX_LLM_API_KEY", "VIMAX_API_KEY"], llm_api_key(workspace_root), workspace_root)


def api_provider_from_base_url(base_url: str) -> str:
    try:
        host = (urlsplit(base_url.strip()).hostname or "").lower()
    except ValueError:
        return ""
    if host == "openrouter.ai" or host.endswith(".openrouter.ai"):
        return "openrouter"
    if host == "yunwu.ai" or host.endswith(".yunwu.ai"):
        return "yunwu"
    if host in {"dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"}:
        return "aliyun"
    if re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com", host):
        return "aliyun"
    return ""


def image_provider(workspace_root: str | Path = ".") -> str:
    explicit = config_value("image", "api_provider", ["VIMAX_IMAGE_PROVIDER"], "", workspace_root).strip().lower()
    return explicit or api_provider_from_base_url(image_base_url(workspace_root))


def video_provider(workspace_root: str | Path = ".") -> str:
    """Choose the API protocol explicitly, inferring known legacy gateways."""
    explicit = config_value("video", "api_provider", ["VIMAX_VIDEO_PROVIDER"], "", workspace_root).strip().lower()
    return explicit or api_provider_from_base_url(video_base_url(workspace_root))

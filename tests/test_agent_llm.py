import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from agent_runtime.llm import OpenAICompatibleLLM
from agent_runtime.errors import RuntimeConfigurationError


class AgentLLMTests(unittest.IsolatedAsyncioTestCase):
    def test_missing_key_fails_before_creating_a_client(self):
        with patch("agent_runtime.llm.llm_api_key", return_value=""), patch("agent_runtime.llm.AsyncOpenAI") as client:
            with self.assertRaises(RuntimeConfigurationError) as caught:
                OpenAICompatibleLLM(model="test", base_url="https://example.invalid/v1")
        self.assertEqual(caught.exception.code, "missing_llm_api_key")
        self.assertIn("前往设置", str(caught.exception))
        client.assert_not_called()

    async def test_string_response_retries_before_clear_error(self):
        llm = OpenAICompatibleLLM(model="test", base_url="https://example.invalid/v1", api_key="test-key")
        create = AsyncMock(side_effect=["data: [DONE]", "bad response"])
        llm.client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        with self.assertRaisesRegex(RuntimeError, "returned a string"):
            await llm.complete([], [])
        self.assertEqual(create.await_count, 2)

    async def test_string_response_retry_can_recover(self):
        llm = OpenAICompatibleLLM(model="test", base_url="https://example.invalid/v1", api_key="test-key")
        create = AsyncMock(side_effect=["data: [DONE]", {"choices": [{"message": {"content": "recovered", "tool_calls": []}}]}])
        llm.client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        message = await llm.complete([], [])
        self.assertEqual(message.text, "recovered")
        self.assertEqual(create.await_count, 2)

    async def test_tool_request_falls_back_to_plain_chat_after_bad_tool_responses(self):
        llm = OpenAICompatibleLLM(model="test", base_url="https://example.invalid/v1", api_key="test-key")
        create = AsyncMock(side_effect=[
            "data: [DONE]",
            "data: [DONE]",
            {"choices": [{"message": {"content": "plain fallback", "tool_calls": []}}]},
        ])
        llm.client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        message = await llm.complete([], [{"type": "function", "function": {"name": "x", "parameters": {}}}])
        self.assertEqual(message.text, "plain fallback")
        self.assertEqual(create.await_count, 3)
        self.assertIsNone(create.await_args_list[-1].kwargs.get("tools"))

    async def test_dict_response_is_accepted(self):
        llm = OpenAICompatibleLLM(model="test", base_url="https://example.invalid/v1", api_key="test-key")
        llm.client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=AsyncMock(return_value={
            "choices": [{"message": {"content": "hello", "tool_calls": []}}]
        }))))
        message = await llm.complete([], [])
        self.assertEqual(message.text, "hello")


if __name__ == "__main__":
    unittest.main()

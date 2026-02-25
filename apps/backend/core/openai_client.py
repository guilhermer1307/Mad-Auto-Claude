"""
OpenAI Client for Non-Claude Models
=====================================

Provides an agent client that uses the OpenAI SDK to communicate with
the OpenAI API for non-Claude models (GPT-4.1, o3, Codex, etc.).

This client matches the ClaudeSDKClient interface so that run_agent_session()
works without modification:
    - async context manager (__aenter__, __aexit__)
    - await client.query(message)
    - async for msg in client.receive_response()

Tool calls are handled locally via ToolExecutor rather than by a CLI subprocess.
"""

import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator

from openai import AsyncOpenAI

from core.tool_executor import TOOL_DEFINITIONS, ToolExecutor

logger = logging.getLogger(__name__)

# Maximum tool call rounds to prevent infinite loops
MAX_TOOL_ROUNDS = 50


# ---------------------------------------------------------------------------
# Message types compatible with ClaudeSDKClient
# ---------------------------------------------------------------------------
# run_agent_session() checks type(msg).__name__ and type(block).__name__,
# so these classes just need matching names and attributes.


@dataclass
class TextBlock:
    """A text content block in an assistant message."""
    text: str


@dataclass
class ToolUseBlock:
    """A tool-use content block in an assistant message."""
    name: str
    input: dict[str, Any]
    id: str = ""


@dataclass
class AssistantMessage:
    """An assistant message containing text and/or tool-use blocks."""
    content: list[TextBlock | ToolUseBlock] = field(default_factory=list)


@dataclass
class ToolResultBlock:
    """A tool result content block in a user message."""
    content: str
    is_error: bool = False
    tool_use_id: str = ""


@dataclass
class UserMessage:
    """A user message containing tool results."""
    content: list[ToolResultBlock] = field(default_factory=list)


class OpenAIClient:
    """
    Agent client using the OpenAI SDK for non-Claude models.

    Implements the same interface as ClaudeSDKClient so that it can be used
    as a drop-in replacement in run_agent_session().

    Usage:
        client = OpenAIClient(
            model="gpt-4.1",
            system_prompt="You are a developer...",
            project_dir=Path("/path/to/project"),
        )
        async with client:
            await client.query("Implement the login feature")
            async for msg in client.receive_response():
                # Process AssistantMessage and UserMessage
                ...
    """

    def __init__(
        self,
        model: str,
        system_prompt: str,
        project_dir: Path,
        api_key: str | None = None,
        base_url: str | None = None,
        max_tokens: int = 16384,
    ):
        """
        Initialize the OpenAI client.

        Args:
            model: OpenAI model ID (e.g., "gpt-4.1", "o3", "codex-mini")
            system_prompt: System prompt for the model
            project_dir: Project directory for tool execution
            api_key: OpenAI API key (defaults to OPENAI_API_KEY env var)
            base_url: API base URL (defaults to OpenAI's API)
            max_tokens: Maximum tokens per response
        """
        self.model = model
        self.system_prompt = system_prompt
        self.project_dir = project_dir
        self.max_tokens = max_tokens

        # Resolve API configuration
        self._api_key = api_key or os.environ.get("OPENAI_API_KEY", "")
        self._base_url = base_url or None  # None = use OpenAI default

        if not self._api_key:
            raise ValueError(
                "OpenAI API key required. Set OPENAI_API_KEY environment variable "
                "or pass api_key parameter."
            )

        # OpenAI client pointing at OpenRouter
        self._openai: AsyncOpenAI | None = None

        # Tool executor for local tool execution
        self._tool_executor = ToolExecutor(project_dir)

        # Conversation state
        self._messages: list[dict[str, Any]] = []
        self._pending_query: str | None = None

    # ------------------------------------------------------------------
    # Async context manager (matches ClaudeSDKClient)
    # ------------------------------------------------------------------

    async def __aenter__(self):
        kwargs: dict[str, Any] = {"api_key": self._api_key}
        if self._base_url:
            kwargs["base_url"] = self._base_url
        self._openai = AsyncOpenAI(**kwargs)
        # Initialize conversation with system prompt
        self._messages = [
            {"role": "system", "content": self.system_prompt},
        ]
        logger.info(
            f"[OpenAIClient] Session started — model={self.model}"
        )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._openai:
            await self._openai.close()
            self._openai = None
        self._messages = []
        self._pending_query = None
        return False

    # ------------------------------------------------------------------
    # Public interface (matches ClaudeSDKClient)
    # ------------------------------------------------------------------

    async def query(self, message: str) -> None:
        """
        Queue a message to send to the model.

        Args:
            message: The user message / prompt to send
        """
        self._pending_query = message

    async def receive_response(self) -> AsyncIterator[AssistantMessage | UserMessage]:
        """
        Send the queued message and yield response messages.

        Implements the agentic tool loop:
        1. Send conversation to the model
        2. Yield AssistantMessage with text and tool calls
        3. Execute tool calls locally via ToolExecutor
        4. Yield UserMessage with tool results
        5. Repeat until no more tool calls (or max rounds reached)

        Yields:
            AssistantMessage or UserMessage objects compatible with
            run_agent_session() expectations.
        """
        if not self._openai:
            raise RuntimeError("Client not initialized. Use 'async with client:'")
        if self._pending_query is None:
            raise RuntimeError("No query pending. Call query() first.")

        # Add user message to conversation
        self._messages.append({"role": "user", "content": self._pending_query})
        self._pending_query = None

        for round_num in range(MAX_TOOL_ROUNDS):
            # Call the model
            response = await self._call_model()
            choice = response.choices[0]
            message = choice.message

            # Build AssistantMessage from the response
            assistant_msg = AssistantMessage()
            tool_calls_to_execute = []

            # Add text content if present
            if message.content:
                assistant_msg.content.append(TextBlock(text=message.content))

            # Add tool use blocks if present
            if message.tool_calls:
                for tc in message.tool_calls:
                    try:
                        tool_input = json.loads(tc.function.arguments)
                    except (json.JSONDecodeError, TypeError):
                        tool_input = {}

                    assistant_msg.content.append(
                        ToolUseBlock(
                            name=tc.function.name,
                            input=tool_input,
                            id=tc.id,
                        )
                    )
                    tool_calls_to_execute.append(tc)

            # Yield the assistant message
            if assistant_msg.content:
                yield assistant_msg

            # If no tool calls, we're done
            if not tool_calls_to_execute:
                break

            # Add assistant message to conversation history
            # (OpenAI format with tool_calls)
            assistant_history: dict[str, Any] = {
                "role": "assistant",
                "content": message.content or "",
            }
            if message.tool_calls:
                assistant_history["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in message.tool_calls
                ]
            self._messages.append(assistant_history)

            # Execute tool calls and yield results
            user_msg = UserMessage()

            for tc in tool_calls_to_execute:
                tool_name = tc.function.name
                try:
                    tool_input = json.loads(tc.function.arguments)
                except (json.JSONDecodeError, TypeError):
                    tool_input = {}

                # Execute the tool locally
                try:
                    result = self._tool_executor.execute(tool_name, tool_input)
                    is_error = result.startswith("Error:")
                except Exception as e:
                    result = f"Error: {str(e)}"
                    is_error = True

                user_msg.content.append(
                    ToolResultBlock(
                        content=result,
                        is_error=is_error,
                        tool_use_id=tc.id,
                    )
                )

                # Add tool result to conversation history (OpenAI format)
                self._messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": result,
                    }
                )

            # Yield the tool results
            yield user_msg

            # Check if model indicated it's done (finish_reason == "stop")
            if choice.finish_reason == "stop":
                break
        else:
            # Max rounds reached
            logger.warning(
                f"[OpenAIClient] Max tool rounds ({MAX_TOOL_ROUNDS}) reached"
            )
            yield AssistantMessage(
                content=[
                    TextBlock(
                        text=f"\n\n[Warning: Maximum tool execution rounds ({MAX_TOOL_ROUNDS}) reached. "
                        "Stopping to prevent runaway execution.]"
                    )
                ]
            )

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    async def _call_model(self):
        """Make a chat completion call to the model via OpenAI SDK."""
        return await self._openai.chat.completions.create(
            model=self.model,
            messages=self._messages,
            tools=TOOL_DEFINITIONS,
            max_tokens=self.max_tokens,
            temperature=0.0,
        )

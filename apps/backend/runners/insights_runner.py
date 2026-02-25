#!/usr/bin/env python3
"""
Insights Runner - AI chat for codebase insights using Claude SDK

This script provides an AI-powered chat interface for asking questions
about a codebase. It can also suggest tasks based on the conversation.
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

# Add auto-claude to path
sys.path.insert(0, str(Path(__file__).parent.parent))

# Validate platform-specific dependencies BEFORE any imports that might
# trigger graphiti_core -> real_ladybug -> pywintypes import chain (ACS-253)
from core.dependency_validator import validate_platform_dependencies

validate_platform_dependencies()

# Load .env file with centralized error handling
from cli.utils import import_dotenv

load_dotenv = import_dotenv()

env_file = Path(__file__).parent.parent / ".env"
if env_file.exists():
    load_dotenv(env_file)

try:
    from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

    SDK_AVAILABLE = True
except ImportError:
    SDK_AVAILABLE = False
    ClaudeAgentOptions = None
    ClaudeSDKClient = None

from core.auth import ensure_claude_code_oauth_token, get_auth_token
from debug import (
    debug,
    debug_detailed,
    debug_error,
    debug_section,
    debug_success,
)
from phase_config import get_thinking_budget, resolve_model_id, sanitize_thinking_level


def load_worktree_context(worktree_path: Path, project_dir: Path) -> str:
    """Load worktree-specific context for the AI."""
    import subprocess
    
    context_parts = []
    
    try:
        # Get current branch name
        branch_result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=worktree_path,
            capture_output=True,
            text=True,
            timeout=5,
        )
        current_branch = branch_result.stdout.strip() if branch_result.returncode == 0 else "unknown"
        
        # Get base branch (try to infer from worktree path or use develop/main)
        base_branch = "develop"  # Default
        worktree_name = worktree_path.name
        
        # Check if this is a task worktree
        task_id = None
        if "auto-claude" in str(worktree_path):
            # Extract task ID from path like .auto-claude/worktrees/tasks/001-feature-name
            parts = str(worktree_path).split(os.sep)
            for part in parts:
                if part.startswith(("00", "01", "02", "03", "04", "05", "06", "07", "08", "09")):
                    task_id = part.split("-")[0]
                    break
        
        # Get changed files relative to base branch
        diff_result = subprocess.run(
            ["git", "diff", "--name-status", f"{base_branch}...HEAD"],
            cwd=worktree_path,
            capture_output=True,
            text=True,
            timeout=10,
        )
        
        changed_files = []
        if diff_result.returncode == 0 and diff_result.stdout.strip():
            for line in diff_result.stdout.strip().split("\n")[:20]:  # Limit to 20 files
                parts = line.split("\t", 1)
                if len(parts) == 2:
                    status, filepath = parts
                    changed_files.append(f"  {status}\t{filepath}")
        
        # Get git status for uncommitted changes
        status_result = subprocess.run(
            ["git", "status", "--short"],
            cwd=worktree_path,
            capture_output=True,
            text=True,
            timeout=5,
        )
        
        uncommitted = []
        if status_result.returncode == 0 and status_result.stdout.strip():
            for line in status_result.stdout.strip().split("\n")[:10]:
                uncommitted.append(f"  {line}")
        
        # Build context
        context_parts.append(f"**Branch:** `{current_branch}`")
        context_parts.append(f"**Base Branch:** `{base_branch}`")
        context_parts.append(f"**Worktree Path:** `{worktree_path.relative_to(project_dir)}`")
        
        if task_id:
            context_parts.append(f"**Task ID:** `{task_id}`")
        
        if changed_files:
            context_parts.append(f"\n**Changed Files** (vs {base_branch}):\n" + "\n".join(changed_files))
        
        if uncommitted:
            context_parts.append(f"\n**Uncommitted Changes:**\n" + "\n".join(uncommitted))
        
        return "## Worktree Context\n\n" + "\n".join(context_parts)
        
    except Exception as e:
        debug_error("insights_runner", f"Failed to load worktree context: {e}")
        return f"## Worktree Context\n\n**Worktree Path:** `{worktree_path}`\n(Context loading failed)"


def load_project_context(project_dir: str, worktree_path: str | None = None) -> str:
    """Load project context for the AI."""
    context_parts = []
    
    # Add worktree context if provided
    if worktree_path:
        worktree_ctx = load_worktree_context(Path(worktree_path), Path(project_dir))
        context_parts.append(worktree_ctx)

    # Load project index if available (from .auto-claude - the installed instance)
    index_path = Path(project_dir) / ".auto-claude" / "project_index.json"
    if index_path.exists():
        try:
            with open(index_path, encoding="utf-8") as f:
                index = json.load(f)
            # Summarize the index for context
            summary = {
                "project_root": index.get("project_root", ""),
                "project_type": index.get("project_type", "unknown"),
                "services": list(index.get("services", {}).keys()),
                "infrastructure": index.get("infrastructure", {}),
            }
            context_parts.append(
                f"## Project Structure\n```json\n{json.dumps(summary, indent=2)}\n```"
            )
        except Exception:
            pass

    # Load roadmap if available
    roadmap_path = Path(project_dir) / ".auto-claude" / "roadmap" / "roadmap.json"
    if roadmap_path.exists():
        try:
            with open(roadmap_path, encoding="utf-8") as f:
                roadmap = json.load(f)
            # Summarize roadmap
            features = roadmap.get("features", [])
            feature_summary = [
                {"title": f.get("title", ""), "status": f.get("status", "")}
                for f in features[:10]
            ]
            context_parts.append(
                f"## Roadmap Features\n```json\n{json.dumps(feature_summary, indent=2)}\n```"
            )
        except Exception:
            pass

    # Load existing tasks
    tasks_path = Path(project_dir) / ".auto-claude" / "specs"
    if tasks_path.exists():
        try:
            task_dirs = [d for d in tasks_path.iterdir() if d.is_dir()]
            task_names = [d.name for d in task_dirs[:10]]
            if task_names:
                context_parts.append(
                    "## Existing Tasks/Specs\n- " + "\n- ".join(task_names)
                )
        except Exception:
            pass

    return (
        "\n\n".join(context_parts)
        if context_parts
        else "No project context available yet."
    )


def build_system_prompt(project_dir: str, worktree_path: str | None = None) -> str:
    """Build the system prompt for the insights agent."""
    context = load_project_context(project_dir, worktree_path)

    return f"""You are an AI coding assistant with full access to the project codebase.
You can read, write, edit files, and run shell commands — just like the Claude CLI.

Project context:

{context}

Your capabilities:
1. Read, search, and explore the codebase (Read, Glob, Grep)
2. Write new files and edit existing ones (Write, Edit)
3. Run shell commands, tests, builds, and scripts (Bash)
4. Look up documentation and search the web (WebFetch, WebSearch)
5. Answer questions about architecture, patterns, and code
6. Implement features, fix bugs, refactor code
7. Help plan and review implementations

When the user asks you to create an Auto-Build task, or when you believe creating one would be helpful, output a task suggestion in this exact format on a SINGLE LINE:
__TASK_SUGGESTION__:{{"title": "Task title here", "description": "Detailed description of what the task involves", "metadata": {{"category": "feature", "complexity": "medium", "impact": "medium"}}}}

Valid categories: feature, bug_fix, refactoring, documentation, security, performance, ui_ux, infrastructure, testing
Valid complexity: trivial, small, medium, large, complex
Valid impact: low, medium, high, critical

Be conversational and helpful. When editing code, explain what you changed and why.
Keep responses concise but informative."""


async def run_with_sdk(
    project_dir: str,
    message: str,
    history: list,
    model: str = "sonnet",  # Shorthand - resolved via API Profile if configured
    thinking_level: str = "medium",
    worktree_path: str | None = None,
) -> None:
    """Run the chat using Claude SDK with streaming."""
    if not SDK_AVAILABLE:
        print("Claude SDK not available, falling back to simple mode", file=sys.stderr)
        run_simple(project_dir, message, history)
        return

    if not get_auth_token():
        print(
            "No authentication token found, falling back to simple mode",
            file=sys.stderr,
        )
        run_simple(project_dir, message, history)
        return

    # Ensure SDK can find the token
    ensure_claude_code_oauth_token()

    system_prompt = build_system_prompt(project_dir, worktree_path)
    
    # Use worktree path as working directory if provided, otherwise project root
    working_dir = Path(worktree_path).resolve() if worktree_path else Path(project_dir).resolve()

    # Build conversation context from history
    # Handle both simple string content and multi-part content (with images)
    conversation_context = ""
    for msg in history[:-1]:  # Exclude the latest message
        role = "User" if msg.get("role") == "user" else "Assistant"
        content = msg.get("content", "")
        if isinstance(content, list):
            # Multi-part content (images + text) - extract text parts for context
            text_parts = [block.get("text", "") for block in content if block.get("type") == "text"]
            content = " ".join(text_parts)
        conversation_context += f"\n{role}: {content}\n"

    # Check if the latest message has image content
    latest_msg = history[-1] if history else None
    has_images = latest_msg and isinstance(latest_msg.get("content"), list)

    # Build the full prompt with conversation history
    if has_images:
        # For messages with images, we need to construct a multi-part prompt
        # The SDK will receive the image blocks directly
        image_blocks = [
            block for block in latest_msg["content"]
            if block.get("type") == "image"
        ]
        text_parts = [
            block.get("text", "") for block in latest_msg["content"]
            if block.get("type") == "text"
        ]
        text_content = " ".join(text_parts) or message

        if conversation_context.strip():
            full_prompt = f"""Previous conversation:
{conversation_context}

Current question: {text_content}

[The user has also attached {len(image_blocks)} image(s) to this message. Please analyze them.]"""
        else:
            full_prompt = text_content
    else:
        full_prompt = message
        if conversation_context.strip():
            full_prompt = f"""Previous conversation:
{conversation_context}

Current question: {message}"""

    # Convert thinking level to token budget
    max_thinking_tokens = get_thinking_budget(thinking_level)

    debug(
        "insights_runner",
        "Using model configuration",
        model=model,
        thinking_level=thinking_level,
        max_thinking_tokens=max_thinking_tokens,
    )

    try:
        options_kwargs = {
            "model": resolve_model_id(model),  # Resolve via API Profile if configured
            "system_prompt": system_prompt,
            "allowed_tools": ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebFetch", "WebSearch"],
            "max_turns": 50,
            "cwd": str(working_dir),
        }

        options_kwargs["max_thinking_tokens"] = max_thinking_tokens

        # Create Claude SDK client with appropriate settings for insights
        client = ClaudeSDKClient(options=ClaudeAgentOptions(**options_kwargs))

        # Use async context manager pattern
        async with client:
            # Send the query - include image blocks if present
            if has_images and image_blocks:
                # Build multi-part content for the query
                query_content = []
                for img_block in image_blocks:
                    query_content.append(img_block)
                query_content.append({"type": "text", "text": full_prompt})
                await client.query(query_content)
            else:
                await client.query(full_prompt)

            # Stream the response
            response_text = ""
            current_tool = None

            async for msg in client.receive_response():
                msg_type = type(msg).__name__
                debug_detailed("insights_runner", "Received message", msg_type=msg_type)

                if msg_type == "AssistantMessage" and hasattr(msg, "content"):
                    for block in msg.content:
                        block_type = type(block).__name__
                        debug_detailed(
                            "insights_runner", "Processing block", block_type=block_type
                        )
                        if block_type == "TextBlock" and hasattr(block, "text"):
                            text = block.text
                            debug_detailed(
                                "insights_runner", "Text block", text_length=len(text)
                            )
                            # Print text with newline to ensure proper line separation for parsing
                            print(text, flush=True)
                            response_text += text
                        elif block_type == "ToolUseBlock" and hasattr(block, "name"):
                            # Emit tool start marker for UI feedback
                            tool_name = block.name
                            tool_input = ""

                            # Extract a brief description of what the tool is doing
                            if hasattr(block, "input") and block.input:
                                inp = block.input
                                if isinstance(inp, dict):
                                    if "pattern" in inp:
                                        tool_input = f"pattern: {inp['pattern']}"
                                    elif "file_path" in inp:
                                        # Shorten path for display
                                        fp = inp["file_path"]
                                        if len(fp) > 50:
                                            fp = "..." + fp[-47:]
                                        tool_input = fp
                                    elif "path" in inp:
                                        tool_input = inp["path"]

                            current_tool = tool_name
                            print(
                                f"__TOOL_START__:{json.dumps({'name': tool_name, 'input': tool_input})}",
                                flush=True,
                            )

                elif msg_type == "ToolResult":
                    # Tool finished executing
                    if current_tool:
                        print(
                            f"__TOOL_END__:{json.dumps({'name': current_tool})}",
                            flush=True,
                        )
                        current_tool = None

            # Ensure we have a newline at the end
            if response_text and not response_text.endswith("\n"):
                print()

            debug(
                "insights_runner",
                "Response complete",
                response_length=len(response_text),
            )

    except Exception as e:
        print(f"Error using Claude SDK: {e}", file=sys.stderr)
        import traceback

        traceback.print_exc(file=sys.stderr)
        run_simple(project_dir, message, history)


def run_simple(project_dir: str, message: str, history: list) -> None:
    """Simple fallback mode without SDK - uses subprocess to call claude CLI."""
    import subprocess

    system_prompt = build_system_prompt(project_dir)

    # Build conversation context
    conversation_context = ""
    for msg in history[:-1]:
        role = "User" if msg.get("role") == "user" else "Assistant"
        conversation_context += f"\n{role}: {msg['content']}\n"

    # Create the full prompt
    full_prompt = f"""{system_prompt}

Previous conversation:
{conversation_context}

User: {message}
Assistant:"""

    try:
        # Try to use claude CLI with --print for simple output
        result = subprocess.run(
            ["claude", "--print", "-p", full_prompt],
            capture_output=True,
            text=True,
            cwd=project_dir,
            timeout=120,
        )

        if result.returncode == 0:
            print(result.stdout)
        else:
            # Fallback response if claude CLI fails
            print(
                f"I apologize, but I encountered an issue processing your request. "
                f"Please ensure Claude CLI is properly configured.\n\n"
                f"Your question was: {message}\n\n"
                f"Based on the project context available, I can help you with:\n"
                f"- Understanding the codebase structure\n"
                f"- Suggesting improvements\n"
                f"- Planning new features\n\n"
                f"Please try again or check your Claude CLI configuration."
            )

    except subprocess.TimeoutExpired:
        print("Request timed out. Please try a shorter query.")
    except FileNotFoundError:
        print("Claude CLI not found. Please ensure it is installed and in your PATH.")
    except Exception as e:
        print(f"Error: {e}")


def main():
    parser = argparse.ArgumentParser(description="Insights AI Chat Runner")
    parser.add_argument("--project-dir", required=True, help="Project directory path")
    parser.add_argument("--message", required=True, help="User message")
    parser.add_argument("--history", default="[]", help="JSON conversation history")
    parser.add_argument(
        "--history-file", help="Path to JSON file containing conversation history"
    )
    parser.add_argument(
        "--model",
        default="sonnet",
        help="Model to use (haiku, sonnet, opus, or full model ID)",
    )
    parser.add_argument(
        "--thinking-level",
        default="medium",
        help="Thinking level for extended reasoning (low, medium, high)",
    )
    parser.add_argument(
        "--worktree-path",
        help="Optional worktree path to provide branch-specific context (defaults to project root)",
    )
    args = parser.parse_args()

    # Validate and sanitize thinking level (handles legacy values like 'ultrathink')
    args.thinking_level = sanitize_thinking_level(args.thinking_level)

    debug_section("insights_runner", "Starting Insights Chat")

    project_dir = args.project_dir
    user_message = args.message
    model = args.model
    thinking_level = args.thinking_level
    worktree_path = args.worktree_path

    debug(
        "insights_runner",
        "Arguments",
        project_dir=project_dir,
        message_length=len(user_message),
        model=model,
        thinking_level=thinking_level,
        worktree_path=worktree_path,
    )

    # Load history from file if provided, otherwise parse inline JSON
    try:
        if args.history_file:
            debug(
                "insights_runner", "Loading history from file", file=args.history_file
            )
            with open(args.history_file, encoding="utf-8") as f:
                history = json.load(f)
            debug_detailed(
                "insights_runner",
                "Loaded history from file",
                history_length=len(history),
            )
        else:
            history = json.loads(args.history)
            debug_detailed(
                "insights_runner", "Parsed inline history", history_length=len(history)
            )
    except (json.JSONDecodeError, FileNotFoundError, OSError) as e:
        debug_error("insights_runner", f"Failed to load history: {e}")
        history = []

    # Run the async SDK function
    debug("insights_runner", "Running SDK query")
    asyncio.run(run_with_sdk(project_dir, user_message, history, model, thinking_level, worktree_path))
    debug_success("insights_runner", "Query completed")


if __name__ == "__main__":
    main()

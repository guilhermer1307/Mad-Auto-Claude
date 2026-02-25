"""
Tool Executor for Non-Claude Models
=====================================

Executes tools (Read, Write, Edit, Bash, Glob, Grep) locally for models
that don't have built-in tool execution (e.g., OpenAI, Gemini via OpenRouter).

These tools match the Claude Code CLI tool interfaces so that prompts written
for Claude can work with other models without modification.
"""

import glob as glob_module
import os
import re
import subprocess
from pathlib import Path

# Maximum output size for tool results (to prevent token bloat)
MAX_RESULT_LENGTH = 50000


def _truncate(text: str, max_len: int = MAX_RESULT_LENGTH) -> str:
    """Truncate text to max length with indicator."""
    if len(text) <= max_len:
        return text
    return text[:max_len] + f"\n\n... (truncated, {len(text)} total characters)"


class ToolExecutor:
    """
    Executes tools in the context of a project directory.

    Provides Read, Write, Edit, Bash, Glob, and Grep tools that match
    the Claude Code CLI tool interfaces.
    """

    def __init__(self, project_dir: Path):
        self.project_dir = project_dir.resolve()

    def _resolve_path(self, file_path: str) -> Path:
        """Resolve a file path relative to the project directory."""
        path = Path(file_path)
        if not path.is_absolute():
            path = self.project_dir / path
        resolved = path.resolve()
        # Security: ensure path is within project directory
        if not str(resolved).startswith(str(self.project_dir)):
            raise ValueError(f"Path {file_path} resolves outside project directory")
        return resolved

    def execute(self, tool_name: str, tool_input: dict) -> str:
        """
        Execute a tool and return the result as a string.

        Args:
            tool_name: Name of the tool (Read, Write, Edit, Bash, Glob, Grep)
            tool_input: Tool-specific input parameters

        Returns:
            Tool result as a string
        """
        handlers = {
            "Read": self._read,
            "Write": self._write,
            "Edit": self._edit,
            "Bash": self._bash,
            "Glob": self._glob,
            "Grep": self._grep,
        }

        handler = handlers.get(tool_name)
        if not handler:
            return f"Error: Unknown tool '{tool_name}'. Available tools: {', '.join(handlers.keys())}"

        try:
            return handler(tool_input)
        except Exception as e:
            return f"Error executing {tool_name}: {str(e)}"

    def _read(self, inp: dict) -> str:
        """Read a file's contents."""
        file_path = inp.get("file_path", "")
        offset = inp.get("offset", 0)
        limit = inp.get("limit", 2000)

        path = self._resolve_path(file_path)
        if not path.exists():
            return f"Error: File not found: {file_path}"
        if path.is_dir():
            return f"Error: {file_path} is a directory, not a file"

        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()

            # Apply offset and limit
            start = max(0, offset)
            end = start + limit if limit else len(lines)
            selected = lines[start:end]

            # Format with line numbers (cat -n style)
            result = ""
            for i, line in enumerate(selected, start=start + 1):
                result += f"     {i}\t{line}"

            return _truncate(result) if result else "(empty file)"
        except Exception as e:
            return f"Error reading {file_path}: {str(e)}"

    def _write(self, inp: dict) -> str:
        """Write content to a file."""
        file_path = inp.get("file_path", "")
        content = inp.get("content", "")

        path = self._resolve_path(file_path)
        # Create parent directories if needed
        path.parent.mkdir(parents=True, exist_ok=True)

        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            return f"Successfully wrote {len(content)} characters to {file_path}"
        except Exception as e:
            return f"Error writing {file_path}: {str(e)}"

    def _edit(self, inp: dict) -> str:
        """Edit a file by replacing old_string with new_string."""
        file_path = inp.get("file_path", "")
        old_string = inp.get("old_string", "")
        new_string = inp.get("new_string", "")
        replace_all = inp.get("replace_all", False)

        path = self._resolve_path(file_path)
        if not path.exists():
            return f"Error: File not found: {file_path}"

        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()

            count = content.count(old_string)
            if count == 0:
                return f"Error: old_string not found in {file_path}"
            if count > 1 and not replace_all:
                return f"Error: old_string found {count} times in {file_path}. Use replace_all=true or provide more context."

            if replace_all:
                new_content = content.replace(old_string, new_string)
            else:
                new_content = content.replace(old_string, new_string, 1)

            with open(path, "w", encoding="utf-8") as f:
                f.write(new_content)

            return f"Successfully edited {file_path} ({count} replacement{'s' if count > 1 else ''})"
        except Exception as e:
            return f"Error editing {file_path}: {str(e)}"

    def _bash(self, inp: dict) -> str:
        """Execute a bash command."""
        command = inp.get("command", "")
        timeout = min(inp.get("timeout", 120000), 600000) / 1000  # ms to seconds

        if not command:
            return "Error: No command provided"

        try:
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=str(self.project_dir),
                env={**os.environ},
            )

            output = ""
            if result.stdout:
                output += result.stdout
            if result.stderr:
                if output:
                    output += "\n"
                output += result.stderr

            if result.returncode != 0:
                output += f"\n(exit code: {result.returncode})"

            return _truncate(output) if output else "(no output)"
        except subprocess.TimeoutExpired:
            return f"Error: Command timed out after {timeout}s"
        except Exception as e:
            return f"Error executing command: {str(e)}"

    def _glob(self, inp: dict) -> str:
        """Find files matching a glob pattern."""
        pattern = inp.get("pattern", "")
        search_path = inp.get("path", str(self.project_dir))

        if not pattern:
            return "Error: No pattern provided"

        base = self._resolve_path(search_path) if search_path != str(self.project_dir) else self.project_dir

        try:
            matches = sorted(glob_module.glob(str(base / pattern), recursive=True))
            # Convert to relative paths
            rel_matches = []
            for m in matches:
                try:
                    rel = os.path.relpath(m, str(self.project_dir))
                    rel_matches.append(rel)
                except ValueError:
                    rel_matches.append(m)

            if not rel_matches:
                return f"No files matching pattern: {pattern}"

            return "\n".join(rel_matches[:500])  # Cap at 500 results
        except Exception as e:
            return f"Error: {str(e)}"

    def _grep(self, inp: dict) -> str:
        """Search file contents for a pattern."""
        pattern = inp.get("pattern", "")
        search_path = inp.get("path", str(self.project_dir))
        file_glob = inp.get("glob", "")
        output_mode = inp.get("output_mode", "files_with_matches")
        case_insensitive = inp.get("-i", False)

        if not pattern:
            return "Error: No pattern provided"

        base = self._resolve_path(search_path) if search_path != str(self.project_dir) else self.project_dir

        try:
            flags = re.IGNORECASE if case_insensitive else 0
            regex = re.compile(pattern, flags)
        except re.error as e:
            return f"Error: Invalid regex pattern: {str(e)}"

        results = []
        try:
            # Walk directory or single file
            if base.is_file():
                files = [base]
            else:
                if file_glob:
                    files = [Path(f) for f in glob_module.glob(str(base / "**" / file_glob), recursive=True)]
                else:
                    files = [f for f in base.rglob("*") if f.is_file()]

            for filepath in files[:1000]:  # Cap file count
                if not filepath.is_file():
                    continue
                # Skip binary files and large files
                try:
                    if filepath.stat().st_size > 1_000_000:
                        continue
                    with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
                        for line_num, line in enumerate(f, 1):
                            if regex.search(line):
                                rel = os.path.relpath(str(filepath), str(self.project_dir))
                                if output_mode == "files_with_matches":
                                    if rel not in results:
                                        results.append(rel)
                                elif output_mode == "content":
                                    results.append(f"{rel}:{line_num}:{line.rstrip()}")
                                elif output_mode == "count":
                                    results.append(f"{rel}:{line_num}")
                                if len(results) > 500:
                                    break
                except (OSError, UnicodeDecodeError):
                    continue

                if len(results) > 500:
                    break

            if not results:
                return f"No matches found for pattern: {pattern}"

            return _truncate("\n".join(results))
        except Exception as e:
            return f"Error: {str(e)}"


# Tool definitions for OpenAI function calling format
TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "Read",
            "description": "Read a file's contents. Returns the file with line numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Absolute or relative path to the file to read"},
                    "offset": {"type": "integer", "description": "Line number to start reading from (0-based)"},
                    "limit": {"type": "integer", "description": "Number of lines to read"},
                },
                "required": ["file_path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "Write",
            "description": "Write content to a file (creates or overwrites).",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Path to the file to write"},
                    "content": {"type": "string", "description": "Content to write to the file"},
                },
                "required": ["file_path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "Edit",
            "description": "Edit a file by replacing old_string with new_string. The old_string must be unique in the file unless replace_all is true.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Path to the file to edit"},
                    "old_string": {"type": "string", "description": "The exact text to find and replace"},
                    "new_string": {"type": "string", "description": "The replacement text"},
                    "replace_all": {"type": "boolean", "description": "Replace all occurrences (default: false)"},
                },
                "required": ["file_path", "old_string", "new_string"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "Bash",
            "description": "Execute a bash command in the project directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The bash command to execute"},
                    "timeout": {"type": "integer", "description": "Timeout in milliseconds (max 600000)"},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "Glob",
            "description": "Find files matching a glob pattern.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Glob pattern (e.g., '**/*.py', 'src/**/*.ts')"},
                    "path": {"type": "string", "description": "Directory to search in (default: project root)"},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "Grep",
            "description": "Search file contents for a regex pattern.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regex pattern to search for"},
                    "path": {"type": "string", "description": "File or directory to search in"},
                    "glob": {"type": "string", "description": "File glob filter (e.g., '*.py')"},
                    "output_mode": {"type": "string", "enum": ["content", "files_with_matches", "count"], "description": "Output format"},
                    "-i": {"type": "boolean", "description": "Case insensitive search"},
                },
                "required": ["pattern"],
            },
        },
    },
]

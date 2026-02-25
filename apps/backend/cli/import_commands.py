"""
Import Commands
===============

CLI commands for importing external module specs into Auto Claude.
"""

from __future__ import annotations

import json
from pathlib import Path

from ui import highlight, print_status


def _status_marker(status: str) -> str:
    """Return a colored status marker for task display."""
    if status == "completed":
        return "\033[32m[done]\033[0m"
    elif status == "in_progress":
        return "\033[33m[wip] \033[0m"
    elif status == "failed":
        return "\033[31m[fail]\033[0m"
    elif status == "blocked":
        return "\033[90m[blk] \033[0m"
    return "\033[37m[todo]\033[0m"


def _progress_bar(done: int, total: int, width: int = 20) -> str:
    """Render a simple progress bar."""
    if total == 0:
        return "░" * width
    filled = int(width * done / total)
    return "█" * filled + "░" * (width - filled)


def print_task_list(spec_dir: Path) -> None:
    """
    Print a formatted list of all tasks from the implementation plan.

    Shows phases, subtasks, status, and dependencies.
    """
    plan_file = spec_dir / "implementation_plan.json"
    if not plan_file.exists():
        print_status("No implementation plan found", "warning")
        return

    with open(plan_file, encoding="utf-8") as f:
        plan = json.load(f)

    phases = plan.get("phases", [])
    total = sum(len(p.get("subtasks", [])) for p in phases)
    completed = sum(
        1
        for p in phases
        for s in p.get("subtasks", [])
        if s.get("status") == "completed"
    )

    print()
    print(highlight(f"Tasks ({total} total, {completed} completed):"))
    print()

    for phase in phases:
        phase_num = phase.get("phase", "?")
        phase_name = phase.get("name", "Unknown")
        subtasks = phase.get("subtasks", [])
        deps = phase.get("depends_on", [])
        phase_done = sum(1 for s in subtasks if s.get("status") == "completed")

        dep_str = ""
        if deps:
            dep_str = f"  \033[90m[depends on: Phase {', '.join(str(d) for d in deps)}]\033[0m"

        print(
            f"  Phase {phase_num}: {phase_name} ({phase_done}/{len(subtasks)}){dep_str}"
        )

        for subtask in subtasks:
            sid = subtask.get("id", "?")
            status = subtask.get("status", "pending")
            desc = subtask.get("description", "No description")
            # Truncate description
            if len(desc) > 70:
                desc = desc[:67] + "..."
            marker = _status_marker(status)
            print(f"    {sid:<6} {marker}  {desc}")

        print()


def print_task_progress(spec_dir: Path) -> None:
    """
    Print a progress summary with bars for each phase.

    Example:
        Task Progress: 5/38 completed (13%)
          Phase 1: ████████░░░░ 8/11
          Phase 2: ░░░░░░░░░░░░ 0/6  [waiting on Phase 1]
    """
    plan_file = spec_dir / "implementation_plan.json"
    if not plan_file.exists():
        return

    with open(plan_file, encoding="utf-8") as f:
        plan = json.load(f)

    phases = plan.get("phases", [])
    total = sum(len(p.get("subtasks", [])) for p in phases)
    completed = sum(
        1
        for p in phases
        for s in p.get("subtasks", [])
        if s.get("status") == "completed"
    )

    pct = int(completed / total * 100) if total > 0 else 0
    print()
    print(highlight(f"Task Progress: {completed}/{total} completed ({pct}%)"))

    # Check which phases are complete (for dependency display)
    phase_complete: dict[int, bool] = {}
    for phase in phases:
        pnum = phase.get("phase", 0)
        subtasks = phase.get("subtasks", [])
        phase_complete[pnum] = all(
            s.get("status") == "completed" for s in subtasks
        )

    for phase in phases:
        phase_num = phase.get("phase", 0)
        phase_name = phase.get("name", "Unknown")
        subtasks = phase.get("subtasks", [])
        deps = phase.get("depends_on", [])
        done = sum(1 for s in subtasks if s.get("status") == "completed")

        bar = _progress_bar(done, len(subtasks))

        blocked_str = ""
        if deps:
            unmet = [d for d in deps if not phase_complete.get(d, False)]
            if unmet:
                blocked_str = f"  \033[90m[waiting on Phase {', '.join(str(d) for d in unmet)}]\033[0m"

        print(f"  Phase {phase_num}: {bar} {done}/{len(subtasks)}  {phase_name}{blocked_str}")

    print()


def handle_import_module_command(
    module_path: str,
    project_dir: Path,
) -> bool:
    """
    Import an external module folder into Auto Claude specs.

    Args:
        module_path: Path to the module folder
        project_dir: Target project directory

    Returns:
        True if successful
    """
    from importers.skills_importer import import_module

    path = Path(module_path).resolve()
    if not path.exists():
        print_status(f"Module path not found: {module_path}", "error")
        return False

    try:
        spec_dir = import_module(path, project_dir)
        print_status(
            f"Module imported successfully: {highlight(spec_dir.name)}",
            "success",
        )

        # Print the full task list
        print_task_list(spec_dir)

        # Print progress summary
        print_task_progress(spec_dir)

        # Print reference files
        ref_dir = spec_dir / "reference"
        print(highlight("Reference files:"))
        if ref_dir.exists():
            for ref_file in sorted(ref_dir.iterdir()):
                print(f"  - reference/{ref_file.name}")
        tasks_count = len(list((spec_dir / "tasks").glob("*.md")))
        print(f"  - tasks/ ({tasks_count} task files)")

        # Print next steps
        spec_num = spec_dir.name[:3]
        print()
        print(highlight("Next steps:"))
        print(f"  1. Review the spec:  cat {spec_dir}/spec.md")
        print(f"  2. Review the plan:  cat {spec_dir}/implementation_plan.json")
        print(
            f"  3. Start building:   python run.py --spec {spec_num} --skip-planning"
        )

        return True
    except ValueError as e:
        print_status(f"Validation error: {e}", "error")
        return False
    except Exception as e:
        print_status(f"Import failed: {e}", "error")
        return False

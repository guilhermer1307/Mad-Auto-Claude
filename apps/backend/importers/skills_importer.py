"""
Skills Module Importer
======================

Imports external module folders (from mm-ai-portal-skills or similar)
into Auto Claude spec directories. Converts task markdown files into
a valid implementation_plan.json with phases grouped by architectural layer.

Usage:
    from importers.skills_importer import import_module
    spec_dir = import_module(Path("output/project/auth"), Path("/target/project"))
"""

from __future__ import annotations

import json
import re
import shutil
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# Layer range → (min, max, phase_number, phase_name, phase_type)
LAYER_RANGES = [
    (0, 99, 1, "Domain Layer", "implementation"),
    (100, 199, 2, "Infrastructure Layer", "implementation"),
    (200, 299, 3, "Application Layer", "implementation"),
    (300, 399, 4, "Presentation Layer", "implementation"),
    (400, 499, 5, "Integration", "integration"),
    (500, 599, 6, "Migration", "implementation"),
    (600, 699, 7, "Testing", "implementation"),
]


def validate_module_structure(module_path: Path) -> None:
    """Validate the input module folder has the expected structure."""
    if not module_path.is_dir():
        raise ValueError(f"Module path is not a directory: {module_path}")

    if not (module_path / "reviewed-to-be.md").exists():
        raise ValueError(
            f"Missing required file: reviewed-to-be.md in {module_path}"
        )

    tasks_dir = module_path / "tasks"
    if not tasks_dir.is_dir():
        raise ValueError(f"Missing tasks directory: {tasks_dir}")

    task_files = list(tasks_dir.glob("[0-9]*.md"))
    if not task_files:
        raise ValueError(f"No task files found in {tasks_dir}")


def parse_task_file(path: Path) -> dict:
    """
    Parse a single task markdown file and extract structured data.

    Args:
        path: Path to the task .md file (e.g., 001-domain-entities.md)

    Returns:
        Dict with parsed fields: number, filename, title, metadata,
        objective, dependencies, acceptance_criteria, files_to_create,
        full_content, etc.
    """
    content = path.read_text(encoding="utf-8")
    filename = path.stem  # e.g., "001-domain-entities"

    # Extract task number from filename
    num_match = re.match(r"(\d+)", filename)
    task_number = int(num_match.group(1)) if num_match else 0

    # Extract title (first H1)
    title_match = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
    title = title_match.group(1).strip() if title_match else filename

    # Extract metadata
    metadata = _parse_metadata(content)

    # Extract objective
    objective = _extract_section(content, "Objective")

    # Extract dependencies from Description section
    dependencies = _parse_dependencies(content)

    # Extract acceptance criteria
    acceptance_criteria = _parse_acceptance_criteria(content)

    # Extract files from Step-by-Step Execution
    files_to_create = _extract_file_paths(content)

    # Extract business rules
    br_match = re.search(
        r"\*\*Business Rules Applied:\*\*\s*(.+)", content
    )
    business_rules = []
    if br_match:
        br_text = br_match.group(1).strip()
        if br_text.lower() not in ("none", "n/a", "none (pure data structures)"):
            business_rules = re.findall(r"BR-[\w-]+", br_text)

    return {
        "number": task_number,
        "filename": filename,
        "title": title,
        "metadata": metadata,
        "objective": objective,
        "dependencies": dependencies,
        "acceptance_criteria": acceptance_criteria,
        "files_to_create": files_to_create,
        "business_rules": business_rules,
        "full_content": content,
    }


def _parse_metadata(content: str) -> dict:
    """Extract Type, Priority, Estimate, Module/Domain from metadata section."""
    metadata = {
        "type": "Core",
        "priority": "Medium",
        "estimate": 5,
        "module_domain": "",
    }

    # Type: find which checkbox is checked
    type_match = re.search(
        r"\*\*Type\*\*:\s*(.+)", content
    )
    if type_match:
        type_line = type_match.group(1)
        for option in ("Core", "Feature", "Integration", "Infrastructure"):
            if f"[x] {option}" in type_line:
                metadata["type"] = option
                break

    # Priority: find which checkbox is checked
    priority_match = re.search(
        r"\*\*Priority\*\*:\s*(.+)", content
    )
    if priority_match:
        priority_line = priority_match.group(1)
        for option in ("Critical", "High", "Medium", "Low"):
            if f"[x] {option}" in priority_line:
                metadata["priority"] = option
                break

    # Estimate
    estimate_match = re.search(
        r"\*\*Estimate\*\*:\s*(\d+)", content
    )
    if estimate_match:
        metadata["estimate"] = int(estimate_match.group(1))

    # Module/Domain
    domain_match = re.search(
        r"\*\*Module/Domain\*\*:\s*(.+)", content
    )
    if domain_match:
        metadata["module_domain"] = domain_match.group(1).strip()

    return metadata


def _extract_section(content: str, heading: str) -> str:
    """Extract the text content of a markdown section (until next heading)."""
    pattern = rf"^##\s+{re.escape(heading)}\s*\n(.*?)(?=^##\s|\Z)"
    match = re.search(pattern, content, re.MULTILINE | re.DOTALL)
    if match:
        return match.group(1).strip()
    return ""


def _parse_dependencies(content: str) -> list[int]:
    """Extract task number dependencies from the Description section."""
    deps = []

    # Look for "Dependencies:" line
    dep_match = re.search(
        r"\*\*Dependencies:\*\*\s*(.+)", content
    )
    if dep_match:
        dep_text = dep_match.group(1).strip()
        if dep_text.lower() not in ("none", "n/a", "none — this is the foundational task."):
            # Extract numbers (e.g., "001, 002, 003" or "006, 007, 008, 010")
            deps.extend(int(n) for n in re.findall(r"\b(\d{1,3})\b", dep_text))

    return deps


def _parse_acceptance_criteria(content: str) -> list[str]:
    """Extract acceptance criteria (checkbox items) from the section."""
    criteria = []
    section = _extract_section(content, "Acceptance Criteria (Use Cases)")
    if not section:
        section = _extract_section(content, "Acceptance Criteria")
    if section:
        for line in section.splitlines():
            line = line.strip()
            if line.startswith("- [ ]") or line.startswith("- [x]"):
                # Remove the checkbox prefix
                text = re.sub(r"^-\s*\[[ x]\]\s*", "", line)
                if text:
                    criteria.append(text)
    return criteria


def _extract_file_paths(content: str) -> list[str]:
    """Extract file paths from the Step-by-Step Execution section."""
    files = []
    section = _extract_section(content, "Step-by-Step Execution")
    if section:
        # Look for file paths in tree structures (├── path/to/file.ext)
        for match in re.finditer(
            r"[├└│─\s]+(\S+/\S+\.\w+)", section
        ):
            path = match.group(1).strip()
            # Filter out obvious non-file-paths
            if "/" in path and not path.startswith("http"):
                files.append(path)
    return files


def get_phase_for_task(task_number: int) -> tuple[int, str, str]:
    """
    Map a task number to its phase.

    Returns:
        (phase_number, phase_name, phase_type)
    """
    for low, high, phase_num, name, ptype in LAYER_RANGES:
        if low <= task_number <= high:
            return phase_num, name, ptype

    # Fallback for numbers outside known ranges
    return 8, "Other", "implementation"


def _compute_phase_dependencies(
    phases_by_number: dict[int, list[dict]],
) -> dict[int, list[int]]:
    """
    Compute phase-level depends_on from inter-task dependencies.

    A phase depends on another if ANY task in it depends on a task in the other phase.
    """
    # Build task -> phase mapping
    task_to_phase: dict[int, int] = {}
    for phase_num, tasks in phases_by_number.items():
        for task in tasks:
            task_to_phase[task["number"]] = phase_num

    # Compute raw phase dependencies
    phase_deps: dict[int, set[int]] = defaultdict(set)
    for phase_num, tasks in phases_by_number.items():
        for task in tasks:
            for dep_num in task["dependencies"]:
                dep_phase = task_to_phase.get(dep_num)
                if dep_phase is not None and dep_phase != phase_num:
                    phase_deps[phase_num].add(dep_phase)

    return {k: sorted(v) for k, v in phase_deps.items()}


def build_implementation_plan(tasks: list[dict], module_name: str) -> dict:
    """
    Build a valid implementation_plan.json from parsed task files.

    Groups tasks by architectural layer (phase), computes inter-phase
    dependencies, and creates subtasks with proper IDs.

    Args:
        tasks: List of parsed task dicts from parse_task_file()
        module_name: Module name (e.g., "auth")

    Returns:
        Dict compatible with ImplementationPlan.from_dict()
    """
    # Group tasks by phase
    phases_by_number: dict[int, list[dict]] = defaultdict(list)
    for task in sorted(tasks, key=lambda t: t["number"]):
        phase_num, _, _ = get_phase_for_task(task["number"])
        phases_by_number[phase_num].append(task)

    # Compute phase dependencies
    phase_deps = _compute_phase_dependencies(phases_by_number)

    # Build phases
    phases = []
    for phase_num in sorted(phases_by_number.keys()):
        phase_tasks = phases_by_number[phase_num]
        _, phase_name, phase_type = get_phase_for_task(phase_tasks[0]["number"])

        subtasks = []
        for idx, task in enumerate(phase_tasks, 1):
            subtask_id = f"{phase_num}.{idx}"

            # Build description: title + objective
            description = task["title"]
            if task["objective"]:
                description += f": {task['objective']}"

            # Build verification referencing the task file
            verification = {
                "type": "manual",
                "scenario": (
                    f"Verify against acceptance criteria in "
                    f"tasks/{task['filename']}.md"
                ),
            }

            subtask = {
                "id": subtask_id,
                "description": description,
                "status": "pending",
                "task_file": f"{task['filename']}.md",
                "task_number": task["number"],
                "verification": verification,
            }

            if task["files_to_create"]:
                subtask["files_to_create"] = task["files_to_create"]

            subtasks.append(subtask)

        phase = {
            "phase": phase_num,
            "name": phase_name,
            "type": phase_type,
            "subtasks": subtasks,
            "depends_on": phase_deps.get(phase_num, []),
        }
        phases.append(phase)

    # Collect all acceptance criteria for final_acceptance
    all_criteria = []
    for task in tasks:
        if task["metadata"]["priority"] == "Critical":
            all_criteria.extend(task["acceptance_criteria"][:3])
    if not all_criteria:
        for task in tasks[:5]:
            all_criteria.extend(task["acceptance_criteria"][:2])

    total_points = sum(t["metadata"]["estimate"] for t in tasks)

    return {
        "feature": f"{module_name.title()} Module Implementation",
        "workflow_type": "feature",
        "services_involved": list(
            {t["metadata"]["module_domain"] for t in tasks if t["metadata"]["module_domain"]}
        ),
        "phases": phases,
        "final_acceptance": all_criteria[:20],
        "created_at": datetime.now().isoformat(),
        "spec_file": "spec.md",
        "description": (
            f"Imported from external skills output. "
            f"{len(tasks)} tasks across {len(phases)} phases. "
            f"Total estimate: {total_points} story points."
        ),
    }


def generate_spec_md(
    module_name: str,
    reviewed_to_be_path: Path,
    tasks: list[dict],
) -> str:
    """
    Generate a spec.md with the required sections.

    Args:
        module_name: Module name (e.g., "auth")
        reviewed_to_be_path: Path to reviewed-to-be.md
        tasks: List of parsed task dicts

    Returns:
        Markdown string for spec.md
    """
    # Extract summary from reviewed-to-be.md
    reviewed_content = reviewed_to_be_path.read_text(encoding="utf-8")
    # Get first ~500 chars after the first heading for the overview
    summary_match = re.search(
        r"^#[^#].*?\n\n(.+?)(?=\n##|\Z)",
        reviewed_content,
        re.DOTALL,
    )
    overview_text = ""
    if summary_match:
        overview_text = summary_match.group(1).strip()[:800]

    # Count tasks per phase
    phase_counts: dict[str, int] = defaultdict(int)
    total_points = 0
    for task in tasks:
        _, phase_name, _ = get_phase_for_task(task["number"])
        phase_counts[phase_name] += 1
        total_points += task["metadata"]["estimate"]

    # Collect critical acceptance criteria
    critical_criteria = []
    for task in tasks:
        if task["metadata"]["priority"] in ("Critical", "High"):
            critical_criteria.extend(task["acceptance_criteria"][:2])

    # Collect all files to create
    all_files = []
    for task in tasks:
        all_files.extend(task["files_to_create"][:5])

    sections = [
        f"# {module_name.title()} Module Implementation\n",
        "## Overview\n",
        f"Imported from external skills module definition.\n",
    ]

    if overview_text:
        sections.append(f"{overview_text}\n")

    sections.extend([
        "## Workflow Type\n",
        "feature\n",
        "## Task Scope\n",
        f"- **{len(tasks)} tasks** across **{len(phase_counts)} phases**",
        f"- **Total estimate:** {total_points} story points\n",
    ])

    for phase_name, count in sorted(phase_counts.items()):
        sections.append(f"  - {phase_name}: {count} tasks")

    sections.append("")

    sections.extend([
        "## Success Criteria\n",
    ])
    for criterion in critical_criteria[:15]:
        sections.append(f"- {criterion}")
    if not critical_criteria:
        sections.append("- All subtask acceptance criteria met")
        sections.append("- All unit and integration tests pass")
    sections.append("")

    if all_files:
        sections.extend([
            "## Files to Modify\n",
        ])
        for f in all_files[:20]:
            sections.append(f"- `{f}`")
        if len(all_files) > 20:
            sections.append(f"- ... and {len(all_files) - 20} more files")
        sections.append("")

    sections.extend([
        "## Files to Reference\n",
        "- `reference/reviewed-to-be.md` — Target architecture specification (source of truth)",
        "- `reference/as-is.md` — Current state documentation",
        "- `tasks/` — Individual task specifications with acceptance criteria\n",
        "## Implementation Notes\n",
        "Each subtask in the implementation plan corresponds to a detailed task specification",
        "in the `tasks/` directory. Before implementing a subtask, **READ the corresponding",
        "task file** for:",
        "- Detailed acceptance criteria (BDD format)",
        "- Step-by-step execution instructions with file paths",
        "- Business rules to apply",
        "- Error scenarios to handle",
        "- Test requirements\n",
        "The target architecture is documented in `reference/reviewed-to-be.md`.",
    ])

    return "\n".join(sections) + "\n"


def generate_requirements_json(tasks: list[dict], module_name: str) -> dict:
    """
    Generate requirements.json from parsed tasks.

    Args:
        tasks: List of parsed task dicts
        module_name: Module name

    Returns:
        Dict for requirements.json
    """
    # User requirements = objectives from critical tasks
    user_requirements = []
    for task in tasks:
        if task["objective"]:
            user_requirements.append(task["objective"])

    # Acceptance criteria from all tasks (capped)
    all_criteria = []
    for task in tasks:
        all_criteria.extend(task["acceptance_criteria"])

    # Services from metadata
    services = list(
        {t["metadata"]["module_domain"].split("/")[0]
         for t in tasks if t["metadata"]["module_domain"]}
    )

    return {
        "task_description": (
            f"Implement the {module_name} module according to the "
            f"reviewed TO-BE architecture specification"
        ),
        "workflow_type": "feature",
        "services_involved": services,
        "user_requirements": user_requirements,
        "acceptance_criteria": all_criteria[:50],
        "created_at": datetime.now().isoformat(),
    }


def build_task_context(tasks: list[dict], plan: dict) -> dict:
    """
    Pre-compute related task mappings for each subtask.

    For each task, finds related tasks based on:
    - Direct dependencies (from Dependencies field)
    - Shared files_to_create directories
    - Shared business rules

    Args:
        tasks: List of parsed task dicts
        plan: The generated implementation plan dict

    Returns:
        Dict with subtask_map and related_tasks
    """
    # Build task number → parsed task lookup
    task_by_number: dict[int, dict] = {t["number"]: t for t in tasks}

    # Build subtask_id → task_number mapping from the plan
    subtask_map: dict[str, dict] = {}
    for phase in plan.get("phases", []):
        for subtask in phase.get("subtasks", []):
            sid = subtask["id"]
            subtask_map[sid] = {
                "task_file": subtask.get("task_file", ""),
                "task_number": subtask.get("task_number", 0),
            }

    # Build task_number → subtask_id reverse mapping
    number_to_sid: dict[int, str] = {}
    for sid, info in subtask_map.items():
        number_to_sid[info["task_number"]] = sid

    # Build file directory index (which tasks touch which directories)
    dir_to_tasks: dict[str, set[int]] = defaultdict(set)
    for task in tasks:
        for fpath in task["files_to_create"]:
            # Get parent directory
            parts = fpath.rsplit("/", 1)
            if len(parts) > 1:
                dir_to_tasks[parts[0]].add(task["number"])

    # Build business rule index
    br_to_tasks: dict[str, set[int]] = defaultdict(set)
    for task in tasks:
        for br in task["business_rules"]:
            br_to_tasks[br].add(task["number"])

    # Compute related tasks for each task
    related_tasks: dict[str, list[int]] = {}
    for task in tasks:
        related: set[int] = set()

        # 1. Direct dependencies
        for dep in task["dependencies"]:
            if dep in task_by_number:
                related.add(dep)

        # 2. Tasks sharing file directories
        for fpath in task["files_to_create"]:
            parts = fpath.rsplit("/", 1)
            if len(parts) > 1:
                for other_num in dir_to_tasks[parts[0]]:
                    if other_num != task["number"]:
                        related.add(other_num)

        # 3. Tasks sharing business rules
        for br in task["business_rules"]:
            for other_num in br_to_tasks[br]:
                if other_num != task["number"]:
                    related.add(other_num)

        # Map to subtask ID
        sid = number_to_sid.get(task["number"])
        if sid and related:
            related_tasks[sid] = sorted(related)

    return {
        "subtask_map": subtask_map,
        "related_tasks": related_tasks,
    }


def import_module(
    module_path: Path,
    project_dir: Path,
    spec_number: int | None = None,
) -> Path:
    """
    Import an external module folder into Auto Claude specs.

    Args:
        module_path: Path to module folder (e.g., output/project/auth/)
        project_dir: Target project directory
        spec_number: Optional spec number override (auto-detects if None)

    Returns:
        Path to the created spec directory
    """
    # 1. Validate
    validate_module_structure(module_path)
    module_name = module_path.name  # e.g., "auth"

    # 2. Parse all task files
    tasks_dir = module_path / "tasks"
    task_files = sorted(
        [f for f in tasks_dir.glob("[0-9]*.md")],
        key=lambda f: int(re.match(r"(\d+)", f.stem).group(1)) if re.match(r"(\d+)", f.stem) else 0,
    )
    tasks = [parse_task_file(f) for f in task_files]

    # 3. Create spec directory
    specs_dir = project_dir / ".auto-claude" / "specs"
    specs_dir.mkdir(parents=True, exist_ok=True)

    if spec_number is None:
        existing = [d.name for d in specs_dir.iterdir() if d.is_dir()]
        existing_nums = [
            int(s.split("-")[0]) for s in existing if s[0:1].isdigit()
        ]
        spec_number = max(existing_nums, default=0) + 1

    spec_name = f"{spec_number:03d}-{module_name}-module"
    spec_dir = specs_dir / spec_name
    spec_dir.mkdir(parents=True, exist_ok=True)

    # 4. Generate and save spec.md
    spec_content = generate_spec_md(
        module_name, module_path / "reviewed-to-be.md", tasks
    )
    (spec_dir / "spec.md").write_text(spec_content, encoding="utf-8")

    # 5. Generate and save requirements.json
    requirements = generate_requirements_json(tasks, module_name)
    (spec_dir / "requirements.json").write_text(
        json.dumps(requirements, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # 6. Generate and save implementation_plan.json
    plan = build_implementation_plan(tasks, module_name)
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps(plan, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # 7. Generate and save task_context.json (related task mappings)
    task_context = build_task_context(tasks, plan)
    (spec_dir / "task_context.json").write_text(
        json.dumps(task_context, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # 8. Copy reference documents
    reference_dir = spec_dir / "reference"
    reference_dir.mkdir(exist_ok=True)
    shutil.copy2(
        module_path / "reviewed-to-be.md",
        reference_dir / "reviewed-to-be.md",
    )
    if (module_path / "as-is.md").exists():
        shutil.copy2(
            module_path / "as-is.md",
            reference_dir / "as-is.md",
        )
    if (module_path / "to-be.md").exists():
        shutil.copy2(
            module_path / "to-be.md",
            reference_dir / "to-be.md",
        )

    # 9. Copy task files
    tasks_dest = spec_dir / "tasks"
    tasks_dest.mkdir(exist_ok=True)
    for task_file in task_files:
        shutil.copy2(task_file, tasks_dest / task_file.name)
    readme = tasks_dir / "README.md"
    if readme.exists():
        shutil.copy2(readme, tasks_dest / "README.md")

    # 10. Discover and copy coding patterns from the target project
    _copy_project_coding_patterns(project_dir, spec_dir, reference_dir)

    return spec_dir


def _copy_project_coding_patterns(
    project_dir: Path,
    spec_dir: Path,
    reference_dir: Path,
) -> None:
    """
    Search the target project for coding patterns/conventions docs
    and copy them into the spec reference directory. Also generates
    a coding_patterns.json that the coder agent will use.
    """
    # Common locations for coding pattern docs
    pattern_candidates = [
        "docs/CODING-PATTERNS.md",
        "docs/coding-patterns.md",
        "docs/CONVENTIONS.md",
        "docs/conventions.md",
        "docs/GUIDELINES.md",
        "docs/guidelines.md",
        "docs/CODE-STYLE.md",
        "CODING-PATTERNS.md",
        "CONVENTIONS.md",
        "GUIDELINES.md",
    ]

    found_patterns: list[Path] = []
    for candidate in pattern_candidates:
        full_path = project_dir / candidate
        if full_path.exists():
            found_patterns.append(full_path)

    if not found_patterns:
        return

    # Copy pattern files to reference directory
    for pattern_file in found_patterns:
        dest_name = pattern_file.name
        shutil.copy2(pattern_file, reference_dir / dest_name)

    # Generate coding_patterns.json pointing to these files
    # This is read by the planner/coder prompt generator
    patterns_json: dict[str, object] = {
        "source": "module_import",
        "pattern_files": [str(f.relative_to(project_dir)) for f in found_patterns],
        "reference_copies": [f"reference/{f.name}" for f in found_patterns],
        "conventions": [],
        "patterns": [],
    }

    (spec_dir / "coding_patterns.json").write_text(
        json.dumps(patterns_json, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

# Module Import Workflow

Import pre-built module specs from an external skills project (e.g. `mm-ai-portal-skills`) into any Auto Claude project — directly from the desktop UI.

## Overview

The module import feature lets you take a structured module folder containing task definitions, architectural docs, and dependency mappings, and turn it into a ready-to-build Auto Claude spec. The imported task **skips planning entirely** and goes straight to the coder phase, since the implementation plan is already defined in the module.

**Key concept:** The source module folder and the target project are separate directories — often in different repositories. You browse to any folder on disk and import into the currently active Auto Claude project.

## Module Folder Structure

A valid module folder must contain:

```
my-module/
├── reviewed-to-be.md          # REQUIRED — Target architecture document
├── as-is.md                   # Optional — Current state analysis
├── to-be.md                   # Optional — Draft target state
└── tasks/                     # REQUIRED — Numbered task markdown files
    ├── 001-domain-entities.md
    ├── 002-value-objects.md
    ├── 010-repository-interfaces.md
    ├── 100-database-schema.md
    ├── 200-application-services.md
    ├── 300-api-endpoints.md
    ├── 400-integration-tests.md
    └── ...
```

### Task File Naming

Task files must be named `NNN-description.md` where `NNN` is a zero-padded number (e.g. `001`, `042`, `300`). The number determines which architectural phase the task belongs to.

### Phase Mapping

Tasks are automatically grouped into phases based on their number:

| Task Numbers | Phase | Name |
|---|---|---|
| 000–099 | 1 | Domain Layer |
| 100–199 | 2 | Infrastructure Layer |
| 200–299 | 3 | Application Layer |
| 300–399 | 4 | Presentation Layer |
| 400–499 | 5 | Integration |
| 500–599 | 6 | Migration |
| 600–699 | 7 | Testing |

This follows clean/hexagonal architecture conventions where domain logic is implemented first, infrastructure adapters second, and so on up through integration and testing.

### Task File Format

Each task markdown file should include:

```markdown
# Task 001: Domain Entities

## Metadata
- **Type**: Core
- **Priority**: Critical
- **Estimate**: 3 points
- **Module/Domain**: auth-service

## Dependencies
- None (or list: 001, 002, 010)

## Objective
Brief description of what this task accomplishes.

## Acceptance Criteria
- [ ] Entity classes are created with proper validation
- [ ] Unit tests pass for all entities
- [ ] Domain events are defined

## Step-by-Step Execution
1. Create the entity files:
   ```
   src/domain/entities/
   ├── user.ts
   └── session.ts
   ```
2. Implement validation logic
3. Add unit tests

## Business Rules
- Users must have a unique email
- Sessions expire after 24 hours
```

## Using the UI

### Step 1: Open the Import Modal

Click **Import Module** in the sidebar (below the "New Task" button). The button is only enabled when a project is selected and initialized with Auto Claude.

### Step 2: Browse for Module Folder

Click **Browse** to open a folder picker. Navigate to your module folder (e.g. `mm-ai-portal-skills/output/mm-core-oauth2-api-new/auth`).

The system automatically validates the folder structure:
- Checks for `reviewed-to-be.md`
- Checks for `tasks/` directory with numbered `.md` files
- If validation fails, an error message explains what's missing

### Step 3: Preview

After validation, you'll see:
- **Module name** (derived from the folder name)
- **Total task count** across all phases
- **Phase breakdown** — each phase with its name and task count
- **Reference file status** — checkmarks showing which optional docs exist (reviewed-to-be.md, as-is.md, to-be.md)

Review the preview and click **Import** to proceed.

### Step 4: Import

The system:
1. Runs the Python importer (`run.py --import-module`) against the active project
2. Creates a new spec directory in `.auto-claude/specs/` with:
   - `spec.md` — Generated specification
   - `requirements.json` — Structured requirements
   - `implementation_plan.json` — Phase/subtask breakdown with dependencies
   - `task_context.json` — Related task mappings for the coder agent
   - `reference/` — Copies of architectural docs
   - `tasks/` — Copies of all task files
3. Writes `task_metadata.json` with `skipPlanning: true` so the task goes directly to the coder

### Step 5: Start Building

After import completes, you have two options:
- **View on Board** — Close the modal and see the new task on the Kanban board
- **Start Building** — Close the modal and immediately start the task (jumps straight to the coder phase)

## What Gets Created

After import, your project will have a new spec at `.auto-claude/specs/NNN-module-name/`:

```
.auto-claude/specs/042-auth/
├── spec.md                    # Generated from reviewed-to-be.md + tasks
├── requirements.json          # Structured requirements for agents
├── implementation_plan.json   # Phases, subtasks, dependencies
├── task_context.json          # Related task mappings for coder context
├── task_metadata.json         # { sourceType: "module_import", skipPlanning: true }
├── reference/
│   ├── reviewed-to-be.md      # Copied from source
│   ├── as-is.md               # Copied if exists
│   └── to-be.md               # Copied if exists
└── tasks/
    ├── 001-domain-entities.md  # Copied from source
    ├── 002-value-objects.md
    └── ...
```

### Implementation Plan Structure

The generated `implementation_plan.json` contains:

```json
{
  "phases": [
    {
      "phase": 1,
      "name": "Domain Layer",
      "type": "implementation",
      "depends_on": [],
      "subtasks": [
        {
          "id": "1.1",
          "description": "Domain Entities",
          "status": "pending",
          "task_file": "001-domain-entities.md",
          "task_number": 1,
          "verification": "Unit tests pass"
        }
      ]
    }
  ]
}
```

Subtask IDs use the format `{phase}.{index}` (e.g. `1.1`, `2.3`, `7.2`). Dependencies between phases are computed automatically from the task dependency declarations.

### Task Context

The `task_context.json` maps each subtask to related tasks, helping the coder agent understand cross-cutting concerns:

```json
{
  "subtask_metadata": {
    "1.1": {
      "task_number": 1,
      "task_file": "001-domain-entities.md",
      "dependencies": []
    }
  },
  "related_tasks": {
    "1.1": {
      "by_dependency": [],
      "by_shared_files": ["1.2", "2.1"],
      "by_business_rules": ["1.3"]
    }
  }
}
```

## CLI Alternative

You can also import modules from the command line:

```bash
cd /path/to/your/project
python run.py --import-module /path/to/module-folder
```

This runs the same Python importer and creates the same spec structure, but doesn't write `task_metadata.json` (that's handled by the Electron app).

## Troubleshooting

| Issue | Cause | Fix |
|---|---|---|
| "Import Module" button is disabled | No project selected or project not initialized | Select a project and run "Initialize Auto Claude" |
| "Missing reviewed-to-be.md" | Module folder doesn't have the required architecture doc | Add `reviewed-to-be.md` to the module root |
| "No valid task files found" | `tasks/` directory is empty or files aren't named `NNN-*.md` | Ensure task files follow the `001-name.md` naming convention |
| Import hangs or times out | Python environment not configured | Check that the Python environment is set up in Settings |
| Task doesn't appear on board | Cache not refreshed | Refresh the Kanban board manually |

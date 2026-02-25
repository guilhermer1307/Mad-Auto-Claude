# Task Selection & Completion Architecture Analysis

## CRITICAL FINDINGS

### 1. How `get_next_subtask()` Works

**Location:** `apps/backend/core/progress.py:406-502`

**Behavior:**
- **Strictly linear, single-threaded selection:** Iterates through phases in order, returns FIRST pending subtask in first available phase
- **Dependency-aware:** Only processes phases whose `depends_on` phases are complete
- **Stuck subtask skipping:** Respects recovery manager's `attempt_history.json` to skip subtasks marked as stuck

**Key Algorithm:**
```python
def get_next_subtask(spec_dir: Path) -> dict | None:
    # 1. Load stuck subtask IDs from memory/attempt_history.json
    stuck_subtask_ids = {entry["subtask_id"] for entry in attempt_history["stuck_subtasks"]}
    
    # 2. Build phase_complete map: phase_id -> bool (all subtasks completed?)
    phase_complete = {}
    for phase in phases:
        phase_complete[phase_id] = all(s.status == "completed" for s in phase.subtasks)
    
    # 3. Find FIRST available phase with satisfied dependencies
    for phase in phases:
        depends_on = phase.get("depends_on", [])
        deps_satisfied = all(phase_complete.get(dep, False) for dep in depends_on)
        if not deps_satisfied:
            continue  # Skip blocked phases
        
        # 4. Return FIRST pending subtask in this phase (skip stuck ones)
        for subtask in phase.subtasks:
            if subtask.id not in stuck_subtask_ids and subtask.status == "pending":
                return subtask  # <-- RETURNS IMMEDIATELY, NO SELECTION LOGIC
```

**Critical Limitation:** No grouping/batching mechanism. Returns ONE subtask at a time.

**User Influence:** ZERO. Users cannot:
- Reorder which subtask runs next
- Run multiple related subtasks in same session
- Skip ahead to a later subtask
- Request parallel execution of independent subtasks

---

### 2. How Subtask Completion Works

**Subtask Status Lifecycle:**

**Models involved:**
- `Subtask` (apps/backend/implementation_plan/subtask.py:17-129)
- `ImplementationPlan` (apps/backend/implementation_plan/plan.py:24-416)

**Status Enum Values:** `pending`, `in_progress`, `completed`, `failed`

**Completion Flow:**

```python
# Step 1: Mark IN_PROGRESS when session starts (subtask.py:107-114)
def subtask.start(session_id: int):
    self.status = SubtaskStatus.IN_PROGRESS
    self.started_at = datetime.now().isoformat()
    self.session_id = session_id
    self.completed_at = None  # Clear stale data

# Step 2: Mark COMPLETED when agent finishes (subtask.py:116-121)
def subtask.complete(output: str | None = None):
    self.status = SubtaskStatus.COMPLETED
    self.completed_at = datetime.now().isoformat()
    if output:
        self.actual_output = output

# Step 3: Save to disk via ImplementationPlan.async_save()
# (plan.py:122-155)
# Uses atomic write to prevent corruption:
# - Updates timestamps
# - Calls update_status_from_subtasks()
# - Writes to JSON file in thread pool
```

**Status Propagation to Plan:**

```python
# plan.py:157-213
def update_status_from_subtasks():
    # Computes overall plan status from subtask states:
    # - If all completed: status="ai_review", planStatus="review"
    # - If some in_progress/completed: status="in_progress"
    # - If any failed: status="in_progress" (can retry)
    # - If all pending: status="backlog" (unless in human_review)
```

**Fields Updated:**
- `status` (string): backlog, in_progress, ai_review, human_review, done
- `planStatus` (string): pending, in_progress, review, completed
- `completed_at` (ISO timestamp)
- `actual_output` (for investigation subtasks)
- `session_id` (which session completed it)
- `critique_result` (from self-critique)

---

### 3. Coder Agent Loop Architecture

**Location:** `apps/backend/agents/coder.py:415-1380`

**Signature:**
```python
async def run_autonomous_agent(
    project_dir: Path,
    spec_dir: Path,
    model: str,
    max_iterations: int | None = None,
    verbose: bool = False,
    source_spec_dir: Path | None = None,
    skip_planning: bool = False,
) -> None
```

**Main Loop Structure (lines 602-1331):**

```
iteration = 0
while True:
    iteration += 1
    
    # 1. Get NEXT subtask (returns ONE, or None if complete)
    next_subtask = None if first_run else get_next_subtask(spec_dir)
    
    # 2. If no subtask, build is complete - BREAK
    if not next_subtask and not first_run:
        break
    
    # 3. Generate focused prompt for THIS subtask only
    # (prompt_generator.py:514-575 load_subtask_context)
    prompt = generate_subtask_prompt(spec_dir, subtask=next_subtask, ...)
    context = load_subtask_context(spec_dir, next_subtask)
    
    # 4. Run SINGLE agent session (agents/session.py)
    async with client:
        status, response = await run_agent_session(client, prompt, ...)
    
    # 5. Post-process: mark subtask complete/failed (agents/session.py)
    # This calls subtask.complete() or subtask.fail()
    # AND saves to implementation_plan.json
    
    # 6. Handle status:
    if status == "complete":  # All subtasks done
        break
    elif status == "continue":  # Subtask done, continue to next
        await asyncio.sleep(AUTO_CONTINUE_DELAY_SECONDS)
        continue  # Loop to get_next_subtask()
    elif status == "error":
        # Retry logic (exponential backoff, rate limits, etc.)
        # May mark subtask as stuck if max retries exceeded
```

**Critical Constraints:**

1. **Unidirectional flow:** Once a subtask is marked complete, it's done. No "rewind" or re-execution.

2. **No session grouping:** Each iteration = ONE subtask + ONE agent session
   - Cannot batch 5 related subtasks into 1 session
   - Agent gets minimal context about other subtasks
   - No information about which subtask will run next

3. **Minimal context per subtask:**
   - Prompt includes: current subtask description + files to modify (names only)
   - Pattern files pre-loaded (truncated to 80 lines)
   - Spec excerpt: None loaded by default
   - Other subtasks: Not mentioned
   - Related files: Not mentioned

4. **No multi-subtask context building:**
   ```python
   # load_subtask_context() (prompt_generator.py:514-575)
   # Returns:
   context = {
       "patterns": {},           # Pre-loaded pattern files (truncated)
       "files_to_modify": {},    # File names + line counts (NO content)
       "spec_excerpt": None,     # Never populated
   }
   # Files_to_create: Never loaded or mentioned to agent
   ```

5. **Stopping conditions:**
   - All subtasks completed (get_next_subtask returns None)
   - max_iterations reached (if provided)
   - Human intervention (PAUSE file)
   - Max retries exceeded on stuck subtask
   - Rate limit or auth errors (pause + wait)

---

### 4. CLI Interaction Model

**Entry Point:** `apps/backend/cli/main.py:49-200+`

**User Flow:**

```
python auto-claude/run.py --spec 001 [OPTIONS]
    |
    ├─ --list              → Print all specs with status
    ├─ --spec SPEC         → Build a specific spec
    ├─ --merge            → Merge existing build to main project
    ├─ --review           → Show what was built
    ├─ --discard          → Delete build
    ├─ --create-pr        → Push to GitHub + create PR
    └─ --qa               → Run QA validation loop
    
BUILD OPTIONS:
    ├─ --model MODEL           → Override Claude model
    ├─ --max-iterations N      → Run at most N sessions
    ├─ --skip-planning         → Skip planner, use minimal plan
    ├─ --skip-qa              → Skip QA after build
    ├─ --isolated/--direct     → Workspace mode (mutually exclusive)
    └─ --verbose              → Verbose output
```

**Build Command Flow** (`build_commands.py:52-335`):

```python
def handle_build_command(...):
    # 1. Validate environment (API token, spec files exist)
    # 2. Check human review approval (review_state.is_approval_valid)
    # 3. Check for existing build (offer to continue or start fresh)
    # 4. Choose workspace mode:
    #    - ISOLATED: Create git worktree (safe, isolated)
    #    - DIRECT: Build in main project (faster, risky)
    # 5. If isolated: setup_workspace() creates fresh worktree
    # 6. Load task_metadata.json for phase-specific model overrides
    # 7. Run autonomous agent:
    #    asyncio.run(run_autonomous_agent(..., skip_planning=skip_planning))
    # 8. After agent completes:
    #    - If !skip_qa AND should_run_qa():
    #        - Run QA validation loop (separate agent loop)
    #    - If !qa_approved:
    #        - Finalize: merge, create PR, or save for later
```

**No Task Selection UI:**
- No menu to pick which subtask to run
- No grouping dialog
- No "run these 3 subtasks together" option
- No "skip this subtask" option (only "mark as stuck" via recovery manager)

**`--skip-planning` Behavior** (coder.py:505-521):
- Creates minimal implementation_plan.json with 1 subtask
- Subtask description: "Implement the full specification as described in spec.md"
- Skips planner agent entirely
- Starts coding agent immediately

---

### 5. Batch Commands Pattern

**Location:** `apps/backend/cli/batch_commands.py:17-112`

**What it does:**
- Creates MULTIPLE SPECS from a batch JSON file (one spec per task)
- Does NOT batch-execute builds
- Does NOT implement sequential building

**Flow:**
```python
def handle_batch_create_command(batch_file: str, project_dir: str):
    # Read tasks from JSON
    tasks = batch_data.get("tasks", [])
    
    # For each task, create a separate spec directory:
    for task in tasks:
        spec_id = "003", "004", etc.
        spec_dir = specs_dir / f"{spec_id}-{slug}"
        spec_dir.mkdir()
        
        # Write requirements.json (NOT spec.md, NOT implementation_plan.json)
        # User still needs to:
        #   1. Generate spec for each (python spec_runner.py --continue 003)
        #   2. Approve each spec
        #   3. Build each spec (python run.py --spec 003)
```

**Current Limitations:**
- No batch-build capability
- No way to say "run spec 001, then 002, then 003 sequentially"
- No way to configure inter-spec dependencies
- Specs run independently with separate build pipelines

---

## DESIGN IMPLICATIONS

### 1. Linear Subtask Execution is Hard-Coded

The system is fundamentally designed for sequential, single-subtask-per-session execution:

- `get_next_subtask()` returns ONE subtask
- Agent loop calls it once per iteration
- No mechanism to return MULTIPLE subtasks
- No mechanism to suggest groupings
- No mechanism to prioritize subtasks

**To enable grouping, you'd need to:**
1. Modify `get_next_subtask()` to return `list[Subtask]` instead of `Subtask | None`
2. Refactor agent loop to handle batches (break into smaller sub-sessions? or single big session?)
3. Update prompt generation to include context for ALL subtasks in the batch
4. Update progress tracking to handle "partial completion" within a batch

### 2. Prompt Context is Minimal

Each subtask session receives:
- Current subtask description
- Files to modify (names + line counts only, NO content)
- Pattern files (first 80 lines, truncated)
- No spec excerpt
- No other subtask descriptions
- No project architecture context

**To enable better grouping decisions, you'd need to:**
1. Extend `load_subtask_context()` to include:
   - Full spec.md excerpt
   - All subtask descriptions (for awareness)
   - Related files (not just files_to_modify)
   - Architecture overview
2. Add grouping-specific context:
   - Which subtasks are independent
   - Which subtasks share files
   - Which subtasks should run together
3. Update `generate_subtask_prompt()` to include group context

### 3. Completion is Point-in-Time

Once a subtask is marked complete:
- Status is set to `COMPLETED`
- `completed_at` timestamp is recorded
- `actual_output` is stored
- Plan is saved atomically

**No mechanism to:**
- Reverse a completion
- Re-run a completed subtask
- Mark as "partially completed" (depends on follow-up work)
- Group completions

### 4. Dependencies are Intra-Spec Only

Current phase dependency system:
- Phase depends on WHICH OTHER PHASES in the SAME spec
- No cross-spec dependencies
- No dependency on external tasks
- Dependencies are checked at phase level, not subtask level

**To enable batching across specs, you'd need:**
1. Extend `Phase.depends_on` to include spec IDs (e.g., "spec-001:phase-2")
2. Modify `get_next_subtask()` to resolve cross-spec dependencies
3. Implement a spec-level orchestrator that runs specs in dependency order

### 5. User Has Zero Control

Current CLI provides:
- Run spec 001 (start from first pending subtask)
- Resume spec 001 (continue from last pending)
- Skip planning (use minimal plan)
- Skip QA

**NOT provided:**
- Select which subtask to run
- Group subtasks to run together
- Reorder subtasks
- Skip a subtask (only "mark as stuck" internally)
- Run multiple specs in parallel (each run.py is separate)
- Configure grouping strategy

---

## KEY DATA STRUCTURES

### ImplementationPlan (plan.py:24-416)

```python
@dataclass
class ImplementationPlan:
    feature: str                          # Task name
    workflow_type: WorkflowType           # "feature", "bugfix", "investigation"
    services_involved: list[str]          # ["backend", "frontend"]
    phases: list[Phase]                   # Ordered list of phases
    final_acceptance: list[str]           # QA criteria
    status: str                           # backlog, in_progress, ai_review, etc.
    planStatus: str                       # pending, in_progress, review, completed
    qa_signoff: dict | None               # QA approval data
    recoveryNote: str | None              # Recovery hints
```

### Phase (phase.py:15-84)

```python
@dataclass
class Phase:
    phase: int                 # Phase number (1, 2, 3...)
    name: str                  # "Database Setup", "API Implementation"
    type: PhaseType            # PLANNING, IMPLEMENTATION, VALIDATION
    subtasks: list[Subtask]    # Ordered list of subtasks
    depends_on: list[int]      # Phase numbers this depends on
    parallel_safe: bool        # Can subtasks run in parallel? (UNUSED)
```

### Subtask (subtask.py:17-129)

```python
@dataclass
class Subtask:
    id: str                              # "1.1", "1.2", etc.
    description: str                     # What to implement
    status: SubtaskStatus                # pending, in_progress, completed, failed
    service: str | None                  # "backend", "frontend", "all"
    all_services: bool                   # For integration subtasks
    files_to_modify: list[str]           # ["src/main.ts", ...]
    files_to_create: list[str]           # ["src/new-component.tsx", ...]
    patterns_from: list[str]             # ["src/existing.ts", ...] (examples to study)
    verification: Verification | None    # How to verify completion
    expected_output: str | None          # For investigation subtasks
    actual_output: str | None            # What was discovered/done
    started_at: str | None               # ISO timestamp
    completed_at: str | None             # ISO timestamp
    session_id: int | None               # Which session completed it
    critique_result: dict | None         # Self-critique results
```

---

## EXECUTION FLOW DIAGRAM

```
CLI: python run.py --spec 001
  |
  ├─ Load spec_dir/.auto-claude/specs/001-feature/
  ├─ Validate environment (token, files)
  ├─ Check approval (review_state.json)
  ├─ Choose workspace (isolated or direct)
  └─ Call: asyncio.run(run_autonomous_agent(...))
      |
      ├─ Initialize recovery manager, status manager, task logger
      ├─ Check if first_run (no implementation_plan.json yet)
      |
      ├─────── IF FIRST RUN (PLANNING PHASE) ──────
      |   |
      |   ├─ Generate planner prompt
      |   ├─ Run agent session: agent creates implementation_plan.json
      |   ├─ Validate plan (schema check)
      |   ├─ Verify requirements coverage
      |   └─ Set first_run = False, transition to coding
      |
      └─────── ELSE (CODING PHASE) ──────
          |
          └─ MAIN LOOP: while True
              |
              ├─ iteration += 1
              |
              ├─ Get next subtask:
              |   next_subtask = get_next_subtask(spec_dir)
              |   if not next_subtask:
              |       break  # All done
              |
              ├─ Validate subtask files exist
              |
              ├─ Generate focused prompt for THIS subtask
              |   (includes description, files, patterns)
              |
              ├─ Load context:
              |   context = load_subtask_context(subtask)
              |   # Returns: patterns (preloaded), files_to_modify (names only)
              |
              ├─ Create client + run agent session:
              |   status, response = await run_agent_session(client, prompt)
              |   # Agent reads/modifies files, makes commits
              |   # Returns: "complete", "continue", or "error"
              |
              ├─ Post-process (if not error):
              |   ├─ Mark subtask complete: subtask.complete()
              |   ├─ Save plan: plan.async_save()
              |   ├─ Update recovery manager
              |   ├─ Sync progress back to main project (if worktree)
              |   └─ Update Linear (if enabled)
              |
              └─ Handle status:
                  ├─ "complete": Break (all subtasks done)
                  ├─ "continue": Sleep & loop (next iteration → get_next_subtask)
                  ├─ "error" + concurrency: Retry with backoff
                  ├─ "error" + rate_limit: Pause & wait for reset
                  ├─ "error" + auth: Pause & wait for re-auth
                  └─ "error" + other: Sleep & retry
      
      ├─ After loop: RUN QA VALIDATION (if !skip_qa)
      |   └─ Run separate agent loop to validate acceptance criteria
      |
      └─ Print summary & exit
```

---

## SUMMARY: WHAT'S MISSING FOR TASK SELECTION/GROUPING

1. **No grouping selection mechanism:**
   - No API to ask "which subtasks should run together?"
   - No mechanism to return multiple subtasks from `get_next_subtask()`
   - No way to represent groups in implementation_plan.json

2. **No context for grouping decisions:**
   - Agent doesn't see other subtasks
   - Agent doesn't see full project architecture
   - Agent doesn't know which files are shared
   - Agent doesn't know execution order

3. **No user control over execution:**
   - Can't choose which subtask to run
   - Can't skip a subtask
   - Can't group subtasks
   - Can't run in parallel

4. **No inter-spec orchestration:**
   - Batch commands create specs, not execution plans
   - No way to run spec A, then B, then C automatically
   - No cross-spec dependencies

5. **Hard-coded linear flow:**
   - One subtask per session
   - Sequential execution only
   - No batching or grouping at any level

---

## FILES TO MODIFY FOR IMPLEMENTATION

To add task selection & grouping feature:

1. **Core data structures:**
   - `apps/backend/implementation_plan/plan.py` - Add group metadata
   - `apps/backend/implementation_plan/subtask.py` - Add group membership

2. **Selection logic:**
   - `apps/backend/core/progress.py` - New `get_next_subtask_group()` function
   - `apps/backend/agents/coder.py` - Refactor main loop to handle groups

3. **Context building:**
   - `apps/backend/prompts_pkg/prompt_generator.py` - Enhanced context for grouped subtasks

4. **CLI:**
   - `apps/backend/cli/build_commands.py` - Add grouping options
   - `apps/backend/cli/main.py` - New CLI flags for grouping

5. **Frontend (if applicable):**
   - `apps/frontend/src/renderer/stores/task-store.ts` - Track grouping state
   - IPC handlers for grouping selection

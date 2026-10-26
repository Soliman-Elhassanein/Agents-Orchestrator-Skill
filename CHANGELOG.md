# Changelog

## Unreleased

Changes:

- Constitution 2.2.0: the agent CLI you talk to is now the operator, not the communicator.
  Besides starting runs and relaying questions, it keeps runs going: when something outside
  the workflow stops a run, it reads the machine knowledge, fixes the cause on its own,
  checks the fix, records the lesson and resumes. It waits for you only on decisions. The
  skill says which CLI the operator is, and lists what it fixes and what it asks.
- A copied adapter must bring the helper files it names as `{adapterDir}/…`. Orchestra now
  refuses one whose helpers are missing, and names the file to copy, instead of failing every
  call with an empty reply. `adapter test --command` prints the error when it reads no exit
  code, lists the helper files to copy, and says to edit a project adapter rather than copy
  it onto itself.
- The adapter guide says that agy's `--sandbox` makes the terminal read-only even in its own
  workspace, so sandboxed agy write steps can't run tests or builds, and how to opt out per
  project.
- `orchestra doctor` prints `ok <agent>: <cli> on PATH`, and the install fix only for a
  missing CLI, instead of an install instruction on every passing line.
- `operatorUpdateMinutes` replaces `communicatorUpdateMinutes`; the old key still works.

- `new-workflow` keeps designs as small as the user's description. The interviewer and the
  reviewers no longer propose safeguards, scripts or limits the user didn't ask for, and
  they treat Orchestra's defaults for failed checks, retries, budgets and loop limits as
  settled. Reviewers raise at most three gaps, and every question recommends the simplest
  option.
- `orchestra adapter test <name> --command "<cmd>"` checks whether a CLI's write sandbox
  blocks a project command, such as a test runner that opens a local port. Orchestra runs the
  command directly, then has the agent run it in its write sandbox, and prints both exit
  codes with the agent's output and the adapter file to override. The orchestra skill runs
  this check before a project's first code run, and proposes an override only with the
  user's agreement.

## 3.0.0 — 2026-10-26

Breaking changes:

- Every run is a workflow. `orchestra run <workflow> "<task>"` and
  `orchestra queue add <workflow> <task>` name one; `--tier` and `--access`, which only
  applied to runs without a workflow, are removed.
- Orchestra ships two built-in workflows. `solo`: a single agent does the task.
  `new-workflow`, rebuilt for format 3: a tier-3 interviewer and two independent reviewers
  question you until the use case is clear, including whether the path is fixed or an agent
  chooses at named points; then it drafts, checks, draws (draw.io and a text outline),
  dry-runs, lets you ask for changes, and saves only on an exact approval. The `code` and
  `council` built-ins (with its modes) are removed; they remain in the history at
  commit `f8f5f72`.
- Node 20 or newer. LangGraph (`@langchain/langgraph` 1.4.21 with `@langchain/core` 1.2.17)
  is the one dependency, pinned exactly. `orchestra init` links the project's engine copy to
  it; run `init` again after updating Orchestra.
- Constitution 2.0.0: the communicator, workflow-only runs, one built-in workflow, and
  LangGraph as the sole dependency.
- A write step that changes nothing completes with `changes: []` instead of failing as
  `no-changes`: checks, answers and reviews are results. Orchestra reports the fact and no
  longer diagnoses or retries empty writes.

Changes:

- Workflows run as LangGraph state graphs compiled from their data: steps are nodes, order
  and routes are edges, loops edge back from an `until` node. Run records stay the durable
  checkpoint, so resume works as before.
- Workflow format v3 adds routing: an `agent` step lists `choices`, and later steps run only
  `when` it returned their value. Only listed values route; anything else is a failed attempt
  and is retried. Routes are validated when a workflow loads, shown in diagrams and followed
  (first value) by dry runs.
- The `lanes` block is now `tasks`. v1 and v2 packs keep the old name and still load;
  diagrams of packs that use it need regenerating.
- Readable names: run IDs are `20261026-142233-k3fq`, task branches
  `orchestra/<run-id>.<step>.T001-first-words-of-the-task` and parallel children
  `orchestra/<run-id>.<step>.agent-1`. Checkpoints record task branches under `branches`;
  runs started before this version resume with their old names.
- Worktrees live in `.orchestra/worktrees/<run-id>/`, one folder per executor, removed when
  the run ends; resumed older runs clear `.git/orchestra-worktrees/`.
- `orchestra init` creates the Git repository when the folder has none, and makes a first
  commit holding only `.gitignore` when there are no commits.
- `orchestra workflow diagram <name> --text` prints a workflow as a text outline.
- `docs/workflows.md` gains "Designing a workflow", drawn from Microsoft's agent
  orchestration, behavior engineering and agents-at-scale guidance.
- `outputFile` rewrites its file each time the step completes, so a revised step's output
  replaces the earlier one.
- Constitution 2.1.0: two built-in workflows.
- `FINAL.md` ends with the last step's result (its text, or its output as JSON), and the
  skill relays it to the user.
- The README explains day-to-day use through your agent CLI, reading a run's result, and
  the queue.
- LangChain tracing is turned off in Orchestra's own process; agents, gates and the worker
  still receive the user's tracing settings.

## 2.2.0 — 2026-10-21

- Workflow format v2 adds a required `description`: what the workflow does, what to give
  it with an example command, and what it returns. v1 packs keep working without one.
- Add `orchestra workflow list [--json]`, showing every workflow in search order with its
  source and description.
- Built-in packs move to v2 and carry their own descriptions. `new-workflow` asks for a
  description and rejects drafts without one.
- Each built-in workflow explains itself in a `README.md` guide in its own folder, which
  `workflow list` shows. The README, format docs and skill no longer name or describe any
  workflow; the skill judges fit from `workflow list`. A test enforces that.

## 2.1.1 — 2026-10-21

- Skill: always re-attach `watch` until `IDLE`, including across queued runs, and brief the
  user on every wake-up and check-in (what happened, progress, what needs them, what's next).

## 2.1.0 — 2026-10-20

- Enforce constitution 1.1.0 promise 1 in the engine: highest-tier, read-only plans,
  briefs, failure diagnosis and parallel syntheses survive workflow replacement or removal.
- Let lanes generate task lists and batch all task briefs once per phase; brief single cheap
  writes, including bare runs, before execution. Highest-tier workers skip separate briefs.
- Diagnose failed writes and attributable gates before bounded retries on the original tier;
  keep escalation as the last resort and exclude startup failures from task failures.
- Preserve raw parallel items alongside synthesis, and record each strong call’s purpose.
- Reduce code to lanes and use engine synthesis in council modes, retaining user decisions
  and records. Regenerate diagrams and include engine calls in dry-run budget estimates.
- Add public constitution invariants and direct-block mock tests without built-in workflows.

## 2.0.1 — 2026-10-20

- Documentation: README rewritten for new users; council vendor fallback documented; upgrade note moved to the changelog.

## 2.0.0 — 2026-10-20

First public release of Orchestra as a workflow runner.

**Upgrade note:** Old role/tier configs must be replaced. `orchestra init --force` writes
the new `orchestra.v2-adapters/1` schema. Edit its suggested agents and tiers for your accounts.

- Generate deterministic draw.io workflow diagrams, check freshness, and create missing diagrams on pack installation.
- Ship diagrams for every built-in workflow and generate drafts before new-workflow approval and saving.

- Make run watch its background job by default, reusing watch events, check-ins and report-once markers.
- Add --detach for immediate return with a reserved run ID; preserve foreground queue execution.
- Document background run/watch handling and cover attention events with mock-agent tests.

- Add workflow validation, bounded mock dry runs and project/user pack installation from paths or Git.
- Add the interactive new-workflow pack with read-only drafting, checks and approval before saving.
- Add four council modes with independent vendor proposals, anonymous peer critique and bounded rounds.
- Check local quotations and file references, mark unverified sources, and record the user decision.
- Keep only machine knowledge per CLI outside repositories; project facts belong in project files.
- Automatically record startup failures with exact fixes and scoped CLI lessons as observed notes,
  skipping normalized duplicates; retain project/code lessons only in run.json suggestions.
- Include all confirmed notes and the newest 10 observations per brief (configurable).
- List all CLIs by default; add confirmed notes with --cli, approve/merge duplicates, or remove by ID.
- Ship one standard Orchestra skill, installed with npx skills add; init writes no per-CLI commands.
- Document installation, first code and council sessions, adapters, packs and runtime records.

- Add versioned declarative and executable adapters, user override folders and adapter tests.
- Move CLI flags, results, transcripts and quota sources into three built-in adapters; remove relays.
- Replace role/executor arrays with model agents, tier escalation and quota-aware upward selection.
- Add JSON workflows and six blocks with call budgets, independent sessions and checkpoints.
- Reuse isolated lane branches, merge recovery and one conflict redo before asking the user.
- Add the code workflow, explicit task lists, phase gates, checkbox-only ticking and run-report/1.
- Run direct tasks as one agent job; require a named landing branch and never push.
- Count interrupted calls and unknown usage; record empty writes, diffs and tested gate revisions.

## 2.0.0-dev — 2026-10-20

- Establish Orchestra's purpose, five promises, non-goals and delivery standards.
- Remove the audit/scoring pipeline, findings, full review, debate, lane review and fixes.
- Pass questions directly to the user; remove question consolidation and automatic answers.
- Remove feature discovery, automatic task ticking and the token usage ledger command.
- Remove similarity merging, lesson kinds and context-management extras.
- Retain three relays; remove the other fifteen and per-CLI slash commands.
- Remove committed runtime state and obsolete feature specifications.
- Keep execution, queue, lanes, gates, retries, setup handover, quota, questions, steering,
  watching and lane recovery. Record process outcomes and per-run token totals.
- Break configuration compatibility: development schema is `orchestra.v2-dev`.
  Adapter, workflow, task-list and public run-report replacements follow in later phases.

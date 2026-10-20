---
name: orchestra
description: Run tasks and workflows through Orchestra, inspect execution status, and relay its questions to the user. Use when the user requests Orchestra or needs its configured agents, quota balancing or isolated parallel execution.
---

Compare the job with available workflows before starting. Read project packs in
`.orchestra/workflows/`, user packs in `~/.config/orchestra/workflows/`, then built-ins in
`.orchestra/engine/workflows/`; the first name match wins. Inspect workflow prompts to
understand fit. When showing a workflow to the user, point to its `workflow.drawio` so they
can open it in draw.io or the Draw.io extension in VS Code. Regenerate it from workflow.json
with `orchestra workflow diagram <name>` if missing or stale; never edit it by hand. A workflow fits: run it. None fits: run the task as given. If the job seems
too simple for Orchestra and this agent could do it directly, explain that and ask the user;
never decide for them. If they insist, run it through Orchestra. If the user has already answered
this fit question or explicitly insists on using Orchestra for this job, honor that answer
without asking again.

Use the installed `orchestra` command, or `node .orchestra/engine/bin/orchestra.mjs`.
If the project has no installation, run `orchestra init` in its Git repository and explain
that the user must install and authenticate their own CLIs and configure model tiers.
Do not install tools, invent model names or assume subscriptions.

- Workflow: `orchestra run <workflow> "<task>"`.
- Bare task: `orchestra run "<task>"`, optionally `--tier N` or `--access read`.
- Explicit task list: `orchestra run code --task-file <path> --gate "<command>"`.
- Workflow checks: `orchestra workflow check <file>` and `orchestra workflow run <name> --dry`.
- Status: `orchestra status --json`, `orchestra check --json`, and the run's `run.json`.
- Run `orchestra run …` in the background; it waits without model calls. When it returns,
  handle the event it printed: relay questions and report facts. Then run `orchestra watch`
  in the background to keep waiting until the run is completed, failed or stopped. On IDLE,
  stop watching. Use `--every` and `--stuck-after` on either command to adjust check-ins.

When a run awaits the user, show every question and its number. Relay the user's answers
with `orchestra answer [run-id] "1. … 2. …"` or `--file <answers-file>`. Never answer for the
user or start another agent while waiting. If the user's earlier instructions already answer
a question, relay those instructions faithfully. `orchestra steer [run-id] "<direction>"`
applies at the next boundary; `stop` and `resume` control interrupted runs.

Report process status, commits, gate exits, logs and unknown token counts as facts.
Completion describes execution. The user decides quality and whether to keep the result.
Council leaves a decision record in its run folder; the user decides where to keep it.
Land only onto a branch the user names with `orchestra land [run-id] <target-branch>`.
Never push without an explicit instruction.

Machine notes live outside repositories in `~/.config/orchestra/knowledge.json`, per CLI.
`orchestra knowledge` lists every CLI; `--cli <adapter-name>` filters it. Add a confirmed
note with `knowledge add "text" --cli <adapter-name>`; `approve <id>` confirms and merges
exact normalized duplicates for that CLI; `rm <id>` removes it. Startup failures and reported
`cli` lessons are recorded automatically as observed notes without normalized duplicates.
Report brief lessons as `{"lessons":[{"scope":"cli|project|code","text":"..."}]}`.
Project/code lessons stay suggestions in run.json; project facts belong in project guidance
files and docs. Briefs label every confirmed note and the newest 10 observed notes for the
selected CLI (`knowledgeObservedLimit` configures the observed limit). Recording uses no model
calls. Orchestra installs no per-CLI command files.

# Orchestra

**Get the most out of the subscriptions you already pay for.**

Orchestra is a Node CLI that coordinates your agent CLIs for code, research, review and
deliberation. Strong models plan and synthesize. Cheap models do the bulk of the work.
This is version **2.1.1**, with no npm dependencies.

The five promises in [CONSTITUTION.md](CONSTITUTION.md):

- **Cheap models do the bulk of the work.** Strong models write briefs, plans and syntheses
  and diagnose failures. They don't do the typing.
- **Every subscription drains at an even pace.** Work is weighted by each account's 5-hour
  and weekly windows, so nothing runs dry early.
- **Work runs in parallel** across agents and vendors. Code enforces each step's guarantees.
- **Nothing spends tokens while waiting.** The tool is idle until something needs you.
- **Any CLI, and you stay the only author.** Orchestra is vendor independent and commits
  as your Git identity, with no AI attribution.

The engine enforces promise 1 in its blocks: planning, briefs, failure diagnosis and
synthesis keep working when workflows are replaced or removed.

Orchestra is not a judge: it reports facts about calls, commits, gate exits and logs; you decide quality.

## How it works

```text
Your agent CLI / you
        |
        v
Orchestra core
  queue, tiers, quota balancing, questions,
  idle waiting, resume, records
        |
        v
Six blocks
  agent, parallel, ask, gate, loop, lanes
        |
        v
Workflows
  data files + prompts + optional gate scripts
```

| Built-in workflow | What it does |
|---|---|
| `code` | Reads or creates a task list, runs isolated lanes, merges, runs gates and records results. |
| `council` | Researches an unclear idea, gathers proposals and critique, then asks you to decide. |
| `council-compare` | Uses the council steps to compare options you already have. |
| `council-learn` | Uses the council steps for concepts, a glossary and a learning order. |
| `council-review` | Uses the council steps for a read-only report with checked evidence. |
| `new-workflow` | Drafts, diagrams, checks and simulates a workflow pack, then asks you to approve saving it. |

Council uses **3 agents from different vendors when available, otherwise any available agents**.
Every call has its own session. Council recommends; you decide.

## Requirements

- Node 18 or newer.
- Git with `user.name` and `user.email` configured. Your project needs at least one commit.
- At least one agent CLI that you installed and logged in to yourself.
  Orchestra does not install or authenticate those tools.

On Linux, Claude Code's sandbox needs **`bubblewrap` and `socat`**: Orchestra runs Claude's
write calls sandboxed and never falls back to running them unsandboxed.

```sh
sudo pacman -S bubblewrap socat        # Arch
sudo apt install bubblewrap socat      # Debian / Ubuntu
```

If they are missing, the failed call is reported with this fix and Claude is left out of the
run. Note that `orchestra adapter test claude` makes a read-only call, so it doesn't exercise
the write sandbox.

## Install

Install the CLI from this repository:

```sh
git clone https://github.com/Soliman-Elhassanein/Agents-Orchestrator-Skill.git orchestra
cd orchestra
npm install -g .
```

Install the single [Agent Skills](https://agentskills.io/specification) file for your agent:

```sh
npx skills add Soliman-Elhassanein/Agents-Orchestrator-Skill --skill orchestra
```

The CLI works without the skill. After project initialization, the local copy also runs as
`node .orchestra/engine/bin/orchestra.mjs`.

## Quick start

### 1. Initialize your project and set tiers

```sh
cd /path/to/your/project
orchestra init
```

Edit `.orchestra/config.json`. Keep its other settings and choose model names, effort levels
and tiers that your accounts support. Detected models and tiers are suggestions.
For the examples below, configure a cheap entry at tier 1, a working entry at tier 2 and a
strong entry at tier 3. One CLI can supply all three. See [agents and tiers](#agents-and-tiers).

```sh
orchestra doctor
orchestra adapter test <name>
```

Replace `<name>` with a configured adapter name, such as `claude`, `codex` or `agy`.
`doctor` checks Node, a Git commit and configured executables on PATH. It does not verify login.
`adapter test` makes one short real read-only call and prints its outcome and log path.
Repeat it for each CLI you plan to use.

### 2. Run one task

```sh
orchestra run "Create overview.md with a short guide to this repository's main folders."
```

`run` starts a background worker, prints the run ID and watches until an event needs attention
or a periodic check-in is due. A return from watching does not always mean execution finished.
Use `orchestra status` to read the state. Answer any questions, then use `orchestra watch`
to keep waiting. Commit input files first: uncommitted project changes are not part of runs.

### 3. Run a task list with a gate

Create `tasks.md` in your project. For example:

```markdown
## Phase 1: Core
- [ ] T001 [P] Create src/one.js exporting a function that returns 1
- [ ] T002 [P] Create src/two.js exporting a function that returns 2
- [ ] T003 Create src/sum.js importing both functions and exporting their sum
```

Adapt the paths and module style to your project, then commit the task file and the
`.gitignore` change from `init`. Run a gate that exists in your project:

```sh
orchestra run code --task-file tasks.md --gate "npm test"
```

Here `npm test` assumes your project has a test script. Repeated `--gate` arguments replace
configured gates for that run. Gates run after each phase on the merged revision.

### 4. Inspect and land

```sh
orchestra status --json
```

Wait for `completed`. Read `.orchestra/runs/<run-id>/run.json` and the logs it names.
The status output gives the branch, normally `orchestra/<run-id>`.
Inspect it before landing:

```sh
git log --oneline HEAD..orchestra/<run-id>
git diff HEAD...orchestra/<run-id>
orchestra land <target-branch>
```

Replace the placeholders. `land` uses the latest run unless you supply a run ID.
Name an **existing target branch** explicitly, including when it is the default branch.
Landing requires a completed run and a clean checkout. It switches to the target branch and
merges the run branch. It never pushes.

Runs use separate branches and worktrees; your checkout stays untouched until landing.
By default, later queued runs build on the last completed run before landing, so the task-list
run above includes the earlier task's changes. Inspect both before keeping them.

### 5. Try a council session

Council research requests tier 1 and proposals request tier 3; engine syntheses use the
highest configured tier.
Configure those tiers. Three vendor CLIs are preferred, but are not required.

```sh
orchestra run council "Should this project store its cache in files or a database?"
orchestra status
orchestra answer "Compare local files and a local database; portability matters most."
orchestra watch
```

Council researches, gathers independent proposals and passes anonymous peers to critique.
The engine synthesizes each parallel block; a gate checks local quotes and file references
before you decide.
If watching returns a check-in or another event, handle it and reattach with `orchestra watch`.
When it reports the final decision question, read the synthesis in `orchestra status --json`
and `.orchestra/runs/<run-id>/verification.json`. Then give your decision:

```sh
orchestra answer "Choose local files because the data is small and portability matters most."
orchestra watch
```

Council waits without calls at each user question. It never edits project files.
Its record is `.orchestra/runs/<run-id>/decision.md`; you choose where to keep it.
Local verification checks locations and exact quotes, not meaning. Remote sources remain unverified.

## Concepts

### Agents and tiers

An entry describes a model at an effort level; the same CLI can have several entries.

```json
{
  "agents": {
    "fast": {"cli":"my-tool","model":"small","tier":1,"weight":2},
    "strong": {"cli":"my-tool","model":"large","effort":"high","tier":3}
  },
  "escalate": {"afterFailures":1}
}
```

This fragment belongs in the config `init` writes. Edit the model names and tiers for your
accounts. The shipped adapters are `claude`, `codex` and `agy`; any other CLI needs a user
adapter. `init` only detects tools; it does not install or authenticate them. Its suggested
model names may need changing for your account. No detected tools produces an empty agents
map, which you must configure before work can start.

Startup errors exclude that entry and report an exact fix. Write failures get a highest-tier
diagnosis and revised brief before retrying on the original tier. Escalation follows
`escalate.afterFailures`, with at least one diagnosed retry on the original tier before moving up.
A write call that changes nothing is `no-changes`; it gets the same diagnosis and bounded retries, and cannot
complete or unblock dependent work without a real change.

`fanout.executors` bounds lane concurrency. `executorRetries` limits retries;
`agentTimeout` and `gateTimeout` limit how long calls and gates may run. `gates` contains shell
commands; repeated `--gate` arguments override them for that run.

### Quota balancing

Subscriptions have usage windows, such as a **5-hour window** and a **weekly window**.
Where the adapter supplies them, Orchestra compares how much you used with how much time
has passed. An account using its quota slowly gets more weight; one using it quickly gets less.
The tightest observed window controls the weight. This helps spread work across your accounts.

- Choose within the requested tier using each entry's weight and observed quota pace.
- Skip an account near its limit: by default, at **95%** used in any current observed window.
  A reported active limit also excludes it. `quotaBalancing.stopAtPercent` sets the threshold.
- If that tier has no eligible quota, go **up a tier, never down**.
- If no eligible entry at or above the requested tier is available, wait and report why.
  Waiting makes no model calls; read-only quota readers may refresh observations.
- Unknown quota stays unknown. It adds no quota adjustment to the configured weight.
  An adapter may read quota from a local source or observe it passively after a call.

`orchestra quota` shows observations; `--no-refresh` shows the saved ones.
Available windows depend on what the CLI exposes. Balancing cannot guarantee that an account
never reaches a limit.

### Workflows and task lists

`orchestra run "task"` is one write agent job at tier 2; `--tier` changes its tier.
Use `--access read` for an answer or research without file edits. Direct tasks use the same
queue, quota, questions, resume and records as workflows.
`orchestra run <workflow> "task"` selects a workflow.

The `code` workflow is a single `lanes` block. The engine reads an explicit task file or
asks a highest-tier agent to write one. It prepares briefs for cheap workers, then runs
lanes, merges and runs phase gates. Only executed tasks whose gates
passed are ticked. Generated lists stay in the run folder. Project task files are ticked
on the run branch and reach your checkout when landed.

| Task-list element | Meaning |
|---|---|
| `## Phase 1: Core` | Phases run in ascending numeric order. |
| `- [ ] T001 Create a file` | An unticked task with a unique `T` plus digits ID. |
| `[P]` after the ID | Consecutive marked tasks may run independently in separate worktrees. |
| An unmarked task | A sequential barrier between parallel groups. |
| Other tags and non-checkbox text | Kept unchanged. |
| `[x]` | Executed, merged and gates passed; you still decide quality. |

A `[P]` marker promises different files and no shared state. Orchestra trusts that promise.
Existing ticks are skipped. `fanout.executors` limits lane concurrency.

Workflows are versioned JSON with six blocks: `agent`, `parallel`, `ask`, `gate`, `loop` and
`lanes`. Project workflows override user workflows, which override built-ins. Each workflow
has a finite call budget. Resume skips completed steps and continues retained lane branches.
A lane merge conflict causes one redo on the merged work; a second conflict asks you.

The engine's strong calls are read-only and text-only, selected with the same quota balancing
as workers at the highest configured tier. If that tier has no quota, the run waits.
Their prompts ship with the engine and workflows cannot disable them. Budget for:

- A cheap single write (including a bare `run`): one brief plus one worker call. A worker
  already on the highest tier needs no separate brief. Read calls need no brief.
- Lanes: one plan if no task file, one brief call per phase containing all that phase's
  task briefs when workers are below the highest tier, plus the task calls.
- Parallel: its child calls plus one synthesis. Write children also receive briefs when needed.
- Each failed write being retried: one diagnosis plus the retry. Attributable gate failures
  also use diagnosis; phase gates repair the phase's tasks on the merged tree. Startup
  failures do not trigger diagnosis. Retries and failed starts count against the call budget.

A typical council session makes nine calls (one research, three proposals, three critiques
and two engine syntheses); a second critique round adds four. These counts exclude retries.
Strong calls appear in `run.json` with `purpose`: `plan`, `brief`, `diagnosis` or `synthesis`.

See [workflow format](docs/workflows.md), [adapter format](docs/adapters.md) and
[records](docs/records.md) for the public interfaces.

### Run facts

Each run writes `.orchestra/runs/<run-id>/run.json`, using `run-report/1`.
It stays current while running, waiting, failed or stopped.

| Record | What to read |
|---|---|
| Commits | Base and final revisions; write-step changes, diffs and commits. |
| Tasks and steps | Execution status, selected agents and attempts. |
| Gates | Command, exit code, tested revision and log path. |
| Questions | Questions and user answers. |
| Usage | Calls and reported token totals; unreported usage stays explicit. |
| Suggestions | Project or code lessons returned by agents. |

`runtimeStatus` distinguishes running and waiting from terminal outcomes.
A `completed` run reports execution and gate exits. It does not decide whether to keep the work.
Token totals measure processed volume, including reported cache fields, not billing or account consumption.

### Machine knowledge

Machine notes live only in `~/.config/orchestra/knowledge.json`, keyed by CLI and shared
across projects. `orchestra knowledge` lists every CLI; `--cli my-tool` filters the list.
`orchestra knowledge add "Use this supported flag" --cli my-tool` adds a confirmed note.
`approve <id>` confirms a note and merges exact whitespace/case-normalized duplicates for
that CLI; `rm <id>` removes it. Manual additions remain separate until approval.

Startup failures automatically record what happened and the adapter's exact fix as observed
notes. Agents may return `lessons` with `scope` and `text`: `cli` lessons become observed
machine notes, while `project` and `code` lessons appear only in `run.json` suggestions.
Automatic recording skips normalized duplicates already present for the same CLI.
Project facts belong in the project's own guidance files and docs.

Each brief labels and includes every confirmed note for its CLI plus the 10 newest observed
notes. Set `knowledgeObservedLimit` in `.orchestra/config.json` to change that limit (0 omits
observations). Notes are advice; recording makes no additional model calls.

## Using it from your agent

The [standard skill](skills/orchestra/SKILL.md) compares your job with available workflows.
It chooses a fitting workflow or runs the task as given. If the job seems too simple and
one agent could do it directly, the skill explains that and asks you. If you insist, it runs
through Orchestra. An answer already given is honored without asking again.
`init` installs no per-CLI commands and does not depend on the skill.

| Command or option | Behavior |
|---|---|
| `orchestra run …` | Starts a background worker and watches by default. |
| `--detach` | Returns immediately with the reserved run ID. |
| `orchestra watch` | Reattaches until an event or a periodic check-in. |
| `--every <minutes>` | Check-in interval for `run` or `watch`; default 15 (`communicatorUpdateMinutes`). `--every 0` disables check-ins. |
| `--stuck-after <minutes>` | Quiet-work warning interval; default 10 (`stuckAfterMinutes`). |
| `--foreground` | Processes the queue in the calling process, without watching, using its execution exit codes. |

Watching returns on questions, completion, failure, stop, crash, stuck work or quota waiting.
It also reports setup problems and queue holds. Handled events exit 0; read the event and
status to know the execution outcome. `watch` exits 3 with `IDLE` when nothing needs watching.
Watching spends no model tokens.

In an agent session, run `orchestra run …` as a background command. When it returns:

1. Brief the user: what happened, progress (step, tasks done, gates), what needs them (every
   numbered question, or nothing) and what comes next. Periodic check-ins (every 15 minutes by
   default) get the same brief.
2. Send the user's answers with `orchestra answer`; never answer for the user.
3. Run `orchestra watch` in the background again, and keep re-attaching while anything is
   running or queued. Stop only on `IDLE`.

Question batches are reported once. Wait for the user's answers before reattaching.
`steer` applies a direction at the next boundary. `stop` and `resume` control interrupted runs.

## Extending

### Add a CLI

Create `.orchestra/adapters/my-tool.json` (or the same file under
`~/.config/orchestra/adapters/`) using the [adapter format](docs/adapters.md). It declares the
executable, prompt passing, model/access flags, result and optional read-only quota reader.
Add a config entry such as `"small":{"cli":"my-tool","model":"your-model","tier":1}`.
Install and authenticate that tool yourself, then run `orchestra adapter test my-tool`.
This makes one short real call. Adding a CLI needs no change to Orchestra's core.

### Write a workflow

A workflow pack is a named folder containing `workflow.json`, prompts and optional gate
scripts. Each includes a generated `workflow.drawio` that opens in draw.io; regenerate it with
`orchestra workflow diagram <name|path-to-workflow.json>` after changing the JSON. [Workflow format v1](docs/workflows.md) documents the six blocks and annotated
examples. Put cheap bulk calls at tier 1, strong proposals at tier 3, a finite call budget
on every workflow and a maximum on every loop. Keep workflow files as data.

```sh
orchestra workflow diagram ./my-workflow/workflow.json
orchestra workflow check ./my-workflow/workflow.json
orchestra workflow add ./my-workflow
orchestra workflow run my-workflow --dry
orchestra run my-workflow "The job"
# Or draft a pack interactively, then check, simulate and approve its installation:
orchestra run new-workflow "Describe the repeated job"
```

`workflow add` also accepts a Git URL or `--user` for installation across projects. Existing
names are never overwritten. Dry mode shows all bounded steps with mock agents, gates and
answers; it starts no commands or model calls and does not modify files. Review third-party
pack scripts before real runs. `init` ignores `.orchestra/`; if your team wants to share a
project pack, explicitly track only `.orchestra/workflows/<name>/`.

## Command reference

```text
init [--force]
run [workflow] [<task>] [--task-file <file>] [--tier N] [--access read|write] [--gate <cmd>]
    [--detach|--foreground] [--every <minutes>] [--stuck-after <minutes>]
adapter test <name>
workflow check <file> | diagram <name|file> [--out <file>] | run <name> --dry | add <git-url|path> [--user]
queue [add <task> | edit <id> <task> | rm <id> | move <id> <position> | hold | resume]
status [run-id] [--json]        list
answer [run-id] "1. … 2. …" | answer [run-id] --file <file>
steer [run-id] "direction" | steer [run-id] --file <file>
stop [run-id]                 resume [run-id]
check [--json]                watch [--every <minutes>] [--stuck-after <minutes>]
quota [--no-refresh] [--json]  doctor
knowledge [add <text> | approve <id> | rm <id>] [--cli <name>] [--json]
land [run-id] <target-branch>
```

Prefix each command above with `orchestra`. A run needs task text or `--task-file`.
`knowledge add` requires `--cli <name>`.

A failed run holds the queue unless `queue.holdOnFailure` is false. By default queued tasks
build on the last completed run before landing; `queue.buildOnPrevious:false` starts from
the checkout. Questions go to the user and all numbered answers must be supplied. Steering
applies at the next boundary. `watch`, `check` and quota readers make no model calls.

## Development

`npm test` is the delivery gate. It uses a test-only mock adapter, real Git, worktrees and
processes. It covers adapters, quota selection, retries, the six blocks, queue and watching,
questions, resume, merges, gates, task ticking, workflow tools, council evidence checks,
diagrams and machine knowledge. It makes no real model calls.
Contribution rules are in [AGENTS.md](AGENTS.md).

## Credits

Orchestra is maintained by Soliman Elhassanein. The built-in adapters' handling of each CLI was
adapted from the relay scripts of [delegate-skills](https://github.com/amElnagdy/delegate-skills)
by Ahmed Mohammed, under the MIT License. See [NOTICE](NOTICE) and [CITATION.cff](CITATION.cff).

The principles every change must keep are in [CONSTITUTION.md](CONSTITUTION.md).

## License

MIT. See [LICENSE](LICENSE).

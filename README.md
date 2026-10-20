# Orchestra

**Get the most out of the subscriptions you already pay for.** Orchestra orchestrates agent
CLIs for code, research, review and deliberation. Strong models write briefs and syntheses;
cheap models do the bulk of the work. Quota balancing spreads work across your subscriptions.
Parallel calls use separate sessions and worktrees. Waiting for your answers spends no tokens.

Orchestra reports what ran, commits, gate exits and logs. You decide quality and what to keep.
It works with any CLI through an adapter, commits as your Git identity and never pushes.

Requires Node 18+, Git, a configured Git author, and your own installed, authenticated agent
CLI. No npm dependencies. This is `2.0.0`.

```sh
git clone https://github.com/Soliman-Elhassanein/Agents-Orchestrator-Skill.git orchestra
cd orchestra
npm install -g .
cd /path/to/your/project
orchestra init
# Edit .orchestra/config.json: detected models and tiers are suggestions.
orchestra doctor
orchestra adapter test <name>
# In your own project, create tasks.md using the task-list example below, then commit it.
orchestra run code --task-file tasks.md --gate "npm test" --foreground
orchestra status
orchestra land <target-branch>
```

Use a gate that exists in your project; `npm test` above assumes it has a test script.
Runs leave the checkout alone. Inspect the run branch and `run.json` before landing.
Landing requires an explicit existing target branch, including the default branch. It never
pushes. The installed copy also runs as `node .orchestra/engine/bin/orchestra.mjs`.

## A first council session

Configure a tier-1 entry and tier-3 entries from three different vendor CLIs (see below).
Then ask an unclear question:

```sh
orchestra run council "Should this project store its cache in files or a database?"
orchestra status
orchestra answer "Compare local files and a local database; portability matters most."
orchestra watch
# When watch reports the final decision question, read the synthesis and verification.json.
orchestra status --json
orchestra answer "Choose local files because the data is small and portability matters most."
orchestra watch
```

The worker researches, gathers independent proposals, passes anonymous peers to critique,
checks quotes against actual files and synthesizes a recommendation. It waits without calls
at each user question. `status --json` exposes the run ID and step outputs. Read
`.orchestra/runs/<run-id>/verification.json` and the synthesized options before deciding.
The result is `.orchestra/runs/<run-id>/decision.md`; you choose where to keep it. Council
never edits the project. `council-compare`, `council-learn` and `council-review` use the same
steps for choosing between options, learning a topic, or a read-only report.

## Agents and tiers

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

Selection balances quota within the requested tier, then moves upward when exhausted.
Unknown quota remains unknown. If no eligible entry is available, the run waits without
model calls and reports the reason. Startup errors exclude that entry and report an exact
fix; ordinary failures retry with a bounded digest and escalate. A write call that changes
nothing is `no-changes`, blocks dependent work and cannot complete a run.

Old role/tier configs must be replaced. `init --force` writes the new
`orchestra.v2-adapters/1` schema. `fanout.executors` bounds lane concurrency;
`executorRetries`, `agentTimeout` and `gateTimeout` bound attempts. `gates` contains shell
commands; repeated `--gate` arguments override them for that run.

## Workflows and task lists

`run "task"` is one write agent job at tier 2 (change with `--tier`). Use `--access read`
for a question or research task that should return an answer without editing files. It uses the same queue,
quota, questions, resume and records as workflows. `run <workflow> "task"` selects a workflow.
The built-in `code` workflow reads an explicit task file, or asks a tier-3 agent to write one,
then runs cheap agents in lanes, merges, runs gates after each phase and ticks only the
executed tasks whose gates passed. Generated task lists stay in the run folder; project task
files are ticked on the run branch and reach your checkout when landed.

```markdown
## Phase 1: Core
- [ ] T001 [P] Create src/one.js
- [ ] T002 [P] Create src/two.js
- [ ] T003 Wire the two modules
```

Parallel markers promise different files and no shared state. Consecutive marked tasks run
independently; unmarked tasks are sequential barriers. Other tags and all non-checkbox text
stay unchanged. A tick reports execution and gate exits, not a quality judgment.

Workflows use versioned JSON and six blocks: agent, parallel, ask, gate, loop and lanes.
Project workflows override user workflows, which override built-ins. Each workflow has a
finite call budget. Resume skips completed steps and continues retained lane branches.
A merge conflict causes one redo on the merged work; a second conflict asks the user.
See [workflow format](docs/workflows.md), [adapter format](docs/adapters.md) and
[records](docs/records.md) for the public interfaces.

## Commands

```text
run [workflow] <task> [--task-file <file>] [--tier N] [--access read|write] [--gate <cmd>]
    [--detach|--foreground] [--every <minutes>] [--stuck-after <minutes>]
adapter test <name>
workflow check <file> | diagram <name|file> [--out <file>] | run <name> --dry | add <git-url|path> [--user]
queue [add <task> | edit <id> <task> | rm <id> | move <id> <position> | hold | resume]
status [run-id] [--json]        list
answer [run-id] "1. … 2. …"    steer [run-id] "direction"
stop [run-id]                 resume [run-id]
check [--json]                watch [--every <minutes>] [--stuck-after <minutes>]
quota [--no-refresh] [--json]  doctor
knowledge [add <text> | approve <id> | rm <id>] [--cli <name>] [--json]
land [run-id] <target-branch>
```

A failed run holds the queue unless `queue.holdOnFailure` is false. By default queued tasks
build on the last completed run before landing; `queue.buildOnPrevious:false` starts from
the checkout. Questions go to the user and all numbered answers must be supplied. Steering
applies at the next boundary. `watch`, `check` and quota readers make no model calls.

`run` starts a background worker, prints the run ID and stays attached as a watcher until
the first attention event: questions, completion, failure, stop, crash, stuck work or quota
waiting. Handled events exit 0. It also reports setup problems and queue holds as `watch`
does. `--every` supplies a periodic check-in (default: `communicatorUpdateMinutes`, 15);
`--every 0` disables check-ins. `--stuck-after` defaults to `stuckAfterMinutes`, 10.
Watching uses no model calls. `--detach` returns immediately with the reserved run ID;
`--foreground` processes the queue in the calling process and keeps its existing exit codes.

For an agent session, run `orchestra run …` in the background. When it returns, handle the
printed event: relay questions to the user and report process facts. After handling it, run
`orchestra watch` in the background to keep waiting until the run completes, fails or stops.
Reported question batches are not repeated when re-attaching. `watch` exits 3 with `IDLE`
when there is nothing to wait for.

## Development

`npm test` uses a test-only mock adapter, real Git, worktrees and processes. No real model
calls. The guard checks CLI independence and the 2,000-line core/block budget. Contribution
rules are in [AGENTS.md](AGENTS.md).

## Add a CLI

Create `.orchestra/adapters/my-tool.json` (or the same file under
`~/.config/orchestra/adapters/`) using the [adapter format](docs/adapters.md). It declares the
executable, prompt passing, model/access flags, result and optional read-only quota reader.
Add a config entry such as `"small":{"cli":"my-tool","model":"your-model","tier":1}`.
Install and authenticate that tool yourself, then run `orchestra adapter test my-tool`.
This makes one short real call. Adding a CLI needs no change to Orchestra's core.

## Write a workflow

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

## Knowledge and the standard skill

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

Install the single [Agent Skills](https://agentskills.io/specification) file for your agent:

```sh
npx skills add Soliman-Elhassanein/Agents-Orchestrator-Skill --skill orchestra
```

The skill compares a job with available workflows, uses a fitting workflow or runs the task
as given. If the job seems too simple for Orchestra it asks you; an insistence runs it anyway.
It relays questions, reads status and waits without extra model calls. `orchestra init`
installs no per-CLI commands and does not depend on the skill.

## Credits

Orchestra is maintained by Soliman Elhassanein. The built-in adapters' handling of each CLI was
adapted from the relay scripts of [delegate-skills](https://github.com/amElnagdy/delegate-skills)
by Ahmed Mohammed, under the MIT License. See [NOTICE](NOTICE) and [CITATION.cff](CITATION.cff).

The principles every change must keep are in [CONSTITUTION.md](CONSTITUTION.md).

# Workflow format v2

Workflows are JSON, with a `.json` extension. A pack contains `workflow.json` and prompt
files. Search order is `.orchestra/workflows/<name>/workflow.json`, then
`~/.config/orchestra/workflows/<name>/workflow.json`, then installed `workflows/<name>/`.
A `<name>.json` file in each folder also works. The first match wins.

```json
{
  "workflow": 2,
  "description": "Compares two designs for a question. Give the question: orchestra run my-pack \"Files or a database for the cache?\". Returns the chosen option and why.",
  "budget": {"calls": 8},
  "steps": [
    {"id":"facts", "agent":{"prompt":"research.md", "tier":1, "access":"read"}},
    {"id":"choices", "parallel":{"prompt":"propose.md", "tier":3,
      "access":"read", "count":2, "distinct":"vendor", "sees":["facts"]}},
    {"id":"choose", "ask":{"questions":["Which option should proceed?"]}}
  ]
}
```

`description` is required. It is how people and agents learn what a pack is for, so say
what the workflow does, what to give it, with one example `orchestra run` command, and what
it returns. `orchestra workflow list` prints every workflow found in the search order with
its source and description; `--json` gives the same as data.

Version 1 is the same format without `description`. Orchestra still runs v1 packs, and
`workflow list` shows them as having no description; add `description` and set
`"workflow": 2` to upgrade one. The built-in authoring workflow only saves v2 packs.

A pack may also include a `README.md` guide that walks through a full run: an example
session, what each step asks and the files it leaves. `workflow list` prints its path.
Keep everything specific to a workflow in its pack, not in Orchestra's own docs.

Each step has a unique `id` and exactly one of six blocks. No embedded functions or
expressions are evaluated. Prompts are files relative to the pack. They receive the original
task, user answers and steering. Add `sees:["id"]` to expose only those earlier outputs.
`sees:"previous"` exposes the previous step. Separate parallel calls never see siblings.
`{{task}}`, `{{taskFile}}`, `{{runDir}}`, `{{workflowDir}}` and `{{steps.id.field}}` interpolate literal values
in prompt text and declared input fields. A whole-field reference preserves its JSON type.
Agents return JSON (bare or fenced); its fields are stored as `output` for later steps.

## Diagram

Every pack includes `workflow.drawio`, an uncompressed draw.io XML diagram generated only
from `workflow.json`. Open it in diagrams.net or the Draw.io extension in VS Code. It shows
the call budget, ordered steps, block colours and legend, parallel agents between a fork and
join, and bounded loop containers with their stop conditions. Labels include agent access,
visibility and skip conditions, user questions, gate commands and lane execution order.

Never edit the diagram by hand. Edit `workflow.json`, then regenerate:

```sh
orchestra workflow diagram my-pack
orchestra workflow diagram ./my-pack/workflow.json
# An optional export (the pack still needs its canonical workflow.drawio):
orchestra workflow diagram my-pack --out ./overview.drawio
```

The output is deterministic: identical workflow data produces byte-identical XML, with no
model calls. `workflow check` fails if the adjacent `workflow.drawio` is missing or stale,
and prints the regeneration command. `workflow add` generates missing diagrams in the
installed copy; it rejects stale supplied diagrams. Source packs are left untouched.

## Six blocks

- `agent`: `prompt`, `tier` (default 2) or `agent` (config entry name), `access` (`read` by
  default or `write`), optional `sees`, optional `outputFile` (save an output field using
  `{field,path}`), and `unless` (skip when its input is present). `outputFile` paths must be
  inside the run folder. Write steps need a real diff, including commits the agent made.
  Before a write below the highest configured tier, the engine makes one read-only brief
  call at that highest tier. The worker receives that brief. Write failures (including errors,
  timeouts and empty writes) get a highest-tier diagnosis and rewritten brief before retrying
  on the original tier. Escalation uses `escalate.afterFailures`, after at least one diagnosed
  retry on that tier. A directly following gate or final configured gate can trigger the same
  recovery for the write it tests. Read failures retry with a bounded digest.
  Startup failures exclude that entry and hand over without a digest or escalation count.
- `parallel`: the agent fields plus `count` (default 2), optional `distinct:"vendor"`: each agent
  comes from a different vendor when enough are available; otherwise the rest are filled from any
  available agents. Every agent still runs in its own session.
  Vendor identity is `cli` from the agent map. Each child uses a separate session and
  detached worktree at the same revision. Write children merge after all calls return.
  The engine then makes a read-only synthesis call at the highest configured tier. Output is
  `{items:[...],synthesis:{...}}`: raw child outputs remain in `items`; synthesis describes
  agreement, disagreement and reasons, options and open questions. Later steps can read
  `{{steps.choices.synthesis}}`. This happens for every parallel block, including inside loops.
- `ask`: `questions` (strings), or `prompt` (a file of text for the user). Waits for
  `orchestra answer`; it makes no calls. All numbered questions must be answered.
- `gate`: `command` (shell command). Records exit, log and tested revision. Runs in a
  detached worktree; build artifacts do not become project changes. A nonzero exit stops
  dependent steps after any attributable write recovery exhausts its retries. Configured gates apply to direct runs and
  after every task phase;
  repeated `run --gate` overrides config gates.
- `loop`: `steps`, positive `max`, `until:{step,field,equals}`. Checks a structured field
  after each iteration; never interprets prose. The maximum is a hard bound; if the field
  never matches, the block stops with `exhausted` and dependent work does not start.
- `lanes`: optional `taskFile` (explicit path, or `{{taskFile}}`), `tier` (default 1), `access:"write"`.
  Without a task file from the block or run options, the engine makes a highest-tier,
  read-only plan call and saves its task-list text inside the run folder. This works with
  `{"lanes":{}}`, without any planning step or installed built-in workflow.
  Before each phase with workers below the highest tier, one engine brief call returns all
  task briefs as `{"briefs":{"T001":"..."}}`. Each brief specifies changes, files, steps and
  the check that proves the change. Workers receive their own briefs.
  Reads Markdown phases and task lines described below. Unticked tasks run by ascending
  phase. Consecutive `[P]` tasks form independent lanes, bounded by configured fanout;
  other tasks are sequential barriers. Lane branches survive interruption. Merge conflicts
  redo the lane once on the merged tree. A second conflict waits for the user, without a
  planning or resolution call. Every phase runs gates on its merged revision before ticking.
  A failed phase gate attributes the failure to the phase's tasks: diagnosis rewrites each
  task's brief and retries repair the merged tree before gates run again, within the same
  per-task retry limit.

A workflow budget counts every agent call, including engine plans, briefs, diagnoses, syntheses, failed starts and retries. Exhaustion
stops execution before another call. Engine prompts are in `orchestra/templates/`, outside
all workflow packs. Strong calls are text-only, read-only and quota-balanced at the highest
configured tier; they wait for its quota without falling to a lower tier. Workflow fields
cannot disable them. `run.json` records each strong call's `purpose`. `parallel` reserves distinct entries before dispatch.
If no eligible entry has quota at or above the requested tier, the step waits and reports
why. Unknown quota stays unknown and keeps weight 1. Nothing falls back to a lower tier.

## Task lists and records

Give the path explicitly to a workflow with a `lanes` block:
`orchestra run <workflow> --task-file tasks.md --foreground`.
Omit `--foreground` to start the worker and watch in the calling process until an attention
event or periodic check-in; use `--detach` to return immediately with the run ID.
After handling a question or another event, re-attach with `orchestra watch`.
Both watching commands accept `--every <minutes>` and `--stuck-after <minutes>`, using
`communicatorUpdateMinutes` and `stuckAfterMinutes` from config by default. They make no
model calls while waiting and exit 0 for handled events. Foreground execution does not watch.

```markdown
## Phase 1: Setup
- [ ] T001 [P] Create src/one.js
- [ ] T002 [P] Create src/two.js
- [ ] T003 Wire both modules
```

`[P]` is the writer's guarantee that tasks touch different files and no shared state.
Other bracketed tags are opaque. Only checkboxes change, after work merges and phase gates
pass. Existing ticks are skipped. Unrecognized lines and original line endings stay intact.
A tick reports execution and gates; it is no quality judgment.

Run state checkpoints each finished step, parallel child and loop iteration. Resume skips
finished steps and continues lane branches. `run.json` uses `contract:"run-report/1"`,
with task path, base/final commits, status, steps, tasks, commits, gates, questions and token
totals. Gates include their tested revision. Missing usage is counted explicitly. Failed,
stopped and waiting runs also have a current report.

## Design rules

Use cheap tiers for bulk work. Use parallel only for independent views or independent file
ownership. Ask only for decisions only the user can make. Use gates for mechanical guarantees.
Keep procedures in JSON and prompts, never engine branches. Set a finite call budget for every
workflow. A prompt starts with `ORCHESTRA ROLE: <role>` and `CYCLE: n` (the engine supplies
these headers when absent). The six blocks are closed; do not hide program code in workflow
data. Gates may call ordinary project scripts.

`orchestra run "task" --tier 2` runs one write agent with the same queue and records.
Use `--access read` for a direct task that returns information without changing the project.
`orchestra run <workflow> "task"` selects a workflow. Land with
`orchestra land [run-id] <target-branch>`; a target is always required, including the default
branch. Landing never pushes.

## Check, simulate and install

```sh
orchestra workflow list
orchestra workflow diagram ./my-pack/workflow.json
orchestra workflow check ./my-pack/workflow.json
orchestra workflow add ./my-pack
orchestra workflow add https://example.org/team/workflow-pack.git --user
orchestra workflow run my-pack --dry
```

A pack is either a named folder with `workflow.json`, prompts and scripts, or a folder of
named packs plus shared resources. Installation validates every workflow before copying,
rejects links and existing destinations, and excludes `.git`. Review scripts before using
packs from others: real gates execute shell commands. `--user` installs outside the project.
Project installations share the project lock; user installations share a user-level lock.

Validation rejects unknown fields and blocks, missing prompts, unbounded loops and missing
budgets. Gate commands are the sole executable field; workflow files contain no functions,
modules or inline script fields. Gates can invoke existing scripts. Prompts may reference a
sibling shared folder in the pack. `{{engineDir}}` and `{{projectRoot}}` also name the installed
engine and original checkout for trusted gate scripts.

Dry mode uses in-process mock outputs, automatic mock user answers and mock successful gates.
It prints each block and parallel child, traverses every bounded loop iteration, and counts
calls against the budget, including syntheses and conservative brief estimates for write
calls (real highest-tier workers skip separate briefs). Lanes use one synthetic phase and
task, with a plan call when no taskFile field is supplied. Real task-file availability,
phase counts, quota and retries can change the actual call count. It never invokes an adapter, command,
quota reader or user question, and never writes files. This checks the bounded execution
shape; real command exits and agent output contents still need an actual run.

For anonymous peer input use `parallel.anonymize:true`: selected item arrays exclude the
recipient's vendor, receive neutral peer labels, and have configured agent identifiers and
identity metadata removed. Outputs must also omit self-identification in their prose.

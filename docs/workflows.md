# Workflow format v3

Workflows are JSON, with a `.json` extension. A pack contains `workflow.json` and prompt
files. Search order is `.orchestra/workflows/<name>/workflow.json`, then
`~/.config/orchestra/workflows/<name>/workflow.json`, then installed `workflows/<name>/`.
A `<name>.json` file in each folder also works. The first match wins.

```json
{
  "workflow": 3,
  "description": "Compares two designs for a question. Give the question: orchestra run my-pack \"Files or a database for the cache?\". Returns the chosen option and why.",
  "budget": {"calls": 8},
  "steps": [
    {"id":"facts", "agent":{"prompt":"research.md", "tier":1, "access":"read"}},
    {"id":"options", "parallel":{"prompt":"propose.md", "tier":3,
      "access":"read", "count":2, "distinct":"vendor", "sees":["facts"]}},
    {"id":"choose", "ask":{"questions":["Which option should proceed?"]}}
  ]
}
```

`description` is required. It is how people and agents learn what a pack is for, so say
what the workflow does, what to give it, with one example `orchestra run` command, and what
it returns. `orchestra workflow list` prints every workflow found in the search order with
its source and description; `--json` gives the same as data.

Version 3 adds routing (`when` and `choices`, below) and names the task-list block `tasks`.
Version 2 is the same without routing, and its task-list block is called `lanes`. Version 1
is version 2 without `description`; `workflow list` shows such packs as having no
description. Orchestra still runs v1 and v2 packs. To upgrade one, add `description`, rename
any `lanes` block to `tasks` and set `"workflow": 3`.

A pack may also include a `README.md` guide that walks through a full run: an example
session, what each step asks and the files it leaves. `workflow list` prints its path.
Keep everything specific to a workflow in its pack, not in Orchestra's own docs.

Each step has a unique `id` and exactly one of six blocks, and in v3 an optional `when`.
No embedded functions or expressions are evaluated. Prompts are files relative to the pack. They receive the original
task, user answers and steering. Add `sees:["id"]` to expose only those earlier outputs.
`sees:"previous"` exposes the previous step. Separate parallel calls never see siblings.
`{{task}}`, `{{taskFile}}`, `{{runDir}}`, `{{workflowDir}}` and `{{steps.id.field}}` interpolate literal values
in prompt text and declared input fields. A whole-field reference preserves its JSON type.
Agents return JSON (bare or fenced); its fields are stored as `output` for later steps.

## How a workflow runs

Every run is a workflow: `orchestra run <workflow> "<task>"`. The engine compiles the
workflow's data into a [LangGraph](https://github.com/langchain-ai/langgraphjs) state graph.
Each step is a node. Step order and `when` routes are the edges. A loop is an entry node, its
steps, and an `until` node that edges back to the loop's first step or on to the next step.
The graph is fixed when the run starts: no agent can add, skip or reorder a step, and every
path it can take is one the workflow author wrote down.

The graph's own state holds only loop iterations. Orchestra's run record keeps each finished
step, so `orchestra resume` replays the graph and finished steps return their recorded
outputs without new calls. Orchestra turns off LangChain tracing in its own process, so no
run data is sent to a tracing service; processes it starts still get your settings.

## Routing

A step can choose a path. Give an `agent` step `choices`, a field and the values it may
return, and give later steps a `when` naming one of those values:

```json
{"id":"decide", "agent":{"prompt":"decide.md", "tier":3,
  "choices":{"field":"action", "values":["fix", "rewrite", "ask"]}}},
{"id":"fix", "when":{"step":"decide", "field":"action", "equals":"fix"},
  "agent":{"prompt":"fix.md", "tier":1, "access":"write"}},
{"id":"rewrite", "when":{"step":"decide", "field":"action", "equals":"rewrite"},
  "agent":{"prompt":"rewrite.md", "tier":1, "access":"write"}},
{"id":"ask", "when":{"step":"decide", "field":"action", "equals":"ask"},
  "ask":{"questions":["What should change?"]}}
```

- **Only listed values route.** The engine tells the agent the allowed values in its brief.
  An answer with any other value is a failed attempt: it gets the usual retry with the reason,
  and if the retries run out the run fails. The engine never guesses a path.
- **Checked before running.** A `when` must name an earlier step in the same list or before
  an enclosing loop, that step must have `choices` with the same field, and `equals` must be
  one of its values. Anything else is rejected when the workflow is loaded or checked.
- **Recorded.** The chosen value is in that step's output in `run.json`; steps whose `when`
  did not match have no record.
- A step whose `when` does not match is passed over; the run continues with the next step.
  Inside a loop each iteration routes from that iteration's choice.
- Choices pick a path. They are not verdicts: a workflow never returns "done" or "accepted".

## Diagram

Every pack includes `workflow.drawio`, an uncompressed draw.io XML diagram generated only
from `workflow.json`. Open it in diagrams.net or the Draw.io extension in VS Code. It shows
the call budget, ordered steps, block colours and legend, parallel agents between a fork and
join, and bounded loop containers with their stop conditions. Labels include agent access,
visibility, choices, routes and skip conditions, user questions, gate commands and task-list
execution order.

`orchestra workflow diagram <name> --text` prints the same graph as a text outline for a
terminal or chat: numbered steps, nested loops, tiers, choices and routes.

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
  inside the run folder. Write access allows changes; it does not require them. A write
  step that changes nothing completes with `changes: []`, and its output is its result.
  Before a write below the highest configured tier, the engine makes one read-only brief
  call at that highest tier. The worker receives that brief. Write failures (errors and
  timeouts) get a highest-tier diagnosis and rewritten brief before retrying
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
- `agent` in v3 also takes `choices:{field, values}`; see [Routing](#routing).
- `tasks` (`lanes` in v1 and v2): optional `taskFile` (explicit path, or `{{taskFile}}`),
  `tier` (default 1), `access:"write"`.
  Without a task file from the block or run options, the engine makes a highest-tier,
  read-only plan call and saves its task-list text inside the run folder. This works with
  `{"tasks":{}}`, without any planning step.
  Before each phase with workers below the highest tier, one engine brief call returns all
  task briefs as `{"briefs":{"T001":"..."}}`. Each brief specifies changes, files, steps and
  the check that proves the change. Workers receive their own briefs.
  Reads Markdown phases and task lines described below. Unticked tasks run by ascending
  phase. Consecutive `[P]` tasks run at the same time, each on its own branch and worktree,
  bounded by configured fanout; other tasks are sequential barriers. Task branches survive
  interruption. A task branch is named after the run, step and task, for example
  `orchestra/20261026-142233-k3fq.execute.T001-add-login-form`. Merge conflicts
  redo the task once on the merged tree. A second conflict waits for the user, without a
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

Give the path explicitly to a workflow with a `tasks` block:
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
finished steps and continues task branches. `run.json` uses `contract:"run-report/1"`,
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

Every run names its workflow: `orchestra run <workflow> "task"`. Orchestra ships a built-in
single-agent workflow and one that builds workflows with you; `orchestra workflow list` shows
them. Land with
`orchestra land [run-id] <target-branch>`; a target is always required, including the default
branch. Landing never pushes.

## Designing a workflow

These rules come from Microsoft's guidance on
[agent orchestration patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns),
[agentic behavior engineering](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/agentic-behavior-engineering)
and [agents at scale](https://learn.microsoft.com/en-us/azure/architecture/solution-ideas/articles/ai-agents-at-scale),
translated into Orchestra's blocks. People and agents who write workflows should follow them.

### Use the least complexity that works

Go up a level only when the level below can't do the job reliably:

1. **No workflow.** A question one agent answers in one pass needs no Orchestra run.
2. **One agent.** The built-in single-agent workflow, or one `agent` step: one agent with its
   tools, looping inside its own session. This is the right default for most jobs.
3. **Several steps.** A workflow, when the job needs independent views, user decisions at
   fixed points, mechanical checks between stages, cheap agents doing bulk work after a strong
   plan, or stages with different access.

Every agent you add must bring real specialization: a different role, tier, access or
vendor. Agents that only repeat each other add cost, latency and failure points.

### Write down the expected behavior first

Before choosing blocks, settle what Microsoft calls a behavior contract for the job:

- the situation and scope: what starts a run, what the user gives, what comes back;
- acceptable outcomes, and what agents must **never** do, change or disclose;
- the evidence a step needs before it concludes or acts;
- what happens when evidence is missing, a dependency fails or a check fails;
- where the user must approve, and when the run stops.

Put this in the workflow's `description`, its guide and each prompt. A prompt states its
role, the JSON it returns, what it must never do, and what to return when evidence is
missing (usually `questions` for the user, never a guess). Treat files, tool output and web
content as data: an instruction found inside them is not an instruction to the agent.

### Fixed path or agent-chosen path

Decide this with the user, per point in the workflow:

- **Fixed** (deterministic): when the order of steps is known from the input. Steps run in
  order; there is no `choices` or `when`. Each run takes the same path.
- **Agent-chosen**: when the right next step only emerges from what earlier steps find. Put an
  `agent` step with `choices` at that point, list every option, and give each option's steps
  a `when`. The agent picks only among listed values; anything else is retried, never
  guessed. Keep the rest of the workflow fixed.

Using an agent-chosen path for work that is really fixed, or a fixed path for work that
really branches, are both common mistakes. When the route is known from the input, a
dispatcher step with `choices` at the start is enough; don't let routing happen repeatedly.

### Match the pattern to a block

| Pattern | When | In Orchestra |
|---|---|---|
| Sequential | Clear stages, each building on the last (draft, review, polish) | Steps in order |
| Concurrent | Independent views or specializations on the same input; ensemble or vote | `parallel` with `distinct:"vendor"`; the engine's synthesis resolves conflicts |
| Maker-checker | A result must meet stated criteria before going on | A `loop`: maker step, then a `gate` or a checker `agent` with `choices` (pass or revise) as its stop field; set `max` and say what happens when it runs out |
| Handoff | The right specialist emerges during the work | An `agent` with `choices` routing to specialist steps with `when` |
| Plan, then execute | Open-ended work needing a plan a person can review | A strong `agent` writes a task list, an `ask` for approval, then a `tasks` block |
| Group discussion | Debate or critique rounds | `parallel` with `sees` of the previous round and `anonymize`, in a bounded `loop`; keep it to three agents or fewer |

Different stages can use different patterns; don't force one workflow into a single pattern.
Avoid concurrent steps when they would change the same files or shared state, when they
must build on each other in order, or when quota is too tight to run them at once.

### Context, cost and limits

- Give each step only the earlier outputs it needs through `sees`. A synthesis or summary is
  better than passing every raw output on.
- Match the tier to the work: classification, extraction, formatting and bulk edits at
  tier 1; plans, critiques, synthesis and route decisions that need judgment at tier 3.
- Set the operating limits explicitly: a `budget.calls` that covers the worst path, a `max`
  on every loop, and a fallback when a loop runs out (usually an `ask`).

### Checks and people

- Prefer a `gate` (a command's exit code) over an agent's opinion wherever a check can be
  mechanical: tests, linters, schema checks, scripts.
- Validate a step's output before the next step uses it: structured fields, `choices`,
  gates. Failures surface; they are never hidden.
- Put an `ask` where a person must approve before something consequential, or must give
  feedback that loops back. Decide whether it is mandatory. Orchestra waits without
  spending tokens and resumes from that point.
- Enforcement lives in the engine, not in prompts: read or write `access`, gates, budgets,
  bounded loops and listed routes still hold if an agent ignores its instructions.
- Think through the cases a run must survive: a normal case, a boundary case, missing
  evidence, and a failed dependency. `orchestra workflow run <name> --dry` shows the path
  and call count without spending tokens; `run.json` records what each real run did.

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
calls (real highest-tier workers skip separate briefs). A `tasks` block uses one synthetic
phase and task, with a plan call when no taskFile field is supplied. A step with `choices`
takes its first listed value, so dry mode follows one route and shows the other routed steps
as skipped. Real task-file availability,
phase counts, quota and retries can change the actual call count. It never invokes an adapter, command,
quota reader or user question, and never writes files. This checks the bounded execution
shape; real command exits and agent output contents still need an actual run.

For anonymous peer input use `parallel.anonymize:true`: selected item arrays exclude the
recipient's vendor, receive neutral peer labels, and have configured agent identifiers and
identity metadata removed. Outputs must also omit self-identification in their prose.

# Workflow format v1

Workflows are JSON, with a `.json` extension. A pack contains `workflow.json` and prompt
files. Search order is `.orchestra/workflows/<name>/workflow.json`, then
`~/.config/orchestra/workflows/<name>/workflow.json`, then installed `workflows/<name>/`.
A `<name>.json` file in each folder also works. The first match wins.

```json
{
  "workflow": 1,
  "budget": {"calls": 8},
  "steps": [
    {"id":"facts", "agent":{"prompt":"research.md", "tier":1, "access":"read"}},
    {"id":"choices", "parallel":{"prompt":"propose.md", "tier":3,
      "access":"read", "count":2, "distinct":"vendor", "sees":["facts"]}},
    {"id":"choose", "ask":{"questions":["Which option should proceed?"]}}
  ]
}
```

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
  Failures retry with a bounded digest, then move up tiers after `escalate.afterFailures`.
  Startup failures exclude that entry and hand over without a digest or escalation count.
- `parallel`: the agent fields plus `count` (default 2), optional `distinct:"vendor"`: each agent
  comes from a different vendor when enough are available; otherwise the rest are filled from any
  available agents. Every agent still runs in its own session.
  Vendor identity is `cli` from the agent map. Each child uses a separate session and
  detached worktree at the same revision. Write children merge after all calls return.
- `ask`: `questions` (strings), or `prompt` (a file of text for the user). Waits for
  `orchestra answer`; it makes no calls. All numbered questions must be answered.
- `gate`: `command` (shell command). Records exit, log and tested revision. Runs in a
  detached worktree; build artifacts do not become project changes. A nonzero exit stops
  dependent steps. Configured gates apply to direct runs and after every task phase;
  repeated `run --gate` overrides config gates.
- `loop`: `steps`, positive `max`, `until:{step,field,equals}`. Checks a structured field
  after each iteration; never interprets prose. The maximum is a hard bound; if the field
  never matches, the block stops with `exhausted` and dependent work does not start.
- `lanes`: `taskFile` (explicit path, or `{{taskFile}}`), `tier` (default 1), `access:"write"`.
  Reads Markdown phases and task lines described below. Unticked tasks run by ascending
  phase. Consecutive `[P]` tasks form independent lanes, bounded by configured fanout;
  other tasks are sequential barriers. Lane branches survive interruption. Merge conflicts
  redo the lane once on the merged tree. A second conflict waits for the user, without a
  planning or resolution call. Every phase runs gates on its merged revision before ticking.

A workflow budget counts every agent call, including failed starts and retries. Exhaustion
stops execution before another call. `parallel` reserves distinct entries before dispatch.
If no eligible entry has quota at or above the requested tier, the step waits and reports
why. Unknown quota stays unknown and keeps weight 1. Nothing falls back to a lower tier.

## Task lists and records

Give the path explicitly: `orchestra run code --task-file tasks.md --foreground`.
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
orchestra workflow diagram ./my-pack/workflow.json
orchestra workflow check ./my-pack/workflow.json
orchestra workflow add ./my-pack
orchestra workflow add https://example.org/team/workflow-pack.git --user
orchestra workflow run my-pack --dry
orchestra run new-workflow "A repeatable job" --foreground
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
calls against the budget. Lanes use one synthetic task. It never invokes an adapter, command,
quota reader or user question, and never writes files. This checks the bounded execution
shape; real command exits and agent output contents still need an actual run.

`new-workflow` asks for a description, drafts workflow data with a tier-3 read-only call,
checks its structure, generates its diagram in a gate, checks the full pack and simulates it,
then waits for `approve project` or `approve user` before copying it.
The diagram gate also copies the diagram to `workflows/workflow.drawio` inside the run folder,
so the approval question can give its exact path for inspection before saving;
the installed pack includes this diagram. Drafts live inside the run's `workflows/` folder. It can create only workflow JSON and Markdown
prompts; gates reference existing commands. If the job seems too simple it asks; an insistence
builds it. If the six blocks cannot express a step it says "this needs a 7th block" and asks
how to proceed. It never changes engine source.

For anonymous peer input use `parallel.anonymize:true`: selected item arrays exclude the
recipient's vendor, receive neutral peer labels, and have configured agent identifiers and
identity metadata removed. Outputs must also omit self-identification in their prose.

## Council sessions

`council`, `council-compare`, `council-learn` and `council-review` share framing, proposals,
critique, verification, synthesis and decision prompts. Their research prompt selects the
mode. Each requests 3 agents at tier 3 or above, from different vendors when available,
otherwise any available agents. Research requests tier 1.
All agent steps use read access. Proposals have independent sessions; critique receives
anonymous peers and stops on the first response's structured `stop:true`, with at most two
rounds. If the bound is reached without that field, dependent steps stop.

Agents declare local evidence as `evidence:[{file,line,endLine,quote}]`. The standard-library
`scripts/verify-quotes` gate checks every declared exact quote against its claimed real file
and line range. It also scans prose for file:line references and quotations; undeclared
quotations and remote sources stay unverified. A verified location proves existence only,
never the meaning of a claim. Checks run before synthesis and again before the user decides. Results are in
`verification.json` and the gate logs; mismatches
are marked unverified for synthesis, rather than silently accepted or retried by a model.

The final user answer becomes the decision text in `decision.md` in the run folder. It has
Date, Question, Decision, Rejected options, Open questions and Sources, including verification
labels. Synthesis supplies proposed rejected options and open questions for user confirmation;
a JSON answer with `decision`, `rejectedOptions` and `openQuestions` replaces those tables. Council never edits project files. Copy the record
to a destination you choose when you want to keep it.

# Records

Project runtime records live under `.orchestra/`. Shared writers use the project lock.
The public record is `runs/<id>/run.json`, version `run-report/1`; readers ignore unknown
fields. The runner writes it atomically at checkpoints, including while waiting and on
failure or stop. `completed` reports process execution, merged changes and zero gate exits.

| File | Writer | Contents |
|---|---|---|
| `config.json` | User; `init` supplies suggestions | `orchestra.v2-adapters/1`: agents map, escalation, fanout, retries, gates, timeouts, queue, quota balancing and knowledgeObservedLimit (nonnegative integer, default 10) |
| `queue.json` | CLI / worker under lock | held reason, nextId, items with task, options (workflow, tier, taskFile, gates), status, runId and timestamps |
| `queue.lock/owner` | Lock holder | pid, token and acquisition time; dead owners can be replaced |
| `worker.pid`, `worker.log` | Worker / launcher under lock | process identity and diagnostics |
| `quota.json` | Adapter readers / runner under lock | provider keys, windows, observed time, source, limit or read error; no model call |
| `watch/*` | `run` / `watch` watcher | shared report-once attention event markers |
| `adapter-tests/<id>/call/` | Adapter test | brief, stdout, stderr and normalized result |

## Run folder

`run` reserves the queue item's `runId` when enqueuing, so even `run --detach` can print it
before the worker starts. The worker retains that ID when claiming the item; its run folder
appears when execution starts. Tasks added with `queue add` receive their ID when claimed.
`run` watches the reserved run unless `--detach` or `--foreground` is supplied. Its questions,
quota, crash and stuck markers use the same keys as a later `watch`, preventing repeat alerts.

| File | Writer | Contents |
|---|---|---|
| `run.json` | Runner | contract, taskFile, baseCommit, finalCommit, status, runtimeStatus, steps, tasks, gates, questions, tokens, calls, unavailable, suggestions |
| `state.json` | Worker creates; runner updates | internal checkpoint, workflow snapshot, per-step outputs, lane branch/base/merge checkpoints, phase progress and question batch |
| `progress.md` | Runner | human view of state, questions, startup fixes and directions |
| `task.md` | Worker | original request |
| `tasks.md` | Workflow output | generated task list, checkboxes only change after merge and gates |
| `FINAL.md` | Runner | process outcome and final revision |
| `calls/<step>[-N]/brief.md` | Runner | fresh prompt with bounded handoff, selected inputs, user answers and steering |
| `calls/<step>[-N]/stdout.txt`, `stderr.txt` | Adapter process | raw output, including partial output from interrupted calls |
| `calls/<step>[-N]/result.json` | Adapter runner | adapterResult:1, status, message/output, tokens or null, exitCode, startup problem/fix, optional quota/transcript |
| `calls/<step>[-N]/unfinished.patch` | Runner | failed task changes, reference only; never applied |
| `calls/<step>-changes.patch` | Runner | diff of a successful write step, including agent-created commits |
| `logs/*.log` | Gate process | complete stdout/stderr of a command |
| `events.jsonl` | Runner | startup handover events |
| `answers-N.md` | `answer` | user's numbered answers; the runner alone updates state |
| `steering.jsonl` | `steer` | directions applied at the next step or dispatch boundary |

Gate records contain `phase`, `command`, `exit`, relative `log` and tested `revision`.
Task records contain `id`, `phase`, `status` (`executed`, `failed`, `skipped`), agent,
commits and attempt count. `executed` is set only after merge and phase gates.
Step records include status, attempts, token totals, structured output, actual changed files, diff path
and commits for writes. A successful empty write has status `no-changes` and stops dependents.
A clean process exit alone never makes a write step completed.

`tokens` is `{calls,tokens,unreported}`. Tokens sum reported input, output and cache fields;
it is processed volume, not billing or account consumption. A call is counted before it
starts. Calls interrupted before reporting usage stay explicitly unreported. Step attempts
and the run call list retain individual token fields and artifact paths.

Internal statuses include `queued`, `running`, `awaiting_user`, `awaiting_quota`, `completed`,
`stopped`, `failed`. The public status is `completed`, `stopped` or `failed`;
`runtimeStatus` distinguishes waiting. Status/check derive `crashed` from a dead worker;
they never rewrite state. Reading a report never makes a model call.

Worktrees live under Git's common directory. Unfinished lane branches survive stopping,
failure and crashes. Resume reattaches those branches and skips completed step checkpoints.
A merge recorded by Git just before a crash is recognized by ancestry on resume.


## Machine knowledge and workflow artifacts

Machine knowledge is outside all repositories at `~/.config/orchestra/knowledge.json`:
`{version:1,nextId,clis:{"<cli>":[{id,text,trusted,source,merged,sources}]}}`.
Writers share the user configuration directory's `queue.lock`, using the same lock protocol
as project writers. IDs are unique across CLIs. An explicit approval confirms a note and
folds exact whitespace/case-normalized duplicates for the same CLI into that ID; merged IDs
and sources are retained. There is no similarity merge. Manual additions are confirmed;
automatic additions are observed and skip normalized duplicates under the user lock.

Adapter startup failures record `what` and the exact `fix`. Structured outputs may contain
`lessons:[{scope:"cli"|"project"|"code",text:"..."}]`. CLI lessons are saved for the CLI that
made the call, with the call artifact path as source. Project/code lessons retain their
scope in `run.json` suggestions, alongside explicit `suggestions` returned by calls, including
failed attempts. No project knowledge files are written. Project facts belong in the project's
own guidance files and documentation.

Briefs include all confirmed notes for the selected CLI and at most the newest
`knowledgeObservedLimit` observed notes (default 10, ordered by creation ID). Every note is
labeled confirmed or observed. Duplicate observations do not change creation order.

The authoring workflow uses `runs/<id>/workflows/draft.json` for a serialized data pack,
then `runs/<id>/workflows/<name>/` for validated JSON and Markdown prompts. Gate logs show
validation and simulation before a user approval permits copying to a workflow folder.
No authoring call has write access to project files or engine source.

Council sessions add `verification.json` (checks, verified/unverified counts, exact source,
line range and reason) and `decision.md` (decision-record/1 Markdown sections). The gate
checks all declared evidence and scanned references before synthesis and again before the
user decides. The user's answer is the decision text; optional JSON can replace suggested
rejected-options and open-questions tables. These files stay in the session folder until
the user chooses a permanent destination. Parallel checkpoints keep peer vendor origins
internally, separate from anonymous peer inputs; they allow peer exclusion after resume.

# code

Implements a task list. Cheap workers run the tasks in isolated lanes; Orchestra merges
each phase and runs your gates on the merged commit. It is a single `lanes` block.

## Use it

Create `tasks.md` in your project, for example:

```markdown
## Phase 1: Core
- [ ] T001 [P] Create src/one.js exporting a function that returns 1
- [ ] T002 [P] Create src/two.js exporting a function that returns 2
- [ ] T003 Create src/sum.js importing both functions and exporting their sum
```

Adapt the paths and module style to your project, then commit the task file. Run it with a
gate that exists in your project:

```sh
orchestra run code --task-file tasks.md --gate "npm test"
```

Here `npm test` assumes your project has a test script. Repeated `--gate` arguments replace
configured gates for that run. Gates run after each phase on the merged revision.
Add `--foreground` to run in the calling process, or `--detach` to return at once.

Without `--task-file`, give a task instead: `orchestra run code "Add a sum module with tests"`.
A highest-tier agent writes the task list first; it stays in the run folder.

## What happens

- When workers are below the highest tier, the highest tier writes all their briefs in one
  call per phase.
- Consecutive `[P]` tasks run in separate worktrees; an unmarked task waits for the ones
  before it. `[P]` promises different files and no shared state, and Orchestra trusts it.
- Only executed tasks whose gates passed are ticked. Existing ticks are skipped. A project
  task file is ticked on the run branch and reaches your checkout when you land it.
- A lane merge conflict gets one redo on the merged work; a second conflict asks you.

## What you get

A run branch, normally `orchestra/<run-id>`, and `.orchestra/runs/<run-id>/run.json` with
tasks, commits, gate commands, exits and logs. Inspect the branch, then land it:

```sh
git diff HEAD...orchestra/<run-id>
orchestra land <target-branch>
```

## Budget

128 calls: one plan when there is no task file, one brief call per phase, one call per task,
plus diagnoses and retries for failures.

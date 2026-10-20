# Working on Orchestra

Read README.md and CONSTITUTION.md first: every change must keep the constitution's promises
and respect its non-goals. Orchestra is a Node CLI, Node 18+, built-in modules only, no dependencies.

## Layout

- `orchestra/bin/orchestra.mjs`: install, queue/worker, run, status, questions, steering,
  watch/check, quota, knowledge, workflow tools, adapter tests, stop/resume, land and doctor.
- `orchestra/lib/runner.mjs`: six-block execution, lanes, merges, gates, retries,
  setup handover, user questions, steering and resume.
- `agents.mjs`, `quota.mjs`, `balance.mjs`: adapter execution and quota balancing.
- `context.mjs`, `digest.mjs`: fresh-call handoffs and failed-attempt summaries.
- `git.mjs`, `state.mjs`, `lock.mjs`, `queue.mjs`: isolation, records and shared writers.
- `knowledge.mjs`: machine notes keyed by CLI, automatic observations and approved duplicate merges.
- `orchestra/adapters/`: three built-in adapters following the public versioned interface.
- `workflows/`: data packs, prompts and standard-library gate scripts.
- `skills/orchestra/SKILL.md`: the single standard skill, installed with `npx skills add`.
- `orchestra/templates/`: development config and execution prompts.
- `test/e2e.mjs`: mock agents, real Git/processes; never spend model tokens in tests.

## Conventions

- Procedures belong in workflow data and prompts; guarantees belong in code.
- Report facts: process exits, commits, gate results and logs. The user decides quality.
- Core and blocks target at most 2,000 non-blank, non-comment lines.
- CLI specifics belong in adapters; the core must not name workflows.
- Prompts start with `ORCHESTRA ROLE: <role>` and `CYCLE: n`.
- Adapter contract: versioned declarations or executables normalize results to
  `adapterResult:1`, `status`, `finalMessage`, structured output and optional usage.
  See `docs/adapters.md`.
- Questions go through the user session and `orchestra answer`; agents never answer for users.
- Nothing spends tokens while waiting. Quota readers are read-only.
- Runtime files are ignored by Git. Shared project files use the project lock; user stores use the user-directory lock. Document record changes
  in `docs/records.md`.
- Branch per change, semantic versions and `CHANGELOG.md`. Run `npm test` and the guard
  before committing. During restructuring, only pre-existing guard failures reduced by the
  change may remain.
- No AI attribution anywhere. Commits use the configured user's identity. Never push unless
  explicitly instructed.

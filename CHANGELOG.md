# Changelog

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

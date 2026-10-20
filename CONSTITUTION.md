# Orchestra Constitution

The principles every change to Orchestra must keep.

## Purpose

> **Get the most out of the subscriptions you already pay for.**
> Strong models orchestrate; cheap models do the bulk of the work.

**What Orchestra does:** it orchestrates agents to get a job done, whatever the job is: code,
research, review or deliberation.

Five promises define Orchestra. Every change must keep all five.

1. **Cheap models do the bulk of the work.** Strong models write briefs, plans and syntheses
   and diagnose failures. They don't do the typing.
2. **Every subscription drains at an even pace.** Work is weighted by each account's 5-hour and
   weekly windows, so nothing runs dry early.
3. **Work runs in parallel** across agents and vendors, with each step's guarantees enforced
   by code, not left to an agent's goodwill.
4. **Nothing spends tokens while waiting.** The tool is idle until something needs you.
5. **Any CLI, and you stay the only author.** It isn't tied to one vendor, and it commits as you
   with no AI attribution.

## Non-goals

Orchestra is not:
- **a judge.** It reports facts (what ran, which commits, which gates exited 0) and never
  decides whether work is "good" or "done". A loop stops only on a field in a step's structured
  output, read mechanically. Workflows that recommend (council) leave the decision to you.
- **a general agent framework.** It has a small, closed set of blocks. A new block needs a real
  workflow that the existing blocks can't express.
- **a place for custom code per job.** Workflows are data files and prompts. The engine never
  names a workflow.
- **the default for every task.** Work one agent can do directly should be done directly.

## Spirit test for any change
- Does it make cheap models do *more* of the work, or strong models do less?
- Does it keep quota even, or spend tokens while waiting?
- Does it work for a CLI we've never heard of?
- Does it add a verdict or score? If so, it doesn't belong in Orchestra.
- Is it a procedure? Then it's a workflow file. Is it a guarantee several workflows need? Then
  it may be a block.

## Delivery standards

- Make each change on its own branch; never work directly on the default branch.
- Use Node 18 or newer and built-in modules only, with no dependencies.
- Keep the core and blocks within 2,000 non-blank, non-comment lines.
- Run `npm test` before every commit; it is the delivery gate. Tests use the mock agent and
  never spend model calls.
- The engine core never names a CLI or a workflow, and nothing in the repository depends on
  another product.
- Use semantic versions and record changes in `CHANGELOG.md`.
- Commit as the configured user's git identity. Never add AI attribution to commits,
  pull requests, issues, code or documentation.

## Governance

Every change must preserve the five promises, pass the spirit test and respect the non-goals.
Procedures belong in workflow files; reusable guarantees belong in the six blocks.
Amend this constitution explicitly before changing the product's direction.

**Version**: 1.0.0 | **Ratified**: 2026-10-20 | **Last amended**: 2026-10-20

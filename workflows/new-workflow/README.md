# new-workflow

Builds a new workflow with you. Agents make sure they understand your use case before
anything is drafted, then the draft is checked, drawn, simulated and saved only after you
approve.

## Use it

```sh
orchestra run new-workflow "Review each pull request with two reviewers and summarize their feedback"
```

## What happens

Orchestra's engine is the orchestrator: it calls each agent in a fixed order and nothing
else can add or skip a step.

1. **Understand** (up to 3 rounds).
   - A tier-3 *interviewer* asks you what repeats, what you give and get back, which steps
     can run at the same time, which decisions are yours, what agents must never do, what
     happens when a check fails, and **whether the path is fixed or an agent chooses at
     named points** (and between which options).
   - Two *reviewers* at tier 2, from different vendors when you have them, look
     independently for gaps that would change the workflow's shape or safety.
   - A tier-3 agent shows you the summary and the gaps and asks you to confirm or correct
     them. It returns `understood: yes` or `no`; `no` starts another round.
2. **Build** (up to 3 drafts).
   - A tier-3 *author* drafts `workflow.json` (format 3) and Markdown prompts, following
     your routing choice: a fixed path, or `choices` and `when` only at the points you named.
     It follows "Designing a workflow" in Orchestra's `docs/workflows.md`.
   - Gates check the draft, draw it (`workflow.drawio` and a text `outline.txt`) and
     dry-run it with mock agents.
   - You read the outline or open the drawing, then reply `approve project`,
     `approve user`, `decline`, or what to change. A change request starts another draft.
3. **Save.** A script saves the pack to `.orchestra/workflows/<name>/` (project) or
   `~/.config/orchestra/workflows/<name>/` (user) only on an exact approval.

Every question waits for `orchestra answer` without spending tokens. A draft that fails its
check or dry run stops the run with the gate log; run it again with what to change.

## What you get

The saved pack, including its diagram, or nothing if you decline. Existing names are never
overwritten; drafts stay in the run's `workflows/` folder. It never changes Orchestra's own
source. Typical cost: 7 calls for one round and one draft, plus one call for each round of
questions; the budget is 40.

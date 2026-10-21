# new-workflow

Builds a new workflow pack with you, checks and simulates it, and saves it only after you
approve.

## Use it

```sh
orchestra run new-workflow "Triage new issues each morning"
```

1. **Describe.** You are asked for the repeated job, its inputs, outputs and the decisions
   that are yours. A description of the workflow is **required**: what it does, what to give
   it with one example command, and what it returns. It is saved in the pack's
   `workflow.json`. If the job seems too simple for a workflow it says so and asks; insisting
   builds it.
2. **Draft.** A tier-3 read-only call drafts `workflow.json` (format v2) and Markdown prompts.
   It cannot add code; gates may only call existing commands. If the six blocks can't express
   a step it says "this needs a 7th block" and asks how to proceed.
3. **Check, diagram and simulate.** Gates check the structure and that the draft has a
   description, generate `workflow.drawio`, then dry-run the pack with mock agents. A draft
   without a description fails here and is not saved.
4. **Approve.** Open `.orchestra/runs/<run-id>/workflows/workflow.drawio` in draw.io or the
   Draw.io extension in VS Code, read the gate logs, then answer exactly `approve project` or
   `approve user`, or `decline`.

## What you get

The pack in `.orchestra/workflows/<name>/` (project) or `~/.config/orchestra/workflows/<name>/`
(user), including its diagram, or nothing if you decline. Existing names are never
overwritten. Drafts stay in the run's `workflows/` folder. It never changes Orchestra's own
source. Budget: 6 calls.

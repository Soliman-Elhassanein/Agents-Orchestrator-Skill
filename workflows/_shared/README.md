# How council sessions run

`council`, `council-compare`, `council-learn` and `council-review` share these steps and
prompts. Only their research prompt (`mode.md`) differs, and it sets what the session
produces. Every step reads; none edits project files.

1. **Frame.** You are asked what you know, want and don't know. Answer with
   `orchestra answer "…"`.
2. **Research** at tier 1 gathers facts with exact local evidence.
3. **Proposals:** three independent agents at tier 3 or above, from different vendors when
   available, otherwise any available agents. Each has its own session.
4. **Critique:** each agent sees the others' proposals anonymously, without its own vendor.
   It stops on the first response's `stop:true`, with at most two rounds; if the bound
   is reached without it, the later steps stop.
5. **Verify:** a gate checks every declared quote against its real file and line range,
   and marks undeclared quotes and remote sources unverified. A verified location proves
   existence only, never the meaning of a claim. Results are in `verification.json`.
6. **Decide:** you read the synthesis in `orchestra status --json` and `verification.json`,
   then answer with your choice and why. A JSON answer with `decision`, `rejectedOptions`
   and `openQuestions` replaces the proposed tables.
7. **Record:** your answer becomes `.orchestra/runs/<run-id>/decision.md`, with Date,
   Question, Decision, Rejected options, Open questions and Sources. Copy it where you want
   to keep it.

The engine synthesizes each parallel block at the highest configured tier. Configure tier
1 and tier 3 entries; three vendor CLIs are preferred but not required. Orchestra waits
without calls at each question. If watching returns a check-in or another event, handle it
and reattach with `orchestra watch`.

A typical session makes nine calls: one research, three proposals, three critiques and two
engine syntheses. A second critique round adds four. Retries are extra; the budget is 16.

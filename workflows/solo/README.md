# solo

One agent does the task. Orchestra picks a tier-2 agent by quota, briefs it, records its
commits on a run branch and runs your gates on the result.

## Use it

```sh
orchestra run solo "Add a health check endpoint with a test" --gate "npm test"
```

`--gate` is optional; repeat it to run several commands. Without it, the gates in
`.orchestra/config.json` run. Add `--foreground` to run in the calling process, or `--detach`
to return at once with the run ID.

## What happens

1. If the chosen agent is below your highest tier, a highest-tier agent writes a brief for it.
2. The agent does the task in its own worktree. Orchestra commits its changes.
3. Gates run on that commit. A failed attempt or gate gets a highest-tier diagnosis and a
   rewritten brief before the next try. `executorRetries` (default 1) limits the tries and
   `escalate.afterFailures` decides when the step moves up a tier.
4. If the agent asks questions, the run waits for `orchestra answer` without spending tokens.

The task does not have to change files. "Check that every endpoint has a test" or "Review
the login flow and tell me what is risky" complete with no commits; the agent's answer is
the result. `.orchestra/runs/<run-id>/FINAL.md` ends with it, and your agent CLI relays it.

## What you get

The agent's answer at the end of `FINAL.md`, a branch `orchestra/<run-id>` with its commits
if it changed anything, and `run.json` in `.orchestra/runs/<run-id>/` with the calls,
commits, gate exits and logs. Look at the branch,
then land it onto a branch you name: `orchestra land <run-id> <branch>`.

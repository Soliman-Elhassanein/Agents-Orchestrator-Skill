# council-review

Reviews code or a document read-only and reports observations with checked evidence. It
returns a report, never tasks or code edits. Agents of different vendors review and critique
each other anonymously.

## Use it

Name what to review and what to look for:

```sh
orchestra run council-review "Review src/queue for error handling"
```

At the end, confirm what to keep in the record with `orchestra answer`.

## What you get

The report in `orchestra status --json`, `verification.json` for the checked quotes and
`.orchestra/runs/<run-id>/decision.md`. You decide what to act on.
See [how council sessions run](../_shared/README.md) for every step.

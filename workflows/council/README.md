# council

Helps you decide an unclear question. It researches, gathers independent proposals and
critique from agents of different vendors, checks their quotes, then asks you to decide.
It recommends; you decide. It never edits project files.

## Use it

```sh
orchestra run council "Should this project store its cache in files or a database?"
orchestra status
orchestra answer "Compare local files and a local database; portability matters most."
orchestra watch
```

When it reports the final decision question, read the synthesis in `orchestra status --json`
and `.orchestra/runs/<run-id>/verification.json`, then decide:

```sh
orchestra answer "Choose local files because the data is small and portability matters most."
orchestra watch
```

## What you get

`.orchestra/runs/<run-id>/decision.md` with your decision, rejected options, open questions
and checked sources. See [how council sessions run](../_shared/README.md) for every step,
the tiers it needs and its call count.

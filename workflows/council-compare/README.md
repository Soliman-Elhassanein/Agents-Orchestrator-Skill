# council-compare

Compares options you already have. Agents of different vendors research them, propose and
critique anonymously, their quotes are checked, and you choose. It never edits project files.

## Use it

Name the question and the options:

```sh
orchestra run council-compare "SQLite or Postgres for the local cache? Portability matters most."
```

Answer the framing question, then give your choice at the end with `orchestra answer`.

## What you get

`.orchestra/runs/<run-id>/decision.md` with the chosen option, the rejected options and why,
and open questions. See [how council sessions run](../_shared/README.md) for every step.

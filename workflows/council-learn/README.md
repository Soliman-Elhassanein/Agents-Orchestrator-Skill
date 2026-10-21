# council-learn

Teaches a topic. Agents of different vendors explain the concepts, a glossary, what to learn
first and in what order, and questions to ask next; they critique each other anonymously and
their quotes are checked. It never edits project files.

## Use it

```sh
orchestra run council-learn "How does this repository's queue work?"
```

Say in the framing answer what you already know. At the end, confirm what to keep in the
record with `orchestra answer`.

## What you get

The synthesis in `orchestra status --json` and `.orchestra/runs/<run-id>/decision.md`.
See [how council sessions run](../_shared/README.md) for every step.

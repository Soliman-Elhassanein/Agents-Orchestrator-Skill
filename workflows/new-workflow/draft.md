ORCHESTRA ROLE: workflow-author
CYCLE: 1

Draft a reusable Orchestra workflow from the confirmed use case in Inputs. Read
{{engineDir}}/docs/workflows.md first: the format, the six blocks, routing and "Designing a
workflow". If Inputs hold an earlier draft and the user asked for changes (see the questions
already answered), revise that draft instead of starting over.

Follow the user's routing choice exactly:
- fixed: no `choices` and no `when`; every run takes the same path.
- agent-decides or mixed: at each named route point, an `agent` step with
  `choices:{field, values}` listing exactly the options the user named, and later steps with
  `when` for each option. Everywhere else the path stays fixed.

Use the fewest steps that do the job: a single agent step when one agent can, a `parallel`
block only for independent views, an `ask` for each decision that belongs to the user, a
`gate` for anything a command can check, a bounded `loop` with a structured stop field for
repetition, and a `checklist` block for task lists. Cheap tiers do the bulk; tier 3 plans,
critiques and synthesizes. Give `sees` only the earlier outputs a step needs. Write each
prompt so it states its role, what to return as JSON, what it must never do, and what to do
when evidence is missing.

If the six blocks cannot express a step, return {"questions":["This needs a 7th block: ..."]}
and ask the user how to proceed. Do not add code; gates may only call existing commands.

Return JSON {"pack":"<serialized JSON object>"}. The serialized object is
{"name":"short-name","files":{"workflow.json":"<workflow JSON text>","prompt.md":"<text>"}}.
Only workflow.json and Markdown prompts are allowed. Use workflow format 3 with a non-empty
"description": what the workflow does, what to give it with one example `orchestra run`
command, and what it returns. Set a positive budget.calls that covers the worst case. Start
every prompt with ORCHESTRA ROLE and CYCLE lines. Do not draw a diagram: code draws it from
workflow.json.

# Adapter format v1

An adapter tells Orchestra how to run an installed, authenticated CLI. Add `my-tool.json`
to `.orchestra/adapters/` or `~/.config/orchestra/adapters/`. Project files win, then user
files, then shipped adapters. Names contain letters, digits, underscores and hyphens.
No core change or package installation is needed.

```json
{
  "adapter": 1,
  "command": ["my-tool", "--json"],
  "prompt": { "mode": "stdin" },
  "flags": {
    "model": ["--model", "{model}"],
    "effort": ["--effort", "{effort}"],
    "read": ["--read-only"],
    "write": ["--allow-write"]
  },
  "result": { "format": "json", "message": "reply", "usage": {
    "input": "usage.input", "output": "usage.output"
  } },
  "startup": [{ "pattern": "login required", "fix": "Run my-tool login." }]
}
```

Add an agent entry to `.orchestra/config.json`:
`"small": {"cli":"my-tool","model":"small","tier":1,"weight":1}`.
Run `orchestra adapter test my-tool` for one short read-only call. It spends a small call
on the configured model; tests in this repository use only a mock.

Commands and flags are argument arrays, never shell strings. `{node}` expands to the Node
executable; `{adapterDir}`, `{briefFile}`, `{cwd}`, `{outDir}`, `{model}` and `{effort}`
expand to literal argument values. Relative helper paths should use `{adapterDir}`.
`prompt.mode` is `stdin`, `arg` (append `prompt.args`, using `{prompt}` for text or
`{briefFile}` for a path), or `none` (the command already includes the brief path).
Flags for absent model/effort are omitted. Access is `read` or `write`.

`result.format` is `text`, `json`, or `jsonl` (last object matching the optional
`result.match` object). Dot paths select `message`, `error`, `status` and usage fields.
A missing usage field means unreported, never zero. `result.file` reads a file relative
to the call directory instead of stdout. `result.finalFile` reads final text separately.
Process exit must be zero and the result must not report failure to count as completed.

For more complicated streams, `reader` is a command array. It receives one JSON request
on stdin: `{operation:"result", outDir, exitCode, agent}`. It prints the normalized result
below. A `transcript` command receives `{operation:"transcript",outDir,agent}` and prints
`{commands:[{cmd,code}],files:["path"],errors:["text"]}` for bounded failure digests.
A `quota` command receives `{operation:"quota",agent}` and prints a read-only observation:
`{windows:[{name,usedPercent,windowMins,resetsAt}],limitReached:null,observedAt,source}`.
It must never prompt a model, consume credits or change account state. A result may also
contain `quota` for passive observations. `quotaKey` is a string or a list of
`{pattern,key}` rules matched against model; `quotaFrom` on an agent overrides it.

## Executable escape hatch and result contract

Set `"executable":true`, `"prompt":{"mode":"none"}` and a `command` array using the
path placeholders. Any executable language is supported. It prints this JSON on stdout:

```json
{"adapterResult":1,"status":"completed","finalMessage":"reply",
 "tokens":{"input":100,"output":20,"cacheRead":0,"cacheWrite":0}}
```

`status` is `completed` or `failed`; `tokens` is null when unreported. Optional `output`
is structured JSON for workflow fields, `quota` is a passive observation, and `transcript`
is the normalized transcript above. Optional `startup` is `{what,fix}` when the CLI could
not start. Declarative `startup` patterns inspect process errors and stderr, never reply
prose. Startup handover does not consume a task retry or produce a failure digest.
Missing executable, permission, sandbox, model and authentication errors need actionable
fixes in each adapter. An executable can classify them itself. Startup classifications
are automatically saved as observed machine notes for the calling CLI, with the exact fix.

Structured output may include `lessons:[{scope:"cli"|"project"|"code",text:"..."}]`.
CLI lessons become observed machine notes (normalized duplicates are skipped); project and
code lessons appear only in run.json suggestions. This also applies to failed calls.
See [records](records.md) for storage and brief limits.

Every call gets fresh artifacts: brief, stdout, stderr, normalized result and process exit.
Read access is checked against the Git tree, including untracked files. Write access allows
changes without requiring them; a completed write call with no changes records `changes: []`.

## When the sandbox blocks your tools

Built-in adapters start write calls inside the CLI's own sandbox, so an agent can change only
its run worktree. Some project tools need more: a test runner that opens a local port, or a
toolchain that writes a cache outside the repository. Then the agent can write code but can't
run the tests, while Orchestra's gates, which run outside the sandbox, still can.

Check each CLI once per project, with the command your gates run:

```sh
orchestra adapter test <name> --command "<test command>"
```

Orchestra runs the command in a clean worktree at `HEAD`. If it fails there, nothing else
runs: fix the command first. Otherwise it starts the agent in a second worktree with its write
flags and asks it to run the command once and report the exit code. It prints `works`, or
`write sandbox blocks` with both exit codes, the agent's output and the logs. It spends one
call and judges nothing; it reports the two exit codes.

To fix a block, copy the adapter it names to `.orchestra/adapters/<name>.json` (the project
copy wins) and change only its `write` flags to allow what the output shows, such as local
network access or one extra writable folder. Your CLI's sandbox documentation names the
setting. Keep the rest of the sandbox, then run the test again.

/**
 * Run records. `state.json` is the machine-readable truth; `progress.md` is the human view the
 * Communicator reads back to the user; `events.jsonl` is the append-only log.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectMessage } from "./util.mjs";

export function runsDir(root) {
  return join(root, ".orchestra", "runs");
}

export function newRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  // Date, time to the second and a random suffix: 20261026-142233-k3fq. Runs sort by start time.
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export class RunState {
  constructor(root, id, data) {
    this.root = root;
    this.id = id;
    this.dir = join(runsDir(root), id);
    this.data = data;
  }

  static create(root, id, data) {
    const run = new RunState(root, id, data);
    mkdirSync(run.dir, { recursive: true });
    run.save();
    return run;
  }

  static load(root, id) {
    const dir = join(runsDir(root), id);
    const data = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    return new RunState(root, id, data);
  }

  path(...parts) {
    return join(this.dir, ...parts);
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    writeAtomic(this.path("state.json"), `${JSON.stringify(this.data, null, 2)}\n`);
    writeAtomic(this.path("progress.md"), renderProgress(this.data));
  }

  event(type, detail = {}) {
    appendFileSync(this.path("events.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), type, ...detail })}\n`);
  }

  set(patch) {
    Object.assign(this.data, patch);
    this.save();
  }

}

export function listRuns(root) {
  const dir = runsDir(root);
  if (!existsSync(dir)) return [];
  // Oldest first, by start time (ids alone can tie within a second on older runs).
  const started = (id) => {
    try { return JSON.parse(readFileSync(join(dir, id, "state.json"), "utf8")).startedAt ?? ""; } catch { return ""; }
  };
  return readdirSync(dir)
    .filter((id) => existsSync(join(dir, id, "state.json")))
    .map((id) => [id, started(id)])
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1))
    .map(([id]) => id);
}

export function latestRunId(root) {
  const runs = listRuns(root);
  return runs[runs.length - 1] ?? null;
}

export function renderProgress(s) {
  const lines=[`# Run ${s.id}`, '', `**Task:** ${s.task.split('\n')[0]}`, '',
    `Status: **${s.status}**; phase: ${s.phase}; branch: \`${s.branch}\`.`, ''];
  if(s.usage)lines.push(`Reported tokens: ${s.usage.tokens}; calls: ${s.usage.calls}; unreported: ${s.usage.unreported}.`, '');
  if(s.questions) {
    lines.push(`Answer batch ${s.questions.batch} with \`orchestra answer ${s.id}\`:`, '');
    for(const q of s.questions.items)lines.push(`${q.n}. ${q.question}${q.options?.length ? ' ('+q.options.join(' / ')+')' : ''}`);
  }
  for(const [name,u] of Object.entries(s.unavailable ?? {}))lines.push(`Agent ${name} could not start: ${u.what}. Fix: ${u.fix}.`);
  for(const [id,e] of Object.entries(s.steps ?? {}))lines.push(`- ${id}: ${e.status}${e.agent ? ' ('+e.agent+')' : ''}${e.commit ? '; commit '+e.commit : ''}`);
  for(const d of s.directions ?? [])lines.push(`Direction: ${d.text}`);
  if(s.final)lines.push('',s.final);
  if(s.error)lines.push('',`Error: ${s.error}`);
  return lines.join('\n')+'\n';
}
export function oneLine(s,root=process.cwd()) {
  if(!s)return 'No run yet.';
  return projectMessage(root,s.questions ? `waiting for your answers — ${s.questions.items.length} question(s)` : `${s.status} — ${s.phase}; ${s.usage?.calls ?? 0} calls`);
}

/** Best-effort desktop notification; silently skipped when no notifier exists. */
export function notify(title, body) {
  const attempt = (cmd, args) => {
    try {
      const p = spawn(cmd, args, { stdio: "ignore", detached: true });
      p.on("error", () => {});
      p.unref();
    } catch { /* no notifier */ }
  };
  if (process.platform === "linux") attempt("notify-send", [title, body]);
  else if (process.platform === "darwin") {
    attempt("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]);
  }
}

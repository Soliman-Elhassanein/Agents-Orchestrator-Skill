#!/usr/bin/env node
/**
 * Orchestra — parallel agent execution with quota balancing and idle waiting.
 * init | run <workflow> [task] [--task-file <file>] [--gate <cmd>] [--detach|--foreground]
 * answer [id] <answers> | steer [id] <direction> | resume [id] | stop [id]
 * status [id] [--json] | list | check [--json] | watch | quota [--no-refresh] [--json]
 * run / watch: [--every <minutes>] [--stuck-after <minutes>] — run watches unless detached or foreground
 * queue [add <workflow> <task>|edit|rm|move|hold|resume] | adapter test <name> [--command <cmd>]
 * workflow list [--json] | check <file> | diagram <name|file> [--out <file>|--text] | run <name> --dry | add <path|git-url> [--user]
 * knowledge [add <text>|approve <id>|rm <id>] [--cli <name>] [--json] | land [id] <target-branch> | doctor
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectedAgents, loadAdapter, quotaKey, runAgent } from "../lib/agents.mjs";
import { loadConfig, parseDuration } from "../lib/config.mjs";
import * as g from "../lib/git.mjs";
import * as queue from "../lib/queue.mjs";
import { listWorkflows, loadWorkflow, workflowFile, builtinWorkflows, checkWorkflow, dryWorkflow, addWorkflow } from "../lib/workflows.mjs";
import { workflowOutline, writeWorkflowDiagram } from "../tools/diagram.mjs";
import { runLoop } from "../lib/runner.mjs";
import { childEnv } from "../lib/util.mjs";
import { RunState, latestRunId, listRuns, newRunId, oneLine } from "../lib/state.mjs";
import { addLessons, approveLesson, loadKnowledge, removeLesson, renderKnowledge } from "../lib/knowledge.mjs";
import { loadQuota, quotaWarnings, refreshQuota, renderQuota } from "../lib/quota.mjs";

const ENGINE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const allAgents = (cfg) => Object.entries(cfg.agents).map(([name,a])=>({...a,name}));

function die(msg, code = 1) {
  process.stderr.write(`orchestra: ${msg}\n`);
  process.exit(code);
}

function findProjectRoot(from = process.cwd()) {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, ".orchestra", "config.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) die("not inside an Orchestra project — run `orchestra init` in your repo first");
    dir = parent;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists, just not ours to signal
  }
}

/**
 * Load a run. A run whose worker died (killed, machine crashed) while it was running or waiting
 * for answers is *reported* as crashed — derived here, never written: state.json has one writer,
 * the runner.
 */
function resolveRun(root, id) {
  const runId = id ?? latestRunId(root);
  if (!runId) die("no runs yet");
  if (!existsSync(join(root, ".orchestra", "runs", runId, "state.json"))) die(`no run "${runId}"`);
  const run = RunState.load(root, runId);
  if (["running", "awaiting_user", "awaiting_quota", "queued"].includes(run.data.status) && run.data.pid && !pidAlive(run.data.pid)) {
    run.data = { ...run.data, status: "crashed", crashedWhile: run.data.status, error: run.data.error ?? "the worker process is gone — see .orchestra/worker.log" };
  }
  return run;
}

/** Task text from `--task-file <f>` or the remaining words (only Orchestra's own flags are removed). */
function taskFrom(args) {
  const fileIdx = args.indexOf("--task-file");
  if (fileIdx !== -1) {
    if (!args[fileIdx + 1]) die("--task-file needs a path");
    return readFileSync(resolve(args[fileIdx + 1]), "utf8").trim();
  }
  return args.filter((a) => a !== "--foreground").join(" ").trim();
}

const guard = (fn) => {
  try { return fn(); } catch (e) { return die(e.message); }
};

// ── init ────────────────────────────────────────────────────────────────────

function cmdInit(args) {
  let root = g.repoRoot(process.cwd());
  if (!root) {
    // A folder that is not a Git repository yet becomes one: runs branch from its history.
    g.git(process.cwd(), ["init", "-q"]);
    root = g.repoRoot(process.cwd());
    console.log(`Created a Git repository in ${root}.`);
  }
  const orch = join(root, ".orchestra");
  const engine = join(orch, "engine");
  mkdirSync(orch, { recursive: true });
  if (resolve(engine) !== resolve(ENGINE_DIR)) {
    rmSync(engine, { recursive: true, force: true });
    for (const part of ["bin", "lib", "adapters", "templates", "tools"]) cpSync(join(ENGINE_DIR, part), join(engine, part), { recursive: true });
    cpSync(join(ENGINE_DIR,existsSync(join(ENGINE_DIR,'docs'))?'docs':'../docs'),join(engine,'docs'),{recursive:true});
    cpSync(builtinWorkflows,join(engine,'workflows'),{recursive:true});
    // The engine runs workflows on LangGraph. The copy links the dependencies of the install that
    // ran init (a copy where links are not allowed); running init again refreshes both.
    const modules=[join(ENGINE_DIR,'node_modules'),join(ENGINE_DIR,'../node_modules')].find((d)=>existsSync(join(d,'@langchain/langgraph')));
    if(!modules)die('LangGraph is not installed next to Orchestra; fix: run npm install in the Orchestra folder');
    try {symlinkSync(realpathSync(modules),join(engine,'node_modules'),'junction');}
    catch {cpSync(modules,join(engine,'node_modules'),{recursive:true});}
  }
  const config = join(orch, "config.json");
  if (!existsSync(config) || args.includes("--force")) {
    const cfg=JSON.parse(readFileSync(join(ENGINE_DIR,'templates/config.json'),'utf8'));
    cfg.agents=detectedAgents(root);
    writeFileSync(config,JSON.stringify(cfg,null,2)+'\n');
  }
  const ignore = join(root, ".gitignore");
  const current = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!current.split("\n").includes("/.orchestra/")) writeFileSync(ignore, `${current}${current.endsWith("\n") || !current ? "" : "\n"}/.orchestra/\n`);
  // A repository without commits gets one holding only .gitignore; the user's files stay theirs to commit.
  if (!g.git(root, ["rev-parse", "--verify", "HEAD"], { allowFail: true }).ok) {
    g.git(root, ["add", ".gitignore"]);
    const first = g.git(root, ["commit", "-q", "-m", "chore: Ignore Orchestra's local files"], { allowFail: true });
    console.log(first.ok ? "Made a first commit with .gitignore. Commit your project files before running: runs start from committed work."
      : "Could not make a first commit; fix: set git config user.name and user.email, then commit your files.");
  }
  console.log("Orchestra installed. Edit .orchestra/config.json: detected agents have editable tier suggestions. Then run orchestra doctor.");
}

// ── queue worker ────────────────────────────────────────────────────────────

const pidFile = (root) => join(root, ".orchestra", "worker.pid");
const readPid = (root) => Number(existsSync(pidFile(root)) ? readFileSync(pidFile(root), "utf8") : 0);

/**
 * Where a new run starts. By default it builds on the most recent completed run that hasn't been
 * landed yet, so queued tasks see each other's work ("q4 builds on q3") without landing in
 * between. Landing the later run then lands both. `queue.buildOnPrevious: false` starts every run
 * from your checkout's HEAD instead.
 */
function baseFor(root, cfg) {
  const head = g.headSha(root);
  if (cfg.queue?.buildOnPrevious === false) return { base: head, builtOn: null };
  for (const id of [...listRuns(root)].reverse()) {
    const prev = RunState.load(root, id).data;
    if (prev.status !== "completed" || !prev.finalCommit) continue;
    const landed = g.git(root, ["merge-base", "--is-ancestor", prev.finalCommit, head], { allowFail: true }).ok;
    return landed ? { base: head, builtOn: null } : { base: prev.finalCommit, builtOn: id };
  }
  return { base: head, builtOn: null };
}

function startRun(root, cfg, item, runId) {
  const { base, builtOn } = baseFor(root, cfg);
  const run = RunState.create(root, runId, {
    id: runId, task: item.task, options: item.options ?? {}, queueId: item.id, status: "queued", phase: "starting",
    base, builtOn, branch: `orchestra/${runId}`,
    cycle: 0, tier: 0,
    cycles: [], startedAt: new Date().toISOString(),
  });
  writeFileSync(run.path("task.md"), `${item.task}\n`);
  return run;
}

/**
 * Work through the queue, one task at a time, then exit. Exactly one worker per project: the
 * pid file is claimed and released under the queue lock.
 */
async function processQueue(root) {
  const claimed = queue.withQueue(root, (q) => {
    // ensureWorker writes the child's pid before the child starts, so "it's me" counts as free.
    if (pidAlive(readPid(root)) && readPid(root) !== process.pid) return false;
    // A task still "running" with no live worker means the last worker died mid-run.
    const orphan = q.items.find((i) => i.status === "running");
    if (orphan) {
      orphan.status = "crashed";
      q.held = { reason: `the worker died while running ${orphan.id} (run ${orphan.runId}) — check it, then resume`, at: new Date().toISOString() };
    }
    writeFileSync(pidFile(root), String(process.pid));
    return true;
  });
  if (!claimed) return false;

  let stopping = false;
  const onSignal = () => { stopping = true; };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    for (;;) {
      let cfg;
      try {
        cfg = loadConfig(root);
      } catch (e) {
        queue.holdQueue(root, `config error: ${e.message.split("\n")[0]}`);
        return true;
      }
      const item = queue.claimNext(root, newRunId(), () => rmSync(pidFile(root), { force: true }));
      if (!item) return true;
      const runId = item.runId;
      if (item.resumed) {
        await runLoop(root, runId, { resume: true });
      } else {
        startRun(root, cfg, item, runId);
        await runLoop(root, runId);
      }
      const status = RunState.load(root, runId).data.status;
      queue.finishTask(root, item.id, status, { holdOnFailure: cfg.queue?.holdOnFailure ?? true });
      if (stopping || status === "stopped") {
        queue.holdQueue(root, `stopped by user during ${item.id}`);
        return true;
      }
    }
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    queue.withQueue(root, () => { if (readPid(root) === process.pid) rmSync(pidFile(root), { force: true }); });
  }
}

/**
 * Start a background worker unless one is already alive. Checking and spawning happen under the
 * project lock, and the child's pid is recorded before the lock is released, so two commands
 * issued at the same moment can't start two workers.
 */
function ensureWorker(root) {
  return queue.withQueue(root, () => {
    if (pidAlive(readPid(root))) return false;
    const log = openSync(join(root, ".orchestra", "worker.log"), "a");
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "_worker"], {
      cwd: root, detached: true, stdio: ["ignore", log, log], env: childEnv(),
    });
    writeFileSync(pidFile(root), String(child.pid));
    child.unref();
    return true;
  });
}

// ── run / queue ─────────────────────────────────────────────────────────────

async function cmdRun(args) {
  const root = findProjectRoot();
  guard(() => loadConfig(root));
  const words=[], options={}, watchArgs=[];
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(['--task-file','--gate'].includes(arg)) {
      const value=args[++i];if(!value || value.startsWith('--'))die(`${arg} needs a value`);
      if(arg==='--gate')(options.gates ??=[]).push(value);
      else options.taskFile=resolve(value);
    } else if(['--every','--stuck-after'].includes(arg)) {
      const value=args[++i];if(!value || value.startsWith('--'))die(`${arg} needs a value`);
      watchArgs.push(arg,value);
    } else if(!['--foreground','--detach'].includes(arg)) {if(arg.startsWith('--'))die(`unknown run option: ${arg}`);words.push(arg);}
  }
  // Every run goes through a workflow; the first word names it.
  options.workflow=words.shift();
  const usage='usage: orchestra run <workflow> "<task>"; orchestra workflow list shows the workflows';
  if(!options.workflow)die(usage);
  try {loadWorkflow(root,options.workflow);}catch(e){die(`${e.message}; ${usage}`);}
  const task=words.join(' ') || (options.taskFile ? `Execute task list ${options.taskFile}` : '');
  if(!task)die(`give a task, or --task-file; ${usage}`);
  if (!g.git(root, ["rev-parse", "--verify", "HEAD"], { allowFail: true }).ok) die("the repository needs at least one commit");
  const dirty = !g.isClean(root);

  const runId = newRunId();
  const item = guard(() => queue.addTask(root, task, options, runId));
  const q = queue.loadQueue(root);
  console.log(`Queued as ${item.id} (position ${item.position} of ${q.items.filter((i) => i.status === "pending").length} waiting).`);
  console.log(`Run ${runId}`);
  if (q.held) console.log(`Note: the queue is HELD (${q.held.reason}). \`orchestra queue resume\` to continue.`);
  if (dirty) console.log("Note: uncommitted changes in your working tree are NOT part of runs — commit them first if they matter.");

  if (args.includes("--foreground")) {
    if (!(await processQueue(root))) {
      console.log("A background worker is already processing the queue; your task will run after the ones ahead of it.");
      return;
    }
    const mine = queue.loadQueue(root).items.find((i) => i.id === item.id);
    console.log(`${item.id}: ${mine?.status ?? "not run"}`);
    if (mine?.status !== "completed") process.exitCode = 1;
    return;
  }
  if (ensureWorker(root)) console.log("Worker started. Progress: `orchestra status`, queue: `orchestra queue`.");
  else console.log("The worker is busy; your task will start when the ones ahead of it finish.");
  if (!args.includes('--detach')) await cmdWatch(watchArgs, runId);
}

function cmdQueue(args) {
  const root = findProjectRoot();
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "list":
      console.log(queue.renderQueue(queue.loadQueue(root)));
      return;
    case "add": {
      const [workflow, ...words] = rest;
      const task = taskFrom(words);
      if (!workflow || !task) die("queue add <workflow> <task…>");
      guard(() => loadWorkflow(root, workflow));
      const item = guard(() => queue.addTask(root, task, { workflow }));
      console.log(`Queued as ${item.id} (position ${item.position}).`);
      if (!queue.loadQueue(root).held) ensureWorker(root);
      return;
    }
    case "edit": {
      const [id, ...words] = rest;
      const task = taskFrom(words);
      if (!id || !task) die("queue edit <qid> <new task…> | --task-file <f>");
      guard(() => queue.editTask(root, id, task));
      console.log(`Updated ${id}.`);
      return;
    }
    case "rm":
    case "remove":
      if (!rest[0]) die("queue rm <qid>");
      guard(() => queue.removeTask(root, rest[0]));
      console.log(`Removed ${rest[0]}.`);
      return;
    case "move":
      if (!rest[0] || !Number.isInteger(Number(rest[1]))) die("queue move <qid> <position>");
      guard(() => queue.moveTask(root, rest[0], Number(rest[1])));
      console.log(queue.renderQueue(queue.loadQueue(root)));
      return;
    case "hold":
      queue.holdQueue(root, rest.join(" ") || "held by user");
      console.log("Queue held — the current run (if any) finishes, nothing new starts.");
      return;
    case "resume":
      queue.releaseQueue(root);
      console.log(ensureWorker(root) ? "Queue resumed; worker started." : "Queue resumed.");
      return;
    default:
      die(`unknown queue command "${sub}"`);
  }
}

// ── answer / steer / resume / check / quota ────────────────────────────────

/** Run id from the first bare argument if it names a run, else the latest run. */
function splitRunArg(root, args) {
  const first = args.find((a) => !a.startsWith("--"));
  if (first && existsSync(join(root, ".orchestra", "runs", first, "state.json"))) {
    return { run: resolveRun(root, first), rest: args.filter((a) => a !== first) };
  }
  return { run: resolveRun(root), rest: args };
}

function textFrom(args, flag = "--file") {
  const i = args.indexOf(flag);
  if (i !== -1) {
    const file = args[i + 1];
    if (!file || file.startsWith("--")) die(`${flag} needs a file path`);
    if (!existsSync(file) || !statSync(file).isFile()) die(`${flag}: no such file: ${file}`);
    return readFileSync(resolve(file), "utf8").trim();
  }
  return args.filter((a) => a !== "--partial").join(" ").trim();
}

function cmdAnswer(args) {
  const root = findProjectRoot();
  const { run, rest } = splitRunArg(root, args);
  const q = run.data.questions;
  if (run.data.status !== "awaiting_user" || !q) die(`run ${run.id} has no open questions (status: ${run.data.status})`);
  const answers = textFrom(rest);
  if (!answers) die("give the answers: orchestra answer [run-id] \"1. … 2. …\" or --file answers.md");
  const file = run.path(`answers-${q.batch}.md`);
  if (existsSync(file)) die(`batch ${q.batch} is already answered — the run will pick it up`);
  // The run resumes once per batch, so a batch is only sent complete: every question numbered.
  if (q.items.length > 1 && !rest.includes("--partial")) {
    // "1. … 2. …" on separate lines or on one line both count; a number must start a line or follow a space.
    const given = new Set([...answers.matchAll(/(?:^|\s)(?:Q)?(\d+)\s*[.):-](?=\s)/gim)].map((m) => Number(m[1])));
    const missing = q.items.map((it) => it.n).filter((num) => !given.has(num));
    if (missing.length) {
      die(`no answer found for question(s) ${missing.join(", ")}. Number each answer to match (1. …, 2. …). `
        + "If the user really wants to leave some to the agents' judgement, write that explicitly as the answer (e.g. \"3. no preference — decide\"), or pass --partial.");
    }
  }
  writeFileSync(file, `${answers}\n`);
  console.log(`Answers for ${q.items.length} question(s) sent to run ${run.id}; it continues shortly.`);
}

function cmdSteer(args) {
  const root = findProjectRoot();
  const { run, rest } = splitRunArg(root, args);
  if (!["running", "awaiting_user", "awaiting_quota"].includes(run.data.status)) die(`run ${run.id} is ${run.data.status} — queue a new task instead`);
  const text = textFrom(rest);
  if (!text) die("give a direction: orchestra steer [run-id] \"use Postgres, not SQLite\"");
  appendFileSync(run.path("steering.jsonl"), `${JSON.stringify({ text, at: new Date().toISOString() })}\n`);
  console.log(`Direction recorded for run ${run.id}; it applies at the next wave boundary.`);
}

function cmdResume(args) {
  const root = findProjectRoot();
  const run = resolveRun(root, args.find((a) => !a.startsWith("--")));
  const s = run.data;
  if (!["crashed", "stopped", "failed"].includes(s.status)) die(`run ${s.id} is ${s.status}; only crashed, stopped or failed runs can resume`);
  guard(() => queue.withQueue(root, (q) => {
    let item = q.items.find((i) => i.runId === s.id);
    if (!item) {
      item = { id: `q${q.nextId}`, task: s.task, createdAt: new Date().toISOString() };
      q.nextId += 1;
    } else {
      q.items = q.items.filter((i) => i !== item);
    }
    Object.assign(item, { status: "pending", runId: s.id, resumed: true, updatedAt: new Date().toISOString() });
    // Resumed work goes first: later tasks may build on it.
    const firstPending = q.items.findIndex((i) => i.status === "pending");
    q.items.splice(firstPending === -1 ? q.items.length : firstPending, 0, item);
    q.held = null;
  }));
  console.log(`Run ${s.id} will resume its unfinished steps and task branches.`);
  if (ensureWorker(root)) console.log("Worker started.");
}

/** Everything the operator should tell the user about without being asked. */
function healthReport(root) {
  const alerts = [];
  const q = queue.loadQueue(root);
  const workerAlive = pidAlive(readPid(root));
  for (const item of q.items.filter((i) => i.status === "running")) {
    if (!workerAlive) {
      const s = item.runId && existsSync(join(root, ".orchestra", "runs", item.runId, "state.json")) ? resolveRun(root, item.runId).data : null;
      let tail = "";
      try { tail = readFileSync(join(root, ".orchestra", "worker.log"), "utf8").trim().split("\n").slice(-12).join("\n"); } catch { /* none */ }
      alerts.push({
        kind: "crashed", runId: item.runId,
        message: `The worker died while running ${item.id}${s ? ` (run ${s.id}, phase ${s.phase})` : ""}. Resume it with \`orchestra resume ${item.runId}\`.`,
        log: tail || null,
      });
    }
  }
  const latest = latestRunId(root);
  if (latest) {
    const s = resolveRun(root, latest).data;
    if (s.status === "awaiting_user" && s.questions) {
      alerts.push({ kind: "questions", message: `Run ${s.id} is waiting for answers to ${s.questions.items.length} question(s). Show them all to the user at once (\`orchestra status\`).` });
    }
    if(s.status==='awaiting_quota')alerts.push({kind:'waiting',runId:s.id,message:'No eligible agent at the requested tier or higher is available; the run is waiting without model calls. Check quota, configured tiers and setup fixes.'});
    for (const [agent, u] of Object.entries(s.unavailable ?? {})) {
      alerts.push({ kind: "setup", runId: s.id, agent, message: `\`${agent}\` couldn't start in run ${s.id} (${u.what}) and is left out of it. Fix: ${u.fix}.` });
    }
    if (["failed", "crashed"].includes(s.status)) {
      alerts.push({ kind: s.status, message: `Run ${s.id} ended ${s.status}. Read .orchestra/runs/${s.id}/FINAL.md and tell the user.` });
    }
  }
  const pending = q.items.filter((i) => i.status === "pending").length;
  if (q.held) alerts.push({ kind: "held", message: `The queue is held (${q.held.reason}); ${pending} task(s) waiting. \`orchestra queue resume\` when the user says so.` });
  else if (pending && !workerAlive) alerts.push({ kind: "idle", message: `${pending} task(s) are queued but no worker is running. \`orchestra queue resume\` starts it.` });
  let warnAt = 90;
  try { warnAt = loadConfig(root).quotaBalancing?.warnAtPercent ?? 90; } catch { /* default */ }
  for (const w of quotaWarnings(loadQuota(root), warnAt)) alerts.push({ kind: "quota", message: w });
  return { ok: alerts.length === 0, workerAlive, pending, alerts };
}

function cmdCheck(args) {
  const root = findProjectRoot();
  const report = healthReport(root);
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else if (report.ok) console.log(`All good. Worker ${report.workerAlive ? "running" : "idle"}, ${report.pending} task(s) queued.`);
  else {
    for (const a of report.alerts) {
      console.log(`⚠ [${a.kind}] ${a.message}`);
      if (a.log) console.log(`  last log lines:\n${a.log.replace(/^/gm, "    ")}`);
    }
  }
  process.exitCode = report.ok ? 0 : 1;
}

const TERMINAL = new Set(["completed", "stopped", "failed", "crashed"]);

/**
 * Newest file change inside a run, ignoring what the heartbeat rewrites on a timer (state.json,
 * progress.md, updates.md). Agents stream their output into agents/…/events.jsonl, so a working
 * agent keeps moving this; a hung one doesn't.
 */
function lastActivity(runDir) {
  let newest = { at: 0, file: null };
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (!["state.json", "progress.md", "updates.md", "state.json.tmp", "progress.md.tmp"].includes(e.name)) {
        const t = statSync(p).mtimeMs;
        if (t > newest.at) newest = { at: t, file: p };
      }
    }
  };
  try { walk(runDir); } catch { /* run dir vanished */ }
  return newest;
}

function tailOf(file, lines = 8) {
  try { return readFileSync(file, "utf8").trim().split("\n").slice(-lines).join("\n"); } catch { return ""; }
}

/**
 * Wait — using no model tokens — until something needs the operator, then print it and exit.
 * The operator runs this as a background command, so it is only woken (and only spends
 * tokens) when there is news: questions, a finished run, a crash, a held queue, or (opt-in)
 * a periodic progress tick. Exit 0 = event, 3 = nothing is running (don't restart the watch).
 */
// run supplies its reserved ID, whose state file may not exist until the worker claims it.
async function cmdWatch(args, runId = null) {
  const root = findProjectRoot();
  let cfg = {};
  try { cfg = loadConfig(root); } catch { /* config broken: defaults below, check reports it */ }
  const everyIdx = args.indexOf("--every");
  const everyMin = everyIdx === -1 ? (cfg.operatorUpdateMinutes ?? cfg.communicatorUpdateMinutes ?? 15) : Number(args[everyIdx + 1]);
  const everyMs = everyMin > 0 ? everyMin * 60_000 : 0;
  const stuckIdx = args.indexOf("--stuck-after");
  const stuckMs = (stuckIdx === -1 ? cfg.stuckAfterMinutes ?? 10 : Number(args[stuckIdx + 1])) * 60_000;
  const pollMs = Number(process.env.ORCHESTRA_WATCH_POLL_MS) || 2000;
  let lastScan = 0;

  // Each attention event is reported once: restarting the watcher after handling an event never
  // re-wakes the operator for the same unanswered batch or the same crash.
  const markerDir = join(root, ".orchestra", "watch");
  mkdirSync(markerDir, { recursive: true });
  const once = (key) => {
    const f = join(markerDir, key.replace(/[^\w.-]/g, "_"));
    if (existsSync(f)) return false;
    writeFileSync(f, new Date().toISOString());
    return true;
  };
  const snapshot = () => {
    const q = queue.loadQueue(root);
    const latest = runId ?? latestRunId(root);
    const s = latest && existsSync(join(root,'.orchestra','runs',latest,'state.json')) ? resolveRun(root, latest).data : null;
    return { q, s, workerAlive: pidAlive(readPid(root)), pending: q.items.filter((i) => i.status === "pending").length };
  };
  const emit = (kind, text) => {
    console.log(`EVENT ${kind}\n${text}\n\nHandle it, then start \`orchestra watch\` again in the background (unless it printed IDLE).`);
    process.exitCode = 0;
  };
  const idle = () => {
    console.log("IDLE\nNothing is running or queued — no need to keep watching.");
    process.exitCode = 3;
  };
  const unanswered = (s) => s?.status === "awaiting_user" && s.questions && !existsSync(join(root, ".orchestra", "runs", s.id, `answers-${s.questions.batch}.md`));
  const questionsEvent = (s) => emit("questions", `Run ${s.id} is waiting for answers to ${s.questions.items.length} question(s) — show them all at once (\`orchestra status\`). Don't restart the watcher until the user has answered; it will not report this batch again.`);
  const crashEvent = () => {
    const c = healthReport(root).alerts.find((a) => a.kind === "crashed");
    return c && once(`crash-${c.runId ?? "worker"}`) ? c : null;
  };

  /** The check-in: what is actually in progress, never a finished run in its place. */
  const progressText = (run, cur) => [
    run && !TERMINAL.has(run.status) ? oneLine(run, root) : "",
    cur.pending ? `${cur.pending} task(s) queued${cur.q.held ? ` — queue HELD: ${cur.q.held.reason}` : ""}` : "",
  ].filter(Boolean).join("\n") || "Nothing is in progress.";
  const start = snapshot();
  const watched = runId ?? (start.s && !TERMINAL.has(start.s.status) ? start.s.id : null);
  if(start.s?.status==='awaiting_quota' && once(`quota-${start.s.id}`))return emit('waiting','No available agent at the requested tier or higher. Waiting without model calls; check quota and setup fixes.');
  if (unanswered(start.s) && once(`questions-${start.s.id}-${start.s.questions.batch}`)) return questionsEvent(start.s);
  const crashedNow = crashEvent();
  if (crashedNow) return emit("crashed", crashedNow.message);
  if (!watched && !start.workerAlive && !start.pending) return idle();
  const began = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const cur = snapshot();
    const run = runId ? cur.s : watched ? resolveRun(root, watched).data : cur.s;
    if(run?.status==='awaiting_quota' && once(`quota-${run.id}`))return emit('waiting','No available agent at the requested tier or higher. Waiting without model calls; check quota and setup fixes.');
    if (unanswered(run) && once(`questions-${run.id}-${run.questions.batch}`)) return questionsEvent(run);
    if (watched && run && TERMINAL.has(run.status)) {
      if (run.status === "crashed") {
        const c = crashEvent();
        if (c) return emit("crashed", c.message);
      } else {
        return emit("finished", `Run ${run.id} ended **${run.status}**. Read .orchestra/runs/${run.id}/FINAL.md.${cur.pending ? ` ${cur.pending} task(s) still queued${cur.q.held ? ` — queue HELD: ${cur.q.held.reason}` : ""}.` : ""}`);
      }
    }
    if (!watched && cur.s && cur.s.id !== start.s?.id && TERMINAL.has(cur.s.status) && cur.s.status !== "crashed") {
      return emit("finished", `Run ${cur.s.id} ended **${cur.s.status}**. Read .orchestra/runs/${cur.s.id}/FINAL.md.`);
    }
    const dead = crashEvent();
    if (dead) return emit("crashed", dead.message);
    // An agent that can't start is a setup problem only the user can fix: say so now, once.
    const setup = healthReport(root).alerts.find((a) => a.kind === "setup" && once(`setup-${a.runId}-${a.agent}`));
    if (setup) return emit("setup", `${setup.message} The run continues with the other agents.`);
    if (cur.q.held && !start.q.held) return emit("held", `The queue is held: ${cur.q.held.reason}.`);
    if (!cur.workerAlive && !cur.pending && !(run && !TERMINAL.has(run.status))) return idle();
    // Stuck: running, but nothing has moved for stuckAfterMinutes. Reported once per quiet spell.
    if (stuckMs && run?.status === "running" && Date.now() - lastScan >= Math.min(30_000, stuckMs / 4)) {
      lastScan = Date.now();
      const runDir = join(root, ".orchestra", "runs", run.id);
      const act = lastActivity(runDir);
      if (act.at && Date.now() - act.at >= stuckMs && once(`stuck-${run.id}-${Math.round(act.at)}`)) {
        const busy=Object.entries(run.steps ?? {}).filter(([,e])=>e.status==='running').map(([id,e])=>`${id} (${e.agent ?? 'dispatching'})`);
        const agentDir = act.file ? dirname(act.file) : null;
        const tail = agentDir ? tailOf(join(agentDir, "stderr.txt")) || tailOf(join(agentDir, "relay.log")) : "";
        return emit("stuck", [
          `Run ${run.id} has shown no activity for ${Math.round((Date.now() - act.at) / 60_000)} min — cycle ${run.cycle}, ${run.phase}${busy.length ? `, waiting on ${busy.join(", ")}` : ""}.`,
          `Last activity: ${act.file ? act.file.slice(runDir.length + 1) : "unknown"}.`,
          tail ? `Its last log lines:\n${tail.replace(/^/gm, "    ")}` : "",
          `The agent timeout (${cfg.agentTimeout ?? "20m"}) will end a hung agent on its own. Options for the user: wait, \`orchestra steer\`, or \`orchestra stop\` then \`orchestra resume\`.`,
        ].filter(Boolean).join("\n"));
      }
    }
    if (everyMs && Date.now() - began >= everyMs) return emit("progress", progressText(run, cur));
  }
}

async function cmdQuota(args) {
  const root = findProjectRoot();
  let used = [];
  try {
    const cfg = loadConfig(root);
    used = [...new Set(allAgents(cfg).map((a) => quotaKey(a, root)))];
  } catch { /* show what we have */ }
  if (!args.includes("--no-refresh")) await refreshQuota(root, allAgents(loadConfig(root)), { saveErrors: true });
  const q = loadQuota(root);
  if (args.includes("--json")) return console.log(JSON.stringify(q, null, 2));
  console.log(renderQuota(q, used.filter((k) => k !== "mock")));
}

// ── status / list / usage / stop / land / doctor ───────────────────────────

function cmdStatus(args) {
  const root = findProjectRoot();
  const run = resolveRun(root, args.find((a) => !a.startsWith("--")));
  if (args.includes("--json")) return console.log(JSON.stringify(run.data, null, 2));
  console.log(readFileSync(run.path("progress.md"), "utf8"));
  const q = queue.loadQueue(root);
  const waiting = q.items.filter((i) => i.status === "pending").length;
  if (waiting || q.held) console.log(`Queue: ${waiting} waiting${q.held ? ` — HELD: ${q.held.reason}` : ""}`);
}

function cmdList() {
  const root = findProjectRoot();
  const ids = listRuns(root);
  if (!ids.length) return console.log("No runs yet.");
  for (const id of ids) {
    const s = resolveRun(root, id).data;
    console.log(`${id}  ${(s.queueId ?? "").padEnd(4)} ${s.status.padEnd(9)} ${s.phase}  ${s.task.split("\n")[0].slice(0, 60)}`);
  }
}

function cmdKnowledge(args) {
  const i=args.indexOf('--cli'),cli=i<0?undefined:args[i+1];
  if(i>=0 && (!cli || cli.startsWith('-')))die('--cli needs a name');
  if(i>=0)args=args.filter((_,n)=>n!==i && n!==i+1);
  const [sub,...rest]=args;
  if(sub==='add') {
    const text=rest.join(' ').trim();if(!text || !cli)die('knowledge add <text> --cli <name>');
    const [id]=addLessons([{text,trusted:true,source:{role:'user'}}],cli);console.log(`Recorded ${id} [confirmed]. Approve it to merge exact duplicates.`);
  }else if(['rm','approve'].includes(sub)) {
    if(!rest[0])die(`knowledge ${sub} <K-id>`);
    (sub==='rm'?removeLesson:approveLesson)(rest[0],cli);console.log(`${sub}: ${rest[0]}`);
  }else {
    if(sub && sub!=='--json')die('unknown knowledge command');
    const k=loadKnowledge(cli);console.log(args.includes('--json')?JSON.stringify(k,null,2):renderKnowledge(k));
  }
}

function cmdStop(args) {
  const root = findProjectRoot();
  const run = resolveRun(root, args[0]);
  if (run.data.status === "crashed") die(`run ${run.id} isn't running — its worker is gone. \`orchestra resume ${run.id}\` continues it.`);
  if (!["running", "awaiting_user", "awaiting_quota"].includes(run.data.status)) die(`run ${run.id} is ${run.data.status}, not running`);
  try {
    process.kill(run.data.pid, "SIGTERM");
  } catch {
    die(`run ${run.id}'s worker already exited`);
  }
  console.log(`Stopping run ${run.id} (agents get a moment to shut down cleanly). The queue is held; \`orchestra queue resume\` continues it.`);
}

function cmdLand(args) {
  const root = findProjectRoot();
  const {run,rest}=splitRunArg(root,args);
  const target=rest[0];
  if(!target || rest.length!==1 || target.startsWith('-'))die('land [run-id] <target-branch>: name the target explicitly, including the default branch');
  if(run.data.status!=='completed')die('only completed runs can land');
  if(!g.isClean(root))die('commit or stash uncommitted changes first');
  if(!g.git(root,['show-ref','--verify',`refs/heads/${target}`],{allowFail:true}).ok)die(`target branch does not exist: ${target}`);
  const current=g.currentBranch(root);
  if(current!==target)g.git(root,['checkout',target]);
  const result=g.merge(root,run.data.branch,`Land orchestra run ${run.id}`);
  if(!result.ok){g.abortMerge(root);if(current!==target)g.git(root,['checkout',current]);die('merge conflicts; landing aborted');}
  console.log(`Landed ${run.data.branch} into ${target}.`);
}

async function cmdDoctor() {
  const root = findProjectRoot();
  const cfg = loadConfig(root);
  const check = (label, ok) => { console.log(`${ok ? "ok" : "missing"} ${label}`); if (!ok) process.exitCode = 1; };
  check("Node 20+", Number(process.versions.node.split(".")[0]) >= 20);
  check("git commit", g.git(root, ["rev-parse", "--verify", "HEAD"], { allowFail: true }).ok);
  for (const agent of allAgents(cfg)) {
    const a=loadAdapter(root,agent.cli);
    check(`${agent.name}: install ${a.command[0]} and authenticate it`, spawnSync('which',[a.command[0]==='{node}'?process.execPath:a.command[0]],{stdio:'ignore'}).status===0);
  }
}

async function cmdAdapter(args) {
  const commandAt=args.indexOf('--command'), command=commandAt>0?args[commandAt+1]:undefined;
  if(args[0]!=='test' || !args[1] || args[1].startsWith('--') || (commandAt>0 && !command?.trim()) || args.length!==(commandAt>0?4:2))die('adapter test <name> [--command "<shell command>"]');
  const root=findProjectRoot(), cfg=loadConfig(root);
  const agent=allAgents(cfg).find((a)=>a.cli===args[1]) ?? {cli:args[1]};
  const dir=join(root,'.orchestra','adapter-tests',newRunId()), wt=join(dir,'tree');mkdirSync(dir,{recursive:true});
  if(command)return adapterCommandTest(root,cfg,agent,dir,command);
  g.addDetachedWorktree(root,wt,g.headSha(root));
  try {
    const before=g.headSha(wt), result=await runAgent(agent,{root,cwd:wt,outDir:join(dir,'call'),readOnly:true,timeout:60000,
      brief:'ORCHESTRA ROLE: adapter-test\nCYCLE: 1\nReply with the single word OK. Do not edit files or run tools.'});
    const ok=result.status==='completed' && Boolean(result.finalMessage?.trim() || result.output) && g.isClean(wt) && !g.changedFiles(wt,before).length;
    console.log(`${args[1]}: ${ok?'works':'failed'}; exit ${result.exitCode ?? 'unknown'}; logs ${result.outDir}`);
    if(result.startup)console.log(`Fix: ${result.startup.fix}`);
    if(!ok)process.exitCode=1;
  } finally {g.removeWorktree(root,wt);}
}

// Runs one project command the way gates do, then inside the agent's write sandbox, and reports
// whether the sandbox blocks it. Facts only: both exit codes, the agent's output and the logs.
async function adapterCommandTest(root,cfg,agent,dir,command) {
  const revision=g.headSha(root), timeout=parseDuration(cfg.gateTimeout) ?? 1200000, outside=join(dir,'outside'), inside=join(dir,'inside');
  const log=join(dir,'outside.log'), fd=openSync(log,'w');
  g.addDetachedWorktree(root,outside,revision);
  let direct;
  try {direct=spawnSync(command,{shell:true,cwd:outside,env:childEnv(),stdio:['ignore',fd,fd],timeout}).status;}
  finally {closeSync(fd);g.removeWorktree(root,outside);}
  if(direct!==0) {
    console.log(`${agent.cli}: not tested; "${command}" exits ${direct ?? 'unknown'} outside any sandbox too, so fix the command first. Log ${log}`);
    process.exitCode=1;return;
  }
  g.addDetachedWorktree(root,inside,revision);
  try {
    const result=await runAgent(agent,{root,cwd:inside,outDir:join(dir,'call'),readOnly:false,timeout:parseDuration(cfg.agentTimeout) ?? 1200000,
      brief:`ORCHESTRA ROLE: adapter-command\nCYCLE: 1\nRun this shell command once from the current directory, exactly as written, then stop. Do not change, fix or retry anything.\nCOMMAND:\n${command}\nReturn JSON {"exit": its exit code as a number, "output": "the last 40 lines it printed"}.`});
    const output=result.output ?? {}, exit=Number.isInteger(output.exit)?output.exit:null;
    if(result.startup || result.status!=='completed' || exit===null) {
      console.log(`${agent.cli}: failed; the agent ran but reported no exit code; exit ${result.exitCode ?? 'unknown'}; logs ${result.outDir}`);
      if(result.startup)console.log(`Fix: ${result.startup.fix}`);
      process.exitCode=1;return;
    }
    if(exit===0) {console.log(`${agent.cli}: works; "${command}" exits 0 inside the write sandbox and outside it; logs ${result.outDir}`);return;}
    let adapter;try{adapter=join(loadAdapter(root,agent.cli).dir,`${agent.cli}.json`);}catch{adapter=`${agent.cli}.json`;}
    console.log(`${agent.cli}: write sandbox blocks "${command}": exit ${exit} inside, 0 outside; logs ${result.outDir}, ${log}`);
    if(typeof output.output==='string' && output.output.trim())console.log(`Agent output:\n${output.output.trim().split('\n').slice(-40).join('\n')}`);
    console.log(`Fix: copy ${adapter} to .orchestra/adapters/${agent.cli}.json and allow only what the output above shows the command needs in its "write" flags, then run this test again.`);
    process.exitCode=1;
  } finally {g.removeWorktree(root,inside);}
}

// ── dispatch ────────────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);
try { switch (command) {
  case "workflow": {
    const [sub,value,...flags]=rest;
    if(sub==='list' && (!value || value==='--json') && !flags.length){
      const packs=listWorkflows(g.repoRoot(process.cwd()) ?? process.cwd());
      if(value)console.log(JSON.stringify(packs,null,2));
      else if(!packs.length)console.log('No workflows found.');
      else for(const p of packs)console.log(`${p.name}  (${p.source})\n  ${p.error?`invalid: ${p.error}`:p.description ?? 'no description (workflow v1)'}${p.guide?`\n  Guide: ${p.guide}`:''}`);
      break;
    }
    if(!value)die('workflow list [--json] | check <file> | diagram <name|file> [--out <file>|--text] | run <name> --dry | add <path|git-url> [--user]');
    if(sub==='diagram' && (!flags.length || flags.length===2 && flags[0]==='--out' || flags.length===1 && flags[0]==='--text')){
      const file=existsSync(resolve(value))?resolve(value):workflowFile(g.repoRoot(process.cwd()) ?? process.cwd(),value);checkWorkflow(file,false);
      // --text prints the outline for a terminal or chat; otherwise write the draw.io file.
      if(flags[0]==='--text')process.stdout.write(workflowOutline(JSON.parse(readFileSync(file,'utf8'))));
      else console.log(writeWorkflowDiagram(file,flags[1]?resolve(flags[1]):undefined));}
    else if(sub==='check' && !flags.length){checkWorkflow(resolve(value));console.log('Workflow valid.');}
    else if(sub==='run' && flags.join(' ')==='--dry')dryWorkflow(loadWorkflow(g.repoRoot(process.cwd()) ?? process.cwd(),value));
    else if(sub==='add' && flags.every((f)=>f==='--user'))console.log(`Installed: ${addWorkflow(flags.includes('--user')?process.cwd():findProjectRoot(),value,flags.includes('--user')).join(', ')}`);
    else die('invalid workflow command');
    break;
  }
  case "adapter": await cmdAdapter(rest); break;
  case "init": cmdInit(rest); break;
  case "run": await cmdRun(rest); break;
  case "queue": cmdQueue(rest); break;
  case "answer": cmdAnswer(rest); break;
  case "steer": cmdSteer(rest); break;
  case "resume": cmdResume(rest); break;
  case "check": cmdCheck(rest); break;
  case "watch": await cmdWatch(rest); break;
  case "quota": await cmdQuota(rest); break;
  case "status": cmdStatus(rest); break;
  case "list": cmdList(); break;
  case "knowledge": cmdKnowledge(rest); break;
  case "stop": cmdStop(rest); break;
  case "land": cmdLand(rest); break;
  case "doctor": await cmdDoctor(rest); break;
  case "_worker": await processQueue(findProjectRoot()); break;
  default: {
    const header = readFileSync(fileURLToPath(import.meta.url), "utf8").match(/\/\*\*([\s\S]*?)\*\//)[1];
    console.log(header.replace(/^ \* ?/gm, "").trim());
    process.exitCode = command && command !== "help" && command !== "--help" ? 2 : 0;
  }
}

} catch(e) {die(e.message);}

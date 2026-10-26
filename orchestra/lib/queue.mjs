/**
 * The task queue. The operator adds the user's requests here; one background worker per
 * project takes them one at a time. A task can be edited, removed or reordered until the worker
 * picks it up. If a run doesn't end completed, the queue is held (by default) until the user
 * decides — later tasks often build on earlier ones.
 *
 * All writes go through the project lock (lock.mjs) so the operator and the worker never race.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "./lock.mjs";

export function queuePath(root) {
  return join(root, ".orchestra", "queue.json");
}

const EMPTY = () => ({ held: null, nextId: 1, items: [] });

/** A missing queue is empty; a corrupt one is an error — never silently replaced by an empty queue. */
function readQueue(root) {
  if (!existsSync(queuePath(root))) return EMPTY();
  const text = readFileSync(queuePath(root), "utf8");
  try {
    const q = JSON.parse(text);
    if (!q || !Array.isArray(q.items)) throw new Error("no items list");
    return q;
  } catch (err) {
    throw new Error(`.orchestra/queue.json is corrupt (${err.message}). Fix or restore it before using the queue; nothing was changed.`);
  }
}

/** Run `fn(queue)` under the project lock; whatever it mutates is saved. Returns fn's return value. */
export function withQueue(root, fn) {
  return withLock(root, () => {
    const q = readQueue(root);
    const out = fn(q);
    const tmp = `${queuePath(root)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(q, null, 2)}\n`);
    renameSync(tmp, queuePath(root));
    return out;
  });
}

export function loadQueue(root) {
  return readQueue(root);
}

const now = () => new Date().toISOString();
const pending = (q) => q.items.filter((i) => i.status === "pending");

function find(q, id) {
  const item = q.items.find((i) => i.id === id);
  if (!item) throw new Error(`no queued task "${id}"`);
  return item;
}

function requirePending(item) {
  if (item.status !== "pending") {
    throw new Error(`task ${item.id} is already ${item.status}${item.runId ? ` (run ${item.runId})` : ""} — it can't be changed any more`);
  }
}

export function addTask(root, task, options = {}, runId) {
  return withQueue(root, (q) => {
    const item = { id: `q${q.nextId}`, task, options, status: "pending", createdAt: now(), updatedAt: now() };
    if (runId) item.runId = runId;
    q.nextId += 1;
    q.items.push(item);
    return { ...item, position: pending(q).length };
  });
}

export function editTask(root, id, task) {
  return withQueue(root, (q) => {
    const item = find(q, id);
    requirePending(item);
    item.task = task;
    item.updatedAt = now();
    return item;
  });
}

export function removeTask(root, id) {
  return withQueue(root, (q) => {
    requirePending(find(q, id));
    q.items = q.items.filter((i) => i.id !== id);
  });
}

/** Move a pending task to a 1-based position among the pending tasks. */
export function moveTask(root, id, position) {
  return withQueue(root, (q) => {
    const item = find(q, id);
    requirePending(item);
    const rest = pending(q).filter((i) => i !== item);
    const at = Math.max(0, Math.min(rest.length, position - 1));
    rest.splice(at, 0, item);
    q.items = [...q.items.filter((i) => i.status !== "pending"), ...rest];
  });
}

export function holdQueue(root, reason) {
  withQueue(root, (q) => { q.held = { reason, at: now() }; });
}

export function releaseQueue(root) {
  withQueue(root, (q) => { q.held = null; });
}

/**
 * Take the next pending task (marks it running), or null when the queue is empty or held.
 * `onIdle` runs inside the lock when there's nothing to take, so a worker can retire without
 * racing a task being added at the same moment.
 */
export function claimNext(root, runId, onIdle) {
  return withQueue(root, (q) => {
    const next = q.held ? null : pending(q)[0];
    if (!next) {
      onIdle?.();
      return null;
    }
    // Keep a reserved or resumed ID; queue-added tasks get their ID here.
    Object.assign(next, { status: "running", runId: next.runId ?? runId, startedAt: now(), updatedAt: now() });
    return { ...next };
  });
}

export function finishTask(root, id, status, { holdOnFailure }) {
  withQueue(root, (q) => {
    const item = find(q, id);
    Object.assign(item, { status, finishedAt: now(), updatedAt: now() });
    // Held even with nothing pending, so a task queued later doesn't build on the failed one unseen.
    if (status !== "completed" && holdOnFailure) {
      q.held = { reason: `task ${id} ended ${status} (run ${item.runId})`, at: now() };
    }
  });
}

export function renderQueue(q) {
  const lines = [];
  if (q.held) lines.push(`⏸  Queue HELD: ${q.held.reason}. Release with \`orchestra queue resume\`.`, "");
  const running = q.items.filter((i) => i.status === "running");
  const waiting = pending(q);
  const done = q.items.filter((i) => !["running", "pending"].includes(i.status));
  if (!q.items.length) return "Queue is empty.";
  for (const i of running) lines.push(`▶ ${i.id}  RUNNING (run ${i.runId})  ${firstLine(i.task)}`);
  waiting.forEach((i, n) => lines.push(`${n + 1}. ${i.id}  ${i.resumed ? `resume (run ${i.runId})` : "pending"}  ${firstLine(i.task)}`));
  if (done.length) {
    lines.push("", "Finished:");
    for (const i of done.slice(-10)) lines.push(`   ${i.id}  ${i.status.padEnd(9)} (run ${i.runId})  ${firstLine(i.task)}`);
  }
  return lines.join("\n");
}

const firstLine = (t) => t.split("\n")[0].slice(0, 80);

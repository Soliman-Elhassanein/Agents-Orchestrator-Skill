/**
 * One lock per project for every shared file that more than one process can write (the queue,
 * quota.json, worker.pid); machine knowledge uses the user-directory lock. A lock is a directory — mkdir is atomic
 * everywhere — holding an `owner` file with the holder's pid and a random token.
 *
 * A lock is only taken over when its owner process is dead (or the lock is ancient, in case the
 * pid was reused), and a holder only ever removes a lock that still carries its own token, so a
 * slow holder can never delete someone else's lock.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const ANCIENT_LOCK_MS = 10 * 60_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists, just not ours to signal
  }
}

function readOwner(lock) {
  try {
    return JSON.parse(readFileSync(join(lock, "owner"), "utf8"));
  } catch {
    return null;
  }
}

export function withLock(root, fn, dir = join(root, ".orchestra")) {
  if (!existsSync(dir)) throw new Error(`no .orchestra/ in ${root} — run \`orchestra init\` first`);
  const lock = join(dir, "queue.lock");
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), JSON.stringify({ pid: process.pid, token, at: Date.now() }));
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const owner = readOwner(lock);
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { /* vanished */ }
      // Owner file not written yet: give the holder a moment before judging it.
      const dead = owner ? !alive(owner.pid) : age > 2_000;
      if (dead || age > ANCIENT_LOCK_MS) {
        // Move it aside first, so two waiters can't both "remove" and re-create it.
        const aside = `${lock}.stale-${token}`;
        try {
          renameSync(lock, aside);
          rmSync(aside, { recursive: true, force: true });
        } catch { /* someone else got there first */ }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`project is locked by process ${owner?.pid ?? "?"} (.orchestra/queue.lock)`);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    if (readOwner(lock)?.token === token) rmSync(lock, { recursive: true, force: true });
  }
}

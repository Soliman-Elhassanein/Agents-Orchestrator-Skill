import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const windowName = (mins) => {
  if (!mins) return "window";
  if (mins === 300) return "5-hour";
  if (mins === 10080) return "weekly";
  if (mins === 1440) return "daily";
  return mins % 1440 === 0 ? `${mins / 1440}-day` : mins % 60 === 0 ? `${mins / 60}-hour` : `${mins}-min`;
};

// ── Codex ───────────────────────────────────────────────────────────────────

export function parseCodexRateLimits(result) {
  const buckets = result?.rateLimitsByLimitId ?? (result?.rateLimits ? { [result.rateLimits.limitId ?? "codex"]: result.rateLimits } : {});
  const windows = [];
  let plan = null;
  for (const [id, snap] of Object.entries(buckets)) {
    plan ??= snap?.planType ?? null;
    for (const slot of ["primary", "secondary"]) {
      const w = snap?.[slot];
      if (!w || !Number.isFinite(w.usedPercent)) continue;
      const label = snap.limitName || (id === "codex" ? "" : id);
      windows.push({
        name: `${label ? `${label} ` : ""}${windowName(w.windowDurationMins)}`.trim(),
        usedPercent: w.usedPercent,
        windowMins: Number.isFinite(w.windowDurationMins) ? w.windowDurationMins : null,
        resetsAt: Number.isFinite(w.resetsAt) ? new Date(w.resetsAt * 1000).toISOString() : null,
      });
    }
  }
  return {
    provider: "OpenAI (Codex)", plan, windows,
    limitReached: Object.values(buckets).find((b) => b?.rateLimitReachedType)?.rateLimitReachedType ?? null,
  };
}

/** Read Codex limits through its app-server. Resolves to an observation or { error }. */
export function readCodexQuota({ bin = process.env.ORCHESTRA_CODEX_BIN || "codex", timeoutMs = 20_000 } = {}) {
  return new Promise((resolvePromise) => {
    let done = false;
    let child;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* gone */ }
      resolvePromise(value);
    };
    const timer = setTimeout(() => finish({ error: "codex app-server did not answer in time" }), timeoutMs);
    try {
      child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch (err) {
      finish({ error: err.message });
      return;
    }
    child.on("error", (err) => finish({ error: `can't start ${bin}: ${err.message}` }));
    child.on("exit", () => finish({ error: "codex app-server exited before answering" }));
    // A server that dies on startup closes stdin; writing to it must not crash the runner.
    child.stdin.on("error", () => finish({ error: "codex app-server closed its input" }));
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          send({ method: "initialized" });
          // Read-only. Never call account/rateLimitResetCredit/consume or anything else that changes the account.
          send({ id: 2, method: "account/rateLimits/read", params: null });
        } else if (m.id === 2) {
          if (m.error) finish({ error: m.error.message ?? "account/rateLimits/read failed" });
          else finish({ ...parseCodexRateLimits(m.result), observedAt: new Date().toISOString(), source: "codex app-server account/rateLimits/read" });
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "orchestra", version: "2.0.0-dev" } } });
  });
}


function readTranscript(file) {
  const out={commands:[],files:new Set(),errors:[]};if(!existsSync(file))return out;
  for(const line of readFileSync(file,'utf8').split('\n')) {
    let e;try{e=JSON.parse(line);}catch{continue;}
    const item=e.item;
    if(e.type==='item.completed' && item?.type==='command_execution') {
      out.commands.push({cmd:item.command,code:item.exit_code ?? null});
      if(item.exit_code)out.errors.push(String(item.aggregated_output ?? '').slice(0,300));
    }
    if(item?.type==='file_change')for(const c of item.changes ?? [])if(c.path)out.files.add(c.path);
    if(e.error)out.errors.push(String(e.error.message ?? e.error).slice(0,300));
  }
  return out;
}

const request = JSON.parse(readFileSync(0, "utf8"));
const { outDir, operation } = request;
const read = (file) => { try { return readFileSync(join(outDir, file), "utf8"); } catch { return ""; } };
const events = () => read("stdout.txt").split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
let result;
if (operation === "transcript") {
  const t = readTranscript(join(outDir, "stdout.txt"));
  result = { ...t, files: [...t.files] };
} else if (operation === "quota") {
  result = await readCodexQuota();
} else {
  const u = events().filter((e) => e.type === "turn.completed").at(-1)?.usage;
  result = { status: request.exitCode === 0 && !events().some((e) => e.type === "turn.failed") ? "completed" : "failed", finalMessage:read("final.txt"),
    tokens: u ? { input: Math.max(0,(u.input_tokens ?? 0)-(u.cached_input_tokens ?? 0)), output:u.output_tokens ?? 0, cacheRead:u.cached_input_tokens ?? 0, cacheWrite:0 } : null };
}
process.stdout.write(JSON.stringify(result));

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

export const AGY_POOLS = { "gemini models": "agy", "claude and gpt models": "agy-claude-gpt" };

/** Parse `agy -p /usage`: one tab-separated line per pool and window, with the share left. */
export function parseAgyUsage(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const [pool, label, left, resets] = line.split("\t").map((x) => x?.trim());
    const pct = /^(\d+(?:\.\d+)?)%$/.exec(left ?? "");
    const key = AGY_POOLS[pool?.toLowerCase()];
    if (!key || !label || !pct) continue;
    const mins = /five hour/i.test(label) ? 300 : /weekly/i.test(label) ? 10080 : /daily/i.test(label) ? 1440 : null;
    (out[key] ??= { provider: `Google (Antigravity) — ${pool}`, plan: null, windows: [], limitReached: null }).windows.push({
      name: mins ? windowName(mins) : label.replace(/ limit remaining/i, "").toLowerCase(),
      usedPercent: 100 - Number(pct[1]), windowMins: mins,
      resetsAt: Number.isFinite(Date.parse(resets)) ? new Date(resets).toISOString() : null,
    });
  }
  for (const o of Object.values(out)) if (o.windows.some((w) => w.usedPercent >= 100)) o.limitReached = "usage limit";
  return out;
}

/** Read Antigravity's pools. Resolves to { observations: { agy: …, "agy-claude-gpt": … } } or { error }. */
export function readAgyQuota({ bin = process.env.ORCHESTRA_AGY_BIN || "agy", timeoutMs = 60_000 } = {}) {
  return new Promise((resolvePromise) => {
    let out = "";
    let child;
    const timer = setTimeout(() => { try { child?.kill(); } catch { /* gone */ } }, timeoutMs);
    const finish = (value) => { clearTimeout(timer); resolvePromise(value); };
    try {
      // Read-only: `/usage` only shows the account's limits.
      child = spawn(bin, ["-p", "/usage", "--print-timeout", `${Math.floor(timeoutMs / 1000) - 5}s`], { cwd: tmpdir(), stdio: ["ignore", "pipe", "ignore"] });
    } catch (err) {
      finish({ error: err.message });
      return;
    }
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", (err) => finish({ error: `can't start ${bin}: ${err.message}` }));
    child.on("close", () => {
      const pools = parseAgyUsage(out);
      if (!Object.keys(pools).length) return finish({ error: "agy /usage printed no limits" });
      const observedAt = new Date().toISOString();
      finish({ observations: Object.fromEntries(Object.entries(pools).map(([k, o]) => [k, { ...o, observedAt, source: "agy /usage" }])) });
    });
  });
}


function readTranscript(file) {
  const out={commands:[],files:new Set(),errors:[]};if(!existsSync(file))return out;
  const visit=(o,n=0)=>{
    if(!o || typeof o!=='object' || n>6)return;
    if(typeof o.command==='string')out.commands.push({cmd:o.command,code:o.exit_code ?? o.exitCode ?? null});
    if(typeof o.file_path==='string')out.files.add(o.file_path);
    if(o.error)out.errors.push(JSON.stringify(o.error).slice(0,300));
    for(const v of Object.values(o))if(typeof v==='object')visit(v,n+1);
  };
  for(const line of readFileSync(file,'utf8').split('\n')){try{visit(JSON.parse(line));}catch{}}
  return out;
}

const request = JSON.parse(readFileSync(0, "utf8"));
const { outDir, operation } = request;
const read = (file) => { try { return readFileSync(join(outDir, file), "utf8"); } catch { return ""; } };
const events = () => read("stdout.txt").split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
let result;
if (operation === "transcript") {
  const t = readTranscript(join(outDir, "events.jsonl"));
  result = { ...t, files: [...t.files] };
} else if (operation === "quota") {
  const pools = await readAgyQuota();
  result = pools.error ? pools : pools.observations[request.agent.quotaFrom ?? (/gemini/i.test(request.agent.model ?? "gemini") ? "agy" : "agy-claude-gpt")];
} else {
  result = { status:request.exitCode === 0 ? "completed" : "failed", finalMessage:read("stdout.txt"), tokens:null };
}
process.stdout.write(JSON.stringify(result));

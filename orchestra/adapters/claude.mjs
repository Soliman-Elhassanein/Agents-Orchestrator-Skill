import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const CLAUDE_WINDOW_MINS = { five_hour: 300, seven_day: 10080, seven_day_opus: 10080, seven_day_sonnet: 10080, seven_day_overage_included: 10080 };
const CLAUDE_WINDOWS = {
  five_hour: "5-hour", seven_day: "weekly", seven_day_opus: "weekly (Opus)",
  seven_day_sonnet: "weekly (Sonnet)", seven_day_overage_included: "weekly (incl. overage)", overage: "overage",
};

/** The latest `rate_limit_event` in a Claude Code stream, as an observation (or null). */
export function claudeQuotaFromEvents(outDir) {
  const file = join(outDir, "stdout.txt");
  if (!existsSync(file)) return null;
  let info = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes("rate_limit_event")) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "rate_limit_event" && e.rate_limit_info) info = e.rate_limit_info;
    } catch { /* partial line */ }
  }
  if (!info) return null;
  const windows = [];
  const pct = (u) => Math.round(Number(u) * 1000) / 10;
  const iso = (s) => (Number.isFinite(Number(s)) ? new Date(Number(s) * 1000).toISOString() : null);
  for (const [key, w] of Object.entries(info.unifiedWindows ?? {})) {
    if (w && Number.isFinite(Number(w.utilization))) windows.push({ name: CLAUDE_WINDOWS[key] ?? key, usedPercent: pct(w.utilization), windowMins: CLAUDE_WINDOW_MINS[key] ?? null, resetsAt: iso(w.resetsAt) });
  }
  if (!windows.length && info.rateLimitType && Number.isFinite(Number(info.utilization))) {
    windows.push({ name: CLAUDE_WINDOWS[info.rateLimitType] ?? info.rateLimitType, usedPercent: pct(info.utilization), windowMins: CLAUDE_WINDOW_MINS[info.rateLimitType] ?? null, resetsAt: iso(info.resetsAt) });
  }
  return {
    provider: "Anthropic (Claude Code)", plan: null, windows,
    limitReached: info.status === "rejected" ? (info.rateLimitType ?? "rejected") : null,
    status: info.status ?? null,
  };
}


function readTranscript(file) {
  const out={commands:[],files:new Set(),errors:[]}, pending=new Map();
  if(!existsSync(file))return out;
  for(const line of readFileSync(file,'utf8').split('\n')) {
    let e;try{e=JSON.parse(line);}catch{continue;}
    for(const c of e.message?.content ?? []) {
      if(c.type==='tool_use') {
        if(c.input?.file_path)out.files.add(c.input.file_path);
        if(c.input?.command){const item={cmd:c.input.command,code:null};out.commands.push(item);pending.set(c.id,item);}
      }
      if(c.type==='tool_result' && c.is_error) {
        if(pending.has(c.tool_use_id))pending.get(c.tool_use_id).code='error';
        out.errors.push(JSON.stringify(c.content).slice(0,300));
      }
    }
    if(e.type==='result' && e.is_error)out.errors.push(String(e.result).slice(0,300));
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
  result = { error: "Quota is observed passively after a call." };
} else {
  const event = events().filter((e) => e.type === "result").at(-1);
  const u = event?.usage;
  result = { status: event && !event.is_error && request.exitCode === 0 ? "completed" : "failed", finalMessage: event?.result ?? "", error: event?.is_error ? event.result : undefined,
    tokens: u ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 } : null };
  const quota=claudeQuotaFromEvents(outDir);
  if(quota)result.quota={...quota,observedAt:new Date().toISOString(),source:'call stream'};
}
process.stdout.write(JSON.stringify(result));

/** Configuration for the reduced execution engine. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_VERSION = "orchestra.v2-adapters/1";
export const configPath = (root) => join(root, ".orchestra", "config.json");
export function loadConfig(root) {
  let cfg;
  try { cfg = JSON.parse(readFileSync(configPath(root), "utf8")); }
  catch (err) { throw new Error(`cannot read .orchestra/config.json: ${err.message}; run orchestra init first`); }
  const errors = validateConfig(cfg);
  if (errors.length) throw new Error(`invalid .orchestra/config.json:\n  - ${errors.join("\n  - ")}`);
  return cfg;
}
const posInt = (v) => Number.isSafeInteger(v) && v > 0;
export function validateConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== "object") return ["config must be an object"];
  const allowed = new Set(["version", "agents", "escalate", "fanout", "executorRetries", "knowledgeObservedLimit",
    "heartbeatMinutes", "communicatorUpdateMinutes", "stuckAfterMinutes", "agentTimeout", "gateTimeout", "gates", "queue", "quotaBalancing"]);
  for (const key of Object.keys(cfg)) if (!allowed.has(key)) errors.push(`unknown config option: ${key}`);
  if (cfg.version !== CONFIG_VERSION) errors.push(`version must be "${CONFIG_VERSION}"; refresh the config with orchestra init --force`);
  if (!cfg.agents || typeof cfg.agents !== 'object' || Array.isArray(cfg.agents)) errors.push('agents must be a map');
  else for (const [name,a] of Object.entries(cfg.agents)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || !a || typeof a.cli !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(a.cli)) errors.push('agent needs a valid name and cli');
    if (!posInt(a?.tier)) errors.push('agent tier must be positive');
    if (a?.weight !== undefined && !(Number.isFinite(a.weight) && a.weight > 0)) errors.push('agent weight must be positive');
    for (const k of ['model','effort','quotaFrom']) if(a?.[k] !== undefined && (typeof a[k] !== 'string' || !a[k]))errors.push(`agent ${k} must be a string`);
    if(Object.keys(a ?? {}).some((k)=>!['cli','model','effort','tier','weight','quotaFrom'].includes(k)))errors.push('unknown agent option');
  }
  if(cfg.escalate !== undefined && (!posInt(cfg.escalate?.afterFailures) || Object.keys(cfg.escalate).some((k)=>k!=='afterFailures')))errors.push('escalate.afterFailures must be positive');
  if (!posInt(cfg.fanout?.executors)) errors.push("fanout.executors must be an integer ≥ 1");
  if (Object.keys(cfg.fanout ?? {}).some((key) => key !== "executors")) errors.push("unknown fanout option");
  for (const key of ["executorRetries", "knowledgeObservedLimit"]) if (cfg[key] !== undefined && !(Number.isSafeInteger(cfg[key]) && cfg[key] >= 0)) errors.push(`${key} must be an integer ≥ 0`);
  for (const key of ["heartbeatMinutes", "communicatorUpdateMinutes", "stuckAfterMinutes"]) if (cfg[key] !== undefined && !(Number.isFinite(cfg[key]) && cfg[key] >= (key === "heartbeatMinutes" ? 0.001 : 0))) errors.push(`${key} must be a valid number of minutes`);
  for (const key of ["agentTimeout", "gateTimeout"]) if (cfg[key] !== undefined && !(parseDuration(cfg[key]) > 0)) errors.push(`${key} must be a positive duration`);
  if (cfg.gates !== undefined && !(Array.isArray(cfg.gates) && cfg.gates.every((v) => typeof v === "string" && v.trim()))) errors.push("gates must be shell commands");
  if (cfg.queue !== undefined && (!cfg.queue || Object.entries(cfg.queue).some(([k,v]) => !["holdOnFailure", "buildOnPrevious"].includes(k) || typeof v !== "boolean"))) errors.push("invalid queue options");
  const qb = cfg.quotaBalancing;
  if (qb !== undefined) {
    if (!qb || typeof qb !== "object" || Array.isArray(qb)) errors.push("quotaBalancing must be an object");
    else for (const [key, v] of Object.entries(qb)) {
      if (key === "enabled" ? typeof v !== "boolean" : key === "strength" ? !(Number.isFinite(v) && v >= 0)
        : ["warnAtPercent", "stopAtPercent"].includes(key) ? !(Number.isFinite(v) && v > 0 && v <= 100) : true) errors.push(`invalid quotaBalancing.${key}`);
    }
  }
  return errors;
}
export function parseDuration(text) {
  const m = /^(\d+)([hms])$/.exec(String(text ?? ""));
  if (!m) return null;
  return Number(m[1]) * { h: 3_600_000, m: 60_000, s: 1000 }[m[2]];
}

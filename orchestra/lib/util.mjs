/**
 * Small helpers shared by every module, so each rule has exactly one definition.
 */
import { basename, resolve } from "node:path";

// LangChain sends traces to a hosted service when one of these is "true". Orchestra clears them
// in its own process, so no run data leaves the machine, and hands the user's values back to
// every process it starts.
const TRACING = ["LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING_V2", "LANGSMITH_TRACING", "LANGCHAIN_TRACING"];
const userTracing = Object.fromEntries(TRACING.filter((k) => k in process.env).map((k) => [k, process.env[k]]));
for (const k of TRACING) delete process.env[k];

/** The environment for agents, gates and workers: Orchestra's own, with the user's tracing settings. */
export function childEnv() {
  return { ...process.env, ...userTracing };
}


/** Identify a notification by its project's root folder, without exposing the full path. */
export function projectMessage(root, message) {
  return `[${basename(resolve(root)) || "project"}] ${message}`;
}

/**
 * Every JSON object in a model reply, last first: fenced ```json blocks, plus a bare object if the
 * reply has no usable fence. One parser for plans, questions and reports alike.
 */
// Every top-level JSON object in a reply, in order, fenced or not. Scanning braces with string
// awareness keeps objects whole even when their strings contain Markdown code fences.
export function jsonObjects(text) {
  if (!text) return [];
  const parse = (s) => { try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? [v] : []; } catch { return []; } };
  const out = [];
  for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
    let depth = 0, quoted = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (quoted) { if (c === "\\") j++; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true; else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { const v = parse(text.slice(i, j + 1)); if (v.length) { out.push(...v); i = j; } break; }
    }
  }
  return out;
}
// One reply object: later objects win, and lessons and suggestions lists are combined.
export function mergeJson(objects) {
  const out = {};
  for (const o of objects) for (const [k, v] of Object.entries(o))
    out[k] = ["lessons", "suggestions"].includes(k) && Array.isArray(out[k]) && Array.isArray(v) ? [...out[k], ...v] : v;
  return objects.length ? out : null;
}

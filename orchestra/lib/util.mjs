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
export function jsonObjects(text) {
  if (!text) return [];
  const out = [];
  for (const m of [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].reverse()) {
    try {
      const v = JSON.parse(m[1]);
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v);
    } catch { /* not JSON */ }
  }
  if (!out.length) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        const v = JSON.parse(text.slice(start, end + 1));
        if (v && typeof v === "object" && !Array.isArray(v)) out.push(v);
      } catch { /* not JSON */ }
    }
  }
  return out;
}

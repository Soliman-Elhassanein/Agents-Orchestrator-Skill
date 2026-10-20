/**
 * Small helpers shared by every module, so each rule has exactly one definition.
 */
import { basename, resolve } from "node:path";


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

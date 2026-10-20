const DEFAULTS = { enabled: true, strength: 2, stopAtPercent: 95 };

export const quotaKeyOf = (agent) => agent.quotaFrom ?? agent.cli;

export function balanceOptions(cfg) {
  return { ...DEFAULTS, ...(cfg.quotaBalancing ?? {}) };
}

function windowFactor(w, opts, now) {
  const used = Number(w.usedPercent) / 100;
  if (!Number.isFinite(used)) return null;
  const resets = w.resetsAt ? new Date(w.resetsAt).getTime() : null;
  if (resets && resets <= now) return null; // that window has reset since we looked; the old number is meaningless
  if (used * 100 >= opts.stopAtPercent) return 0;
  const elapsed = resets && w.windowMins ? 1 - (resets - now) / (w.windowMins * 60_000) : null;
  const pace = Number.isFinite(elapsed) ? Math.min(1, Math.max(0, elapsed)) - used : 0.5 - used;
  return Math.min(3, Math.max(0.2, 1 + opts.strength * pace));
}

/** Factors for observed quota sources. */
export function balanceFactors(quota, opts, now = Date.now()) {
  const out = {};
  for (const [key, obs] of Object.entries(quota?.providers ?? {})) {
    if (!obs || obs.error) continue;
    if (obs.limitReached) {
      // A hit limit lasts until its window resets — after that it's history, not a reason to skip
      // the provider forever (skipping it would also stop us ever observing fresh numbers).
      const resets = (obs.windows ?? []).map((w) => (w.resetsAt ? new Date(w.resetsAt).getTime() : null)).filter(Boolean);
      const stillLimited = resets.length ? resets.some((t) => t > now) : now - new Date(obs.observedAt ?? 0).getTime() < 5 * 3_600_000;
      if (stillLimited) {
        out[key] = { factor: 0, why: `limit reached (${obs.limitReached})` };
        continue;
      }
    }
    let tightest = null;
    for (const w of obs.windows ?? []) {
      const f = windowFactor(w, opts, now);
      if (f !== null && (tightest === null || f < tightest.factor)) tightest = { factor: Math.round(f * 100) / 100, why: `${w.name} ${Math.round(w.usedPercent)}% used` };
    }
    if (tightest) out[key] = tightest;
  }
  return out;
}

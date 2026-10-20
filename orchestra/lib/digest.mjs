const clip = (s,n) => String(s ?? '').slice(0,n);
export function attemptSummary(_dir,result={}) {
  const t=result.transcript ?? {};
  return [`Outcome: ${result.status}; ${clip(result.error,300)}`,
    `Files: ${(t.files ?? []).slice(0,20).join(', ')}`,
    ...(t.commands ?? []).slice(-15).map((c)=>`${clip(c.cmd,160)} → ${c.code}`),
    ...(t.errors ?? []).slice(-5).map((s)=>clip(s,300))].join('\n');
}

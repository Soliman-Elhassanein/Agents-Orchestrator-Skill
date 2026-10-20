/** Fresh-call handoff; provider prompt caches are left alone. */
export function prepareBrief(brief,{context}={}) {
  const text=String(brief), header=/^(?:[A-Z][A-Z ]*: .*\n)+/.exec(text)?.[0] ?? '';
  const handoff=context?.handoff ? `\n## Current handoff\n${String(context.handoff).slice(0,8000)}\n\n` : '';
  return {brief:header+handoff+text.slice(header.length)};
}

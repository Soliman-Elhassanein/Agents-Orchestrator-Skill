import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from './lock.mjs';
import { adapterHelper, loadAdapter, quotaKey } from './agents.mjs';
export const quotaPath = (root) => join(root,'.orchestra/quota.json');
export function loadQuota(root) { try {return JSON.parse(readFileSync(quotaPath(root),'utf8'));} catch(e) {if(e.code==='ENOENT')return {providers:{}};throw e;} }
export function saveObservation(root,key,observation) {
  withLock(root,()=>{ const q=loadQuota(root); if(q.providers[key]?.observedAt > observation.observedAt)return;
    q.providers[key]=observation; writeFileSync(quotaPath(root)+'.tmp',JSON.stringify(q,null,2)+'\n'); renameSync(quotaPath(root)+'.tmp',quotaPath(root)); });
}
export async function refreshQuota(root,agents,{saveErrors=false}={}) {
  const seen=new Set();
  for(const agent of agents) {
    const key=quotaKey(agent,root); if(seen.has(key))continue; seen.add(key);
    try { const a=loadAdapter(root,agent.cli);if(!a.quota)continue;const o=adapterHelper(a,a.quota,{operation:'quota',agent:{...agent,quotaFrom:key}}); if(o && (!o.error || saveErrors))saveObservation(root,key,o); }
    catch(e) {if(saveErrors)saveObservation(root,key,{error:e.message,observedAt:new Date().toISOString()});}
  }
}
export function renderQuota(q,keys=[]) { return [...new Set([...keys,...Object.keys(q.providers)])].map((k)=>`${k}: ${q.providers[k] ? JSON.stringify(q.providers[k]) : 'unknown (no observation)'}`).join('\n')+'\n'; }
export function quotaWarnings(q,threshold=90) {return Object.entries(q.providers).flatMap(([k,o])=>(o.windows ?? []).filter((w)=>w.usedPercent>=threshold).map((w)=>`${k} ${w.name}: ${w.usedPercent}% used`));}

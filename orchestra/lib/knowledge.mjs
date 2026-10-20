import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { withLock } from './lock.mjs';
const path=()=>join(homedir(),'.config/orchestra/knowledge.json');
const norm=(s)=>s.trim().replace(/\s+/g,' ').toLowerCase();
function read(cli) {
  if(cli !== undefined && (typeof cli!=='string' || !/^[\w-]+$/.test(cli)))throw new Error('invalid CLI knowledge key');
  if(!existsSync(path()))return {version:1,nextId:1,clis:Object.create(null)};
  try {
    const k=JSON.parse(readFileSync(path(),'utf8'));
    if(!Number.isSafeInteger(k.nextId) || !k.clis || typeof k.clis!=='object' || Array.isArray(k.clis) || Object.values(k.clis).some((v)=>!Array.isArray(v)))throw new Error('invalid knowledge record');
    k.clis=Object.assign(Object.create(null),k.clis);return k;
  }catch(e){throw new Error(`knowledge.json is corrupt (${e.message}); nothing was changed`);}
}
export function loadKnowledge(cli) {
  const k=read(cli);return {version:1,nextId:k.nextId,items:Object.entries(k.clis).filter(([name])=>cli===undefined || name===cli).flatMap(([name,items])=>items.map((i)=>({...i,cli:name})))};
}
function edit(cli,fn) {
  const file=path(),dir=dirname(file);mkdirSync(dir,{recursive:true});
  return withLock(dir,()=>{
    const k=read(cli),result=fn(k);
    writeFileSync(file+'.tmp',JSON.stringify(k,null,2)+'\n');renameSync(file+'.tmp',file);return result;
  },dir);
}
export function addLessons(lessons,cli) {
  if(!cli)throw new Error('knowledge add requires --cli <name>');
  return edit(cli,(k)=>{const items=k.clis[cli] ??=[];return lessons.filter((l)=>typeof l?.text==='string' && l.text.trim()).map((l)=>{
    if(!l.trusted){const same=items.find((i)=>norm(i.text)===norm(l.text));if(same)return same.id;}
    const item={id:`K${k.nextId++}`,text:l.text.trim(),trusted:Boolean(l.trusted),source:l.source ?? null};items.push(item);return item.id;
  });});
}
function update(id,cli,fn) {
  return edit(cli,(k)=>{const items=Object.entries(k.clis).filter(([name])=>cli===undefined || name===cli).find(([,items])=>items.some((i)=>i.id===id))?.[1];
    const item=items?.find((i)=>i.id===id);if(!item)throw new Error(`no lesson "${id}"`);fn(items,item);});
}
export const removeLesson=(id,cli)=>update(id,cli,(items,item)=>items.splice(items.indexOf(item),1));
export const approveLesson=(id,cli)=>update(id,cli,(items,item)=>{
  const duplicates=items.filter((i)=>i!==item && norm(i.text)===norm(item.text));
  item.trusted=true;item.merged=[...(item.merged ?? []),...duplicates.flatMap((i)=>[i.id,...(i.merged ?? [])])];
  item.sources=[...(item.sources ?? [item.source]),...duplicates.flatMap((i)=>i.sources ?? [i.source])].filter(Boolean);
  for(const d of duplicates)items.splice(items.indexOf(d),1);
});
export const renderKnowledge=(k)=>k.items.map((i)=>`- ${i.id} (${i.cli}) [${i.trusted?'confirmed':'observed'}] ${i.text}`).join('\n') || 'Nothing recorded yet.';
export function knowledgeForBrief(cli,limit=10) {
  const {items}=loadKnowledge(cli),observed=items.filter((i)=>!i.trusted).sort((a,b)=>Number(a.id.slice(1))-Number(b.id.slice(1)));
  return renderKnowledge({items:[...items.filter((i)=>i.trusted),...(limit?observed.slice(-limit):[])]});
}

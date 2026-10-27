import { addLessons } from './knowledge.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, openSync, closeSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareBrief } from './context.mjs';
import { childEnv, jsonObjects, mergeJson } from './util.mjs';
export const engineDir = dirname(dirname(fileURLToPath(import.meta.url)));
const validName = (s) => /^[a-zA-Z0-9_-]+$/.test(s);
export const adapterDirs = (root) => [join(root, '.orchestra/adapters'), join(homedir(), '.config/orchestra/adapters'), join(engineDir, 'adapters')];
export function loadAdapter(root, name) {
  if (!validName(name)) throw new Error('invalid adapter name');
  const file = adapterDirs(root).map((d) => join(d, `${name}.json`)).find(existsSync);
  if (!file) throw new Error(`adapter ${name} not found; add ${name}.json to .orchestra/adapters/`);
  const a = JSON.parse(readFileSync(file, 'utf8'));
  if (a.adapter !== 1 || !Array.isArray(a.command) || !a.command.length || a.command.some((v) => typeof v !== 'string')) throw new Error(`invalid adapter v1: ${file}`);
  if (!['stdin', 'arg', 'none'].includes(a.prompt?.mode)) throw new Error(`invalid prompt mode: ${file}`);
  const argv=(v)=>Array.isArray(v) && v.every((s)=>typeof s==='string');
  for(const v of [a.prompt.args,...Object.values(a.flags ?? {}),a.reader,a.quota,a.transcript].filter((v)=>v!==undefined))if(!argv(v))throw new Error(`adapter arguments must be string arrays: ${file}`);
  if(!a.executable && !a.reader && !['text','json','jsonl'].includes(a.result?.format))throw new Error(`adapter result format required: ${file}`);
  for(const rule of a.startup ?? []) {new RegExp(rule.pattern);if(!rule.fix)throw new Error(`startup classification needs a fix: ${file}`);}
  // A copied adapter must bring the helper files it names next to it.
  const helpers=[a.command,a.prompt.args,...Object.values(a.flags ?? {}),a.reader,a.quota,a.transcript].flat().filter((s)=>typeof s==='string' && s.startsWith('{adapterDir}/'));
  for(const helper of new Set(helpers))if(!existsSync(join(dirname(file),helper.slice('{adapterDir}/'.length))))throw new Error(`adapter ${name} needs ${helper.slice('{adapterDir}/'.length)} next to ${file}; copy it from the adapter you started from`);

  return { ...a, dir:dirname(file), name };
}
export function detectedAgents(root) {
  const agents = {}, seen = new Set();
  for (const dir of adapterDirs(root)) for (const file of existsSync(dir) ? readdirSync(dir) : []) {
    if (!file.endsWith('.json')) continue;
    const name = file.slice(0,-5);
    if (seen.has(name)) continue; seen.add(name);
    const a = loadAdapter(root,name);
    if (spawnSync('which', [a.command[0]==='{node}'?process.execPath:a.command[0]], {stdio:'ignore'}).status === 0) {
      for (const [id,entry] of Object.entries(a.suggestions ?? {[name]:{tier:2,weight:1}})) agents[id] = {cli:name,...entry};
    }
  }
  return agents;
}
const expand = (args, vars) => args.map((s) => s.replace(/\{(\w+)\}/g, (m,k) => vars[k] ?? m));
const get = (o,p) => p ? p.split('.').reduce((v,k) => v?.[k],o) : undefined;
const read = (p) => { try { return readFileSync(p,'utf8'); } catch { return ''; } };
const live = new Set();
export function stopAllAgents() {
  for(const p of live) {
    try {process.kill(-p.pid,'SIGTERM');}catch{p.kill();}
    const timer=setTimeout(()=>{if(live.has(p)){try{process.kill(-p.pid,'SIGKILL');}catch{}}},1000);timer.unref();
  }
}
export const describeAgent = (a) => [a.name ?? a.cli, a.model, a.effort].filter(Boolean).join(' / ');
export const extractJson = (s) => mergeJson(jsonObjects(s));
export const setupProblem = (_a,r) => r.startup ?? null;
export function seededRandom(seed) {
  let n = 2166136261;
  for (const c of seed) n = Math.imul(n ^ c.charCodeAt(0),16777619);
  return () => { n = Math.imul(1664525,n)+1013904223 | 0; return (n>>>0)/4294967296; };
}
export function pickWeighted(agents,count,seed) {
  const random = seededRandom(seed), total = agents.reduce((s,a) => s+(a.weight ?? 1),0);
  return Array.from({length:count}, () => { let r=random()*total; return agents.findIndex((a) => (r-=a.weight ?? 1)<0); });
}
export function adapterHelper(a, command, request) {
  if (!command) return null;
  const argv = expand(command,{node:process.execPath,adapterDir:a.dir});
  const dir=mkdtempSync(join(tmpdir(),'orchestra-reader-'));
  writeFileSync(join(dir,'input'),JSON.stringify(request));
  const input=openSync(join(dir,'input'),'r'), output=openSync(join(dir,'output'),'w'), error=openSync(join(dir,'error'),'w');
  try {
    const p=spawnSync(argv[0],argv.slice(1),{env:childEnv(),stdio:[input,output,error],timeout:65000});
    if(p.error || p.status!==0)throw new Error(`adapter helper failed: ${p.error?.message ?? readFileSync(join(dir,'error'),'utf8')}`);
    return JSON.parse(readFileSync(join(dir,'output'),'utf8'));
  } finally {closeSync(input);closeSync(output);closeSync(error);rmSync(dir,{recursive:true,force:true});}
}
export function quotaKey(agent, root) {
  if (agent.quotaFrom) return agent.quotaFrom;
  let k;try{k=loadAdapter(root,agent.cli).quotaKey;}catch{return agent.cli;}
  return (Array.isArray(k) ? k.find((r) => new RegExp(r.pattern,'i').test(agent.model ?? ''))?.key : k) ?? agent.cli;
}
export async function runAgent(agent,options) {
  const result=await executeAgent(agent,options),source={call:result.outDir};
  if(result.startup)addLessons([{text:`${result.startup.what}. Fix: ${result.startup.fix}`,source}],agent.cli);
  const output=result.output ?? extractJson(result.finalMessage);
  if(output && typeof output==='object') {
    const lessons=Array.isArray(output.lessons)?output.lessons.filter((l)=>typeof l?.text==='string' && l.text.trim()):[];
    const machine=lessons.filter((l)=>l.scope==='cli').map((l)=>({text:l.text,source}));
    if(machine.length)addLessons(machine,agent.cli);
    result.output={...output,suggestions:[...(Array.isArray(output.suggestions)?output.suggestions:[]),...lessons.filter((l)=>['project','code'].includes(l.scope))]};
  }
  return result;
}
async function executeAgent(agent,{brief,cwd,outDir:requested,readOnly=false,timeout,root=cwd,context}) {
  let outDir=requested;
  for (let n=2;existsSync(outDir);n++) outDir=`${requested}-${n}`;
  mkdirSync(outDir,{recursive:true});
  const briefFile=join(outDir,'brief.md'), prompt=prepareBrief(brief,{context}).brief;
  writeFileSync(briefFile,prompt);
  let a;
  try { a=loadAdapter(root,agent.cli); } catch(e) { return {status:'failed',outDir,startup:{what:e.message,fix:'Create or repair the named adapter JSON file.'},usage:{tokens:null}}; }
  const vars={node:process.execPath,adapterDir:a.dir,briefFile,cwd,outDir,prompt,model:agent.model,effort:agent.effort};
  let argv=expand(a.command,vars);
  for (const k of ['model','effort',readOnly?'read':'write']) if (!['model','effort'].includes(k) || agent[k]) argv.push(...expand(a.flags?.[k] ?? [],vars));
  if (a.prompt.mode==='arg') argv.push(...expand(a.prompt.args ?? ['{prompt}'],vars));
  const stdout=openSync(join(outDir,'stdout.txt'),'w'), stderr=openSync(join(outDir,'stderr.txt'),'w');
  const input=a.prompt.mode==='stdin' ? openSync(briefFile,'r') : 'ignore';
  const execution=await new Promise((resolve) => {
    let child, timer, killer, timedOut=false, settled=false;
    const finish=(exitCode,error) => { if(settled)return; settled=true; clearTimeout(timer); clearTimeout(killer); live.delete(child); resolve({exitCode,error:timedOut ? 'agent timeout' : error}); };
    try {
      child=spawn(argv[0],argv.slice(1),{cwd,env:childEnv(),stdio:[input,stdout,stderr],detached:true}); live.add(child);
      child.on('error',(e)=>finish(null,e.message)); child.on('exit',(code)=>finish(code));
      timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGTERM');}catch{}
        killer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1000);
      },timeout ?? 1800000);
    } catch(e) {finish(null,e.message);}
  });
  closeSync(stdout); closeSync(stderr); if(typeof input==='number')closeSync(input);
  let result;
  try {
    if(a.reader) result=adapterHelper(a,a.reader,{operation:'result',outDir,agent,...execution});
    else {
      const spec=a.result ?? {}, raw=read(join(outDir,spec.file ?? 'stdout.txt'));
      let obj;
      if(a.executable || spec.format==='json') obj=JSON.parse(raw);
      else if(spec.format==='jsonl') obj=raw.split('\n').flatMap((l)=>{try{return [JSON.parse(l)];}catch{return [];}}).filter((o)=>Object.entries(spec.match ?? {}).every(([k,v])=>get(o,k)===v)).at(-1);
      if(a.executable) {if(obj?.adapterResult!==1)throw new Error('executable adapter must emit adapterResult:1');result=obj;}
      else result={status:get(obj,spec.status) ?? 'completed',error:get(obj,spec.error),finalMessage:spec.finalFile ? read(join(outDir,spec.finalFile)) : spec.format==='text' ? raw : get(obj,spec.message) ?? '',tokens:spec.usage && Object.values(spec.usage).some((p)=>Number.isFinite(get(obj,p))) ? Object.fromEntries(Object.entries(spec.usage).map(([k,p])=>[k,get(obj,p) ?? 0])) : null};
    }
  } catch(e) {result={status:'failed',error:e.message};}
  if(!result || typeof result!=='object' || Array.isArray(result))result={status:'failed',error:'adapter returned no result object'};
  result.status=result.status==='completed'?'completed':'failed';
  result.adapterResult=1;
  if(typeof result.finalMessage!=='string')result.finalMessage='';
  if(!result.tokens || !Object.values(result.tokens).some(Number.isFinite))result.tokens=null;
  const evidence=[execution.error,read(join(outDir,'stderr.txt'))].join('\n');
  const known=(a.startup ?? []).find((r)=>new RegExp(r.pattern,'i').test(evidence));
  if(known && (execution.exitCode!==0 || result.status!=='completed')) result.startup={what:known.what ?? 'CLI could not start',fix:known.fix};
  if(/ENOENT|EACCES/.test(execution.error ?? '')) result.startup={what:execution.error,fix:`Install ${a.command[0]} and ensure it is executable on PATH.`};
  if(execution.exitCode!==0 || execution.error || result.startup) result.status='failed';
  result={...result,...execution,error:execution.error ?? result.error,outDir,usage:{tokens:result.tokens ?? null}};
  if(a.transcript) { try {result.transcript=adapterHelper(a,a.transcript,{operation:'transcript',outDir,agent});} catch {} }
  writeFileSync(join(outDir,'result.json'),JSON.stringify(result,null,2)+'\n');
  return result;
}

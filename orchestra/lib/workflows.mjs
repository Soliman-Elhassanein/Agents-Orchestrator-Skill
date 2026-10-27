import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { workflowDiagram, writeWorkflowDiagram } from '../tools/diagram.mjs';
import { withLock } from './lock.mjs';
import { engineDir } from './agents.mjs';
export const builtinWorkflows=existsSync(join(engineDir,'workflows')) ? join(engineDir,'workflows') : join(dirname(engineDir),'workflows');
export const blocks = ['agent','parallel','ask','gate','loop','checklist'];
// The checklist block was `lanes` in v1 and v2 packs and `tasks` in early v3 packs; loading renames both.
export const checklistNames = ['checklist','tasks','lanes'];
export function normalizeWorkflow(w) {
  const step=({lanes,tasks,...s})=>{
    if(lanes!==undefined || tasks!==undefined)s.checklist=lanes ?? tasks;
    if(s.loop?.steps)s.loop={...s.loop,steps:s.loop.steps.map(step)};
    return s;
  };
  return {...w,steps:w.steps?.map(step)};
}
// A step with `when` runs only if the named earlier step chose that value.
export function routed(step,outputs,get) {
  return !step.when || get(outputs[step.when.step],step.when.field)===step.when.equals;
}
export function workflowFile(root,name) {
  if(!/^[\w-]+$/.test(name))throw new Error('invalid workflow name');
  const file=[join(root,'.orchestra/workflows'),join(homedir(),'.config/orchestra/workflows'),builtinWorkflows]
    .flatMap((d)=>[join(d,name,'workflow.json'),join(d,`${name}.json`)]).find(existsSync);
  if(!file)throw new Error(`workflow ${name} not found`);
  return file;
}
// Every workflow name in search order; the first match wins, as in workflowFile.
export function listWorkflows(root) {
  const found=new Map();
  for(const [source,dir] of [['project',join(root,'.orchestra/workflows')],['user',join(homedir(),'.config/orchestra/workflows')],['built-in',builtinWorkflows]]) {
    if(!existsSync(dir))continue;
    for(const entry of readdirSync(dir).sort()) {
      const name=entry.replace(/\.json$/,''),file=entry.endsWith('.json')?join(dir,entry):join(dir,entry,'workflow.json');
      if(!/^[\w-]+$/.test(name) || found.has(name) || !existsSync(file))continue;
      try {const w=JSON.parse(readFileSync(file,'utf8'));validateWorkflow(w,dirname(file));const guide=join(dirname(file),'README.md');found.set(name,{name,source,file,version:w.workflow,description:w.description ?? null,guide:!entry.endsWith('.json') && existsSync(guide)?guide:null});}
      catch(e){found.set(name,{name,source,file,error:e.message});}
    }
  }
  return [...found.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
export function loadWorkflow(root,name) {
  const file=workflowFile(root,name),data=JSON.parse(readFileSync(file,'utf8'));validateWorkflow(data,dirname(file));
  return { ...normalizeWorkflow(data), dir:dirname(file) };
}
export function validateWorkflow(w,dir) {
  // v2 adds a required description; v3 adds routing and names the checklist block `checklist` (or `tasks`).
  const fields=w?.workflow>=2?['workflow','description','budget','steps']:['workflow','budget','steps'];
  if(!w || Object.keys(w).some((k)=>!fields.includes(k)) || Object.keys(w.budget ?? {}).some((k)=>k!=='calls'))throw new Error('unknown workflow field; workflows contain data only');
  if(![1,2,3].includes(w.workflow) || !Number.isSafeInteger(w.budget?.calls) || w.budget.calls<1)throw new Error('workflow v1, v2 or v3 requires a positive calls budget');
  if(w.workflow>=2 && (typeof w.description!=='string' || !w.description.trim()))throw new Error(`workflow v${w.workflow} requires a description: what it does, what to give it and what it returns`);
  const v3=w.workflow===3, known=v3?[...blocks,'tasks']:blocks.map((k)=>k==='checklist'?'lanes':k);
  // visible: earlier steps here and before each enclosing loop, by id; only they can route.
  const walk=(steps,visible=new Map())=>{
    visible=new Map(visible);
    if(!Array.isArray(steps) || !steps.length)throw new Error('steps must be non-empty');
    const ids=new Set();
    for(const s of steps) {
      if(!s || typeof s!=='object')throw new Error('invalid step');
      if(v3 && s.lanes!==undefined)throw new Error('workflow v3 names the lanes block checklist');
      const keys=known.filter((k)=>s[k]!==undefined);
      // Ids starting with "__" are reserved for the workflow graph's own nodes.
      if(keys.length!==1 || typeof s.id!=='string' || !/^[\w-]+$/.test(s.id) || s.id.startsWith('__') || ids.has(s.id))throw new Error('each step needs a unique id and one known block');
      ids.add(s.id); const raw=keys[0], k=checklistNames.includes(raw)?'checklist':raw, b=s[raw];
      if(Object.keys(s).some((p)=>p!=='id' && p!==raw && !(v3 && p==='when')) || !b || typeof b!=='object' || Array.isArray(b))throw new Error(`invalid step ${s.id}`);
      if(s.when!==undefined) {
        const w=s.when, source=visible.get(w?.step)?.agent?.choices;
        if(!w || typeof w!=='object' || Object.keys(w).sort().join(',')!=='equals,field,step')throw new Error(`step ${s.id}: when needs step, field and equals`);
        if(!source || source.field!==w.field || !source.values.includes(w.equals))throw new Error(`step ${s.id}: when must name an earlier step's choices field and one of its values`);
      }
      if(b.choices!==undefined) {
        const c=b.choices;
        if(!v3 || k!=='agent')throw new Error('choices need workflow v3 and an agent step');
        if(!c || typeof c!=='object' || Object.keys(c).sort().join(',')!=='field,values' || typeof c.field!=='string' || !/^[\w-]+$/.test(c.field) || !Array.isArray(c.values) || c.values.length<2 || c.values.some((v)=>typeof v!=='string' || !v.trim()) || new Set(c.values).size!==c.values.length)throw new Error(`step ${s.id}: choices need a field and two or more distinct text values`);
      }
      if(b.access && !['read','write'].includes(b.access))throw new Error('access must be read or write');
      if(b.tier!==undefined && (!Number.isSafeInteger(b.tier)||b.tier<1))throw new Error('tier must be positive');
      if(b.prompt && (typeof b.prompt!=='string' || !existsSync(join(dir,b.prompt)) || typeof b.prompt==='string' && (!statSync(join(dir,b.prompt)).isFile() || !within(dirname(dir),realpathSync(join(dir,b.prompt))))))throw new Error(`missing prompt ${b.prompt}`);
      if(['agent','parallel'].includes(k) && !b.prompt)throw new Error('agent prompt is required');
      if(b.distinct!==undefined && b.distinct!=='vendor' || b.anonymize!==undefined && typeof b.anonymize!=='boolean')throw new Error('invalid parallel visibility or distinct field');
      if(b.outputFile && (Object.keys(b.outputFile).sort().join(',')!=='field,path' || typeof b.outputFile.path!=='string' || typeof b.outputFile.field!=='string'))throw new Error('outputFile requires field and path');
      if(k==='parallel' && b.count!==undefined && (!Number.isSafeInteger(b.count)||b.count<1))throw new Error('parallel count must be positive');
      if(k==='gate' && (typeof b.command!=='string' || !b.command.trim()))throw new Error('gate command required');
      if(k==='ask' && (b.questions!==undefined && (!Array.isArray(b.questions)||b.questions.some((q)=>typeof q!=='string' || !q.trim())) || !b.prompt && !b.questions?.length))throw new Error('ask questions required');
      if(k==='loop') {if(!Number.isSafeInteger(b.max)||b.max<1 || !b.until?.step || !b.until.field || !Object.hasOwn(b.until,'equals') || (b.until.equals!==null && typeof b.until.equals==='object'))throw new Error('loop needs max and structured until');walk(b.steps,visible);if(!b.steps.some((s)=>s.id===b.until.step))throw new Error('loop until must reference a child step');}
      if(b.sees!==undefined && b.sees!=='previous' && (!Array.isArray(b.sees) || b.sees.some((s)=>typeof s!=='string')))throw new Error('sees must name earlier steps');
      if(k==='checklist' && b.access && b.access!=='write')throw new Error(`${raw} requires write access`);
      const allowed={agent:['prompt','tier','agent','access','sees','unless','outputFile','choices'],parallel:['prompt','tier','agent','access','sees','count','distinct','anonymize'],ask:['prompt','questions'],gate:['command'],loop:['steps','max','until'],checklist:['taskFile','tier','access']}[k];
      if(Object.keys(b).some((p)=>!allowed.includes(p)))throw new Error(`unknown ${raw} field`);
      visible.set(s.id,s);
    }
  }; walk(w.steps);
}
export function parseTasks(text) {
  const tasks=[], ids=new Set(); let phase=null;
  for(const [lineIndex,line] of text.split('\n').entries()) {
    const heading=/^## Phase (\d+):\s*(.*)/.exec(line); if(heading)phase=Number(heading[1]);
    const m=/^- \[([ xX])\] (T\d+)\s+((?:\[[^\]]+\]\s+)*)(.+?)\r?$/.exec(line);
    if(!m)continue; if(phase===null || ids.has(m[2]))throw new Error('tasks need a phase and unique IDs'); ids.add(m[2]);
    tasks.push({id:m[2],phase,lineIndex,ticked:m[1]!==' ',parallel:/\[P\]/.test(m[3]),text:m[3]+m[4]});
  }
  if(!tasks.length)throw new Error('task list has no tasks');
  return tasks.sort((a,b)=>a.phase-b.phase || a.lineIndex-b.lineIndex);
}

export function within(root,file) {
  const r=relative(resolve(root),resolve(file));return !isAbsolute(r) && r!=='..' && !r.startsWith('../');
}
export function checkWorkflow(file,diagram=true) {
  const w=JSON.parse(readFileSync(file,'utf8')),dir=dirname(resolve(file));validateWorkflow(w,dir);
  const drawing=join(dir,'workflow.drawio');
  if(diagram && (!existsSync(drawing) || readFileSync(drawing,'utf8')!==workflowDiagram(w)))throw new Error(`missing or stale workflow.drawio; fix: orchestra workflow diagram ${basename(file)==='workflow.json'?basename(dir):file} (file: ${JSON.stringify(resolve(file))})`);
  return {...w,dir};
}
export function dryWorkflow(raw,emit=console.log) {
  const w=normalizeWorkflow(raw);let calls=0;const outputs={};
  const field=(o,p)=>String(p).split('.').reduce((v,k)=>v?.[k],o);
  const walk=(steps,prefix='')=>{for(const s of steps){
    const k=blocks.find((k)=>s[k]),b=s[k],key=prefix+s.id;
    if(!routed(s,outputs,field)){emit(`${key}: ${k} (skipped: runs when ${s.when.step}.${s.when.field} = ${JSON.stringify(s.when.equals)})`);continue;}
    emit(`${key}: ${k}${k==='gate'?` (mock exit 0; not executed) ${b.command}`:k==='ask'?' (mock user answer)':k==='checklist'?' (mock checklist; no project writes)':''}`);
    if(k==='loop'){for(let i=0;i<b.max;i++)walk(b.steps,`${key}/${i}/`);outputs[s.id]={[b.until.field]:b.until.equals};}
    else if(['agent','parallel','checklist'].includes(k)){
      const call=(label,tier,access)=>{if(++calls>w.budget.calls)throw new Error('agent call budget exhausted in dry run');emit(`  ${key}/${label}: mock agent; tier ${tier}; ${access}`);};
      if(k==='checklist') {
        emit('  engine: plan if no task file; one brief call per phase below highest tier');
        if(!b.taskFile)call('plan','highest','read');
        call('phase-brief','highest','read');call('task',b.tier ?? 1,'write');
      } else {
        const n=k==='parallel'?(b.count ?? 2):1;
        for(let i=0;i<n;i++) {
          if(b.access==='write')call(`${i}-brief-if-below-top`,'highest','read');
          call(i,b.tier ?? 2,b.access ?? 'read');
        }
        if(k==='parallel')call('synthesis','highest','read');
      }
      outputs[s.id]=b.choices?{[b.choices.field]:b.choices.values[0]}:{mock:true};
      if(b.choices)emit(`  ${key}: mock choice ${b.choices.field} = ${JSON.stringify(b.choices.values[0])} (first listed)`);
    }else outputs[s.id]={mock:true};
  }};
  walk(w.steps);emit(`Dry run: ${calls}/${w.budget.calls} mock calls; no processes, quota reads or writes.`);return outputs;
}
export function addWorkflow(root,source,user=false) {
  const target=user?join(homedir(),'.config/orchestra/workflows'):join(root,'.orchestra/workflows');
  const temp=mkdtempSync(join(tmpdir(),'orchestra-pack-'));
  try {
    let from=resolve(source);
    if(!existsSync(from)){
      if(!/^(https:\/\/|ssh:\/\/|git@)/.test(source))throw new Error('pack path or Git URL required');
      const r=spawnSync('git',['clone','--depth','1','--',source,join(temp,basename(source).replace(/\.git$/,''))],{stdio:'ignore'});
      if(r.status!==0)throw new Error('could not clone workflow pack');from=join(temp,basename(source).replace(/\.git$/,''));
    }
    const safe=(dir)=>{for(const e of readdirSync(dir)){if(e==='.git')continue;const f=join(dir,e),st=lstatSync(f);if(st.isSymbolicLink() || !st.isDirectory() && !st.isFile())throw new Error('pack must contain only regular files');if(st.isDirectory())safe(f);}};safe(from);
    const packs=existsSync(join(from,'workflow.json'))?[from]:readdirSync(from).map((n)=>join(from,n)).filter((d)=>lstatSync(d).isDirectory() && existsSync(join(d,'workflow.json')));
    if(!packs.length)throw new Error('pack needs <name>/workflow.json');
    for(const p of packs){if(!/^[\w-]+$/.test(basename(p)))throw new Error('invalid workflow name');const w=checkWorkflow(join(p,'workflow.json'),existsSync(join(p,'workflow.drawio')));const prompts=(steps)=>{for(const s of steps){const b=s[blocks.find((k)=>s[k])];if(b.prompt && !within(from,realpathSync(join(p,b.prompt))))throw new Error('include shared prompts in the pack');if(b.steps)prompts(b.steps);}};prompts(w.steps);}
    mkdirSync(user?join(homedir(),'.config/orchestra'):join(root,'.orchestra'),{recursive:true});
    return withLock(user?join(homedir(),'.config/orchestra'):root,()=>{
      mkdirSync(target,{recursive:true});
      const names=readdirSync(from).filter((n)=>n!=='.git');
      if(packs[0]!==from)for(const n of names)if(existsSync(join(target,n)))throw new Error(`workflow destination exists: ${n}`);
      if(packs[0]===from){const n=basename(from);if(existsSync(join(target,n)))throw new Error(`workflow destination exists: ${n}`);cpSync(from,join(target,n),{recursive:true,filter:(s)=>basename(s)!=='.git'});if(!existsSync(join(target,n,'workflow.drawio')))writeWorkflowDiagram(join(target,n,'workflow.json'));return [n];}
      for(const n of names)cpSync(join(from,n),join(target,n),{recursive:true,filter:(s)=>basename(s)!=='.git'});for(const p of packs)if(!existsSync(join(target,basename(p),'workflow.drawio')))writeWorkflowDiagram(join(target,basename(p),'workflow.json'));return packs.map((p)=>basename(p));
    },user?join(homedir(),'.config/orchestra'):join(root,'.orchestra'));
  }finally{rmSync(temp,{recursive:true,force:true});}
}

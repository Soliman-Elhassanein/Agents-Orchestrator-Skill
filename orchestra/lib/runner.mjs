import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import * as g from './git.mjs';
import { loadConfig, parseDuration } from './config.mjs';
import { runAgent, stopAllAgents, extractJson, engineDir, quotaKey, pickWeighted, describeAgent } from './agents.mjs';
import { balanceFactors, balanceOptions } from './balance.mjs';
import { loadQuota, refreshQuota, saveObservation } from './quota.mjs';
import { attemptSummary } from './digest.mjs';
import { loadWorkflow, normalizeWorkflow, parseTasks, blocks } from './workflows.mjs';
import { RunState, notify } from './state.mjs';
import { knowledgeForBrief } from './knowledge.mjs';
import { childEnv } from './util.mjs';
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
const get=(o,p)=>String(p).split('.').reduce((v,k)=>v?.[k],o);
// A short, ref-safe slug of a task's first words: "[P] Add the login form" -> "add-the-login-form".
const slug=(text)=>text.replace(/\[[^\]]*\]/g,' ').toLowerCase().replace(/[^a-z0-9]+/g,'-').split('-').filter(Boolean).slice(0,5).join('-').slice(0,40).replace(/-+$/,'');
class Halt extends Error {}
class Runtime {
  constructor(root,run,cfg) {
    Object.assign(this,{root,run,cfg,s:run.data});
    this.wtRoot=g.worktreesRoot(root,run.id); this.wt=join(this.wtRoot,'run'); this.askChain=Promise.resolve();
    const s=this.s;
    s.steps ??={}; s.tasks ??=[]; s.gates ??=[]; s.calls ??=[]; s.decisions ??=[]; s.directions ??=[]; s.unavailable ??={};
    s.usage ??={calls:0,tokens:0,unreported:0};
    this.agents=Object.entries(cfg.agents).map(([name,a])=>({...a,name,quotaFrom:quotaKey(a,root)}));
    this.gateCommands=s.options?.gates ?? cfg.gates ?? [];
  }
  save() {
    this.s.finalCommit=existsSync(this.wt) ? g.headSha(this.wt) : this.s.finalCommit ?? this.s.base;
    this.run.save();
    const s=this.s;
    const totals=(key)=>s.calls.filter((c)=>c.step===key || c.step.startsWith(key+'/')).reduce((u,c)=>({calls:u.calls+1,tokens:u.tokens+Object.values(c.tokens ?? {}).filter(Number.isFinite).reduce((a,b)=>a+b,0),unreported:u.unreported+(c.tokens?0:1)}),{calls:0,tokens:0,unreported:0});
    const report={contract:'run-report/1',taskFile:s.taskFile ?? s.options?.taskFile ?? null,baseCommit:s.base,finalCommit:s.finalCommit,
      status:s.status==='completed'?'completed':['failed','stopped'].includes(s.status)?s.status:'stopped',runtimeStatus:s.status,
      steps:Object.fromEntries(Object.entries(s.steps).map(([key,e])=>[key,{...e,tokens:totals(key)}])),tasks:s.tasks,gates:s.gates,questions:[...s.decisions.flatMap((d)=>d.questions.map((q)=>({task:d.origin,question:q.question,answer:d.answers}))),
      ...(s.questions?.items ?? []).map((q)=>({task:s.questions.origin,question:q.question,answer:null}))],tokens:s.usage,calls:s.calls,unavailable:s.unavailable,suggestions:s.calls.flatMap((c)=>c.suggestions ?? [])};
    writeFileSync(this.run.path('run.json.tmp'),JSON.stringify(report,null,2)+'\n');renameSync(this.run.path('run.json.tmp'),this.run.path('run.json'));
  }
  check() {if(this.stopping)throw new Halt('stopped');}
  async wait(ms=Number(process.env.ORCHESTRA_ANSWER_POLL_MS ?? 1000)) {for(let left=ms;left>0;left-=1000){this.check();await sleep(Math.min(left,1000));}this.check();}
  steering() {
    const f=this.run.path('steering.jsonl'); if(!existsSync(f))return;
    const rows=readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map((l)=>JSON.parse(l));
    for(const d of rows.slice(this.s.directions.length))this.s.directions.push({...d,appliedAt:new Date().toISOString()});
  }
  interpolate(value) {
    const lookup=(p)=>p==='task'?this.s.task:p==='taskFile'?this.s.options?.taskFile:p==='runDir'?this.run.dir:p==='workflowDir'?this.workflow.dir:p==='engineDir'?engineDir:p==='projectRoot'?this.root:p.startsWith('steps.')?get(this.outputs,p.slice(6)):undefined;
    if(typeof value!=='string')return value;
    const whole=/^\{\{([^}]+)\}\}$/.exec(value); if(whole)return lookup(whole[1]) ?? '';
    return value.replace(/\{\{([^}]+)\}\}/g,(_m,p)=>{const v=lookup(p);return typeof v==='object'?JSON.stringify(v):v ?? '';});
  }
  prompt(b,role='agent',extra='') {
    let text=b.engineText ?? (b.prompt ? this.interpolate(readFileSync(join(this.workflow.dir,b.prompt),'utf8')) : extra);
    role=/^ORCHESTRA ROLE: ([^\n]+)/.exec(text)?.[1] ?? role;
    text=text.replace(/^ORCHESTRA ROLE: [^\n]+\nCYCLE: [^\n]+\n?/, '');
    const rules=readFileSync(join(engineDir,'templates/agent.md'),'utf8');
    text=`ORCHESTRA ROLE: ${role}\nCYCLE: ${this.cycle ?? 1}\n\n${rules}\n\n${text}\n\nTask: ${this.s.task}`;
    const sees=b.sees==='previous'?[this.previous]:b.sees ?? [];
    let visible=Object.fromEntries(sees.filter(Boolean).map((id)=>[id,this.outputs[id]]));
    if(b.anonymize){
      const scrub=(v)=>typeof v==='string'?this.agents.reduce((t,a)=>[a.name,a.cli,a.model].filter(Boolean).reduce((t,n)=>t.replace(new RegExp('(?<![\\w-])'+n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![\\w-])','g'),'[anonymous]'),t),v):Array.isArray(v)?v.map(scrub):v && typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>!['agent','cli','model','vendor','entry'].includes(k)).map(([k,x])=>[k,scrub(x)])):v;
      visible=Object.fromEntries(Object.entries(visible).map(([id,v])=>[id,scrub(v?.items?{items:v.items.filter((_,i)=>this.origins[id]?.[i]?this.origins[id][i]!==b.cli:i!==b.peerIndex).map((x,i)=>({label:`Peer ${i+1}`,output:x}))}:v)]));
    }
    // The values are part of every brief for this step, including engine-written ones.
    if(b.choices)text+=`\n\nChoose one path. Return JSON whose "${b.choices.field}" field is exactly one of: ${b.choices.values.map((v)=>JSON.stringify(v)).join(', ')}.`;
    return text+`\n\nInputs: ${JSON.stringify(visible)}\n\nQuestions already answered: ${JSON.stringify(this.s.decisions)}\n\nUser directions (newest wins): ${JSON.stringify(this.s.directions)}\n\nMachine notes for this CLI (advice): ${knowledgeForBrief(b.cli,this.cfg.knowledgeObservedLimit ?? 10)}\n${extra}`;
  }
  ask(origin,questions) {
    const job=async()=>{
      this.check();
      let batch=this.s.questions;
      if(!batch || batch.origin!==origin) {
        const n=(this.s.questionBatches ?? 0)+1; this.s.questionBatches=n;
        batch={batch:n,origin,cycle:1,items:questions.map((q,i)=>({n:i+1,...(typeof q==='string'?{question:q}:q)}))};
        this.s.questions=batch;
      }
      this.s.status='awaiting_user';this.s.phase='questions';this.save();
      notify('Orchestra needs your answers',`${batch.items.length} question(s) waiting`);
      const file=this.run.path(`answers-${batch.batch}.md`);
      while(!existsSync(file))await this.wait();
      const answers=readFileSync(file,'utf8').trim();
      this.s.decisions.push({origin,batch:batch.batch,by:'user',questions:batch.items,answers});
      this.s.questions=null;this.s.status='running';this.save();return {answers};
    };
    const p=this.askChain.then(job);this.askChain=p.catch(()=>{});return p;
  }
  async choose(b,excluded=new Set(),claim) {
    for(;;) {
      this.check();
      const factors=this.cfg.quotaBalancing?.enabled===false ? {} : balanceFactors(loadQuota(this.root),balanceOptions(this.cfg));
      const omitted=typeof excluded==='function'?excluded():excluded;
      const fits=(a)=>!this.s.unavailable[a.name] && (!b.agent || a.name===b.agent) && a.tier>=(b.purpose?this.topTier():b.tier ?? (b.agent?1:2));
      // Distinct vendors are preferred, not required: with too few vendors, any available agent serves.
      let eligible=this.agents.filter((a)=>fits(a) && !omitted.has(a.cli));
      if(!eligible.length && omitted.size)eligible=this.agents.filter(fits);
      for(const tier of [...new Set(eligible.map((a)=>a.tier))].sort((a,b)=>a-b)) {
        const pool=eligible.filter((a)=>a.tier===tier).map((a)=>({...a,weight:(a.weight ?? 1)*(factors[a.quotaFrom]?.factor ?? 1)})).filter((a)=>a.weight>0);
        if(pool.length) {this.s.status='running';const selected=pool[pickWeighted(pool,1,`${this.run.id}-${this.s.usage.calls}`)[0]];claim?.(selected);return selected;}
      }
      this.s.status='awaiting_quota';this.s.phase='waiting for an available agent at the requested tier or higher';this.save();
      // No model calls while waiting; only read-only quota sources refresh.
      await this.wait(Number(process.env.ORCHESTRA_QUOTA_POLL_MS ?? 30000));
      this.cfg=loadConfig(this.root);this.agents=Object.entries(this.cfg.agents).map(([name,a])=>({...a,name,quotaFrom:quotaKey(a,this.root)}));
      await refreshQuota(this.root,this.agents);
    }
  }
  protect(wt,base) {
    g.git(wt,['reset','-q','--','.orchestra'],{allowFail:true});
    g.git(wt,['restore','--source',base,'--staged','--worktree','--','.orchestra'],{allowFail:true});
    g.git(wt,['clean','-fdqx','--','.orchestra']);
  }
  topTier() {return Math.max(...this.agents.map((a)=>a.tier));}
  // Work branches sit next to the run branch: orchestra/<run>.<step>.<part>, e.g. orchestra/<run>.execute.T001-add-login-form.
  branchFor(key,part) {return `${this.s.branch}.${key.split('/').join('.')}.${part}`;}
  async strong(purpose,key,wt,input) {
    const e=await this.isolated({access:'read',tier:this.topTier(),purpose,role:purpose,
      engineText:readFileSync(join(engineDir,`templates/${purpose}.md`),'utf8')+'\n\n'+input},key,g.headSha(wt));
    return e.output;
  }
  text(output) {return typeof output?.text==='string'?output.text:JSON.stringify(output);}
  recordWrite(wt,base,e,call,outDir) {
    const changes=g.changedFiles(wt,base),commits=g.git(wt,['rev-list',`${base}..HEAD`]).out.split('\n').filter(Boolean);
    const patch=join(outDir,'changes.patch');writeFileSync(patch,g.git(wt,['diff','--binary',base,'HEAD']).out);
    Object.assign(call,{changes,commits,diff:relative(this.run.dir,patch)});
    e.changes=[...new Set([...(e.changes ?? []),...changes])];
    e.commits=[...new Set([...(e.commits ?? []),...commits])];
    e.diff=call.diff;e.diffs=[...(e.diffs ?? []),call.diff];
  }
  async retryFailure(b,key,wt,e,summary,status='failed') {
    e.failures++;e.tierFailures++;e.status=status;e.pendingFailure=summary;this.save();
    await this.prepareRetry(b,key,wt,e);
  }
  async prepareRetry(b,key,wt,e) {
    const summary=e.pendingFailure;
    if(e.failures>(this.cfg.executorRetries ?? 1))throw new Error(`${key}: ${summary}`);
    // A diagnosed retry on the original tier precedes escalation, even at threshold 1.
    if(b.access==='write') {
      e.brief=this.text(await this.strong('diagnosis',`${key}/diagnosis-${e.failures}`,wt,
        `Task and current brief:\n${e.brief ?? this.prompt(b,b.role, e.extra ?? '')}\nPrevious attempt failed:\n${summary}`));
    } else e.digest=`\nPrevious attempt failed:\n${summary}`;
    if(e.tierFailures>=Math.max(b.access==='write'?2:1,this.cfg.escalate?.afterFailures ?? 1)) {e.tier=this.agents.map((a)=>a.tier).filter((tier)=>tier>e.tier).sort((a,b)=>a-b)[0] ?? e.tier;e.tierFailures=0;e.escalated=true;}
    delete e.pendingFailure;this.save();
  }
  async job(b,key,wt,extra='',fixed,reservations) {
    const e=this.s.steps[key] ??= {status:'running'}; e.attempts ??=[];e.failures ??=0;
    if(e.status==='completed')return e;
    e.startBase ??= g.headSha(wt);
    e.tier ??= b.tier ?? (b.agent ? this.agents.find((a)=>a.name===b.agent)?.tier ?? 2 : 2);e.tierFailures ??=0;
    if(extra)e.extra=extra;extra=e.extra ?? extra;
    if(e.pendingFailure)await this.prepareRetry(b,key,wt,e);
    let named=e.escalated?undefined:b.agent;
    for(;;) {
      this.check();this.steering();
      if(this.s.usage.calls>=this.workflow.budget.calls)throw new Error('agent call budget exhausted');
      const requested=e.tier;
      const omitted=()=>new Set(reservations ? [...reservations].filter(([k])=>k!==key).map(([,v])=>v) : []);
      const agent=fixed ?? await this.choose({...b,agent:named,tier:requested},omitted,(a)=>reservations?.set(key,a.cli));fixed=null;
      if(agent.tier>e.tier)e.tierFailures=0;e.tier=agent.tier;
      if(b.access==='write' && agent.tier<this.topTier() && !e.brief) {
        e.brief=b.phaseBrief ?? this.text(await this.strong('brief',`${key}/brief`,wt,this.prompt(b,b.role,extra)));this.save();
      }
      if(this.s.usage.calls>=this.workflow.budget.calls)throw new Error('agent call budget exhausted');
      const base=g.headSha(wt);e.base=base;e.status='running';this.s.phase='executing';this.save();
      this.s.usage.calls++;this.s.usage.unreported++;
      const call={agent:describeAgent(agent),entry:agent.name,step:key,...(b.purpose?{purpose:b.purpose}:{}),status:'running',exit:null,tokens:null};
      this.s.calls.push(call);e.attempts.push(call);e.agent=agent.name;e.cli=agent.cli;this.save();
      const res=await runAgent(agent,{root:this.root,cwd:wt,outDir:this.run.path('calls',key.replace(/[^\w-]/g,'-')),readOnly:b.access!=='write',
        context:{handoff:JSON.stringify({run:this.s.id,step:key,base,finished:Object.keys(this.s.steps).filter((k)=>this.s.steps[k].status==='completed')}).slice(0,8000)},
        timeout:parseDuration(this.cfg.agentTimeout) ?? 1200000,brief:this.prompt({...b,cli:agent.cli,prompt:e.brief?undefined:b.prompt,engineText:e.brief ?? b.engineText},b.role ?? 'agent',extra+(e.digest ?? ''))});
      const tokens=res.usage?.tokens;
      if(tokens){this.s.usage.unreported--;this.s.usage.tokens+=Object.values(tokens).filter(Number.isFinite).reduce((a,b)=>a+b,0);}
      Object.assign(call,{status:res.status,exit:res.exitCode ?? null,log:relative(this.run.dir,res.outDir),tokens:tokens ?? null});
      if(res.quota)saveObservation(this.root,agent.quotaFrom,res.quota);
      this.check();
      this.protect(wt,base);
      const output=res.output ?? extractJson(res.finalMessage) ?? {text:res.finalMessage};
      call.suggestions=output.suggestions ?? [];
      const dirty=!g.isClean(wt) || g.changedFiles(wt,base).length>0;
      if(res.startup) {
        g.git(wt,['reset','--hard',base]);g.git(wt,['clean','-fdq']);
        named=undefined;this.s.unavailable[agent.name]={...res.startup,role:key,cycle:1};call.status='startup-failed';e.status='waiting';
        this.run.event('agent_unavailable',{agent:agent.name,...res.startup});
        notify('Orchestra: agent could not start',`${agent.name}: ${res.startup.what}. Fix: ${res.startup.fix}`);this.save();continue;
      }
      if(b.access!=='write' && dirty) {res.status='failed';res.error='read-only call changed files';}
      // A route is taken only from a listed value; anything else is a failed attempt, never a guess.
      if(res.status==='completed' && b.choices && !output.questions?.length && !b.choices.values.includes(get(output,b.choices.field))) {
        res.status='failed';res.error=`output field ${b.choices.field} must be one of ${b.choices.values.join(', ')}`;
      }
      if(res.status==='completed' && output.questions?.length) {
        if(b.access==='write') {g.commitAll(wt,`orchestra: ${key} before user question`);this.recordWrite(wt,base,e,call,res.outDir);}
        await this.ask(key,output.questions);continue;
      }
      if(res.status==='completed') {
        if(b.access==='write') {
          g.commitAll(wt,`orchestra: ${key}`);
          if(!g.changedFiles(wt,e.validationBase ?? e.startBase).length) {res.status='no-changes';res.error='write call made no changes';}
          else this.recordWrite(wt,base,e,call,res.outDir);
        }
        if(res.status==='completed') {e.status='completed';if(e.output && typeof e.output==='object' && typeof output==='object') {for(const field of Object.keys(e.output))delete e.output[field];Object.assign(e.output,output);}else e.output=output;e.commit=g.headSha(wt);call.status='completed';this.save();return e;}
      }
      g.git(wt,['add','-A']);writeFileSync(join(res.outDir,'unfinished.patch'),g.git(wt,['diff','--cached','--binary',base]).out);
      g.git(wt,['reset','--hard',base]);g.git(wt,['clean','-fdq']);
      call.status=res.status;await this.retryFailure(b,key,wt,e,attemptSummary(res.outDir,res),res.status);
      if(e.escalated)named=undefined;
    }
  }
  async gate(command,key,phase) {
    const revision=g.headSha(this.wt), id=`${key}-${this.s.gates.length}`;
    const wt=join(this.wtRoot,`gate-${this.s.gates.length}`), log=`logs/${id.replace(/[^\w-]/g,'-')}.log`;
    mkdirSync(this.run.path('logs'),{recursive:true});g.addDetachedWorktree(this.root,wt,revision);
    const fd=openSync(this.run.path(log),'w');let exit;
    const record={phase,command,exit:null,log,revision,status:'running'};this.s.gates.push(record);this.save();
    try { exit=await new Promise((r)=>{
      const child=spawn(command,{shell:true,cwd:wt,env:childEnv(),stdio:['ignore',fd,fd],detached:true});
      this.gateChild=child;let killer;const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}
        killer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1000);
      },parseDuration(this.cfg.gateTimeout) ?? 1200000);
      child.on('error',()=>{clearTimeout(timer);clearTimeout(killer);r(null);});child.on('exit',(code)=>{clearTimeout(timer);clearTimeout(killer);r(code);});
    }); } finally {closeSync(fd);this.gateChild=null;g.removeWorktree(this.root,wt);}
    Object.assign(record,{exit,status:'finished'});this.save();this.check();
    if(exit!==0)throw new Error(`gate exited ${exit}: ${command}`);return record;
  }
  gateDigest(error) {
    const gate=this.s.gates.at(-1);
    return `${error.message}\nRevision: ${gate?.revision}\n${gate?readFileSync(this.run.path(gate.log),'utf8').slice(-6000):''}`;
  }
  async checkedGates(runGates,writers) {
    for(;;) {
      for(const {b,key} of writers ?? [])if(this.s.steps[key].pendingFailure)await this.job(b,key,this.wt);
      try {return await runGates();}catch(error) {
        this.check();if(!writers?.length)throw error;
        const summary=this.gateDigest(error);
        for(const {b,key} of writers) {
          const e=this.s.steps[key];
          e.validationBase=g.headSha(this.wt);
          await this.retryFailure(b,key,this.wt,e,summary);
          await this.job(b,key,this.wt);
        }
      }
    }
  }
  async gates(key,phase) {for(const [i,cmd] of this.gateCommands.entries())await this.gate(cmd,`${key}-${i}`,phase);}
  async isolated(b,key,base,extra='',branch) {
    const wt=join(this.wtRoot,key.replace(/[^\w-]/g,'-'));
    if(branch) {
      if(g.git(this.root,['rev-parse','--verify',`refs/heads/${branch}`],{allowFail:true}).ok)g.addExistingBranchWorktree(this.root,wt,branch);
      else g.addBranchWorktree(this.root,wt,branch,base);
    } else g.addDetachedWorktree(this.root,wt,base);
    try {return await this.job(b,key,wt,extra);} finally {g.removeWorktree(this.root,wt);}
  }
  async parallel(b,key) {
    const parent=this.s.steps[key];parent.base ??=g.headSha(this.wt);this.save();
    const base=parent.base, jobs=[], reservations=b.distinct==='vendor'?new Map():null;
    for(let i=0;i<(b.count ?? 2);i++) {
      const child=`${key}/${i}`, done=this.s.steps[child];
      if(done?.status==='completed' && reservations)reservations.set(child,done.cli);
    }
    for(let i=0;i<(b.count ?? 2);i++) {
      const child=`${key}/${i}`, done=this.s.steps[child];
      const agent=done?.status==='completed' ? null : await this.choose(b,new Set(reservations?.values() ?? []),(a)=>reservations?.set(child,a.cli));
      jobs.push({agent,key:child,branch:this.branchFor(key,`agent-${i+1}`),wt:join(this.wtRoot,`${key.replace(/[^\w-]/g,'-')}-${i}`)});
    }
    const results=await Promise.allSettled(jobs.map(async(j)=>{
      if(this.s.steps[j.key]?.status==='completed')return this.s.steps[j.key];
      if(g.git(this.root,['show-ref','--verify',`refs/heads/${j.branch}`],{allowFail:true}).ok)g.addExistingBranchWorktree(this.root,j.wt,j.branch);
      else g.addBranchWorktree(this.root,j.wt,j.branch,base);
      try {return await this.job({...b,peerIndex:jobs.indexOf(j)},j.key,j.wt,'',j.agent,reservations);}finally{g.removeWorktree(this.root,j.wt);}
    }));
    const error=results.find((r)=>r.status==='rejected');if(error)throw error.reason;
    const output=[];
    for(const r of results) {
      const e=r.value;output.push(e.output);
      if(b.access==='write') {const m=g.merge(this.wt,e.commit,`orchestra: merge ${key}`);if(!m.ok){g.abortMerge(this.wt);throw new Error('parallel writes conflict');}}
    }parent.peers=results.map((r)=>r.value.cli);
    const synthesis=await this.strong('synthesis',`${key}/synthesis`,this.wt,
      this.prompt(b,'synthesis')+'\nIndependent outputs:\n'+JSON.stringify(output));
    return {items:output,synthesis};
  }
  async tasks(b,key) {
    const entry=this.s.steps[key] ??= {status:'running'};entry.phases ??=[];
    // Runs recorded before the rename keep their task branches.
    entry.branches ??=entry.lanes ?? {};delete entry.lanes;
    if(!entry.text) {
      let input=this.interpolate(b.taskFile) || this.s.options?.taskFile;
      if(!input) {
        const output=await this.strong('plan',`${key}/plan`,this.wt,this.s.task);
        const text=output.taskList ?? output.text;parseTasks(text ?? '');
        input=this.run.path('tasks.md');writeFileSync(input,text);
      }
      const path=resolve(this.root,input);entry.text=readFileSync(path,'utf8');entry.path=path;
      const rel=relative(this.root,path);entry.tickPath=path.startsWith(this.run.dir+'/') ? path : !rel.startsWith('..') && !isAbsolute(rel) ? join(this.wt,rel) : null;this.s.taskFile=path;
      if(!entry.tickPath)throw new Error('task file must be in the project or run folder');
      // A tracked task file is read from this run branch; its source checkout remains untouched.
      if(existsSync(entry.tickPath))entry.text=readFileSync(entry.tickPath,'utf8');
      parseTasks(entry.text);this.save();
    }
    const tasks=parseTasks(entry.text);
    for(const t of tasks)if(!this.s.tasks.some((r)=>r.id===t.id))this.s.tasks.push({id:t.id,phase:t.phase,status:'skipped',commits:[],attempts:0});
    for(const phase of [...new Set(tasks.filter((t)=>!t.ticked).map((t)=>t.phase))]) {
      if(entry.phases.includes(phase))continue;
      const todo=tasks.filter((t)=>t.phase===phase && !t.ticked), groups=[];
      for(const task of todo) {
        if(task.parallel && groups.at(-1)?.every((t)=>t.parallel))groups.at(-1).push(task);else groups.push([task]);
      }
      entry.briefs ??={};
      if(!entry.briefs[phase] && (await this.choose({...b,tier:b.tier ?? 1})).tier<this.topTier()) {
        const output=await this.strong('brief',`${key}/phase-${phase}/brief`,this.wt,
          `Return {"briefs":{"TASK_ID":"brief text"}} for every task in this phase.\n${JSON.stringify(todo)}\nRequest: ${this.s.task}`);
        if(!todo.every((t)=>typeof output.briefs?.[t.id]==='string' && output.briefs[t.id].trim()))throw new Error('phase briefs missing task IDs or text');
        entry.briefs[phase]=output.briefs;this.save();
      }
      for(const group of groups) {
        for(let offset=0;offset<group.length;offset+=this.cfg.fanout.executors) {
          const batch=group.slice(offset,offset+this.cfg.fanout.executors), base=g.headSha(this.wt);
          const runTask=async(t,redo=false)=>{
            const work=entry.branches[t.id] ??= {branch:this.branchFor(key,[t.id,slug(t.text)].filter(Boolean).join('-')),base};
            if(work.merged)return;
            if(redo) {
              if(!work.redo){work.redo=true;work.base=g.headSha(this.wt);g.deleteBranch(this.root,work.branch);this.save();}
            }
            const taskKey=`${key}/${t.id}${work.redo?'/redo':''}`;
            const e=await this.isolated({...b,tier:b.tier ?? 1,phaseBrief:entry.briefs[phase]?.[t.id],role:'executor',access:'write'},taskKey,work.base,`\nSUBTASK:\n${t.id} ${t.text}\n\n${work.redo?'Redo your work on top of the merged result; preserve the changes already there.':''}`,work.branch);
            let record=this.s.tasks.find((r)=>r.id===t.id);if(!record){record={id:t.id,phase,status:'skipped',commits:[]};this.s.tasks.push(record);}
            Object.assign(record,{status:'skipped',agent:e.agent,commits:e.commits,attempts:Object.entries(this.s.steps).filter(([k])=>k===`${key}/${t.id}` || k.startsWith(`${key}/${t.id}/`)).reduce((n,[,e])=>n+(e.attempts?.filter((c)=>!c.purpose).length ?? 0),0)});this.save();
          };
          const results=await Promise.allSettled(batch.map((t)=>runTask(t)));
          const failed=results.find((r)=>r.status==='rejected');if(failed){
            for(const t of batch){const e=this.s.steps[`${key}/${t.id}`];if(e?.status!=='completed')Object.assign(this.s.tasks.find((r)=>r.id===t.id),{status:'failed',attempts:e?.attempts?.length ?? 0,agent:e?.agent});}
            this.save();throw failed.reason;
          }
          for(const task of batch) {
            const work=entry.branches[task.id];if(work.merged)continue;
            // Detect a merge committed just before a crash but not yet checkpointed.
            let merged=g.git(this.wt,['merge-base','--is-ancestor',work.branch,'HEAD'],{allowFail:true}).ok;
            if(!merged)merged=g.merge(this.wt,work.branch,`orchestra: merge ${task.id}`).ok;
            if(!merged) {
              g.abortMerge(this.wt);
              if(!work.redo) {await runTask(task,true);merged=g.merge(this.wt,work.branch,`orchestra: merge ${task.id} redone`).ok;}
              if(!merged) {g.abortMerge(this.wt);await this.ask(`${key}/${task.id}/conflict`,[`Task ${task.id} conflicts again. Resolve branch ${work.branch} on top of ${this.s.branch}, then answer to retry the merge.`]);
                merged=g.merge(this.wt,work.branch,`orchestra: merge ${task.id} after user answer`).ok;
                if(!merged){g.abortMerge(this.wt);throw new Error(`task ${task.id} still conflicts`);}}
            }
            work.merged=true;this.save();
          }
        }
      }
      for(;;) {
        for(const t of todo) {
          const work=entry.branches[t.id], taskKey=`${key}/${t.id}${work.redo?'/redo':''}`;
          if(this.s.steps[taskKey].pendingFailure)await this.job({...b,role:'executor',access:'write'},taskKey,this.wt);
        }
        try {await this.gates(`${key}-phase${phase}`,phase);break;}
        catch(error) {
          this.check();
          for(const t of todo) {
            const work=entry.branches[t.id], taskKey=`${key}/${t.id}${work.redo?'/redo':''}`, e=this.s.steps[taskKey];
            const worker={...b,role:'executor',access:'write'};
            e.validationBase=g.headSha(this.wt);
            await this.retryFailure(worker,taskKey,this.wt,e,this.gateDigest(error));
            const repaired=await this.job(worker,taskKey,this.wt,`\nSUBTASK:\n${t.id} ${t.text}`);
            Object.assign(this.s.tasks.find((r)=>r.id===t.id),{agent:repaired.agent,commits:repaired.commits,attempts:repaired.attempts.length});
          }
        }
      }
      this.s.phaseGateRevision=g.headSha(this.wt);
      const lines=entry.text.split('\n');for(const t of todo){lines[t.lineIndex]=lines[t.lineIndex].replace('- [ ]','- [x]');this.s.tasks.find((r)=>r.id===t.id).status='executed';}
      entry.text=lines.join('\n');mkdirSync(resolve(entry.tickPath,'..'),{recursive:true});writeFileSync(entry.tickPath,entry.text);
      if(entry.tickPath.startsWith(this.wt+'/'))g.commitAll(this.wt,`orchestra: tick phase ${phase}`);
      entry.phases.push(phase);this.s.phaseGateRevision=g.headSha(this.wt);this.save();
    }
    return {tasks:this.s.tasks};
  }
  materialize(b,output) {
    if(!b.outputFile || output?.skipped)return;
    const file=resolve(this.interpolate(b.outputFile.path));
    if(!file.startsWith(this.run.dir+'/'))throw new Error('outputFile must be inside the run folder');
    const value=get(output,b.outputFile.field);if(typeof value!=='string')throw new Error('outputFile field must contain text');
    mkdirSync(resolve(file,'..'),{recursive:true});if(!existsSync(file))writeFileSync(file,value);output.taskFile=file;
  }
  trackWriters(kind,b,key,e) {
    if(kind==='agent' && b.access==='write' && !e.output?.skipped)this.lastWriters=[{b,key}];
    else if(kind==='parallel' && b.access==='write')this.lastWriters=Array.from({length:b.count ?? 2},(_,i)=>({b,key:`${key}/${i}`}));
    else if(kind==='loop') {e.writers ??=this.lastWriters;this.lastWriters=e.writers;}
    else if(kind!=='gate')this.lastWriters=null;
  }
  restore(id,e) {this.outputs[id]=e.output;this.origins[id]=e.peers;this.previous=id;}
  async runStep(step,key) {
    this.check();this.steering();const k=blocks.find((k)=>step[k]),b=step[k];
    let e=this.s.steps[key];
    if(e?.status==='completed') {
      this.trackWriters(k,b,key,e);if(k==='agent')this.materialize(b,e.output);
      this.restore(step.id,e);return;
    }
    if(k==='agent' && b.unless && this.interpolate(b.unless)) {this.s.steps[key]={status:'completed',output:{skipped:true,taskFile:this.interpolate(b.unless)}};this.restore(step.id,this.s.steps[key]);this.save();return;}
    if(!e)e=this.s.steps[key]={status:'running'};
    let output;
    if(k==='agent') {
      e=await this.job(b,key,this.wt);output=e.output;
      this.materialize(b,output);
    } else if(k==='parallel')output=await this.parallel(b,key);
    else if(k==='ask')output=await this.ask(key,b.questions?.map((q)=>this.interpolate(q)) ?? [this.interpolate(readFileSync(join(this.workflow.dir,b.prompt),'utf8'))]);
    else if(k==='gate')output=await this.checkedGates(()=>this.gate(this.interpolate(b.command),key),this.lastWriters);
    else if(k==='tasks')output=await this.tasks(b,key);
    this.complete(k,b,key,e,step.id,output);
  }
  complete(k,b,key,e,id,output) {
    this.trackWriters(k,b,key,e);
    e.status='completed';e.output=output;this.restore(id,e);this.save();
  }
  // Returns the iteration to run; a finished loop restores its output and is passed over.
  enterLoop(step,key) {
    this.check();const b=step.loop;let e=this.s.steps[key];
    if(e?.status==='completed') {this.trackWriters('loop',b,key,e);this.restore(step.id,e);return e.iteration;}
    if(!e)e=this.s.steps[key]={status:'running'};
    for(const child of b.steps){const prior=this.s.steps[`${key}/${(e.iteration ?? 0)-1}/${child.id}`];if(prior?.status==='completed'){this.outputs[child.id]=prior.output;this.origins[child.id]=prior.peers;}}
    this.save();return e.iteration ?? 0;
  }
  // After one iteration: completes the loop on its structured field, or returns the next iteration.
  checkLoop(step,key,i) {
    const b=step.loop,e=this.s.steps[key];e.iteration=i;this.save();
    const out=this.s.steps[`${key}/${i}/${b.until.step}`]?.output;
    e.iteration=i+1;
    if(get(out,b.until.field)===b.until.equals){this.complete('loop',b,key,e,step.id,out);return i;}
    if(e.iteration>=b.max){e.status='exhausted';this.save();throw new Error(`loop ${key} reached max`);}
    this.save();return e.iteration;
  }
  async execute(resume) {
    this.outputs={};this.origins={};
    if(!this.s.workflowData && !this.s.options?.workflow)throw new Error('a run needs a workflow: orchestra run <workflow> "<task>"');
    this.workflow=normalizeWorkflow(this.s.workflowData ?? loadWorkflow(this.root,this.s.options.workflow));
    this.s.workflowData=this.workflow;
    this.onSignal=()=>{this.stopping=true;stopAllAgents();if(this.gateChild){try{process.kill(-this.gateChild.pid,'SIGTERM');}catch{}}};
    process.on('SIGTERM',this.onSignal);process.on('SIGINT',this.onSignal);
    try {
      if(existsSync(this.wtRoot))for(const d of readdirSync(this.wtRoot))g.removeWorktree(this.root,join(this.wtRoot,d));
      if(resume) {
        for(const call of [...this.s.calls,...Object.values(this.s.steps).flatMap((e)=>e.attempts ?? []),...this.s.gates])if(call.status==='running')call.status='interrupted';
        g.addExistingBranchWorktree(this.root,this.wt,this.s.branch);this.s.finishedAt=undefined;this.s.error=undefined;}
      else g.addBranchWorktree(this.root,this.wt,this.s.branch,this.s.base);
      this.s.pid=process.pid;this.s.status='running';this.save();
      await refreshQuota(this.root,this.agents);
      // Loaded here so that commands which only read state never pay for importing LangGraph.
      const { compileWorkflow } = await import('./graph.mjs');
      await compileWorkflow(this.workflow,this).invoke();
      if(!this.s.finalGatesPassed) {
        if(this.s.phaseGateRevision!==g.headSha(this.wt))await this.checkedGates(()=>this.gates('final'),this.lastWriters);
        this.s.finalGatesPassed=true;
      }
      this.s.status='completed';
    } catch(e) {this.s.status=e instanceof Halt?'stopped':'failed';this.s.error=e.message;}
    finally {
      for(const e of Object.values(this.s.steps))if(['running','waiting'].includes(e.status))e.status=this.s.status==='stopped'?'stopped':'failed';
      this.s.phase='done';this.s.finishedAt=new Date().toISOString();this.s.final=`Execution ${this.s.status}. Commit: ${existsSync(this.wt)?g.headSha(this.wt):this.s.base}.`;
      this.save();writeFileSync(this.run.path('FINAL.md'),this.s.final+'\n');
      process.off('SIGTERM',this.onSignal);process.off('SIGINT',this.onSignal);
      if(existsSync(this.wtRoot))for(const d of readdirSync(this.wtRoot))g.removeWorktree(this.root,join(this.wtRoot,d));
      if(this.s.status==='completed')for(const sep of ['.','-'])for(const branch of g.branchesWithPrefix(this.root,this.s.branch+sep))g.deleteBranch(this.root,branch);
      notify('Orchestra',this.s.final);
    }
  }
}
export async function runLoop(root,id,{resume=false}={}) {
  const run=RunState.load(root,id);
  try {await new Runtime(root,run,loadConfig(root)).execute(resume);}catch(e){run.set({status:'failed',error:e.message});
    writeFileSync(run.path('run.json'),JSON.stringify({contract:'run-report/1',baseCommit:run.data.base,finalCommit:run.data.finalCommit ?? run.data.base,status:'failed',tasks:[],gates:[],questions:[],tokens:run.data.usage ?? {calls:0,tokens:0,unreported:0},error:e.message},null,2));}
}

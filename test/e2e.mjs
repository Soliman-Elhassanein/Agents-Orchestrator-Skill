#!/usr/bin/env node
/**
 * End-to-end tests with the built-in mock agent: real git, real worktrees, real runner process,
 * no CLI installed and no tokens spent.   node test/e2e.mjs [name filter]
 */
import { workflowDiagram } from "../orchestra/tools/diagram.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync as nativeSpawnSync } from "node:child_process";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_BIN = join(REPO, "orchestra", "bin", "orchestra.mjs");
const tmpRoots = [];
const testHome=mkdtempSync(join(tmpdir(),"orchestra-home-"));tmpRoots.push(testHome);
process.env.HOME=testHome;
process.env.XDG_CONFIG_HOME=join(testHome,".config");
process.env.ORCHESTRA_ANSWER_POLL_MS = "150";
process.env.ORCHESTRA_WATCH_POLL_MS = "50";
// File capture also works on hosts where synchronous child-process pipes are restricted.
function spawnSync(cmd, args, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orchestra-capture-"));
  const out = openSync(join(dir, "out"), "w");
  const err = openSync(join(dir, "err"), "w");
  try {
    const result = nativeSpawnSync(cmd, args, { ...options, stdio: ["ignore", out, err] });
    return { ...result, stdout: readFileSync(join(dir, "out"), "utf8"), stderr: readFileSync(join(dir, "err"), "utf8") };
  } finally { closeSync(out); closeSync(err); rmSync(dir, { recursive: true, force: true }); }
}

function sh(cwd, cmd, args, env = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} → ${res.status}\n${res.stdout}\n${res.stderr}`);
  return res.stdout;
}

function project(configPatch = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orchestra-e2e-"));
  tmpRoots.push(dir);
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  sh(dir, "git", ["config", "user.email", "test@example.com"]);
  sh(dir, "git", ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "# demo\n");
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "init"]);
  sh(dir, process.execPath, [SOURCE_BIN, "init"]);
  const cfgPath = join(dir, ".orchestra", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  Object.assign(cfg, { agents:{small:{cli:'mock',model:'small',tier:1},medium:{cli:'mock',model:'medium',tier:2},strong:{cli:'mock',model:'strong',tier:3}}, fanout:{executors:2}, ...configPatch });
  mkdirSync(join(dir,'.orchestra/adapters'),{recursive:true});
  writeFileSync(join(dir,'.orchestra/adapters/mock.json'),JSON.stringify({adapter:1,executable:true,
    command:[process.execPath,join(REPO,'test/mock-agent.mjs'),'--brief','{briefFile}','--out-dir','{outDir}'],prompt:{mode:'none'},
    flags:{model:['--model','{model}'],read:['--read']},startup:[{pattern:'permission denied|cannot prompt|socat|unsupported model|login required',what:'cannot start',fix:'Repair the test CLI permission, sandbox, model or login.'}]}));
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  sh(dir, "git", ["add", "."]);
  sh(dir, "git", ["commit", "-qm", "orchestra init"]);
  return dir;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(fn, what, ms = 90_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    let v;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    sleep(200);
  }
}
/** Run orchestra without blocking the test (for `watch`). Resolves { code, out }. */
const orchAsync = (dir, args, env = {}) => new Promise((resolvePromise) => {
  const capture = mkdtempSync(join(tmpdir(), "orchestra-async-"));
  const fd = openSync(join(capture, "output"), "w");
  const child = spawn(process.execPath, [join(dir, ".orchestra/engine/bin/orchestra.mjs"), ...args], { cwd: dir, env: { ...process.env, ...env }, stdio: ["ignore", fd, fd] });
  child.on("close", (code) => {
    closeSync(fd);
    const out = readFileSync(join(capture, "output"), "utf8");
    rmSync(capture, { recursive: true, force: true });
    resolvePromise({ code, out });
  });
});
const queueOf = (dir) => JSON.parse(readFileSync(join(dir, ".orchestra", "queue.json"), "utf8"));
const runOf = (dir, qid) => queueOf(dir).items.find((i) => i.id === qid);
const runState = (dir, runId) => JSON.parse(orch(dir, ["status", runId, "--json"]));

/** Like orch, but returns { code, out, err } instead of throwing on a non-zero exit. */
const orchRaw = (dir, args, env = {}) => {
  const r = spawnSync(process.execPath, [join(dir, ".orchestra", "engine", "bin", "orchestra.mjs"), ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const orch = (dir, args, env) => sh(dir, process.execPath, [join(dir, ".orchestra", "engine", "bin", "orchestra.mjs"), ...args], env);
const state = (dir) => JSON.parse(orch(dir, ["status", "--json"]));
const report=(dir)=>JSON.parse(readFileSync(join(dir,'.orchestra/runs',state(dir).id,'run.json'),'utf8'));
const commit=(dir,msg='fixture')=>{sh(dir,'git',['add','.']);sh(dir,'git',['commit','-qm',msg]);};
function workflow(dir,name,steps,budget=16,prompts={},version=1) {
  const path=join(dir,'.orchestra/workflows',name);mkdirSync(path,{recursive:true});
  writeFileSync(join(path,'workflow.json'),JSON.stringify(version===1?{workflow:1,budget:{calls:budget},steps}:{workflow:version,description:'Test workflow.',budget:{calls:budget},steps}));
  writeFileSync(join(path,'read.md'),'Read the project and return JSON with a stop boolean.');
  writeFileSync(join(path,'write.md'),'Make the requested change.');
  for(const [name,text]of Object.entries(prompts))writeFileSync(join(path,name),text);
  return path;
}
// A task-list workflow and a read-only single agent, as project fixtures.
const codeWorkflow=(dir)=>workflow(dir,'code',[{id:'execute',tasks:{taskFile:'{{taskFile}}',tier:1,access:'write'}}],128,{},3);
const reader=(dir)=>workflow(dir,'reader',[{id:'task',agent:{prompt:'read.md',access:'read'}}],32);
function taskFile(dir,text) {writeFileSync(join(dir,'tasks.md'),text);commit(dir);return join(dir,'tasks.md');}
// Validate the XML subset emitted by the renderer, including graph IDs and references.
function drawingCells(xml) {
  const stack=[],ids=new Set(),cells=[];
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  for(const match of xml.replace(/^<\?xml[^?]*\?>/, '').matchAll(/<([^>]+)>|([^<]+)/g)) {
    if(match[2]){assert.equal(match[2].trim(),'');continue;}
    const tag=match[1];
    if(tag.startsWith('/')){assert.equal(stack.pop(),tag.slice(1));continue;}
    const name=/^\w+/.exec(tag)[0],attrs={};
    let rest=tag.slice(name.length).replace(/\/$/,'');
    for(const a of rest.matchAll(/\s+([\w-]+)="([^"<>]*)"/g)) {
      assert.doesNotMatch(a[2],/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/);
      attrs[a[1]]=a[2];
    }
    rest=rest.replace(/\s+[\w-]+="[^"<>]*"/g,'');assert.equal(rest.trim(),'');
    if(name==='mxCell'){assert.ok(!ids.has(attrs.id));ids.add(attrs.id);cells.push(attrs);}
    if(!tag.endsWith('/'))stack.push(name);
  }
  assert.deepEqual(stack,[]);
  for(const cell of cells)for(const key of ['parent','source','target'])if(cell[key])assert.ok(ids.has(cell[key]),`${key}: ${cell[key]}`);
  return cells;
}
const tests={
  'diagrams: deterministic XML represents steps, parallel children, loops and escaped labels'() {
    const w={workflow:1,budget:{calls:12},steps:[
      {id:'writer',agent:{agent:'named & "quoted"',prompt:'write.md',access:'write',unless:'{{taskFile}}'}},
      {id:'views',parallel:{count:3,tier:3,access:'read',distinct:'vendor',anonymize:true,sees:['writer']}},
      {id:'repeat',loop:{max:2,until:{step:'ready',field:'stop',equals:true},steps:[{id:'ready',gate:{command:'printf "<ready> & done"'}}]}},
      {id:'answer',ask:{questions:['Choose?']}},{id:'tasks',lanes:{taskFile:'tasks.md',access:'write'}}]};
    const xml=workflowDiagram(w);assert.equal(xml,workflowDiagram(JSON.parse(JSON.stringify(w))));
    const cells=drawingCells(xml),steps=cells.filter(c=>c['data-role']==='step');
    assert.equal(steps.length,6);assert.equal(cells.filter(c=>c['data-role']==='child').length,3);
    assert.equal(cells.filter(c=>c['data-role']==='join').length,1);
    const loop=steps.find(c=>c['data-kind']==='loop');assert.match(loop.style,/container=1/);
    assert.ok(steps.some(c=>c.parent===loop.id));
    assert.ok(cells.some(c=>c.edge==='1' && /until ready.stop = true; max 2/.test(c.value)));
    for(const text of ['budget: 12 calls','access: write','distinct: vendor','anonymised: yes','sees: writer','you answer','[P] tasks','skip if present','&lt;ready&gt; &amp; done'])assert.ok(xml.includes(text),text);
    const nested={workflow:1,budget:{calls:1},steps:[{id:'outer',loop:{max:1,until:{step:'repeat',field:'stop',equals:true},steps:[w.steps[2]]}}]};
    assert.equal(drawingCells(workflowDiagram(nested)).filter(c=>/container=1/.test(c.style ?? '')).length,2);
  },
  'diagrams: check detects missing and stale drawings; diagram supports names, paths and --out'() {
    const dir=project(),folder=workflow(dir,'drawing',[{id:'read',agent:{prompt:'read.md',tier:1}}]),file=join(folder,'workflow.json'),drawing=join(folder,'workflow.drawio');
    let result=orchRaw(dir,['workflow','check',file]);assert.equal(result.code,1);assert.match(result.err,/orchestra workflow diagram drawing/);
    orch(dir,['workflow','diagram','drawing']);assert.match(orch(dir,['workflow','check',file]),/valid/);
    const first=readFileSync(drawing,'utf8');orch(dir,['workflow','diagram',file]);assert.equal(readFileSync(drawing,'utf8'),first);
    const out=join(dir,'custom.drawio');orch(dir,['workflow','diagram',file,'--out',out]);assert.equal(readFileSync(out,'utf8'),first);
    const w=JSON.parse(readFileSync(file));w.budget.calls++;writeFileSync(file,JSON.stringify(w));
    result=orchRaw(dir,['workflow','check',file]);assert.equal(result.code,1);assert.match(result.err,/stale/);
    orch(dir,['workflow','diagram','drawing']);assert.match(orch(dir,['workflow','check',file]),/valid/);
    assert.notEqual(readFileSync(drawing,'utf8'),first);
    assert.equal(orchRaw(dir,['workflow','diagram','drawing','--out']).code,1);
  },
  'diagrams: all built-in drawings are current and parse as XML'() {
    for(const name of readdirSync(join(REPO,'workflows'))) {
      const folder=join(REPO,'workflows',name),file=join(folder,'workflow.json'),xml=readFileSync(join(folder,'workflow.drawio'),'utf8');
      assert.equal(xml,workflowDiagram(JSON.parse(readFileSync(file))));drawingCells(xml);
      assert.match(sh(REPO,process.execPath,[SOURCE_BIN,'workflow','check',file]),/valid/);
    }
  },
  'diagrams: installing packs without drawings creates them without changing the source'() {
    const dir=project(),source=join(dir,'packs'),folder=join(source,'fresh');mkdirSync(folder,{recursive:true});
    const w={workflow:1,budget:{calls:1},steps:[{id:'ask',ask:{questions:['Choose?']}}]};
    writeFileSync(join(folder,'workflow.json'),JSON.stringify(w));
    orch(dir,['workflow','add',folder]);assert.equal(existsSync(join(folder,'workflow.drawio')),false);
    const installed=join(dir,'.orchestra/workflows/fresh');assert.equal(readFileSync(join(installed,'workflow.drawio'),'utf8'),workflowDiagram(w));
    assert.match(orch(dir,['workflow','check',join(installed,'workflow.json')]),/valid/);
    const bundle=join(dir,'bundle'),child=join(bundle,'second');mkdirSync(child,{recursive:true});writeFileSync(join(child,'workflow.json'),JSON.stringify(w));
    orch(dir,['workflow','add',bundle]);assert.ok(existsSync(join(dir,'.orchestra/workflows/second/workflow.drawio')));
    writeFileSync(join(folder,'workflow.drawio'),'stale');const other=project();
    assert.equal(orchRaw(other,['workflow','add',folder]).code,1);assert.equal(existsSync(join(other,'.orchestra/workflows/fresh')),false);
  },
  'run watches: direct and workflow jobs return completion events with the reserved run id'() {
    for (const withWorkflow of [false,true]) {
      const dir=project();
      if(withWorkflow)workflow(dir,'sample',[{id:'read',agent:{prompt:'read.md',access:'read'}}]);
      const result=orchRaw(dir,withWorkflow?['run','sample','read this']:['run','solo','write this']);
      assert.equal(result.code,0,result.err);assert.match(result.out,/EVENT finished/);
      const s=state(dir);assert.equal(s.status,'completed');assert.ok(result.out.includes(`Run ${s.id}`));
      assert.match(result.out,/ended \*\*completed\*\*/);
      const later=orchRaw(dir,['watch']);assert.equal(later.code,3);assert.doesNotMatch(later.out,/EVENT finished/);
    }
  },
  async 'run watches: questions are reported once and a later watch waits for answer completion'() {
    const dir=project();
    const first=orchRaw(dir,['run','solo','ask me'],{MOCK_QUESTIONS:'1'});
    assert.equal(first.code,0,first.err);assert.match(first.out,/EVENT questions/);
    const s=state(dir);assert.equal(s.status,'awaiting_user');assert.ok(first.out.includes(s.id));
    assert.equal(report(dir).tokens.calls,2);
    let returned=false;
    const watching=orchAsync(dir,['watch','--every','0']).then(r=>{returned=true;return r;});
    await new Promise(r=>setTimeout(r,350));assert.equal(returned,false);
    assert.equal(report(dir).tokens.calls,2);
    orch(dir,['answer','1. pg 2. example']);
    const next=await watching;assert.equal(next.code,0);assert.match(next.out,/EVENT finished/);
    assert.doesNotMatch(next.out,/EVENT questions/);assert.equal(report(dir).tokens.calls,3);
  },
  'run watches: detach returns before the mock completes and prints the eventual run id'() {
    const dir=project();const result=orchRaw(dir,['run','solo','slow job','--detach'],{MOCK_DELAY:'1800'});
    assert.equal(result.code,0);assert.doesNotMatch(result.out,/EVENT/);
    const item=queueOf(dir).items[0];assert.ok(result.out.includes(`Run ${item.runId}`));
    assert.notEqual(item.status,'completed');
    waitFor(()=>runOf(dir,item.id).status==='completed','detached completion');
    assert.equal(state(dir).id,item.runId);
    orch(dir,['queue','hold']);
    const held=orchRaw(dir,['run','solo','queued job','--detach']);
    assert.equal(held.code,0);assert.ok(held.out.includes(`Run ${queueOf(dir).items[1].runId}`));
  },
  'run watches: failure and quota events return zero without idle model calls'() {
    const failed=project();const result=orchRaw(failed,['run','solo','do work','--gate','exit 7']);
    assert.equal(result.code,0);assert.match(result.out,/EVENT finished/);assert.match(result.out,/ended \*\*failed\*\*/);
    const quota=project({agents:{only:{cli:'mock',model:'one',tier:1}}});
    const waiting=orchRaw(quota,['run','solo','higher tier needed']);
    assert.equal(waiting.code,0);assert.match(waiting.out,/EVENT waiting/);assert.ok(waiting.out.includes(state(quota).id));
    assert.equal(report(quota).tokens.calls,0);orch(quota,['stop']);
    waitFor(()=>state(quota).status==='stopped','stop waiting run');
  },
  'run watches: check-in and stuck flags reuse watcher options and config defaults'() {
    const progress=project({operatorUpdateMinutes:0.003,stuckAfterMinutes:0});
    const tick=orchRaw(progress,['run','solo','slow task'],{MOCK_DELAY:'1800'});
    assert.equal(tick.code,0);assert.match(tick.out,/EVENT progress/);
    waitFor(()=>state(progress).status==='completed','check-in completion');
    const stuck=project({communicatorUpdateMinutes:0.001,stuckAfterMinutes:0});
    const quiet=orchRaw(stuck,['run','solo','slow task','--every','0','--stuck-after','0.004'],{MOCK_DELAY:'1800'});
    assert.equal(quiet.code,0);assert.match(quiet.out,/EVENT stuck/);
    waitFor(()=>state(stuck).status==='completed','stuck completion');
  },
  async 'run watches: stop is a handled event and a queued run stays attached to its own id'() {
    const dir=project();
    orch(dir,['run','solo','first job','--detach'],{MOCK_DELAY:'1200'});
    const following=orchAsync(dir,['run','solo','second job','--every','0']);
    const result=await following;const second=queueOf(dir).items[1];
    assert.equal(result.code,0);assert.match(result.out,/EVENT finished/);
    assert.ok(result.out.includes(`Run ${second.runId} ended **completed**`));
    const stopped=project();const watching=orchAsync(stopped,['run','solo','slow task','--every','0'],{MOCK_DELAY:'1500'});
    waitFor(()=>state(stopped).status==='running','running before stop');orch(stopped,['stop']);
    const event=await watching;assert.equal(event.code,0);assert.match(event.out,/ended \*\*stopped\*\*/);
  },
  async 'step 3: generic adapters pass literal argv, stdin and file prompts; usage and executable escape hatch'() {
    const dir=project();
    const {runAgent,loadAdapter}=await import(join(REPO,'orchestra/lib/agents.mjs'));
    assert.equal(loadAdapter(dir,'mock').adapter,1);
    const result=await runAgent({cli:'mock',model:'unreported'},{root:dir,cwd:dir,outDir:join(dir,'.orchestra/probe'),brief:'ORCHESTRA ROLE: adapter-test\nCYCLE: 1',readOnly:true});
    assert.equal(result.status,'completed');assert.equal(result.usage.tokens,null);
    const js=join(dir,'.orchestra/echo.mjs');
    writeFileSync(js,"import {readFileSync} from 'node:fs'; process.stdout.write(JSON.stringify({reply:readFileSync(0,'utf8'),usage:{input:2,output:3},args:process.argv.slice(2)}));");
    const spec={adapter:1,command:[process.execPath,js],prompt:{mode:'stdin'},flags:{model:['--model','{model}']},result:{format:'json',message:'reply',usage:{input:'usage.input',output:'usage.output'}}};
    writeFileSync(join(dir,'.orchestra/adapters/echo.json'),JSON.stringify(spec));
    const literal='hello $(touch unwanted) `touch unwanted`';
    const echo=await runAgent({cli:'echo',model:literal},{root:dir,cwd:dir,outDir:join(dir,'.orchestra/echo'),brief:literal,readOnly:true});
    assert.equal(echo.finalMessage,literal);assert.deepEqual(echo.usage.tokens,{input:2,output:3});assert.ok(!existsSync(join(dir,'unwanted')));
    assert.equal(orchRaw(dir,['adapter','test','mock']).code,0);
    assert.throws(()=>loadAdapter(dir,'../bad'),/invalid adapter/);
  },
  'step 3: adapter test --command compares the write sandbox with a direct run'() {
    const dir=project();
    const works=orchRaw(dir,['adapter','test','mock','--command','test -f README.md']);
    assert.equal(works.code,0);assert.match(works.out,/mock: works; "test -f README.md" exits 0 inside the write sandbox and outside it/);
    const blocked=orchRaw(dir,['adapter','test','mock','--command','test -f README.md'],{MOCK_SANDBOX_BLOCK:'1'});
    assert.equal(blocked.code,1);assert.match(blocked.out,/write sandbox blocks "test -f README.md": exit 1 inside, 0 outside/);
    assert.match(blocked.out,/operation not permitted/);assert.match(blocked.out,/Fix: copy .*mock\.json to \.orchestra\/adapters\/mock\.json/);
    const broken=orchRaw(dir,['adapter','test','mock','--command','test -f missing.txt'],{MOCK_CALL_LOG:join(dir,'calls.jsonl')});
    assert.equal(broken.code,1);assert.match(broken.out,/not tested; .* outside any sandbox too/);assert.ok(!existsSync(join(dir,'calls.jsonl')),'no agent call when the command fails directly');
    assert.equal(orchRaw(dir,['adapter','test','mock','--command']).code,1);
    assert.equal(sh(dir,'git',['worktree','list']).trim().split('\n').length,1,'probe worktrees are removed');
  },
  'step 3: startup handover stays at the same tier, records exact fixes, never diagnoses startup failures'() {
    const agents={bad:{cli:'mock',model:'broken',tier:2,weight:100000},good:{cli:'mock',model:'good',tier:2,weight:0.00001},strong:{cli:'mock',model:'strong',tier:3}};
    const dir=project({agents});orch(dir,['run','solo','one task','--foreground'],{MOCK_STARTUP:'broken'});
    const s=state(dir),r=report(dir);assert.equal(s.status,'completed',s.error);assert.equal(r.tokens.calls,3);
    assert.equal(r.calls[1].status,'startup-failed');assert.equal(r.calls[2].entry,'good');
    assert.equal(r.calls.filter(c=>c.purpose==='diagnosis').length,0);assert.equal(s.steps.task.failures,0);assert.match(s.unavailable.bad.fix,/Repair/);
    assert.doesNotMatch(readFileSync(join(dir,'.orchestra/runs',s.id,r.calls[2].log,'brief.md'),'utf8'),/Previous attempt/);
    assert.ok(!existsSync(join(dir,'.orchestra/runs',s.id,r.calls[1].log,'unfinished.patch')));
  },
  'step 3: model tiers use quota weights, go up when empty and never down'() {
    const dir=project();writeFileSync(join(dir,'.orchestra/quota.json'),JSON.stringify({providers:{mock:{limitReached:'limit',observedAt:new Date().toISOString(),windows:[]},up:{windows:[{name:'weekly',usedPercent:10}]}}}));
    const file=join(dir,'.orchestra/config.json'),cfg=JSON.parse(readFileSync(file));cfg.agents.strong.quotaFrom='up';writeFileSync(file,JSON.stringify(cfg));
    orch(dir,['run','solo','one task','--foreground']);const r=report(dir);assert.equal(r.calls[0].entry,'strong');assert.equal(r.tokens.calls,1);
  },
  'step 3: diagnosed retries precede escalation; incomplete usage stays explicit'() {
    const dir=project({executorRetries:2});orch(dir,['run','solo','one task','--foreground'],{MOCK_FAIL:'medium'});
    const r=report(dir);assert.deepEqual(r.calls.map((c)=>c.entry),['strong','medium','strong','medium','strong','strong']);assert.equal(r.tokens.tokens,7500);
    assert.deepEqual(r.calls.filter(c=>c.purpose).map(c=>c.purpose),['brief','diagnosis','diagnosis']);
    const brief=readFileSync(join(dir,'.orchestra/runs',state(dir).id,r.calls[3].log,'brief.md'),'utf8');assert.match(brief,/Previous attempt[\s\S]*npm test/);
    const other=project({agents:{u:{cli:'mock',model:'unreported',tier:2}}});orch(other,['run','solo','one task','--foreground']);assert.deepEqual(report(other).tokens,{calls:1,tokens:0,unreported:1});
  },
  'step 4: six blocks, structured outputs, bounded loops and independent parallel sessions'() {
    const dir=project(),steps=[{id:'research',agent:{prompt:'read.md',tier:1}},{id:'views',parallel:{prompt:'read.md',count:2,tier:2,sees:['research']}},
      {id:'repeat',loop:{max:2,until:{step:'check',field:'stop',equals:true},steps:[{id:'check',agent:{prompt:'read.md',tier:1}}]}},
      {id:'verify',gate:{command:'test ! -d mock-output'}}];
    workflow(dir,'sample',steps);orch(dir,['run','sample','learn this','--foreground']);const r=report(dir);
    assert.equal(r.status,'completed',state(dir).error);assert.equal(r.tokens.calls,5);assert.equal(r.steps.repeat.iteration,1);
    const calls=r.calls.filter((c)=>c.step.startsWith('views/') && !c.purpose);assert.equal(calls.length,2);
    const briefs=calls.map((c)=>readFileSync(join(dir,'.orchestra/runs',state(dir).id,c.log,'brief.md'),'utf8'));
    assert.ok(briefs.every((b)=>b.includes('"research"') && !b.includes('"views"')));
    assert.equal(r.gates[0].exit,0);assert.equal(r.gates[0].revision,r.baseCommit);
  },
  'step 4: ask waits with zero calls, requires numbered answers and resumes from its checkpoint'() {
    const dir=project();workflow(dir,'sample',[{id:'before',agent:{prompt:'read.md',tier:1}},{id:'choice',ask:{questions:['Which database?','Which name?']}},{id:'after',agent:{prompt:'read.md',tier:1}}]);
    orch(dir,['run','sample','ask me','--detach']);waitFor(()=>state(dir).status==='awaiting_user','question');
    assert.equal(report(dir).tokens.calls,1);assert.equal(orchRaw(dir,['answer','1. pg']).code,1);
    const pid=state(dir).pid;process.kill(pid,'SIGKILL');waitFor(()=>state(dir).status==='crashed','worker crash');
    orch(dir,['resume']);waitFor(()=>state(dir).status==='awaiting_user','resumed question');
    assert.equal(report(dir).tokens.calls,1);orch(dir,['answer','1. pg 2. example']);waitFor(()=>state(dir).status==='completed','answer completion');
    assert.equal(report(dir).tokens.calls,2);assert.equal(report(dir).questions[0].answer,'1. pg 2. example');
  },
  'step 4: loop max and budget stop dependent calls; invalid workflow rejected'() {
    const dir=project();workflow(dir,'bounded',[{id:'repeat',loop:{max:2,until:{step:'check',field:'stop',equals:false},steps:[{id:'check',agent:{prompt:'read.md',tier:1}}]}},{id:'after',agent:{prompt:'read.md'}}]);
    assert.equal(orchRaw(dir,['run','bounded','loop','--foreground']).code,1);assert.equal(report(dir).tokens.calls,2);assert.equal(report(dir).steps.repeat.status,'exhausted');
    const other=project();workflow(other,'budget',[{id:'views',parallel:{prompt:'read.md',tier:1,count:3}}],2);
    assert.equal(orchRaw(other,['run','budget','work','--foreground']).code,1);assert.equal(report(other).tokens.calls,2);
    workflow(other,'bad',[{id:'x',unknown:{}}]);assert.match(orchRaw(other,['run','bad','x','--foreground']).err,/known block/);
  },
  'step 4: read-only writes are failures and do not leak into the run'() {
    const dir=project({executorRetries:0});workflow(dir,'read',[{id:'read',agent:{prompt:'read.md',tier:1,access:'read'}},{id:'after',agent:{prompt:'read.md'}}]);
    assert.equal(orchRaw(dir,['run','read','look','--foreground'],{MOCK_VIOLATE_READ:'1'}).code,1);
    assert.equal(report(dir).tokens.calls,1);assert.equal(sh(dir,'git',['ls-tree','-r','--name-only',state(dir).branch]).includes('mock-output'),false);
  },
  'step 5: supplied task list runs parallel work, sequential barriers, phase gates and exact checkbox edits'() {
    const dir=project({gates:['test -f mock-output/T001.txt && test -f mock-output/T002.txt']});
    const original='# Tasks\r\nKeep this text.\r\n## Phase 1: Work\r\n- [ ] T001 [P] [X] Write one\r\n- [ ] T002 [P] Write two\r\n- [ ] T003 Wire both\r\n\r\n## Phase 2: More\r\n- [ ] T004 Add last\r\n';
    codeWorkflow(dir);taskFile(dir,original);orch(dir,['run','code','--task-file','tasks.md','--foreground']);const s=state(dir),r=report(dir);
    assert.equal(s.status,'completed',s.error);assert.equal(r.tokens.calls,6);assert.deepEqual(r.tasks.map((t)=>t.status),['executed','executed','executed','executed']);
    const show=(f)=>sh(dir,'git',['show',`${s.branch}:${f}`]);
    assert.equal(show('tasks.md'),original.replaceAll('- [ ]','- [x]'));
    assert.equal(readFileSync(join(dir,'tasks.md'),'utf8'),original,'source checkout stays isolated');
    assert.doesNotMatch(show('mock-output/T002-saw.txt'),/T001/);assert.match(show('mock-output/T003-saw.txt'),/T001.txt[\s\S]*T002.txt/);
    assert.equal(r.gates.filter((g)=>g.phase===1).length,1);assert.equal(r.gates.filter((g)=>g.phase===2).length,1);
    for(const gate of r.gates){assert.equal(gate.exit,0);assert.ok(existsSync(join(dir,'.orchestra/runs',s.id,gate.log)));assert.ok(gate.revision);}
  },
  'step 5: generated task list uses a tier-3 call then cheap lanes'() {
    const dir=project();codeWorkflow(dir);orch(dir,['run','code','make two changes','--foreground']);const s=state(dir),r=report(dir);
    assert.equal(s.status,'completed',s.error);assert.deepEqual(r.calls.map((c)=>c.entry),['strong','strong','small','small']);
    assert.equal(r.tasks.length,2);assert.match(readFileSync(join(dir,'.orchestra/runs',s.id,'tasks.md'),'utf8'),/\[x\] T001/);
  },
  'step 5: a task that changes nothing completes and reports no changes; failed gates never tick'() {
    const dir=project();codeWorkflow(dir);taskFile(dir,'## Phase 1: Work\n- [ ] T001 Check something\n- [ ] T002 Depends on first\n');
    assert.equal(orchRaw(dir,['run','code','--task-file','tasks.md','--foreground'],{MOCK_NOOP:'T001'}).code,0);
    const r=report(dir);assert.equal(r.status,'completed',state(dir).error);assert.equal(r.tokens.calls,3);
    assert.deepEqual(r.steps['execute/T001'].changes,[]);assert.equal(r.calls.filter(c=>c.purpose==='diagnosis').length,0);
    assert.deepEqual(r.tasks.map(t=>t.status),['executed','executed']);
    assert.match(sh(dir,'git',['show',`${state(dir).branch}:tasks.md`]),/\[x\] T001[\s\S]*\[x\] T002/);
    const gated=project();codeWorkflow(gated);taskFile(gated,'## Phase 1: Work\n- [ ] T001 Write one\n');
    assert.equal(orchRaw(gated,['run','code','--task-file','tasks.md','--gate','echo detail; exit 7','--foreground']).code,1);
    const gr=report(gated);assert.equal(gr.gates[0].exit,7);assert.equal(gr.gates[0].command,'echo detail; exit 7');assert.ok(gr.gates.every(g=>g.revision));assert.equal(gr.gates.at(-1).revision,gr.finalCommit);
    assert.equal(gr.tasks[0].status,'skipped');assert.doesNotMatch(sh(gated,'git',['show',`${state(gated).branch}:tasks.md`]),/\[x\]/);
  },
  'step 5: direct job has brief and worker calls, config and repeated gate overrides; land needs explicit branch'() {
    const dir=project({gates:['exit 7']});orch(dir,['run','solo','simple job','--gate','test -f mock-output/direct.txt','--gate','echo artifact > generated.txt','--foreground']);
    const r=report(dir);assert.equal(r.tokens.calls,2);assert.equal(r.calls[1].entry,'medium');assert.equal(r.gates.length,2);
    assert.doesNotMatch(sh(dir,'git',['ls-tree','-r','--name-only',state(dir).branch]),/generated.txt/);
    assert.match(orchRaw(dir,['land']).err,/name the target explicitly/);sh(dir,'git',['branch','target']);orch(dir,['land','target']);
    assert.equal(sh(dir,'git',['branch','--show-current']).trim(),'target');assert.ok(existsSync(join(dir,'mock-output/direct.txt')));
    assert.equal(sh(dir,'git',['ls-tree','-r','--name-only','main']).includes('mock-output'),false);
  },
  'step 4: interrupted lane resumes from its branch without rerunning merged work'() {
    const dir=project({fanout:{executors:1}});codeWorkflow(dir);taskFile(dir,'## Phase 1: Work\n- [ ] T001 First\n- [ ] T002 Second\n');
    orch(dir,['run','code','--task-file','tasks.md','--detach'],{MOCK_CRASH_TITLE:'T002'});
    waitFor(()=>state(dir).status==='crashed','lane crash');const before=report(dir);assert.equal(before.steps['execute/T001'].status,'completed');
    orch(dir,['resume']);waitFor(()=>state(dir).status==='completed','lane resume');const r=report(dir);assert.equal(r.tokens.calls,4);assert.equal(r.tokens.unreported,1);assert.equal(r.steps['execute/T001'].attempts.length,1);
    assert.match(sh(dir,'git',['show',`${state(dir).branch}:tasks.md`]),/\[x\] T002/);
  },
  'step 4: conflicts redo once on the merged revision with no planning call'() {
    const dir=project();codeWorkflow(dir);taskFile(dir,'## Phase 1: Work\n- [ ] T001 [P] First\n- [ ] T002 [P] Second\n');
    orch(dir,['run','code','--task-file','tasks.md','--foreground'],{MOCK_CONFLICT:'1'});const r=report(dir);
    assert.equal(r.status,'completed',state(dir).error);assert.equal(r.tokens.calls,4);assert.ok(r.steps.execute.branches.T002.redo);
    assert.equal(sh(dir,'git',['show',`${state(dir).branch}:shared.txt`]),'T002 [P] Second\n');
  },
  'queue, questions from an agent, steering, quota waiting and records use no idle calls'() {
    const dir=project();orch(dir,['run','solo','one job','--detach'],{MOCK_QUESTIONS:'1'});waitFor(()=>state(dir).status==='awaiting_user','agent questions');
    assert.equal(report(dir).tokens.calls,2);orch(dir,['steer','use the chosen name']);orch(dir,['answer','1. pg 2. chosen']);waitFor(()=>state(dir).status==='completed','direct answers');
    assert.equal(report(dir).tokens.calls,3);assert.equal(state(dir).directions[0].text,'use the chosen name');
    const waiting=project({agents:{only:{cli:'mock',model:'one',tier:1}}});orch(waiting,['run','solo','higher tier needed','--detach']);waitFor(()=>state(waiting).status==='awaiting_quota','quota wait');
    assert.equal(report(waiting).tokens.calls,0);orch(waiting,['stop']);waitFor(()=>state(waiting).status==='stopped','stop quota wait');
    assert.equal(report(waiting).tokens.calls,0);
  },
  async 'step 3: shipped adapter flags, results, passive quota and transcripts use fixtures only'() {
    const dir=project();
    const {loadAdapter,runAgent,adapterHelper,adapterDirs,quotaKey}=await import(join(REPO,'orchestra/lib/agents.mjs'));
    assert.equal(adapterDirs(dir).length,3);
    const fake=join(dir,'.orchestra/fixture.mjs');
    writeFileSync(fake,`import {writeFileSync} from 'node:fs';
const args=process.argv.slice(3),name=process.argv[2];
if(name==='claude')process.stdout.write([
 {type:'rate_limit_event',rate_limit_info:{unifiedWindows:{five_hour:{utilization:0.25,resetsAt:2000000000}}}},
 {type:'assistant',message:{content:[{type:'tool_use',id:'tool',input:{command:'npm test',file_path:'a.js'}}]}},
 {type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool',is_error:true,content:'failed fixture'}]}},
 {type:'result',result:'hello',usage:{input_tokens:100,output_tokens:20,cache_read_input_tokens:30}}
].map(JSON.stringify).join('\\n'));
if(name==='codex'){writeFileSync(args[args.indexOf('-o')+1],'hello');process.stdout.write([
 {type:'item.completed',item:{type:'command_execution',command:'npm test',exit_code:7,aggregated_output:'failed fixture'}},
 {type:'turn.completed',usage:{input_tokens:100,output_tokens:20,cached_input_tokens:30}}
].map(JSON.stringify).join('\\n'));}
if(name==='agy')process.stdout.write('hello');
`);
    for(const name of ['claude','codex','agy']) {
      const original=loadAdapter(dir,name),spec={...original,command:[process.execPath,fake,name,...original.command.slice(1)]};delete spec.dir;delete spec.name;
      writeFileSync(join(dir,'.orchestra/adapters',name+'.json'),JSON.stringify(spec));
      cpSync(join(REPO,'orchestra/adapters',name+'.mjs'),join(dir,'.orchestra/adapters',name+'.mjs'));
      const result=await runAgent({cli:name,model:name==='agy'?'gemini-test':'test',effort:'high'},{root:dir,cwd:dir,outDir:join(dir,'.orchestra/fixture-'+name),brief:'read',readOnly:true});
      assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.finalMessage,'hello');
      if(name==='claude'){assert.equal(result.quota.windows[0].usedPercent,25);assert.equal(result.tokens.input,100);assert.equal(result.transcript.commands[0].code,'error');}
      if(name==='codex'){assert.equal(result.tokens.input,70);assert.equal(result.tokens.cacheRead,30);assert.equal(result.transcript.commands[0].code,7);}
      if(name==='agy'){assert.equal(result.tokens,null);assert.ok(original.command.includes('--add-dir'));assert.ok(original.flags.read.includes('--sandbox'));assert.equal(quotaKey({cli:name,model:'other'},dir),'agy-claude-gpt');}
      const errors=['permission denied','sandbox dependencies are missing: socat','unsupported model','login required'];
      for(const message of errors)assert.ok(spec.startup.some((r)=>new RegExp(r.pattern,'i').test(message)));
    }
    const original=loadAdapter(dir,'codex');assert.equal(original.dir,join(dir,'.orchestra/adapters'),'project override wins');
  },
  async 'step 3: active quota readers preserve account windows and only request metadata'() {
    const dir=project(),{loadAdapter,adapterHelper}=await import(join(REPO,'orchestra/lib/agents.mjs'));
    const server=join(dir,'.orchestra/fake-server');
    writeFileSync(server,`#!${process.execPath}
const fs=require('node:fs');let buf='';const chunk=Buffer.alloc(4096);
for(;;){const n=fs.readSync(0,chunk,0,chunk.length,null);if(!n)break;buf+=chunk.subarray(0,n);let at;
while((at=buf.indexOf('\\n'))>=0){const m=JSON.parse(buf.slice(0,at));buf=buf.slice(at+1);
if(m.id===1)fs.writeSync(1,JSON.stringify({id:1,result:{}})+'\\n');
if(m.id===2){if(m.method!=='account/rateLimits/read')process.exit(9);
fs.writeSync(1,JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:40,windowDurationMins:300,resetsAt:2000000000}}}})+'\\n');}
}}
`);chmodSync(server,0o755);
    const usage=join(dir,'.orchestra/fake-usage');writeFileSync(usage,`#!${process.execPath}
require('node:fs').writeSync(1,'Gemini Models\\tFive Hour limit remaining\\t75%\\t2030-01-01T00:00:00Z\\nClaude and GPT Models\\tWeekly limit remaining\\t60%\\t2030-01-01T00:00:00Z\\n');`);chmodSync(usage,0o755);
    const oldServer=process.env.ORCHESTRA_CODEX_BIN,oldUsage=process.env.ORCHESTRA_AGY_BIN;
    process.env.ORCHESTRA_CODEX_BIN=server;process.env.ORCHESTRA_AGY_BIN=usage;
    try {
      const a=loadAdapter(dir,'codex'),r=adapterHelper(a,a.quota,{operation:'quota',agent:{cli:'codex'}});assert.equal(r.windows[0].usedPercent,40);assert.equal(r.windows[0].windowMins,300);
      const b=loadAdapter(dir,'agy'),q=adapterHelper(b,b.quota,{operation:'quota',agent:{cli:'agy',model:'gemini-test'}});assert.equal(q.windows[0].usedPercent,25);
    } finally {if(oldServer===undefined)delete process.env.ORCHESTRA_CODEX_BIN;else process.env.ORCHESTRA_CODEX_BIN=oldServer;if(oldUsage===undefined)delete process.env.ORCHESTRA_AGY_BIN;else process.env.ORCHESTRA_AGY_BIN=oldUsage;}
  },
  'step 4: named agents and distinct vendors survive startup fallback; project workflows override built-ins'() {
    const dir=project({agents:{bad:{cli:'mock',model:'broken',tier:3,weight:100000},good:{cli:'mock',model:'good',tier:3,weight:0.00001},other:{cli:'other',model:'other',tier:3}}});
    cpSync(join(dir,'.orchestra/adapters/mock.json'),join(dir,'.orchestra/adapters/other.json'));
    workflow(dir,'independent',[{id:'views',parallel:{prompt:'read.md',tier:3,count:2,distinct:'vendor'}}]);
    orch(dir,['run','independent','compare','--foreground'],{MOCK_STARTUP:'broken'});const r=report(dir);assert.equal(r.status,'completed',state(dir).error);
    const children=['views/0','views/1'].map((k)=>r.steps[k]);assert.equal(new Set(children.map((e)=>e.cli)).size,2);assert.equal(r.tokens.calls,4);
    const override=project();workflow(override,'solo',[{id:'cheap',agent:{prompt:'read.md',agent:'small'}}]);orch(override,['run','solo','custom procedure','--foreground']);
    assert.equal(report(override).tokens.calls,1);assert.equal(report(override).calls[0].entry,'small');assert.equal(report(override).tasks.length,0);
  },
  'step 4: distinct vendors fall back to any available agent when too few vendors exist'() {
    const dir=project({agents:{only:{cli:'mock',model:'good',tier:3}}});
    workflow(dir,'independent',[{id:'views',parallel:{prompt:'read.md',tier:3,count:3,distinct:'vendor'}}]);
    orch(dir,['run','independent','compare','--foreground']);const r=report(dir);assert.equal(r.status,'completed',state(dir).error);
    assert.equal(r.tokens.calls,4);assert.deepEqual(['views/0','views/1','views/2'].map((k)=>r.steps[k].cli),['mock','mock','mock']);
  },
  'step 4: a repeated merge conflict waits for the user and makes no resolution call'() {
    const dir=project();codeWorkflow(dir);taskFile(dir,'## Phase 1: Work\n- [ ] T001 [P] First\n- [ ] T002 [P] Second\n');
    orch(dir,['run','code','--task-file','tasks.md','--detach'],{MOCK_CONFLICT:'1',MOCK_REPEAT_CONFLICT:'1'});
    waitFor(()=>state(dir).status==='awaiting_user','repeated conflict');const s=state(dir),r=report(dir);assert.equal(r.tokens.calls,4);
    const lane=s.steps.execute.branches.T002.branch;
    sh(dir,'git',['checkout',lane]);sh(dir,'git',['merge','-s','ours','--no-ff','-m','resolve lane ancestry',s.branch]);sh(dir,'git',['checkout','main']);
    orch(dir,['answer','Resolved the lane branch.']);waitFor(()=>state(dir).status==='completed','user conflict resolution');assert.equal(report(dir).tokens.calls,4);
  },
  'step 3: all exhausted agents wait without calls and refresh into a higher tier'() {
    const dir=project();writeFileSync(join(dir,'.orchestra/quota.json'),JSON.stringify({providers:{mock:{limitReached:'limit',observedAt:new Date().toISOString(),windows:[]}}}));
    orch(dir,['run','solo','wait for quota','--detach'],{ORCHESTRA_QUOTA_POLL_MS:'100'});waitFor(()=>state(dir).status==='awaiting_quota','all exhausted');assert.equal(report(dir).tokens.calls,0);
    assert.match(orchRaw(dir,['check']).out,/requested tier or higher/);
    writeFileSync(join(dir,'.orchestra/quota.json'),JSON.stringify({providers:{}}));waitFor(()=>state(dir).status==='completed','quota recovered');assert.equal(report(dir).tokens.calls,2);
  },
  'step 5: direct read tasks return information; missing adapters hand over without planning'() {
    const read=project();reader(read);orch(read,['run','reader','explain the project','--foreground']);const r=report(read);assert.equal(r.tokens.calls,1);assert.equal(r.steps.task.status,'completed');assert.equal(r.finalCommit,r.baseCommit);
    const dir=project({agents:{missing:{cli:'absent',tier:2,weight:100000},good:{cli:'mock',model:'good',tier:2,weight:0.00001}}});
    orch(dir,['run','solo','one job','--foreground']);const out=report(dir);assert.equal(out.tokens.calls,2);assert.equal(out.calls[0].status,'startup-failed');assert.equal(out.calls[1].entry,'good');assert.match(state(dir).unavailable.missing.what,/not found/);
  },
  'source ships only three adapters, no relays; old config and malformed queue fail clearly'() {
    assert.equal(existsSync(join(REPO,'orchestra/relays')),false);assert.deepEqual(readdirSync(join(REPO,'orchestra/adapters')).filter((f)=>f.endsWith('.json')).sort(),['agy.json','claude.json','codex.json']);
    const dir=project();writeFileSync(join(dir,'.orchestra/queue.json'),'{ broken');assert.match(orchRaw(dir,['queue','add','solo','x']).err,/corrupt/);
    const cfgFile=join(dir,'.orchestra/config.json'),cfg=JSON.parse(readFileSync(cfgFile));cfg.roles={};writeFileSync(cfgFile,JSON.stringify(cfg));assert.match(orchRaw(dir,['run','solo','x','--foreground']).err,/unknown config option: roles/);
  }
};
Object.assign(tests, {
  'step 6: authoring validates, installs and simulates without executing gates or adapters'() {
    const dir=project();workflow(dir,'safe',[{id:'read',agent:{prompt:'read.md',tier:1}},{id:'ask',ask:{questions:['Choose?']}},{id:'gate',gate:{command:'exit 99'}},{id:'loop',loop:{max:2,until:{step:'read',field:'stop',equals:true},steps:[{id:'read',agent:{prompt:'read.md'}}]}}]);
    const file=join(dir,'.orchestra/workflows/safe/workflow.json');
    orch(dir,['workflow','diagram',file]);assert.match(orch(dir,['workflow','check',file]),/valid/);
    const nested=join(dir,'nested');mkdirSync(nested);assert.match(sh(nested,process.execPath,[join(dir,'.orchestra/engine/bin/orchestra.mjs'),'workflow','run','safe','--dry']),/mock exit 0/);
    const dry=orch(dir,['workflow','run','safe','--dry']);assert.match(dry,/loop\/1\/read/);assert.match(dry,/mock exit 0/);assert.equal(existsSync(join(dir,'.orchestra/queue.json')),false);
    const pack=join(dir,'packs');mkdirSync(pack);cpSync(join(dir,'.orchestra/workflows/safe'),join(pack,'copy'),{recursive:true});
    assert.match(orch(dir,['workflow','add',pack]),/copy/);assert.equal(orchRaw(dir,['workflow','add',pack]).code,1);
    for(const mutation of [w=>w.code='process.exit()',w=>w.steps[0].agent.script='bad',w=>delete w.budget,w=>w.steps[3].loop.max=0,w=>w.steps[0].agent.prompt='absent.md']) {
      const w=JSON.parse(readFileSync(file));mutation(w);writeFileSync(join(dir,'invalid.json'),JSON.stringify(w));assert.equal(orchRaw(dir,['workflow','check',join(dir,'invalid.json')]).code,1);
    }
  },
});
Object.assign(tests, {
  'routing: a choices step picks one path; the engine follows only listed values'() {
    const steps=[{id:'decide',agent:{prompt:'read.md',tier:1,choices:{field:'action',values:['fix','rewrite']}}},
      {id:'fix',when:{step:'decide',field:'action',equals:'fix'},agent:{prompt:'read.md',tier:1}},
      {id:'rewrite',when:{step:'decide',field:'action',equals:'rewrite'},agent:{prompt:'read.md',tier:1}},
      {id:'after',agent:{prompt:'read.md',tier:1}}];
    const brief=(dir,call)=>readFileSync(join(dir,'.orchestra/runs',state(dir).id,call.log,'brief.md'),'utf8');
    const dir=project();workflow(dir,'route',steps,16,{},3);
    orch(dir,['run','route','choose a path','--foreground'],{MOCK_CHOICE:'action=rewrite'});const r=report(dir);
    assert.equal(r.status,'completed',state(dir).error);assert.deepEqual(r.calls.map(c=>c.step),['decide','rewrite','after']);
    assert.equal(r.steps.decide.output.action,'rewrite');assert.equal(r.steps.fix,undefined);
    assert.ok(brief(dir,r.calls[0]).includes('"action" field is exactly one of: "fix", "rewrite"'));
    const retry=project();workflow(retry,'route',steps,16,{},3);
    orch(retry,['run','route','choose a path','--foreground'],{MOCK_CHOICE:'action=fix',MOCK_CHOICE_FIRST:'maybe'});const rr=report(retry);
    assert.equal(rr.status,'completed',state(retry).error);assert.deepEqual(rr.calls.map(c=>c.step),['decide','decide','fix','after']);
    assert.match(brief(retry,rr.calls[1]),/must be one of fix, rewrite/);
    const bad=project();workflow(bad,'route',steps,16,{},3);
    assert.equal(orchRaw(bad,['run','route','choose a path','--foreground'],{MOCK_CHOICE:'action=maybe'}).code,1);
    const br=report(bad);assert.equal(br.status,'failed');assert.ok(br.calls.every(c=>c.step==='decide'));
  },
  'routing: routes inside loops use each iteration\'s choice; dry runs follow the first value'() {
    const dir=project(),steps=[{id:'repeat',loop:{max:2,until:{step:'check',field:'stop',equals:true},steps:[
      {id:'decide',agent:{prompt:'read.md',tier:1,choices:{field:'action',values:['fix','rewrite']}}},
      {id:'fix',when:{step:'decide',field:'action',equals:'fix'},agent:{prompt:'read.md',tier:1}},
      {id:'rewrite',when:{step:'decide',field:'action',equals:'rewrite'},agent:{prompt:'read.md',tier:1}},
      {id:'check',agent:{prompt:'read.md',tier:1}}]}}];
    workflow(dir,'looped',steps,16,{},3);
    orch(dir,['run','looped','route in a loop','--foreground'],{MOCK_CHOICE:'action=fix'});const r=report(dir);
    assert.equal(r.status,'completed',state(dir).error);assert.equal(r.steps.repeat.iteration,1);
    assert.deepEqual(r.calls.map(c=>c.step),['repeat/0/decide','repeat/0/fix','repeat/0/check']);
    const changing=project(),again=[{id:'repeat',loop:{max:3,until:{step:'check',field:'stop',equals:true},steps:[
      ...steps[0].loop.steps.slice(0,3),{id:'check',agent:{prompt:'read.md',tier:1,sees:['fix']}}]}}];
    workflow(changing,'looped',again,16,{},3);
    orch(changing,['run','looped','route twice','--foreground'],{MOCK_CHOICE:'action=fix,rewrite',MOCK_STOP_CYCLE:'2'});const c=report(changing);
    assert.equal(c.status,'completed',state(changing).error);assert.equal(c.steps.repeat.iteration,2);
    assert.deepEqual(c.calls.map(x=>x.step),['repeat/0/decide','repeat/0/fix','repeat/0/check','repeat/1/decide','repeat/1/rewrite','repeat/1/check']);
    const inputs=(step)=>readFileSync(join(changing,'.orchestra/runs',state(changing).id,c.calls.find(x=>x.step===step).log,'brief.md'),'utf8').split('Inputs: ')[1].split('\n')[0];
    assert.match(inputs('repeat/0/check'),/"fix"/);assert.equal(inputs('repeat/1/check'),'{}','a step passed over has no output');
    const dry=orch(dir,['workflow','run','looped','--dry']);
    assert.match(dry,/repeat\/0\/decide: mock choice action = "fix" \(first listed\)/);assert.match(dry,/repeat\/0\/rewrite: agent \(skipped: runs when decide.action = "rewrite"\)/);
  },
  'routing: validation rejects routes the graph cannot follow'() {
    const dir=project(),ask={id:'ask',ask:{questions:['Choose?']}};
    const decide={id:'decide',agent:{prompt:'read.md',choices:{field:'action',values:['fix','rewrite']}}};
    const when=(equals='fix',step='decide')=>({step,field:'action',equals});
    const check=(w)=>{const f=workflow(dir,'candidate',w.steps,4,{},w.workflow);return orchRaw(dir,['workflow','check',join(f,'workflow.json')]);};
    const cases=[
      [{workflow:2,steps:[{id:'plain',agent:{prompt:'read.md'}},{...ask,when:when('fix','plain')}]},/invalid step ask/],
      [{workflow:3,steps:[{...ask,when:when()},decide]},/earlier step's choices/],
      [{workflow:3,steps:[decide,{...ask,when:when('other')}]},/earlier step's choices/],
      [{workflow:3,steps:[{id:'plain',agent:{prompt:'read.md'}},{...ask,when:when('fix','plain')}]},/earlier step's choices/],
      [{workflow:3,steps:[{id:'views',parallel:{prompt:'read.md',choices:decide.agent.choices}}]},/choices need workflow v3 and an agent step/],
      [{workflow:3,steps:[{id:'one',agent:{prompt:'read.md',choices:{field:'action',values:['only']}}}]},/two or more distinct/],
      [{workflow:3,steps:[{id:'work',lanes:{tier:1}}]},/names the lanes block tasks/],
      [{workflow:3,steps:[{id:'__start__',ask:ask.ask}]},/unique id/],
      [{workflow:3,steps:[{id:'repeat',loop:{max:1,until:{step:'decide',field:'action',equals:'fix'},steps:[decide]}},{...ask,when:when()}]},/earlier step's choices/]];
    for(const [w,error] of cases){const result=check(w);assert.equal(result.code,1,JSON.stringify(w));assert.match(result.err,error);}
    const f=workflow(dir,'nested',[decide,{id:'repeat',loop:{max:1,until:{step:'ask',field:'x',equals:true},steps:[{...ask,when:when()}]}}],4,{},3);
    orch(dir,['workflow','diagram','nested']);assert.match(orch(dir,['workflow','check',join(f,'workflow.json')]),/valid/);
    assert.match(readFileSync(join(f,'workflow.drawio'),'utf8'),/only when decide.action = &quot;fix&quot;/);
  },
  'graph: runs need a workflow; branches are readable; tracing stays local; installs carry LangGraph'() {
    const dir=project();assert.ok(existsSync(join(dir,'.orchestra/engine/node_modules/@langchain/langgraph/package.json')));
    const bare=orchRaw(dir,['run','do something useful']);assert.equal(bare.code,1);assert.match(bare.err,/usage: orchestra run <workflow> "<task>"/);
    assert.equal(existsSync(join(dir,'.orchestra/queue.json')),false);
    assert.equal(orchRaw(dir,['queue','add','do something']).code,1);
    codeWorkflow(dir);taskFile(dir,'## Phase 1: Work\n- [ ] T001 [P] [X] Write the first file\n- [ ] T002 [P] Write two\n');
    orch(dir,['run','code','--task-file','tasks.md','--foreground']);const s=state(dir);
    assert.equal(s.status,'completed',s.error);assert.match(s.id,/^\d{8}-\d{6}-[a-z0-9]{1,4}$/);assert.equal(s.branch,`orchestra/${s.id}`);
    assert.equal(s.steps.execute.branches.T001.branch,`${s.branch}.execute.T001-write-the-first-file`);
    assert.equal(s.steps.execute.branches.T002.branch,`${s.branch}.execute.T002-write-two`);
    assert.deepEqual(sh(dir,'git',['branch','--list',`${s.branch}.*`]).trim(),'','work branches are removed after completion');
    const traced=project();
    orch(traced,['run','solo','change files','--gate','test "$LANGCHAIN_TRACING_V2" = true','--foreground'],{LANGCHAIN_TRACING_V2:'true'});
    assert.equal(state(traced).status,'completed',state(traced).error);assert.equal(report(traced).gates[0].exit,0);
  },
  'solo: a run that only checks or answers completes, and its result reaches FINAL.md'() {
    const dir=project();orch(dir,['run','solo','check the readme','--foreground'],{MOCK_NOOP:'all'});
    const s=state(dir),r=report(dir);assert.equal(s.status,'completed',s.error);
    assert.equal(r.finalCommit,r.baseCommit);assert.deepEqual(r.steps.task.changes,[]);assert.equal(r.calls.filter(c=>c.purpose==='diagnosis').length,0);
    const final=readFileSync(join(dir,'.orchestra/runs',s.id,'FINAL.md'),'utf8');
    assert.match(final,/^Execution completed\./);assert.match(final,/Result of step task:\nresponse from medium/);
  },
  'new-workflow: interviews until understood, then drafts, draws and saves only on exact approval'() {
    const packFile=(dir,name)=>{const f=join(dir,`${name}.json`);writeFileSync(f,JSON.stringify({name,files:{
      'workflow.json':JSON.stringify({workflow:3,description:'Reviews a change. Give it: orchestra run x "y". Returns feedback.',budget:{calls:4},steps:[
        {id:'triage',agent:{prompt:'triage.md',tier:1,choices:{field:'kind',values:['small','large']}}},
        {id:'review',when:{step:'triage',field:'kind',equals:'large'},parallel:{prompt:'triage.md',count:2}}]}),
      'triage.md':'ORCHESTRA ROLE: triage\nCYCLE: 1\nClassify the change.'}}));return f;};
    const runDir=(dir)=>join(dir,'.orchestra/runs',state(dir).id);
    const dir=project();
    orch(dir,['run','new-workflow','review each change','--detach'],{MOCK_PACK_FILE:packFile(dir,'approved'),MOCK_CHOICE:'understood=yes;next=finish'});
    waitFor(()=>state(dir).questions?.origin==='build/0/approve','approval question');
    assert.deepEqual(report(dir).calls.map(c=>c.purpose ?? c.step),['understand/0/interview','understand/0/gaps/0','understand/0/gaps/1','synthesis','understand/0/confirm','build/0/draft']);
    const outline=readFileSync(join(runDir(dir),'workflows/outline.txt'),'utf8');
    assert.match(outline,/1\. triage · agent — tier: 1 · access: read; chooses kind: small \| large/);assert.match(outline,/only when triage.kind = "large"/);
    assert.ok(existsSync(join(runDir(dir),'workflows/workflow.drawio')));assert.equal(existsSync(join(dir,'.orchestra/workflows/approved')),false);
    orch(dir,['answer','approve project']);waitFor(()=>state(dir).status==='completed','saved');
    assert.ok(existsSync(join(dir,'.orchestra/workflows/approved/workflow.drawio')));assert.match(orch(dir,['workflow','check',join(dir,'.orchestra/workflows/approved/workflow.json')]),/valid/);
    assert.equal(report(dir).tokens.calls,7);
    const declined=project();
    orch(declined,['run','new-workflow','review each change','--detach'],{MOCK_PACK_FILE:packFile(declined,'declined'),MOCK_CHOICE:'understood=yes;next=finish'});
    waitFor(()=>state(declined).questions?.origin==='build/0/approve','declined approval');orch(declined,['answer','decline']);
    waitFor(()=>state(declined).status==='completed','declined');assert.equal(existsSync(join(declined,'.orchestra/workflows/declined')),false);
    const revised=project();
    orch(revised,['run','new-workflow','review each change','--detach'],{MOCK_PACK_FILE:packFile(revised,'revised'),MOCK_CHOICE:'understood=yes;next=revise,finish'});
    waitFor(()=>state(revised).questions?.origin==='build/0/approve','first draft');orch(revised,['answer','Add a gate that runs the tests.']);
    waitFor(()=>state(revised).questions?.origin==='build/1/approve','second draft');
    assert.match(readFileSync(join(runDir(revised),report(revised).calls.find(c=>c.step==='build/1/draft').log,'brief.md'),'utf8'),/Add a gate that runs the tests/);
    orch(revised,['answer','approve user']);waitFor(()=>state(revised).status==='completed','saved for the user');
    assert.ok(existsSync(join(process.env.HOME,'.config/orchestra/workflows/revised/workflow.json')));assert.equal(report(revised).tokens.calls,9);
  },
  'init: creates the repository and a first commit with only .gitignore; worktrees live in .orchestra'() {
    const fresh=mkdtempSync(join(tmpdir(),'orchestra-e2e-'));tmpRoots.push(fresh);writeFileSync(join(fresh,'notes.md'),'mine\n');
    const config=join(fresh,'..',`${basename(fresh)}.gitconfig`);tmpRoots.push(config);writeFileSync(config,'[user]\n\tname = Test\n\temail = test@example.com\n');
    const id={GIT_CONFIG_GLOBAL:config};
    assert.match(sh(fresh,process.execPath,[SOURCE_BIN,'init'],id),/Created a Git repository[\s\S]*Made a first commit/);
    assert.equal(sh(fresh,'git',['log','--format=%s'],id).trim(),"chore: Ignore Orchestra's local files");
    assert.equal(sh(fresh,'git',['ls-files']).trim(),'.gitignore');assert.match(readFileSync(join(fresh,'.gitignore'),'utf8'),/^\/\.orchestra\/$/m);
    assert.match(sh(fresh,'git',['status','--porcelain']),/notes\.md/,'the user\'s own files stay uncommitted');
    const dir=project();orch(dir,['run','solo','slow job','--detach'],{MOCK_DELAY:'1500'});
    const run=waitFor(()=>{const s=state(dir);return s.status==='running' && existsSync(join(dir,'.orchestra/worktrees',s.id,'run')) && s.id;},'worktree in .orchestra');
    assert.equal(sh(dir,'git',['status','--porcelain']).trim(),'','worktrees are ignored');
    waitFor(()=>state(dir).status==='completed','completion');
    assert.equal(existsSync(join(dir,'.orchestra/worktrees',run)),false);assert.equal(existsSync(join(dir,'.git/orchestra-worktrees')),false);
    assert.match(orch(dir,['workflow','diagram','new-workflow','--text']),/^Workflow · budget: 40 calls\n1\. understand · loop/);
  },
  'parallel: anonymized peers see labels instead of agent names'() {
    const dir=project({agents:{a:{cli:'mock',model:'first',tier:3},b:{cli:'second',model:'second',tier:3}}});
    cpSync(join(dir,'.orchestra/adapters/mock.json'),join(dir,'.orchestra/adapters/second.json'));
    workflow(dir,'peers',[{id:'views',parallel:{prompt:'read.md',tier:3,count:2,distinct:'vendor'}},
      {id:'critique',parallel:{prompt:'read.md',tier:3,count:2,distinct:'vendor',sees:['views'],anonymize:true}}]);
    orch(dir,['run','peers','compare','--foreground']);const r=report(dir),runDir=join(dir,'.orchestra/runs',state(dir).id);
    assert.equal(r.status,'completed',state(dir).error);
    const critics=r.calls.filter(c=>c.step.startsWith('critique/') && !c.purpose);assert.equal(critics.length,2);
    for(const c of critics) {
      const inputs=readFileSync(join(runDir,c.log,'brief.md'),'utf8').split('Inputs: ')[1].split('Questions already answered:')[0];
      assert.doesNotMatch(inputs,/response from (first|second)/);assert.match(inputs,/Peer 1/);assert.doesNotMatch(inputs,/Peer 2/);
    }
  }
});
Object.assign(tests, {
  'machine knowledge: confirmed notes cross projects, list every CLI, approve and remove by ID'() {
    const one=project(),two=project();reader(one);const user=mkdtempSync(join(tmpdir(),'orchestra-user-'));tmpRoots.push(user);const env={HOME:user};
    const load=(cli)=>JSON.parse(orch(two,['knowledge','--json',...(cli?['--cli',cli]:[])],env)).items;
    orch(one,['knowledge','add','Use a supported flag','--cli','mock'],env);orch(one,['knowledge','add','use  a supported flag','--cli','mock'],env);
    orch(one,['knowledge','add','Different CLI advice','--cli','other'],env);
    assert.equal(load().length,3);assert.equal(load('mock').length,2);assert.equal(load('missing').length,0);
    orch(two,['knowledge','approve','K2'],env);const items=load('mock');assert.equal(items.length,1);assert.equal(items[0].trusted,true);assert.deepEqual(items[0].merged,['K1']);
    assert.notEqual(orchRaw(one,['knowledge','add','Run npm test'],env).code,0);
    orch(one,['knowledge','rm','K3'],env);assert.equal(load().length,1);
    orch(one,['run','reader','Explain','--foreground'],{...env,MOCK_SUGGESTION:'1'});const r=report(one);assert.equal(r.suggestions.length,1);
    const brief=readFileSync(join(one,'.orchestra/runs',state(one).id,r.calls[0].log,'brief.md'),'utf8');assert.match(brief,/\[confirmed\] use  a supported flag/);assert.doesNotMatch(brief,/Different CLI advice/);
    for(const dir of [one,two])for(const file of ['knowledge.json','KNOWLEDGE.md'])assert.equal(existsSync(join(dir,'.orchestra',file)),false);
    const pack=join(one,'pack');mkdirSync(pack);workflow(one,'small',[{id:'read',agent:{prompt:'read.md'}}]);cpSync(join(one,'.orchestra/workflows/small'),join(pack,'small'),{recursive:true});
    orch(one,['workflow','add',pack,'--user'],env);assert.ok(existsSync(join(user,'.config/orchestra/workflows/small/workflow.json')));
  },
  'machine knowledge: startup failures record once and reach the next brief for that CLI'() {
    const user=mkdtempSync(join(tmpdir(),'orchestra-startup-home-'));tmpRoots.push(user);const env={HOME:user,MOCK_STARTUP:'broken'};
    const dir=project({agents:{bad:{cli:'mock',model:'broken',tier:2,weight:100000},good:{cli:'mock',model:'good',tier:2,weight:0.00001}}});reader(dir);
    for(let n=0;n<2;n++) {
      orch(dir,['run','reader','Explain','--foreground'],env);const r=report(dir);
      assert.equal(r.calls[0].status,'startup-failed');assert.equal(r.calls[1].status,'completed');
      const items=JSON.parse(orch(dir,['knowledge','--json'],env)).items;assert.equal(items.length,1);assert.equal(items[0].trusted,false);assert.equal(items[0].cli,'mock');
      assert.equal(items[0].text,`cannot start. Fix: ${r.unavailable.bad.fix}`);
      const brief=readFileSync(join(dir,'.orchestra/runs',state(dir).id,r.calls[1].log,'brief.md'),'utf8');assert.ok(brief.includes(`[observed] ${items[0].text}`));
    }
    assert.equal(existsSync(join(dir,'.orchestra/knowledge.json')),false);
  },
  'machine knowledge: scoped lessons, normalized deduplication and bounded newest observations'() {
    const user=mkdtempSync(join(tmpdir(),'orchestra-lessons-home-'));tmpRoots.push(user);const env={HOME:user};
    const dir=project(),load=()=>JSON.parse(orch(dir,['knowledge','--json'],env)).items;reader(dir);
    orch(dir,['knowledge','add','Keep this confirmed note','--cli','mock'],env);
    const lessons=[...Array.from({length:12},(_,n)=>({scope:'cli',text:`Machine lesson ${n+1}`})),{scope:'project',text:'Run the project check'},{scope:'code',text:'Keep functions small'}];
    orch(dir,['run','reader','Explain','--foreground'],{...env,MOCK_LESSONS:JSON.stringify(lessons)});
    assert.equal(load().length,13);assert.ok(load().slice(1).every(i=>!i.trusted));
    assert.deepEqual(report(dir).suggestions,lessons.slice(-2));
    orch(dir,['run','reader','Explain','--foreground'],{...env,MOCK_LESSONS:JSON.stringify([{scope:'cli',text:'  MACHINE   lesson 1  '},{scope:'cli',text:' keep THIS confirmed NOTE '}])});
    assert.equal(load().length,13);
    const brief=()=>{const r=report(dir);return readFileSync(join(dir,'.orchestra/runs',state(dir).id,r.calls[0].log,'brief.md'),'utf8');};
    assert.match(brief(),/\[confirmed\] Keep this confirmed note/);
    assert.equal((brief().match(/\[observed\]/g) ?? []).length,10);assert.doesNotMatch(brief(),/Machine lesson [12]\n/);assert.match(brief(),/Machine lesson 3\n/);assert.match(brief(),/Machine lesson 12/);
    const config=join(dir,'.orchestra/config.json'),cfg=JSON.parse(readFileSync(config));cfg.knowledgeObservedLimit=2;writeFileSync(config,JSON.stringify(cfg));
    orch(dir,['run','reader','Explain','--foreground'],env);assert.equal((brief().match(/\[observed\]/g) ?? []).length,2);assert.match(brief(),/Machine lesson 11/);
    cfg.knowledgeObservedLimit=0;writeFileSync(config,JSON.stringify(cfg));orch(dir,['run','reader','Explain','--foreground'],env);assert.doesNotMatch(brief(),/\[observed\]/);assert.match(brief(),/\[confirmed\]/);
    orch(dir,['knowledge','approve','K2'],env);assert.equal(load().filter(i=>i.trusted).length,2);
    const failed=project({executorRetries:0});reader(failed);
    const failedLessons=[{scope:'cli',text:'Failure diagnostic lesson'},{scope:'project',text:'Failure build command'},{scope:'code',text:'Failure code rule'}];
    assert.notEqual(orchRaw(failed,['run','reader','Explain','--foreground'],{...env,MOCK_FAIL:'all',MOCK_LESSONS:JSON.stringify(failedLessons)}).code,0);
    assert.deepEqual(report(failed).suggestions,failedLessons.slice(1));assert.equal(load().at(-1).text,failedLessons[0].text);
    for(const file of ['knowledge.json','KNOWLEDGE.md'])assert.equal(existsSync(join(dir,'.orchestra',file)),false);
  }
});
Object.assign(tests, {
  'workflows: v2 and v3 require a description while v1 packs and the lanes name still load'() {
    const dir=project(),steps=[{id:'ask',ask:{questions:['Choose?']}}];
    const write=(name,w)=>{const f=join(dir,'.orchestra/workflows',name);mkdirSync(f,{recursive:true});writeFileSync(join(f,'workflow.json'),JSON.stringify(w));orch(dir,['workflow','diagram',name]);return join(f,'workflow.json');};
    assert.match(orch(dir,['workflow','check',write('old',{workflow:1,budget:{calls:1},steps})]),/valid/);
    assert.match(orch(dir,['workflow','check',write('new',{workflow:2,description:'Asks. Give a topic. Returns a choice.',budget:{calls:1},steps})]),/valid/);
    for(const [name,w] of [['blank',{workflow:2,description:' ',budget:{calls:1},steps}],['none',{workflow:2,budget:{calls:1},steps}]]) {
      const file=join(dir,name+'.json');writeFileSync(file,JSON.stringify(w));
      const result=orchRaw(dir,['workflow','check',file]);assert.equal(result.code,1);assert.match(result.err,/requires a description/);
    }
    const v1=join(dir,'v1-described.json');writeFileSync(v1,JSON.stringify({workflow:1,description:'x',budget:{calls:1},steps}));
    assert.match(orchRaw(dir,['workflow','check',v1]).err,/unknown workflow field/);
    assert.match(orch(dir,['workflow','check',write('routed',{workflow:3,description:'Asks. Give a topic. Returns a choice.',budget:{calls:1},steps})]),/valid/);
    assert.match(orch(dir,['workflow','check',write('legacy',{workflow:1,budget:{calls:1},steps:[{id:'work',lanes:{tier:1}}]})]),/valid/);
    const none=join(dir,'v3-none.json');writeFileSync(none,JSON.stringify({workflow:3,budget:{calls:1},steps}));assert.match(orchRaw(dir,['workflow','check',none]).err,/v3 requires a description/);
    const v4=join(dir,'v4.json');writeFileSync(v4,JSON.stringify({workflow:4,description:'x',budget:{calls:1},steps}));
    assert.equal(orchRaw(dir,['workflow','check',v4]).code,1);
  },
  'workflows: list shows each name once in search order with its source and description'() {
    const dir=project(),steps=[{id:'ask',ask:{questions:['Choose?']}}];
    const write=(name,w)=>{const f=join(dir,'.orchestra/workflows',name);mkdirSync(f,{recursive:true});writeFileSync(join(f,'workflow.json'),typeof w==='string'?w:JSON.stringify(w));};
    write('old',{workflow:1,budget:{calls:1},steps});write('broken','{');
    const builtin=readdirSync(join(REPO,'workflows')).filter(n=>existsSync(join(REPO,'workflows',n,'workflow.json')));
    const shipped=JSON.parse(orch(dir,['workflow','list','--json'])).filter(p=>p.source==='built-in');
    assert.deepEqual(shipped.map(p=>p.name),builtin);
    for(const p of shipped){assert.ok(p.description.trim(),p.name);assert.equal(p.version,3);assert.ok(existsSync(p.guide),p.name);}
    write(builtin[0],{workflow:2,description:'Project override.',budget:{calls:1},steps});
    const list=JSON.parse(orch(dir,['workflow','list','--json'])),by=Object.fromEntries(list.map(p=>[p.name,p]));
    assert.equal(list.length,new Set(list.map(p=>p.name)).size);
    assert.equal(by[builtin[0]].source,'project');assert.equal(by[builtin[0]].description,'Project override.');
    assert.equal(by.old.description,null);assert.equal(by.old.guide,null);assert.equal(by.old.version,1);assert.ok(by.broken.error);
    const text=orch(dir,['workflow','list']);assert.match(text,/no description \(workflow v1\)/);assert.match(text,/invalid: /);assert.match(text,/Project override\./);
    assert.equal(orchRaw(dir,['workflow','list','extra']).code,1);
  },
});
Object.assign(tests, {
  'constitution: public core stays independent of CLIs and workflows'() {
    const walk=(dir)=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]);
    const clis=[...new Set([...readdirSync(join(REPO,'orchestra/adapters')).map(n=>n.replace(/\.[^.]+$/,'')),
      'antigravity','gemini','aider','cline','copilot','cursor','grok','kimi','opencode','qoder','warp','vibe','zcode','commandcode','muse','omp'])];
    const names=readdirSync(join(REPO,'workflows')).filter(n=>n!=='_shared');
    // "code" is also an exit-code property and the public lesson scope; those uses are not workflow names.
    const plain=(text)=>text.replace(/\['project','code'\]/g,"[]").replace(/`project` and `code` lessons/g,'');
    // Docs may name the shipped adapters, but everything about one workflow lives in its pack.
    const namesWorkflow=(text)=>names.filter(n=>n!=='code').some(n=>new RegExp(`\\b${n}\\b`,'i').test(plain(text))) ||
      /["'`]code["'`]|\bcode\s+workflow\b|\bworkflow\s+code\b/i.test(plain(text));
    const forbidden=(text)=>clis.some(n=>new RegExp(`\\b${n}\\b`,'i').test(plain(text))) || namesWorkflow(text);
    for(const path of [...walk(join(REPO,'orchestra/lib')),...walk(join(REPO,'orchestra/bin'))])assert.equal(forbidden(readFileSync(path,'utf8')),false,path);
    assert.equal(forbidden(readFileSync(join(REPO,'CONSTITUTION.md'),'utf8')),false);
    for(const doc of ['skills/orchestra/SKILL.md','README.md','docs/workflows.md'])assert.equal(namesWorkflow(readFileSync(join(REPO,doc),'utf8')),false,`${doc} names no workflow`);
    for(const name of [...clis,...names])assert.equal(forbidden(`const workflow = '${name}';`),true,name);
  },
  'promise 1: ad-hoc lanes plan and batch phase briefs without built-ins'() {
    const dir=project();rmSync(join(dir,'.orchestra/engine/workflows'),{recursive:true});
    workflow(dir,'minimal',[{id:'work',lanes:{tier:1}}]);
    const log=join(dir,'.orchestra/call-log.jsonl');
    orch(dir,['run','minimal','make changes','--foreground'],{MOCK_CALL_LOG:log});const r=report(dir);
    const logged=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.ok(logged.filter(c=>['plan','brief'].includes(c.role)).every(c=>c.readOnly));
    assert.deepEqual(r.calls.map(c=>c.purpose ?? c.entry),['plan','brief','small','small']);
    assert.ok(r.calls.filter(c=>c.purpose).every(c=>c.entry==='strong'));
    for(const id of ['T001','T002']) {
      const c=r.calls.find(c=>c.step===`work/${id}`), text=readFileSync(join(dir,'.orchestra/runs',state(dir).id,c.log,'brief.md'),'utf8');
      assert.match(text,/Prepared brief/);assert.ok(text.includes(id));
    }
    assert.equal(r.steps.work.phases.length,1);assert.equal(r.tasks.filter(t=>t.status==='executed').length,2);
  },
  'promise 1: ad-hoc cheap writes receive briefs; top-tier writes need none'() {
    for(const tier of [1,3]) {
      const dir=project();rmSync(join(dir,'.orchestra/engine/workflows'),{recursive:true});
      workflow(dir,'minimal',[{id:'write',agent:{prompt:'write.md',tier,access:'write'}}]);
      orch(dir,['run','minimal','change files','--foreground']);const r=report(dir);
      assert.deepEqual(r.calls.map(c=>c.purpose ?? c.entry),tier===1?['brief','small']:['strong']);
      const c=r.calls.at(-1), text=readFileSync(join(dir,'.orchestra/runs',state(dir).id,c.log,'brief.md'),'utf8');
      if(tier===1)assert.match(text,/Prepared brief/);
    }
  },
  'promise 1: write errors and timeouts diagnose before same-tier retry'() {
    for(const env of [{MOCK_FAIL:'first'},{MOCK_TIMEOUT_FIRST:'1'}]) {
      const dir=project({agentTimeout:'1s',escalate:{afterFailures:1}});
      workflow(dir,'minimal',[{id:'write',agent:{prompt:'write.md',tier:1,access:'write'}}]);
      orch(dir,['run','minimal','change files','--foreground'],env);const r=report(dir);
      assert.deepEqual(r.calls.map(c=>c.purpose ?? c.entry),['brief','small','diagnosis','small']);
      const diagnosis=r.calls[2],worker=r.calls[3],runDir=join(dir,'.orchestra/runs',state(dir).id);
      assert.match(readFileSync(join(runDir,diagnosis.log,'brief.md'),'utf8'),/Previous attempt failed/);
      assert.match(readFileSync(join(runDir,worker.log,'brief.md'),'utf8'),/Revised brief/);
      assert.equal(r.steps.write.failures,1);
    }
  },
  'promise 1: attributable gates diagnose direct writes and lane tasks before repair'() {
    for(const lanes of [false,true,'parallel']) {
      const dir=project({gates:['test -f repaired.txt']});
      if(lanes===true)taskFile(dir,'## Phase 1: Work\n- [ ] T001 Repair the file\n');
      workflow(dir,'minimal',lanes===true?[{id:'work',lanes:{taskFile:'tasks.md',tier:1}}]:lanes==='parallel'?[{id:'views',parallel:{prompt:'write.md',tier:1,access:'write',count:1}}]:[{id:'write',agent:{prompt:'write.md',tier:1,access:'write'}}]);
      orch(dir,['run','minimal','change files','--foreground'],{MOCK_GATE_REPAIR:'1'});const r=report(dir);
      assert.deepEqual(r.calls.map(c=>c.purpose ?? c.entry),lanes==='parallel'?['brief','small','synthesis','diagnosis','small']:['brief','small','diagnosis','small']);
      assert.deepEqual(r.gates.map(g=>g.exit),[1,0]);
      const c=r.calls.find(c=>c.purpose==='diagnosis');assert.match(readFileSync(join(dir,'.orchestra/runs',state(dir).id,c.log,'brief.md'),'utf8'),/test -f repaired.txt/);
      if(lanes===true) {assert.equal(r.tasks[0].status,'executed');assert.equal(r.tasks[0].attempts,2);}
    }
  },
  'promise 1: ad-hoc parallel retains items and engine synthesis'() {
    const dir=project();rmSync(join(dir,'.orchestra/engine/workflows'),{recursive:true});
    workflow(dir,'minimal',[{id:'views',parallel:{prompt:'read.md',tier:1,count:2}}]);
    orch(dir,['run','minimal','compare views','--foreground']);const r=report(dir);
    assert.deepEqual(r.calls.map(c=>c.purpose ?? c.entry),['small','small','synthesis']);
    assert.equal(r.steps.views.output.items.length,2);assert.match(r.steps.views.output.synthesis.text,/Agreement and disagreement/);
    assert.equal(r.calls.at(-1).entry,'strong');
    assert.equal(r.baseCommit,r.finalCommit);
  },
  'promise 1: interrupted diagnosis resumes before the same-tier worker'() {
    const dir=project();workflow(dir,'minimal',[{id:'write',agent:{prompt:'write.md',tier:1,access:'write'}}]);
    orch(dir,['run','minimal','change files','--detach'],{MOCK_FAIL:'first',MOCK_CRASH_ROLE:'diagnosis'});
    waitFor(()=>state(dir).status==='crashed','diagnosis crash');
    assert.deepEqual(report(dir).calls.map(c=>c.purpose ?? c.entry),['brief','small','diagnosis']);
    orch(dir,['resume']);waitFor(()=>state(dir).status==='completed','diagnosis resume');
    const r=report(dir);assert.deepEqual(r.calls.map(c=>c.purpose ?? c.entry),['brief','small','diagnosis','diagnosis','small']);
    assert.equal(r.calls[2].status,'interrupted');assert.equal(r.steps.write.failures,1);
  },
  'promise 1: strong calls obey budgets and wait for top-tier quota without falling down'() {
    const budget=project();workflow(budget,'minimal',[{id:'write',agent:{prompt:'write.md',tier:1,access:'write'}}],1);
    assert.equal(orchRaw(budget,['run','minimal','change files','--foreground']).code,1);
    assert.deepEqual(report(budget).calls.map(c=>c.purpose),['brief']);
    const dir=project(),cfgPath=join(dir,'.orchestra/config.json'),cfg=JSON.parse(readFileSync(cfgPath));
    cfg.agents.strong.quotaFrom='top';writeFileSync(cfgPath,JSON.stringify(cfg));
    writeFileSync(join(dir,'.orchestra/quota.json'),JSON.stringify({providers:{top:{limitReached:'limit',observedAt:new Date().toISOString(),windows:[]}}}));
    orch(dir,['run','solo','change files','--detach'],{ORCHESTRA_QUOTA_POLL_MS:'100'});
    waitFor(()=>state(dir).status==='awaiting_quota','strong quota wait');assert.equal(report(dir).tokens.calls,0);
    writeFileSync(join(dir,'.orchestra/quota.json'),JSON.stringify({providers:{}}));
    waitFor(()=>state(dir).status==='completed','strong quota recovery');
    assert.deepEqual(report(dir).calls.map(c=>c.purpose ?? c.entry),['brief','medium']);
  }
});
const only=process.argv[2];let failed=0;
for(const [name,fn]of Object.entries(tests).filter(([n])=>!only || n.includes(only))) {
  try {await fn();console.log(`✓ ${name}`);}catch(e){failed++;console.log(`✗ ${name}\n${e.stack}`);}
}
for(const dir of tmpRoots) {try {const pid=Number(readFileSync(join(dir,'.orchestra/worker.pid'),'utf8'));if(pid)process.kill(pid,'SIGTERM');}catch{} }
for(const dir of tmpRoots){try{rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch{}}
console.log(failed?`${failed} failed`:'all passed');process.exitCode=failed?1:0;

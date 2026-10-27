import { readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const args=process.argv.slice(2), opt=(s)=>args[args.indexOf(s)+1], env=process.env;
const brief=readFileSync(opt('--brief'),'utf8'), out=opt('--out-dir'), model=args.includes('--model')?opt('--model'):'default';
const title=/SUBTASK:\n(.+)/.exec(brief)?.[1] ?? 'direct';
const role=/ORCHESTRA ROLE: (.*)/.exec(brief)?.[1];
// MOCK_STARTUP_ONCE names a marker file: only the first listed model to be called fails to start.
if((env.MOCK_STARTUP ?? '').split(',').includes(model) && !(env.MOCK_STARTUP_ONCE && existsSync(env.MOCK_STARTUP_ONCE))) {
  if(env.MOCK_STARTUP_ONCE)writeFileSync(env.MOCK_STARTUP_ONCE,model);
  process.stderr.write(env.MOCK_STARTUP_ERROR ?? 'permission denied: headless cannot prompt');
  process.stdout.write(JSON.stringify({status:'failed',finalMessage:'',tokens:null}));process.exit(1);
}
if(env.MOCK_CALL_LOG)appendFileSync(env.MOCK_CALL_LOG,JSON.stringify({model,role,title,brief,readOnly:args.includes('--read'),cwd:process.cwd(),at:Date.now()})+'\n');
if(env.MOCK_DELAY)await new Promise((r)=>setTimeout(r,Number(env.MOCK_DELAY)));
if(env.MOCK_CRASH_ROLE===role)process.kill(process.ppid,'SIGKILL');
if(env.MOCK_CRASH_TITLE && title.startsWith(env.MOCK_CRASH_TITLE))process.kill(process.ppid,'SIGKILL');
let output={text:`response from ${model}`,stop:true};
if(env.MOCK_EVIDENCE && ['mode','propose','critique'].includes(role))output={text:`response from ${model}`,stop:true,evidence:[{file:'README.md',line:1,quote:'# demo'},{file:'README.md',line:1,quote:'wrong quote'}]};
if(role==='adapter-test')output={text:'OK'};
if(role==='adapter-command') {
  // MOCK_SANDBOX_BLOCK stands in for a sandbox that stops the command.
  const run=env.MOCK_SANDBOX_BLOCK?{status:1,stdout:'bind 127.0.0.1: operation not permitted\n'}:spawnSync(/COMMAND:\n(.*)/.exec(brief)[1],{shell:true,encoding:'utf8'});
  output={exit:run.status,output:run.stdout};
}
if(role==='plan')output={taskList:'## Phase 1: Work\n- [ ] T001 [P] Write one\n- [ ] T002 [P] Write two\n'};
if(role==='brief') {
  const tasks=/\n(\[\{"id":.*\])\nRequest:/.exec(brief);
  const make=(task)=>`Prepared brief: change the requested files; implement the steps; done when the relevant check passes.\nSUBTASK:\n${task}`;
  output=tasks?{briefs:Object.fromEntries(JSON.parse(tasks[1]).map((t)=>[t.id,make(t.id+' '+t.text)]))}:{text:make(title)};
  if(tasks && env.MOCK_BRIEF_MISSING && !brief.includes('Previous attempt'))output={lessons:[]};
}
if(role==='diagnosis')output={text:`Revised brief.\nSUBTASK:\n${title}\nPrevious attempt failed; fix npm test and repeat the relevant check.`};
if(role==='synthesis')output={text:'Agreement and disagreement with reasons; options and open questions.',agreement:['shared points'],disagreement:[],options:[],openQuestions:[]};
if(role==='workflow-author' && env.MOCK_PACK_FILE)output={pack:readFileSync(env.MOCK_PACK_FILE,'utf8')};
if(env.MOCK_CHOICE && !['plan','brief','diagnosis','synthesis'].includes(role)) {
  // field=value;other=value, where value may be first,second to choose by loop cycle.
  const cycle=Number(/CYCLE: (\d+)/.exec(brief)?.[1] ?? 1);
  for(const pair of env.MOCK_CHOICE.split(';')) {
    const [field,value]=pair.split('='),values=value.split(',');
    output[field]=env.MOCK_CHOICE_FIRST && !brief.includes('Previous attempt')?env.MOCK_CHOICE_FIRST:values[Math.min(cycle,values.length)-1];
  }
}
if(env.MOCK_STOP_CYCLE)output.stop=Number(/CYCLE: (\d+)/.exec(brief)?.[1] ?? 1)>=Number(env.MOCK_STOP_CYCLE);
if(env.MOCK_LESSONS)output.lessons=JSON.parse(env.MOCK_LESSONS);
if(env.MOCK_SUGGESTION)output.suggestions=[{text:'Consider a code convention',source:'direct'}];
if(!['plan','brief','diagnosis','synthesis'].includes(role) && env.MOCK_QUESTIONS && !brief.includes('"by":"user"'))output={questions:[{question:'Which database?'},{question:'Which name?'}]};
const write=!args.includes('--read');
if(env.MOCK_TIMEOUT_FIRST && args.includes('--read')===false && !brief.includes('Revised brief'))await new Promise(r=>setTimeout(r,2000));
const noop=(env.MOCK_NOOP==='first' && !brief.includes('Revised brief')) || env.MOCK_NOOP==='all' || env.MOCK_NOOP===title.split(' ')[0];
if(env.MOCK_REPEAT_CONFLICT && brief.includes('Redo your work'))spawnSync('git',['reset','--hard','HEAD~1'],{stdio:'ignore'});
if((write || env.MOCK_VIOLATE_READ) && !noop && !output.questions) {
  mkdirSync('mock-output',{recursive:true});
  const name=title.split(' ')[0].replace(/[^\w-]/g,'-');
  writeFileSync(join('mock-output',`${name}-saw.txt`),readdirSync('mock-output').sort().join('\n'));
  writeFileSync(join('mock-output',`${name}.txt`),`${model}\n${title}\n`);
  if(env.MOCK_GATE_REPAIR && brief.includes('Revised brief'))writeFileSync('repaired.txt','fixed\n');
  if(env.MOCK_CONFLICT)writeFileSync('shared.txt',`${title}\n`);
  if(env.MOCK_APPEND_TASK && title.startsWith(env.MOCK_APPEND_TASK))appendFileSync('tasks.md','\n## Phase 9: Convergence\n- [ ] T099 Appended by a task\n');
  if(env.MOCK_SELF_COMMIT)spawnSync('git',['-c','commit.gpgsign=false','commit','-qam','self commit'],{stdio:'ignore'});
}
if(env.MOCK_TOUCH_PROTECTED){mkdirSync('.orchestra',{recursive:true});writeFileSync('.orchestra/config.json','bad');}
const failed=!['plan','brief','diagnosis','synthesis'].includes(role) && (env.MOCK_FAIL==='all' || (env.MOCK_FAIL===model) || (env.MOCK_FAIL==='first' && !brief.includes('Previous attempt')));
const tokens=model==='unreported'?null:{input:1000,output:200,cacheRead:50,cacheWrite:0};
const transcript={commands:[{cmd:'npm test',code:7}],files:['src/example.js'],errors:['example failed']};
const result={adapterResult:1,status:failed?'failed':'completed',finalMessage:JSON.stringify(output),output,tokens,transcript};
process.stdout.write(JSON.stringify(result));
if(env.MOCK_EXIT)process.exitCode=Number(env.MOCK_EXIT);

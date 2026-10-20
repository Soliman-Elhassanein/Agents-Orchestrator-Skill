import { readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const args=process.argv.slice(2), opt=(s)=>args[args.indexOf(s)+1], env=process.env;
const brief=readFileSync(opt('--brief'),'utf8'), out=opt('--out-dir'), model=args.includes('--model')?opt('--model'):'default';
const title=/SUBTASK:\n(.+)/.exec(brief)?.[1] ?? 'direct';
const role=/ORCHESTRA ROLE: (.*)/.exec(brief)?.[1];
if((env.MOCK_STARTUP ?? '').split(',').includes(model)) {
  process.stderr.write(env.MOCK_STARTUP_ERROR ?? 'permission denied: headless cannot prompt');
  process.stdout.write(JSON.stringify({status:'failed',finalMessage:'',tokens:null}));process.exit(1);
}
if(env.MOCK_CALL_LOG)appendFileSync(env.MOCK_CALL_LOG,JSON.stringify({model,role,title,brief,cwd:process.cwd(),at:Date.now()})+'\n');
if(env.MOCK_DELAY)await new Promise((r)=>setTimeout(r,Number(env.MOCK_DELAY)));
if(env.MOCK_CRASH_TITLE && title.startsWith(env.MOCK_CRASH_TITLE))process.kill(process.ppid,'SIGKILL');
let output={text:`response from ${model}`,stop:true};
if(env.MOCK_EVIDENCE && ['mode','propose','critique'].includes(role))output={text:`response from ${model}`,stop:true,evidence:[{file:'README.md',line:1,quote:'# demo'},{file:'README.md',line:1,quote:'wrong quote'}]};
if(role==='adapter-test')output={text:'OK'};
if(brief.includes('taskList') && role!=='adapter-test')output={taskList:'## Phase 1: Work\n- [ ] T001 [P] Write one\n- [ ] T002 [P] Write two\n'};
if(role==='workflow-author' && env.MOCK_PACK_FILE)output={pack:readFileSync(env.MOCK_PACK_FILE,'utf8')};
if(env.MOCK_LESSONS)output.lessons=JSON.parse(env.MOCK_LESSONS);
if(env.MOCK_SUGGESTION)output.suggestions=[{text:'Consider a code convention',source:'direct'}];
if(env.MOCK_QUESTIONS && !brief.includes('"by":"user"'))output={questions:[{question:'Which database?'},{question:'Which name?'}]};
const write=!args.includes('--read');
const noop=env.MOCK_NOOP==='all' || env.MOCK_NOOP===title.split(' ')[0];
if(env.MOCK_REPEAT_CONFLICT && brief.includes('Redo your work'))spawnSync('git',['reset','--hard','HEAD~1'],{stdio:'ignore'});
if((write || env.MOCK_VIOLATE_READ) && !noop && !output.questions) {
  mkdirSync('mock-output',{recursive:true});
  const name=title.split(' ')[0].replace(/[^\w-]/g,'-');
  writeFileSync(join('mock-output',`${name}-saw.txt`),readdirSync('mock-output').sort().join('\n'));
  writeFileSync(join('mock-output',`${name}.txt`),`${model}\n${title}\n`);
  if(env.MOCK_CONFLICT)writeFileSync('shared.txt',`${title}\n`);
  if(env.MOCK_SELF_COMMIT)spawnSync('git',['-c','commit.gpgsign=false','commit','-qam','self commit'],{stdio:'ignore'});
}
if(env.MOCK_TOUCH_PROTECTED){mkdirSync('.orchestra',{recursive:true});writeFileSync('.orchestra/config.json','bad');}
const failed=env.MOCK_FAIL==='all' || (env.MOCK_FAIL===model) || (env.MOCK_FAIL==='first' && !brief.includes('Previous attempt'));
const tokens=model==='unreported'?null:{input:1000,output:200,cacheRead:50,cacheWrite:0};
const transcript={commands:[{cmd:'npm test',code:7}],files:['src/example.js'],errors:['example failed']};
const result={adapterResult:1,status:failed?'failed':'completed',finalMessage:JSON.stringify(output),output,tokens,transcript};
process.stdout.write(JSON.stringify(result));
if(env.MOCK_EXIT)process.exitCode=Number(env.MOCK_EXIT);

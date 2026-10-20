import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const [mode,runDir,engine,root]=process.argv.slice(2);
const {checkWorkflow,dryWorkflow,addWorkflow,within}=await import(pathToFileURL(join(engine,'lib/workflows.mjs')));
const {writeWorkflowDiagram}=await import(pathToFileURL(join(engine,'tools/diagram.mjs')));
const pack=JSON.parse(readFileSync(join(runDir,'workflows/draft.json'),'utf8'));
if(!/^[\w-]+$/.test(pack.name) || !pack.files || !Object.hasOwn(pack.files,'workflow.json'))throw new Error('draft needs name and files including workflow.json');
const folder=join(runDir,'workflows',pack.name);
if(mode==='check') {
  mkdirSync(folder,{recursive:true});
  for(const [name,text] of Object.entries(pack.files)) {
    if(!within(folder,join(folder,name)) || name!=='workflow.json' && !name.endsWith('.md') || typeof text!=='string')throw new Error('only workflow data and prompts may be drafted; this needs a 7th block if existing blocks cannot express it');
    const file=join(folder,name);mkdirSync(dirname(file),{recursive:true});
    if(!within(folder,realpathSync(dirname(file))))throw new Error('draft path escapes workflow folder');
    if(existsSync(file) && realpathSync(file)!==resolve(file))throw new Error('draft file is a link');
    writeFileSync(file,text);
  }
  checkWorkflow(join(folder,'workflow.json'),false);console.log('Workflow structure valid.');
} else if(mode==='diagram') {
  const file=writeWorkflowDiagram(join(folder,'workflow.json')),preview=join(runDir,'workflows/workflow.drawio');
  copyFileSync(file,preview);console.log(preview);
}
else if(mode==='dry')dryWorkflow(checkWorkflow(join(folder,'workflow.json')));
else if(mode==='save') {
  const state=JSON.parse(readFileSync(join(runDir,'state.json'),'utf8'));
  const answer=state.steps.approve.output.answers.trim().toLowerCase();
  if(!/^approve (project|user)$/.test(answer)){console.log('Not saved: user did not approve.');process.exit(0);}
  console.log(`Saved: ${addWorkflow(root,folder,answer==='approve user').join(', ')}`);
} else throw new Error('unknown operation');

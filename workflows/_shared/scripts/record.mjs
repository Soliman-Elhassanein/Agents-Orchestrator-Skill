import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const run=process.argv[2],s=JSON.parse(readFileSync(join(run,'state.json'),'utf8'));
const summary=s.steps.synthesize.output, answer=s.steps.decide.output.answers;
let choice;try{choice=JSON.parse(answer);}catch{}
if(choice && typeof choice==='object'){if(typeof choice.decision!=='string')throw new Error('decision text required');Object.assign(summary,choice);}
const evidence=JSON.parse(readFileSync(join(run,'verification.json'),'utf8'));
const cell=(v)=>String(v ?? '').replaceAll('|','\\|').replaceAll('\n',' ');
const table=(headers,rows)=>`| ${headers.join(' | ')} |\n|${headers.map(()=>'---').join('|')}|\n${rows.map((r)=>`| ${r.map(cell).join(' | ')} |`).join('\n')}`;
const text=`# Decision: ${cell(summary.title ?? s.task)}
Date: ${new Date().toISOString().slice(0,10)}
Question: ${cell(summary.question ?? s.task)}

## Decision
${choice?.decision ?? answer}

## Rejected options
${table(['Option','Why not'],summary.rejectedOptions ?? [])}

## Open questions
${table(['Question','Blocks'],summary.openQuestions ?? [])}

## Sources
${evidence.checks.map((c)=>`- ${cell(c.file?`${c.file}:${c.line}${c.endLine?`-${c.endLine}`:''}`:c.url ?? c.quote)} — ${c.status}: ${cell(c.reason)}`).join('\n')}
`;
writeFileSync(join(run,'decision.md'),text);console.log(join(run,'decision.md'));

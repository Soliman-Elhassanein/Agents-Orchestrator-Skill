import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const colors = { agent:'#dae8fc', parallel:'#e1d5e7', ask:'#fff2cc', gate:'#d5e8d4', loop:'#ffe6cc', lanes:'#f8cecc' };
const kindOf = (step) => Object.keys(colors).find((kind) => step[kind]);
const xml = (value) => String(value).replace(/[&<>"'\r\n]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;','\r':'&#13;','\n':'&#10;'}[c]));
const selection = (b) => `${b.agent ? `agent: ${b.agent}` : `tier: ${b.tier ?? 2}`} · access: ${b.access ?? 'read'}`;
function label(step) {
  const kind=kindOf(step), b=step[kind], lines=[`${step.id} · ${kind}`];
  if(kind==='agent' || kind==='parallel')lines.push(selection(b));
  if(kind==='parallel')lines.push(`count: ${b.count ?? 2}${b.distinct ? ' · distinct: vendor' : ''}`,`anonymised: ${b.anonymize ? 'yes' : 'no'}`,`sees: ${Array.isArray(b.sees) ? b.sees.join(', ') || 'none' : b.sees ?? 'none'}`);
  if(kind==='ask')lines.push('you answer');
  if(kind==='gate')lines.push(b.command);
  if(kind==='lanes')lines.push('phases in order, [P] tasks in parallel worktrees, merge, gates');
  if(kind==='loop')lines.push(`max: ${b.max}`);
  return lines.join('\n');
}
function size(step) {
  const kind=kindOf(step), b=step[kind];
  if(kind==='parallel')return {w:Math.max(420,(b.count ?? 2)*250),h:310};
  if(kind==='loop')return {w:Math.max(420,...b.steps.map((s)=>size(s).w))+100,h:140+b.steps.reduce((n,s)=>n+size(s).h+60,0)};
  return {w:420,h:Math.max(90,45+Math.ceil(label(step).length/55)*22)};
}

/** Pure authoring renderer: no timestamps, randomness, file paths or model calls. */
export function workflowDiagram(workflow) {
  const cells=['<mxCell id="0"/>','<mxCell id="1" parent="0"/>'];
  let serial=1;
  const node=(value,kind,x,y,w,h,parent='1',extra='',role='step')=>{
    const id=`n${++serial}`;
    cells.push(`<mxCell id="${id}" value="${xml(value)}" style="rounded=1;whiteSpace=wrap;html=0;fillColor=${colors[kind] ?? '#f5f5f5'};strokeColor=#666666;${extra}" vertex="1" parent="${parent}" data-kind="${kind}" data-role="${role}"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`);
    return id;
  };
  const edge=(source,target,value='',extra='',parent='1',points='')=>{
    cells.push(`<mxCell id="e${++serial}" value="${xml(value)}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=0;endArrow=block;${extra}" edge="1" parent="${parent}" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry">${points}</mxGeometry></mxCell>`);
  };
  const draw=(step,x,y,parent)=>{
    const kind=kindOf(step),b=step[kind],{w,h}=size(step);
    if(kind==='loop') {
      const group=node(label(step),kind,x,y,w,h,parent,'swimlane;startSize=60;horizontal=1;container=1;collapsible=0;');
      const first=node('loop entry',kind,w/2-50,75,100,30,group,'ellipse;','entry');
      let last=first,cy=145;
      for(const inner of b.steps){const next=draw(inner,(w-size(inner).w)/2,cy,group);edge(last,next.entry,inner.agent?.unless ? `skip if present: ${inner.agent.unless}` : '','',group);last=next.exit;cy+=size(inner).h+60;}
      const end=node('check until',kind,w/2-60,h-45,120,30,group,'rhombus;','condition');
      edge(last,end,'','',group);
      const condition=`until ${b.until.step}.${b.until.field} = ${JSON.stringify(b.until.equals)}; max ${b.max}`;
      edge(end,first,`repeat while false · ${condition}`,'exitX=1;exitY=0.5;entryX=1;entryY=0.5;',group,`<Array as="points"><mxPoint x="${w-20}" y="${h-30}"/><mxPoint x="${w-20}" y="90"/></Array>`);
      return {entry:first,exit:end};
    }
    if(kind==='parallel') {
      const fork=node(`${label(step)}\nfork`,kind,x+w/2-210,y,420,120,parent,'shape=hexagon;','step');
      const joinNode=node('join',kind,x+w/2-40,y+h-30,80,30,parent,'rhombus;','join');
      for(let i=0;i<(b.count ?? 2);i++){
        const child=node(`${step.id} / ${i+1} · parallel\n${selection(b)}`,kind,x+i*250+10,y+165,230,90,parent,'','child');
        edge(fork,child,'','',parent);edge(child,joinNode,'','',parent);
      }
      return {entry:fork,exit:joinNode};
    }
    const id=node(label(step),kind,x,y,w,h,parent);
    return {entry:id,exit:id};
  };
  const width=Math.max(660,Math.max(420,...workflow.steps.map((s)=>size(s).w))+160);
  node(`Workflow · budget: ${workflow.budget.calls} calls`,'title',20,20,width-40,50,'1','fontSize=20;strokeColor=none;','title');
  let last=node('Start','start',width/2-60,100,120,45,'1','ellipse;','start'),y=205;
  for(const step of workflow.steps){const next=draw(step,(width-size(step).w)/2,y,'1');edge(last,next.entry,step.agent?.unless ? `skip if present: ${step.agent.unless}` : '');last=next.exit;y+=size(step).h+100;}
  const end=node('End','end',width/2-60,y,120,45,'1','ellipse;','end');edge(last,end);y+=100;
  Object.keys(colors).forEach((kind,i)=>node(kind,kind,20+i*100,y,95,35,'1','fontSize=12;','legend'));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<mxfile><diagram id="workflow" name="Workflow"><mxGraphModel grid="1" gridSize="10" page="0" pageWidth="${width}" pageHeight="${y+80}"><root>\n${cells.map((c)=>'  '+c).join('\n')}\n</root></mxGraphModel></diagram></mxfile>\n`;
}

export function writeWorkflowDiagram(file,out=join(dirname(file),'workflow.drawio')) {
  writeFileSync(out,workflowDiagram(JSON.parse(readFileSync(file,'utf8'))));
  return out;
}

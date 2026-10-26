/**
 * Compiles a workflow's data into a LangGraph state graph. Each step is a node; step order and
 * `when` routes are conditional edges; a loop is an entry node, its steps and an `until` node
 * that edges back. The graph holds only loop iterations. The runtime executes every node and
 * keeps the durable checkpoint, so a resumed run replays the graph and finished steps return
 * their recorded outputs.
 */
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { routed } from './workflows.mjs';

const State = Annotation.Root({ iter: Annotation({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }) });
const get = (o, p) => String(p).split('.').reduce((v, k) => v?.[k], o);

/** Supersteps a run can take at most: every node once, and every loop node `max` times. */
function maxSteps(steps) {
  return steps.reduce((n, s) => n + (s.loop ? 1 + s.loop.max * (maxSteps(s.loop.steps) + 1) : 1), 0);
}

export function compileWorkflow(workflow, rt) {
  const graph = new StateGraph(State);
  // A step's record key: enclosing loops and their current iterations, then its id.
  const keyOf = (loops, id, state) => loops.map((l) => `${l.id}/${state.iter[l.path]}/`).join('') + id;
  const cycleOf = (loops, state) => (loops.length ? state.iter[loops.at(-1).path] + 1 : 1);

  // Steps of one list; `tail` is where the list continues after its last step.
  const list = (steps, loops, tail) => {
    const names = steps.map((s) => [...loops.map((l) => l.id), s.id].join('/'));
    // The next step whose route matches; a step passed over has no output, even from an earlier iteration.
    const from = (i) => () => {
      for (let j = i; j < steps.length; j++) {
        if (routed(steps[j], rt.outputs, get)) return names[j];
        delete rt.outputs[steps[j].id];
      }
      return tail;
    };
    const targets = (i) => [...names.slice(i), tail];
    steps.forEach((step, i) => {
      const name = names[i], next = from(i + 1);
      if (!step.loop) {
        graph.addNode(name, async (state) => {
          rt.cycle = cycleOf(loops, state);
          await rt.runStep(step, keyOf(loops, step.id, state));
          return {};
        });
        graph.addConditionalEdges(name, next, targets(i + 1));
        return;
      }
      const b = step.loop, loop = { id: step.id, path: name }, until = `${name}#until`;
      const inner = [...loops, loop], body = list(b.steps, inner, until);
      const done = (state) => rt.s.steps[keyOf(loops, step.id, state)]?.status === 'completed';
      graph.addNode(name, async (state) => {
        const iteration = rt.enterLoop(step, keyOf(loops, step.id, state));
        return { iter: { [name]: iteration } };
      });
      const exits = [...new Set([...body.targets, ...targets(i + 1)])];
      graph.addConditionalEdges(name, (state) => (done(state) ? next(state) : body.first(state)), exits);
      graph.addNode(until, async (state) => {
        const iteration = rt.checkLoop(step, keyOf(loops, step.id, state), state.iter[name]);
        return { iter: { [name]: iteration } };
      });
      graph.addConditionalEdges(until, (state) => (done(state) ? next(state) : body.first(state)), exits);
    });
    return { first: from(0), targets: targets(0) };
  };

  const top = list(workflow.steps, [], END);
  graph.addConditionalEdges(START, top.first, top.targets);
  const app = graph.compile();
  return { invoke: () => app.invoke({}, { recursionLimit: maxSteps(workflow.steps) + 10 }) };
}

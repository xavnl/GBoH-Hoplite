// Headless AI-vs-AI play: used by tests to exercise the whole engine and the AI together.
import { reducer, type Action } from '../engine/reducer';
import type { GameState, SideId } from '../engine/types';
import { aiActivation, aiReaction } from './ai';
import { aiPendingDecision, trumpKey } from './useAi';

export interface SimResult { state: GameState; steps: number; actions: number }

export function simulate(start: GameState, maxSteps = 4000, maxTurns = 30, onAction?: (a: Action, before: GameState, after: GameState) => void): SimResult {
  let s = start;
  let actions = 0;
  const considered: Record<SideId, string> = { A: '', B: '' };
  const apply = (a: Action) => { const before = s; s = reducer(s, a); actions++; onAction?.(a, before, s); };
  const answerReactions = () => {
    let guard = 0;
    while ((s.reactions ?? []).length && guard++ < 50) apply(aiReaction(s, s.reactions![0]));
  };

  let steps = 0;
  for (; steps < maxSteps && s.phase !== 'over' && s.turn <= maxTurns; steps++) {
    // Decisions of either side outside an Orders Phase.
    let decided = false;
    for (const side of ['A', 'B'] as SideId[]) {
      const key = trumpKey(s);
      const d = aiPendingDecision(s, side, considered[side] === key);
      if (d) { if (d.type === 'trump') considered[side] = key; apply(d); decided = true; break; }
      if (s.active && s.active.side !== side) considered[side] = key;
    }
    if (decided) continue;

    if (s.active?.kind === 'command' && !s.pendingChoice) {
      const gen = aiActivation(s, s.active.side);
      let r = gen.next(s);
      let guard = 0;
      while (!r.done && guard++ < 500) {
        const a = r.value;
        if (a.type === 'note' && a.text === '__wait_reactions__') answerReactions();
        else apply(a);
        r = gen.next(s);
      }
      if (s.active?.kind === 'command') apply({ type: 'endActivation' }); // safety
      continue;
    }
    if (s.active && s.active.kind === 'momentum') { apply({ type: 'endActivation' }); continue; }

    // Neutral steps the players perform together.
    if (s.phase === 'initiative' && !s.initiativeSide) apply({ type: 'rollInitiative' });
    else if (s.phase === 'initiative') apply({ type: 'pickInitiativeMarker', marker: null });
    else if ((s.phase === 'activation' || s.phase === 'orders') && !s.active && s.pool.length) apply({ type: 'drawMarker' });
    else if (s.phase === 'rout' || ((s.phase === 'activation' || s.phase === 'orders') && !s.active && !s.pool.length)) apply({ type: 'endTurn' });
    else break;
  }
  return { state: s, steps, actions };
}

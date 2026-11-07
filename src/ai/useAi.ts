import { useEffect, useRef, useState } from 'react';
import type { Action } from '../engine/reducer';
import type { GameState, SideId } from '../engine/types';
import { aiActivation, aiChoice, aiInitiativePick, aiReaction, aiWantsTrump } from './ai';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Next single decision the AI must take outside its own Orders Phase, if any. */
export function aiPendingDecision(s: GameState, side: SideId, trumpConsidered: boolean): Action | null {
  if (s.phase === 'over') return null;
  if (s.phase === 'initiative' && s.initiativeSide === side) return aiInitiativePick(s, side);
  if (s.pendingChoice?.side === side) return aiChoice(s, side);
  const mine = (s.reactions ?? []).find((r) => s.units[r.reactorId]?.side === side);
  if (mine) return aiReaction(s, mine);
  if (!trumpConsidered && aiWantsTrump(s, side)) return { type: 'trump', side };
  return null;
}

export const trumpKey = (s: GameState) => `${s.turn}:${s.used.length}:${s.pool.length}:${s.active ? JSON.stringify(s.active) : ''}`;

/**
 * Lets the AI play `aiSide`: answers its decisions and runs its Orders Phases, dispatching
 * actions one by one so the player can follow them on the map.
 */
export function useAiDriver(state: GameState, dispatch: (a: Action) => void, aiSide: SideId | null, delay = 450) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const considered = useRef('');

  useEffect(() => {
    if (!aiSide || running.current) return;
    const s = state;
    const key = trumpKey(s);
    const decision = aiPendingDecision(s, aiSide, considered.current === key);
    const myActivation = s.active?.kind === 'command' && s.active.side === aiSide && !s.pendingChoice;
    if (!decision && !myActivation) {
      if (s.active && s.active.side !== aiSide) considered.current = key; // nothing to do for this marker
      return;
    }
    running.current = true;
    setBusy(true);
    (async () => {
      try {
        if (decision) {
          await sleep(delay);
          if (decision.type === 'trump') considered.current = key;
          dispatch(decision);
          await sleep(60);
          return;
        }
        const gen = aiActivation(stateRef.current, aiSide);
        let r = gen.next(stateRef.current);
        let guard = 0;
        while (!r.done && guard++ < 500) {
          const a = r.value;
          if (a.type === 'note' && a.text === '__wait_reactions__') {
            // The opponent decides its reactions; resume once they are all answered.
            while ((stateRef.current.reactions ?? []).some((x) => stateRef.current.units[x.reactorId]?.side !== aiSide)) await sleep(200);
            r = gen.next(stateRef.current);
            continue;
          }
          dispatch(a);
          await sleep(delay);
          r = gen.next(stateRef.current);
        }
      } finally {
        running.current = false;
        setBusy(false);
      }
    })();
  }, [state, aiSide, dispatch, delay, busy]); // `busy` re-runs the check once a run finishes

  return busy;
}

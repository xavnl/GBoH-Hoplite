import { useCallback, useEffect, useState } from 'react';
import { BOARDS } from '../data/boards';
import { NEMEA } from '../data/scenarios/nemea';
import type { ScenarioDef, VassalSetup } from '../data/scenarios/types';
import nemeaSetup from '../data/setups/nemea.vassal.json';
import { reducer, type Action } from '../engine/reducer';
import { newSeed } from '../engine/rng';
import { createGame } from '../engine/setup';
import type { GameState } from '../engine/types';

export const SCENARIOS: Record<string, { def: ScenarioDef; setup: VassalSetup }> = {
  nemea: { def: NEMEA, setup: nemeaSetup as VassalSetup },
};

const SAVE_KEY = 'hoplite.save.v1';
const MAX_UNDO = 200;

export function newGame(scenarioId: string): GameState {
  const scn = SCENARIOS[scenarioId];
  return createGame(scn.def, scn.setup, BOARDS[scn.def.boardId], newSeed());
}

function loadSaved(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? (JSON.parse(raw) as GameState) : null;
  } catch {
    return null;
  }
}

export function useGame() {
  const [history, setHistory] = useState<{ past: GameState[]; present: GameState; future: GameState[] }>(() => ({
    past: [],
    present: loadSaved() ?? newGame('nemea'),
    future: [],
  }));

  useEffect(() => {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(history.present));
    } catch {
      /* storage unavailable: autosave is a convenience only */
    }
  }, [history.present]);

  const dispatch = useCallback((a: Action) => {
    setHistory((h) => {
      const next = reducer(h.present, a);
      if (next === h.present) return h;
      return { past: [...h.past, h.present].slice(-MAX_UNDO), present: next, future: [] };
    });
  }, []);

  const undo = useCallback(() => setHistory((h) => (h.past.length ? {
    past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future],
  } : h)), []);

  const redo = useCallback(() => setHistory((h) => (h.future.length ? {
    past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1),
  } : h)), []);

  const reset = useCallback((s: GameState) => setHistory({ past: [], present: s, future: [] }), []);

  return {
    state: history.present,
    dispatch,
    undo,
    redo,
    reset,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}

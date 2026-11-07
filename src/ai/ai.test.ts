import { describe, expect, it } from 'vitest';
import { BOARDS } from '../data/boards';
import { NEMEA } from '../data/scenarios/nemea';
import type { VassalSetup } from '../data/scenarios/types';
import nemeaSetup from '../data/setups/nemea.vassal.json';
import { footprint, hexKey } from '../engine/hex';
import { sideRoutPoints } from '../engine/routPoints';
import { createGame } from '../engine/setup';
import type { GameState } from '../engine/types';
import { simulate } from './simulate';

function invariants(s: GameState) {
  const seen = new Map<string, string>();
  for (const u of Object.values(s.units)) {
    if (u.eliminated || !u.hex) continue;
    for (const h of footprint(u.hex, u.facing, u.size).hexes) {
      const k = hexKey(h);
      expect(seen.get(k), `${u.name} stacked with ${seen.get(k)} at ${k}`).toBeUndefined();
      seen.set(k, u.name);
    }
    if (!u.routed) expect(u.hits, `${u.name} hits ${u.hits} vs TQ ${u.tq}`).toBeLessThan(u.tq);
  }
}

describe('AI vs AI on Nemea', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    it(`plays a full battle without breaking the rules (seed ${seed})`, () => {
      const start = createGame(NEMEA, nemeaSetup as VassalSetup, BOARDS.blankFull, seed);
      const { state, actions } = simulate(start, 6000, 40);
      invariants(state);
      const rp = sideRoutPoints(state, 'A') + sideRoutPoints(state, 'B');
      // The armies must actually fight: rout points are scored, and most battles end.
      expect(actions).toBeGreaterThan(50);
      expect(rp).toBeGreaterThan(0);
      console.log(`seed ${seed}: turn ${state.turn}, winner ${state.winner ?? '-'}, RP A ${sideRoutPoints(state, 'A')} / B ${sideRoutPoints(state, 'B')}, ${actions} actions`);
    }, 60000);
  }
});

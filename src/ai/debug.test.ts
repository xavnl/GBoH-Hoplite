// Diagnostic only: AI_DEBUG=<seed> npx vitest run src/ai/debug.test.ts
import { it } from 'vitest';
import { BOARDS } from '../data/boards';
import { NEMEA } from '../data/scenarios/nemea';
import type { VassalSetup } from '../data/scenarios/types';
import nemeaSetup from '../data/setups/nemea.vassal.json';
import { footprint, hexKey, hexLabel } from '../engine/hex';
import { legalMoves } from '../engine/movement';
import { createGame } from '../engine/setup';
import type { GameState } from '../engine/types';
import { simulate } from './simulate';

declare const process: { env: Record<string, string | undefined> };

const stacked = (s: GameState) => {
  const seen = new Map<string, string>();
  for (const u of Object.values(s.units)) {
    if (u.eliminated || !u.hex) continue;
    for (const h of footprint(u.hex, u.facing, u.size).hexes) {
      if (seen.has(hexKey(h))) return `${u.name} + ${seen.get(hexKey(h))} @ ${hexLabel(BOARDS.blankFull.geometry, h)}`;
      seen.set(hexKey(h), u.name);
    }
  }
  return null;
};

it.skipIf(!process.env.AI_LOG)('battle log', () => {
  const start = createGame(NEMEA, nemeaSetup as VassalSetup, BOARDS.blankFull, Number(process.env.AI_LOG));
  const res = simulate(start, 6000, 40);
  console.log(res.state.log.map((l) => `T${l.turn} ${l.text}`).join('\n'));
});

it.skipIf(!process.env.AI_DEBUG)('debug stacking', () => {
  const g = BOARDS.blankFull.geometry;
  const start = createGame(NEMEA, nemeaSetup as VassalSetup, BOARDS.blankFull, Number(process.env.AI_DEBUG));
  let reported = false;
  simulate(start, 6000, 40, (a, before, after) => {
    if (reported || stacked(before) || !stacked(after)) return;
    reported = true;
    console.log('ACTION', JSON.stringify(a));
    console.log('STACK', stacked(after));
    if (a.type === 'legalMove') {
      const u = before.units[a.id];
      const lm = legalMoves(before, g, u);
      const k = `${a.hex.q},${a.hex.r},${a.facing}`;
      console.log('in legalMoves?', lm.has(k), 'from', hexLabel(g, u.hex!), 'to', hexLabel(g, a.hex));
      console.log('activity', JSON.stringify(before.activity), 'reactions', JSON.stringify(before.reactions));
    }
    console.log(after.log.slice(-6).map((l) => l.text).join('\n'));
    for (const id of Object.keys(after.units)) {
      const b = before.units[id], c = after.units[id];
      if (JSON.stringify(b.hex) !== JSON.stringify(c.hex) || b.facing !== c.facing) {
        console.log('CHANGED', c.name, footprint(b.hex!, b.facing, b.size).hexes.map((h) => hexLabel(g, h)), b.facing, '->', footprint(c.hex!, c.facing, c.size).hexes.map((h) => hexLabel(g, h)), c.facing);
      }
    }
  });
});

// Movement (6.0) on clear terrain: legal destinations with MP and cohesion costs.
// Handles facing (6.9), front-hex-only movement, Hoplite Phalanx forward / Front-to-Flank /
// Reverse Face (6.4), stopping in enemy Front hexes (6.96), stacking & moving through friends
// (6.8), Out of Command restriction (5.45) and Advance-to-Combat rates (6.2).
// Terrain other than clear is not modelled yet (Nemea is flat).
import { occupiedBy } from './command';
import { distance, footprint, hexKey, isOnMap, neighborAt, neighbors, normFacing, pivotKeepLeft, pivotKeepRight, reverseFace, type BoardGeometry, type Hex } from './hex';
import { ADVANCE_MA } from './tables';
import type { GameState, Unit } from './types';

export interface MoveState { anchor: Hex; facing: number }
export interface Reach extends MoveState {
  mp: number;
  hits: number;
  path: string[];
  /** Hexes occupied after each step, starting with the start position (used for reactions). */
  trail: Hex[][];
}

export const stateKey = (s: MoveState) => `${s.anchor.q},${s.anchor.r},${normFacing(s.facing)}`;

export function movementAllowance(u: Unit): number {
  if (u.advance) return ADVANCE_MA[u.advance];
  return u.ma;
}

/** Leaders have 9 MP (4.13). */
export const LEADER_MA = 9;

export function legalMoves(s: GameState, g: BoardGeometry, u: Unit): Map<string, Reach> {
  const out = new Map<string, Reach>();
  if (!u.hex || u.eliminated || u.routed || u.engaged || u.rallied) return out;
  const activeHere = s.active?.kind === 'command' && s.active.command === u.command;
  // Orders (5.44): under Disengage non-engaged units do nothing; under Rally they move as if Out of Command.
  if (activeHere && s.orders === 'disengage') return out;
  const act = s.activity?.[u.id];
  if (act === 'recovered' || act === 'disengaged' || act === 'rallied' || act === 'moved' || act === 'inactive') return out;
  if (act === 'fired' && u.type === 'LI' && (u.missile === 'B' || u.missile === 'C')) return out; // 7.11: move OR fire
  const ooc = u.outOfCommand || (activeHere && s.orders === 'rally');
  const ma = movementAllowance(u);
  const occ = occupiedBy(s);
  const enemies = Object.values(s.units).filter((e) => e.side !== u.side && e.hex && !e.eliminated);
  const enemyHexes = new Set<string>();
  const enemyFront = new Set<string>();
  const enemyAdj = new Set<string>();
  for (const e of enemies) {
    const fp = footprint(e.hex!, e.facing, e.size);
    fp.hexes.forEach((h) => { enemyHexes.add(hexKey(h)); neighbors(h).forEach((n) => enemyAdj.add(hexKey(n))); });
    if (!e.routed) fp.front.forEach((h) => enemyFront.add(hexKey(h)));
  }
  const isHoplite = u.type === 'HO';
  const startInFront = footprint(u.hex, u.facing, u.size).hexes.some((h) => enemyFront.has(hexKey(h)));

  /** Validate a candidate position; returns extra MP / hits for entering friendly-occupied hexes, or null if illegal. */
  const enter = (st: MoveState, newHexes: Hex[]): { mp: number; hits: number; stop: boolean; endable: boolean } | null => {
    let mp = 0, hits = 0, endable = true;
    for (const h of newHexes) {
      const k = hexKey(h);
      if (!isOnMap(g, h) || enemyHexes.has(k)) return null;
      const o = occ.get(k);
      if (o && o.id !== u.id) {
        if (o.side !== u.side) return null;
        if (isHoplite && o.type === 'HO') return null; // 6.83: hoplite never through hoplite
        if (u.size === 2 || o.size === 2) { if (isHoplite || o.type === 'HO') hits = 1; }
        else if (isHoplite || o.type === 'HO') hits = 1;
        mp = 1;
        endable = false;
      }
      if (ooc && enemyAdj.has(k) && !u.advance) return null; // 5.45
    }
    const fpHexes = footprint(st.anchor, st.facing, u.size).hexes;
    const stop = fpHexes.some((h) => enemyFront.has(hexKey(h)));
    // Stacking (6.81) is judged on the whole final position, not just the hexes just entered
    // (a unit that moved into a friend's hex and then turned there cannot stop).
    endable = endable && fpHexes.every((h) => { const o = occ.get(hexKey(h)); return !o || o.id === u.id; });
    return { mp, hits, stop, endable };
  };

  // Hellene Law of Inertia (6.28): advancing hoplites move only toward the enemy, and non-Spartans
  // must expend all their MP (unless they cannot go further).
  const advancing = u.type === 'HO' && !!u.advance;
  const enemyList = enemies.flatMap((e) => footprint(e.hex!, e.facing, e.size).hexes);
  const nearest = (hs: Hex[]) => (enemyList.length ? Math.min(...hs.flatMap((h) => enemyList.map((e) => distance(h, e)))) : 0);
  // Drift to the Right (6.29): a Hoplite Phalanx moving a second time this turn.
  const drifts = u.size === 2 && u.type === 'HO' && u.moved && !u.spartan && u.depth !== 4;
  const expandable = new Set<string>();

  const startKey = stateKey({ anchor: u.hex, facing: u.facing });
  const best = new Map<string, Reach & { stopped: boolean; endable: boolean }>();
  const queue: (Reach & { stopped: boolean; endable: boolean })[] = [];
  const push = (r: Reach & { stopped: boolean; endable: boolean }) => {
    const k = stateKey(r);
    const b = best.get(k);
    if (b && (b.mp < r.mp || (b.mp === r.mp && b.hits <= r.hits))) return;
    best.set(k, r);
    queue.push(r);
  };
  push({ anchor: u.hex, facing: u.facing, mp: 0, hits: 0, path: [], trail: [footprint(u.hex, u.facing, u.size).hexes], stopped: false, endable: true });

  while (queue.length) {
    queue.sort((a, b) => a.mp - b.mp);
    const cur = queue.shift()!;
    if (best.get(stateKey(cur)) !== cur) continue;
    const curFp = footprint(cur.anchor, cur.facing, u.size);
    // A unit that entered an enemy Front hex must stop (unless it started there and hasn't moved).
    if (cur.stopped && !(cur.path.length === 0 && startInFront)) continue;

    const tryState = (st: MoveState, newHexes: Hex[], mp: number, hits: number, label: string) => {
      const e = enter(st, newHexes);
      if (!e) return;
      const total = cur.mp + mp + e.mp;
      if (total > ma) return;
      if (advancing && nearest(footprint(st.anchor, st.facing, u.size).hexes) > nearest(curFp.hexes)) return;
      expandable.add(stateKey(cur));
      push({ ...st, facing: normFacing(st.facing), mp: total, hits: cur.hits + hits + e.hits, path: [...cur.path, label],
        trail: [...cur.trail, footprint(st.anchor, st.facing, u.size).hexes], stopped: e.stop, endable: e.endable });
    };

    if (u.size === 1) {
      // Move into one of the front hexes (keeps facing).
      for (const h of curFp.front) tryState({ anchor: h, facing: cur.facing }, [h], 1, 0, 'move');
      // Change facing (6.92): 1 MP per vertex; skirmishers 1 MP for any change. Not once in an enemy front hex (6.96).
      const inFrontNow = curFp.hexes.some((h) => enemyFront.has(hexKey(h)));
      if (!(inFrontNow && cur.path.length > 0)) {
        for (const d of [-2, 2, -4, 4, 6]) {
          const vertices = Math.abs(d) / 2;
          const cost = u.type === 'SK' ? 1 : vertices;
          if (u.type !== 'SK' && vertices > 1) continue; // reached via successive single-vertex steps
          tryState({ anchor: cur.anchor, facing: cur.facing + d }, [], cost, 0, 'face');
        }
      }
    } else {
      const base = cur.facing * 30;
      const [a, b] = curFp.hexes;
      // Straight ahead: both halves enter new hexes (forward-left or forward-right).
      const fl = { anchor: neighborAt(a, base - 30), facing: cur.facing };
      const fr = { anchor: neighborAt(a, base + 30), facing: cur.facing };
      const flHexes = [neighborAt(a, base - 30), neighborAt(b, base - 30)];
      const frHexes = [neighborAt(a, base + 30), neighborAt(b, base + 30)];
      let mustDrift = false;
      if (drifts && [1, 2, 4].includes(cur.mp + 1)) {
        const e = enter(fr, frHexes);
        const frOk = !!e && cur.mp + 1 + e.mp <= ma && (!advancing || nearest(frHexes) <= nearest(curFp.hexes));
        const flNextToEnemy = flHexes.some((h) => enemyAdj.has(hexKey(h)));
        mustDrift = frOk && !flNextToEnemy;
      }
      if (!mustDrift) tryState(fl, flHexes, 1, 0, 'forward-left');
      tryState(fr, frHexes, 1, 0, 'forward-right');
      // Front-to-Flank pivots (6.42): +1 hit unless Spartan.
      const pivotHit = u.spartan ? 0 : 1;
      const pl = pivotKeepLeft(cur.anchor, cur.facing);
      tryState(pl, [neighborAt(a, base + 30)], 1, pivotHit, 'pivot-left');
      const pr = pivotKeepRight(cur.anchor, cur.facing);
      tryState(pr, [neighborAt(b, base - 30)], 1, pivotHit, 'pivot-right');
      // Reverse Face (6.44): 4 MP, not while advancing.
      if (!u.advance && u.depth !== 4) tryState(reverseFace(cur.anchor, cur.facing), [], 4, 0, 'reverse');
    }
  }

  for (const [k, r] of best) {
    if (k === startKey || !r.endable) continue;
    if (advancing && !u.spartan && r.mp < ma && expandable.has(k)) continue; // 6.28: spend all MP
    out.set(k, { anchor: r.anchor, facing: r.facing, mp: r.mp, hits: r.hits, path: r.path, trail: r.trail });
  }
  return out;
}

// Rout movement (10.21–10.24) and Advance after Combat (8.2).
import { occupiedBy } from './command';
import {
  footprint, hexKey, hexToPixel, isOnMap, neighborAt, neighbors, normFacing, pivotKeepLeft, pivotKeepRight,
  type BoardGeometry, type Hex,
} from './hex';
import { rollD10 } from './rng';
import { sideRoutPoints } from './routPoints';
import type { GameState, Leader, LogEntry, SideInfo, Unit } from './types';

// ---------- small state helpers (kept local to avoid import cycles) ----------

const log = (s: GameState, text: string, kind: LogEntry['kind'] = 'combat'): GameState =>
  ({ ...s, log: [...s.log, { turn: s.turn, text, kind }] });
const setUnit = (s: GameState, u: Unit): GameState => ({ ...s, units: { ...s.units, [u.id]: u } });
const setLeader = (s: GameState, l: Leader): GameState => ({ ...s, leaders: { ...s.leaders, [l.id]: l } });
const roll = (s: GameState): [number, GameState] => { const [r, rng] = rollD10(s.rng); return [r, { ...s, rng }]; };
const hexesOf = (u: Unit) => (u.hex ? footprint(u.hex, u.facing, u.size).hexes : []);

function eliminate(s: GameState, id: string, why: string): GameState {
  const u = s.units[id];
  const st = setUnit(s, { ...u, eliminated: true, engaged: false, routed: true });
  return log(st, `${u.name} ELIMINATED (${why}). ${s.sides[u.side].name}: ${sideRoutPoints(st, u.side)} RP.`);
}

/** Facing (0..11) pointing at the side's Retreat Edge. */
export function retreatFacing(side: SideInfo): number {
  return { top: 0, right: 2, bottom: 6, left: 10 }[side.retreatEdge] ?? 0; // 'right' uses a vertex near 60°
}

/** Signed "closeness" to the Retreat Edge (bigger = closer), in pixels. */
function edgeScore(g: BoardGeometry, side: SideInfo, h: Hex): number {
  const p = hexToPixel(g, h);
  switch (side.retreatEdge) {
    case 'top': return -p.y;
    case 'bottom': return p.y;
    case 'left': return -p.x;
    case 'right': return p.x;
  }
}

/** Stacked leaders go along with a unit that rout-moves or advances (4.23, 10.25). */
function moveLeadersWith(s: GameState, from: Hex[], to: Hex | null, side: Unit['side']): GameState {
  const keys = new Set(from.map(hexKey));
  let st = s;
  for (const l of Object.values(s.leaders)) {
    if (l.side !== side || l.killed || !l.hex || !keys.has(hexKey(l.hex))) continue;
    if (to) st = setLeader(st, { ...l, hex: to });
    else st = log(setLeader(st, { ...l, hex: null }), `${l.name} leaves the map with the routed unit — place him with the nearest friendly unit.`, 'info');
  }
  return st;
}

/** 10.22: a unit moved through by a routed unit checks TQ (min 1 hit); a routed unit moved through is eliminated. */
function movedThrough(s: GameState, id: string, by: string): GameState {
  const u = s.units[id];
  if (u.routed) return eliminate(s, id, `moved through by routed ${s.units[by].name} (10.22)`);
  // 10.22: if DR > TQ, hits = DR−TQ (minimum 1); a passed check has no effect.
  const [r, st] = roll(s);
  if (r <= u.tq) return log(st, `${u.name} moved through by routed ${s.units[by].name}: rolled ${r} ≤ ${u.tq}, steady.`, 'dice');
  const n = Math.max(1, r - u.tq);
  let out = setUnit(log(st, `${u.name} moved through by routed ${s.units[by].name}: rolled ${r} > ${u.tq} → ${n} hit(s) (10.22).`, 'dice'), { ...u, hits: u.hits + n });
  const after = out.units[id];
  if (after.hits >= after.tq) out = routStatus(out, id, 'moved through by a routed unit');
  return out;
}

/** Mark a unit as Routed (status only). Skirmishers & Chariots are eliminated instead (10.14). */
export function routStatus(s: GameState, id: string, why: string): GameState {
  const u = s.units[id];
  if (!u || u.eliminated) return s;
  if (u.type === 'SK' || u.type === 'CH') return eliminate(s, id, `routs — ${why}`);
  const missileSupply = u.type === 'LC' || !u.missile ? u.missileSupply : 'no';
  const st = setUnit(s, { ...u, routed: true, rallied: false, hits: 0, engaged: false, advance: null, missileSupply });
  return log(st, `${u.name} ROUTS (${why}).`);
}

export interface RoutOptions {
  /** Enemy units that were in the Shock combat: hexes adjacent to them block the rout path (10.21). */
  shockEnemies?: string[];
}

/**
 * Move a routed unit `steps` hexes toward its Retreat Edge (10.21 / 10.23).
 * Eliminated if it leaves the map or cannot complete the move (10.24).
 */
export function routMove(s: GameState, g: BoardGeometry, id: string, steps: number, opts: RoutOptions = {}): GameState {
  const u0 = s.units[id];
  if (!u0 || u0.eliminated || !u0.hex) return s;
  const side = s.sides[u0.side];
  const start = hexesOf(u0);
  let st = s;

  const blockedCtx = () => {
    const occ = occupiedBy(st);
    const enemyAdj = new Set<string>();
    const shockAdj = new Set<string>();
    const shock = new Set(opts.shockEnemies ?? []);
    for (const e of Object.values(st.units)) {
      if (e.side === u0.side || e.eliminated || !e.hex) continue;
      for (const h of hexesOf(e)) for (const n of neighbors(h)) {
        enemyAdj.add(hexKey(n));
        if (shock.has(e.id)) shockAdj.add(hexKey(n));
      }
    }
    return { occ, enemyAdj, shockAdj };
  };

  /** Rank a hex for entry: null = blocked; otherwise priority 1..4 (10.21) and 'off' when leaving the map. */
  const rank = (u: Unit, h: Hex, ctx: ReturnType<typeof blockedCtx>): number | 'off' | null => {
    if (!isOnMap(g, h)) return 'off';
    const k = hexKey(h);
    const o = ctx.occ.get(k);
    if (o && o.id !== u.id) {
      if (o.side !== u.side) return null;
      if (o.engaged) return null;
      if (u.type === 'HO' && o.type === 'HO') return null; // a hoplite never moves through a hoplite (6.83)
      if (o.depth === 4) return null;
    }
    if (ctx.shockAdj.has(k)) return null;
    const adj = ctx.enemyAdj.has(k);
    return (adj ? 2 : 0) + (o && o.id !== u.id ? 1 : 0) + 1;
  };

  // ---------------- Hoplite Phalanx ----------------
  if (u0.size === 2) {
    const tryDir = (facing: number): Hex[][] | null => {
      // Two forward steps with both halves, choosing left/right drift by priority & edge closeness.
      let anchor = u0.hex!;
      const path: Hex[][] = [];
      for (let i = 0; i < steps; i++) {
        const ctx = blockedCtx();
        const base = facing * 30;
        const fp = footprint(anchor, facing, 2).hexes;
        const opts2 = [-30, 30].map((d) => {
          const nh = fp.map((h) => neighborAt(h, base + d));
          const ranks = nh.map((h) => rank(st.units[id], h, ctx));
          if (ranks.some((r) => r === null)) return null;
          if (ranks.some((r) => r === 'off')) return { nh, prio: 0, score: Infinity, off: true };
          const prio = Math.max(...(ranks as number[]));
          return { nh, prio, score: nh.reduce((s2, h) => s2 + edgeScore(g, side, h), 0), off: false };
        }).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => a.prio - b.prio || b.score - a.score);
        if (!opts2.length) return null;
        path.push(opts2[0].nh);
        if (opts2[0].off) return path;
        anchor = opts2[0].nh[0];
      }
      return path;
    };
    const fwd = u0.facing;
    const rev = normFacing(u0.facing + 6);
    // Facing points at a vertex: the hexes straight ahead are at ±30°.
    const fwdBetter = edgeScore(g, side, neighborAt(u0.hex!, fwd * 30 + 30)) >= edgeScore(g, side, neighborAt(u0.hex!, rev * 30 + 30));
    const order = fwdBetter ? [fwd, rev] : [rev, fwd];
    for (const f of order) {
      // Reversing keeps the same two hexes: the new left half is the old right half.
      const anchor0 = f === u0.facing ? u0.hex! : footprint(u0.hex!, u0.facing, 2).hexes[1];
      const turned = { ...st.units[id], hex: anchor0, facing: f };
      st = setUnit(st, turned);
      const path = tryDir(f);
      if (!path) continue;
      const last = path[path.length - 1];
      const offMap = last.some((h) => !isOnMap(g, h));
      if (offMap) {
        st = moveLeadersWith(st, start, null, u0.side);
        return eliminate(st, id, 'routed off the map (10.24)');
      }
      // Moved-through units (any friendly in intermediate hexes).
      for (const hs of path) for (const h of hs) {
        const o = occupiedBy(st).get(hexKey(h));
        if (o && o.id !== id && o.side === u0.side) st = movedThrough(st, o.id, id);
      }
      // Cannot end stacked: extra hex or elimination (10.22).
      const endOcc = last.map((h) => occupiedBy(st).get(hexKey(h))).find((o) => o && o.id !== id && !o.eliminated);
      if (endOcc) {
        st = moveLeadersWith(st, start, last[0], u0.side);
        return eliminate(setUnit(st, { ...st.units[id], hex: last[0] }), id, 'routed into a friendly unit and could not continue (10.22)');
      }
      st = setUnit(st, { ...st.units[id], hex: last[0], facing: f });
      st = moveLeadersWith(st, start, last[0], u0.side);
      return log(st, `${u0.name} rout-moves ${path.length} hex(es) toward the ${side.retreatEdge} edge.`, 'info');
    }
    st = moveLeadersWith(st, start, null, u0.side);
    return eliminate(st, id, 'phalanx cannot complete its rout move (10.21)');
  }

  // ---------------- Single-sized units ----------------
  let hex = u0.hex!;
  const toEdge = retreatFacing(side);
  let facing = toEdge;
  const passed: string[] = [];
  let moved = 0;
  let extra = 0; // 10.22: one more hex if forced to stack
  while (moved < steps + extra) {
    const ctx = blockedCtx();
    const u = st.units[id];
    // Facing toward the edge, then adjust one vertex at a time either way (10.21).
    const tiers = [[-30, 30], [-90, 90], [-150, 150]];
    let choice: { h: Hex; prio: number | 'off'; face: number } | null = null;
    for (const tier of tiers) {
      const cands = tier.map((d) => {
        // Each step starts faced toward the edge; the facing actually used is kept at the end.
        const h = neighborAt(hex, toEdge * 30 + d);
        return { h, prio: rank(u, h, ctx), face: normFacing(toEdge + (d < 0 ? Math.ceil(d / 60) * 2 : Math.floor(d / 60) * 2)) };
      }).filter((c) => c.prio !== null) as { h: Hex; prio: number | 'off'; face: number }[];
      if (!cands.length) continue;
      cands.sort((a, b) => (a.prio === 'off' ? -1 : b.prio === 'off' ? 1 : (a.prio as number) - (b.prio as number) || edgeScore(g, side, b.h) - edgeScore(g, side, a.h)));
      choice = cands[0];
      break;
    }
    if (!choice) {
      st = moveLeadersWith(st, start, null, u0.side);
      return eliminate(st, id, 'rout path blocked (10.24)');
    }
    if (choice.prio === 'off') {
      st = moveLeadersWith(st, start, null, u0.side);
      return eliminate(st, id, 'routed off the map (10.24)');
    }
    const o = occupiedBy(st).get(hexKey(choice.h));
    hex = choice.h;
    facing = choice.face;
    moved++;
    if (o && o.id !== id) {
      passed.push(o.id);
      st = movedThrough(st, o.id, id);
      if (moved === steps + extra) {
        if (extra) {
          st = setUnit(st, { ...st.units[id], hex });
          return eliminate(st, id, 'forced to stack at the end of its rout (10.22)');
        }
        extra = 1;
      }
    }
    st = setUnit(st, { ...st.units[id], hex, facing });
  }
  st = moveLeadersWith(st, start, hex, u0.side);
  return log(st, `${u0.name} rout-moves ${moved} hex(es) toward the ${side.retreatEdge} edge.`, 'info');
}

/** Phase D.1 (10.23): routed phalanxes are eliminated; other routed units move their full printed MA. */
export function routPhase(s: GameState, g: BoardGeometry): GameState {
  let st = log(s, 'Rout Movement segment (10.23).', 'system');
  for (const u of Object.values(s.units)) {
    const cur = st.units[u.id];
    if (!cur.routed || cur.eliminated || cur.rallied) continue;
    if (cur.size === 2) st = eliminate(st, u.id, 'routed Hoplite Phalanx in the Rout Movement segment (10.23)');
    else st = routMove(st, g, u.id, cur.ma);
  }
  return st;
}

// ---------------------------------------------------------------------------
// Advance after Combat (8.2)
// ---------------------------------------------------------------------------

export interface AdvanceInput {
  attackerIds: string[];
  /** Hexes vacated by defenders as a result of this Shock combat. */
  vacated: Hex[];
  /** Attacker that had Superiority (advances first, 8.24). */
  superiorId?: string | null;
  /** Vacated by a pre-shock check: attackers in another enemy's Front hex do not advance (8.21). */
  preShock?: boolean;
}

export function advanceAfterCombat(s: GameState, g: BoardGeometry, inp: AdvanceInput): { state: GameState; advanced: Set<string>; pivoted: Set<string> } {
  let st = s;
  const advanced = new Set<string>();
  const pivoted = new Set<string>();
  const free = new Set(inp.vacated.map(hexKey));
  const occNow = () => occupiedBy(st);
  const enemyFrontOf = (u: Unit) => {
    const hs = new Set(hexesOf(u).map(hexKey));
    return Object.values(st.units).some((e) => e.side !== u.side && !e.eliminated && !e.routed && e.hex &&
      footprint(e.hex, e.facing, e.size).front.some((h) => hs.has(hexKey(h))));
  };

  const order = inp.attackerIds.map((id) => st.units[id]).filter((u) => u && !u.eliminated && !u.routed)
    .sort((a, b) => (b.id === inp.superiorId ? 1 : 0) - (a.id === inp.superiorId ? 1 : 0) || b.tq - a.tq);

  for (const u0 of order) {
    if (!free.size) break;
    const u = st.units[u0.id];
    if (inp.preShock && enemyFrontOf(u)) continue;
    const fp = footprint(u.hex!, u.facing, u.size);
    const startHexes = fp.hexes;
    const empty = (h: Hex) => { const o = occNow().get(hexKey(h)); return isOnMap(g, h) && (!o || o.id === u.id); };

    if (u.size === 1) {
      const target = fp.front.find((h) => free.has(hexKey(h)) && empty(h));
      if (!target) continue;
      free.delete(hexKey(target));
      st = setUnit(st, { ...u, hex: target, engaged: false });
      st = moveLeadersWith(st, startHexes, target, u.side);
      advanced.add(u.id);
      st = log(st, `${u.name} advances after combat into the vacated hex (8.2); it may change facing one vertex (8.22).`, 'info');
      continue;
    }

    // Hoplite Phalanx (8.23): forward with both halves if at least one hex was vacated and both are enterable.
    const base = u.facing * 30;
    const [a, b] = fp.hexes;
    const [left, centre, right] = fp.front;
    const enemyAt = (h: Hex) => { const o = occNow().get(hexKey(h)); return o && o.side !== u.side && !o.eliminated ? o : null; };
    // 8.23: enemy in exactly one side front hex and only the centre vacated -> wheel instead of advancing.
    const wheelCase = free.has(hexKey(centre)) && empty(centre) && (!!enemyAt(left) !== !!enemyAt(right))
      && !free.has(hexKey(left)) && !free.has(hexKey(right));
    const forwards = [-30, 30].map((d) => ({ anchor: neighborAt(a, base + d), nh: [neighborAt(a, base + d), neighborAt(b, base + d)] }))
      .filter((f) => f.nh.every(empty) && f.nh.some((h) => free.has(hexKey(h))));
    if (forwards.length && !wheelCase) {
      const f = forwards[0];
      f.nh.forEach((h) => free.delete(hexKey(h)));
      st = setUnit(st, { ...u, hex: f.anchor, engaged: false });
      st = moveLeadersWith(st, startHexes, f.anchor, u.side);
      advanced.add(u.id);
      st = log(st, `${u.name} advances after combat with both halves (8.23).`, 'info');
      continue;
    }
    // Wheel into the centre front hex (the Theban Massed Phalanx cannot wheel, 9.62).
    if (wheelCase && u.depth !== 4) {
      const blocking = enemyAt(left) ?? enemyAt(right)!;
      // The half facing the enemy stays; the other half swings into the centre hex toward it:
      // enemy on the left -> left half stays (pivotKeepLeft moves the right half into the centre).
      const pv = enemyAt(left) ? pivotKeepLeft(u.hex!, u.facing) : pivotKeepRight(u.hex!, u.facing);
      free.delete(hexKey(centre));
      let hits = u.spartan ? 0 : 1;
      let note = u.spartan ? '' : ' +1 hit (Front-to-Flank)';
      let rollState = st;
      if (blocking.type !== 'SK' && u.depth !== 4) {
        const [r, s1] = roll(st);
        rollState = s1;
        const add = r > u.tq ? Math.max(1, r - u.tq) : 0; // 6.43: only on a failed check
        hits += add;
        note += `; wheeling check ${r} vs ${u.tq}${add ? ` → +${add}` : ' → ok'}`;
      }
      st = rollState;
      let newHits = u.hits + hits;
      if (newHits >= u.tq) { newHits = u.tq - 1; note += ' (capped at TQ−1, 8.21)'; }
      st = setUnit(st, { ...u, hex: pv.anchor, facing: pv.facing, hits: newHits });
      st = moveLeadersWith(st, startHexes, pv.anchor, u.side);
      advanced.add(u.id);
      pivoted.add(u.id);
      st = log(st, `${u.name} wheels into the vacated centre hex (8.23 / 6.43)${note}.`, 'combat');
    }
  }
  return { state: st, advanced, pivoted };
}

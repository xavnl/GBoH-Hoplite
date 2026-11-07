// Position & combat evaluation used by the AI. Pure functions over GameState.
import { attackApproach, canShock, inFrontOf, missileCalc, resolveShock, shockCalc, unitDistance, unitHexes } from '../engine/combat';
import { leadersWith } from '../engine/combatActions';
import { footprint, hexKey, type BoardGeometry, type Hex } from '../engine/hex';
import type { GameState, Unit } from '../engine/types';

export const isLight = (u: Unit) => u.type === 'SK' || u.type === 'LC' || ((u.type === 'LI') && (u.missile === 'B' || u.missile === 'C'));
export const isHeavy = (u: Unit) => u.type === 'HO' || u.type === 'HI' || u.type === 'MI';

export const liveEnemies = (s: GameState, side: Unit['side']) =>
  Object.values(s.units).filter((e) => e.side !== side && !e.eliminated && e.hex);

/** Probability that a missile shot hits, and expected hits. */
export function missileOdds(g: BoardGeometry, firer: Unit, target: Unit): { p: number; ev: number } {
  const c = missileCalc(g, firer, target);
  if (!c.allowed || c.strength == null) return { p: 0, ev: 0 };
  let ev = 0, p = 0;
  for (let dr = 0; dr <= 9; dr++) {
    const adj = dr + c.totalMod;
    if (adj <= c.strength) { p += 0.1; ev += firer.missile === 'C' && c.range === 1 && adj <= 0 ? 0.2 : 0.1; }
  }
  return { p, ev };
}

/**
 * Expected value of a Shock combat for the attacker: (defender hits / defender margin)
 * minus (attacker hits / attacker margin), averaged over the ten die results.
 * Margins make a hit on a fragile unit worth more.
 */
export function shockValue(s: GameState, attackers: Unit[], defenders: Unit[]): number {
  if (!attackers.length || !defenders.length) return 0;
  const calc = shockCalc({
    attackers, defenders, run: attackers.some((a) => a.advance === 'run'),
    attackerLeaders: attackers.flatMap((u) => leadersWith(s, u)), defenderLeaders: defenders.flatMap((u) => leadersWith(s, u)),
  });
  if (!calc.allowed) return -5;
  const margin = (us: Unit[]) => Math.max(1, Math.min(...us.map((u) => u.tq - u.hits)));
  const am = margin(attackers), dm = margin(defenders);
  let v = 0;
  for (let dr = 0; dr <= 9; dr++) {
    const o = resolveShock(calc, attackers, defenders, dr);
    v += (o.defenderHits / dm - o.attackerHits / am) / 10;
  }
  // Rout Points at stake.
  const worth = (us: Unit[]) => us.reduce((t, u) => t + (u.size === 2 ? 2 * u.tq : u.tq), 0);
  return v * (1 + worth(defenders) / 20);
}

/** Enemies of `u` that are in `u`'s front hexes. */
export const enemiesInFront = (s: GameState, u: Unit) => liveEnemies(s, u.side).filter((e) => inFrontOf(u, e));

/** Hexes of u's flank and rear. */
function weakHexes(u: Unit): Set<string> {
  const fp = footprint(u.hex!, u.facing, u.size);
  return new Set([...fp.flank, ...fp.rear].map(hexKey));
}

/**
 * Exposure of a (hypothetical) unit position: enemy shock units close enough to reach its
 * flank or rear hexes next phase, weighted by how dangerous they are.
 */
export function exposure(s: GameState, u: Unit): number {
  const weak = weakHexes(u);
  let risk = 0;
  for (const e of liveEnemies(s, u.side)) {
    if (e.routed || e.engaged || !canShock(e)) continue;
    const reach = e.size === 2 ? 3 : e.ma;
    const d = Math.min(...[...weak].map((k) => { const [q, r] = k.split(',').map(Number); return unitDistance([{ q, r }], unitHexes(e)); }));
    if (d <= reach) risk += (isHeavy(e) ? 1 : 0.5) * (d <= 1 ? 2 : 1);
  }
  return risk;
}

/** Is an ally covering the given hexes (friendly unit adjacent on the flank)? */
export function flankSupport(s: GameState, u: Unit): number {
  const fp = footprint(u.hex!, u.facing, u.size);
  const occ = new Map<string, Unit>();
  for (const f of Object.values(s.units)) if (f.side === u.side && f.id !== u.id && !f.eliminated && f.hex && !f.routed) for (const h of unitHexes(f)) occ.set(hexKey(h), f);
  return fp.flank.filter((h) => occ.has(hexKey(h))).length;
}

export const nearestEnemyDistance = (s: GameState, hexes: Hex[], side: Unit['side'], pred: (e: Unit) => boolean = () => true) => {
  let d = Infinity;
  for (const e of liveEnemies(s, side)) if (!e.routed && pred(e)) d = Math.min(d, unitDistance(hexes, unitHexes(e)));
  return d;
};

export { attackApproach };

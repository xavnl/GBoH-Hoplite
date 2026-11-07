// Orders other than Move/Fire: Disengage (10.32-10.34), Rally (10.42) and Recovery (10.41).
import { missileCalc, unitDistance, unitHexes } from './combat';
import { commandRangeHexes, occupiedBy, unitInRange } from './command';
import { footprint, hexKey, isOnMap, neighbors, type BoardGeometry, type Hex } from './hex';
import { effRating } from './ratings';
import type { GameState, Leader, Unit } from './types';

export const enemiesOf = (s: GameState, u: Unit) =>
  Object.values(s.units).filter((e) => e.side !== u.side && !e.eliminated && e.hex);

export const adjacentToEnemy = (s: GameState, u: Unit) =>
  enemiesOf(s, u).some((e) => unitDistance(unitHexes(e), unitHexes(u)) === 1);

/**
 * Can an enemy missile unit "fire effectively" at `u` (has missiles, not Engaged, in range & arc,
 * and the DRMs do not preclude a hit) — 10.41 / 10.42.
 */
export function underEffectiveFire(s: GameState, g: BoardGeometry, u: Unit): boolean {
  return enemiesOf(s, u).some((e) => {
    if (!e.missile || e.missileSupply === 'no' || e.engaged || e.routed) return false;
    const c = missileCalc(g, e, u);
    return c.allowed && c.strength != null && 0 + c.totalMod <= c.strength;
  });
}

/** Leaders of a command, alive and on the map. */
export function commandLeaders(s: GameState, commandId: string): Leader[] {
  return Object.values(s.leaders).filter((l) => l.commands.includes(commandId) && !l.killed && l.hex);
}

/** Overall Commander of a side, if alive. */
export const overallCommanderOf = (s: GameState, side: Unit['side']) =>
  Object.values(s.leaders).find((l) => l.side === side && l.rank === 'OC' && !l.killed) ?? null;

/** Disengage target number (10.33): Capability/Initiative, + OC Charisma if the leader is the OC or with/adjacent to him. */
export function disengageRating(s: GameState, l: Leader): number {
  const base = effRating(l.initiative, l.wounded);
  const oc = overallCommanderOf(s, l.side);
  if (!oc || !oc.hex || !l.hex) return base;
  const near = oc.id === l.id || unitDistance([oc.hex], [l.hex]) <= 1;
  return near ? base + effRating(oc.charisma ?? 0, oc.wounded) : base;
}

/** Rally target number (10.42): OC Charisma, otherwise Capability. */
export const rallyRating = (l: Leader) => effRating(l.rank === 'OC' ? l.charisma ?? 0 : l.initiative, l.wounded);

/** Units of `commandId` within `l`'s Command Range. */
export function unitsInRange(s: GameState, g: BoardGeometry, l: Leader, commandId: string, pred: (u: Unit) => boolean): Unit[] {
  const range = commandRangeHexes(s, g, l);
  return Object.values(s.units).filter((u) => u.command === commandId && !u.eliminated && u.hex && pred(u) && unitInRange(u, range));
}

/**
 * One-hex Disengage retreat (10.34): away from the Engaged enemy, same facing,
 * not adjacent to any enemy, not into an occupied or off-map hex. Best option first.
 */
export function disengageHex(s: GameState, g: BoardGeometry, u: Unit): Hex | null {
  if (!u.hex) return null;
  const occ = occupiedBy(s);
  const engagedFoes = enemiesOf(s, u).filter((e) => e.engaged && unitDistance(unitHexes(e), unitHexes(u)) === 1);
  const foesHexes = (engagedFoes.length ? engagedFoes : enemiesOf(s, u)).flatMap(unitHexes);
  const enemyAdj = new Set(enemiesOf(s, u).flatMap(unitHexes).flatMap((h) => neighbors(h)).map(hexKey));
  const d0 = unitDistance(unitHexes(u), foesHexes);
  const opts = neighbors({ q: 0, r: 0 }).map((o) => ({ q: u.hex!.q + o.q, r: u.hex!.r + o.r }))
    .map((anchor) => ({ anchor, hs: footprint(anchor, u.facing, u.size).hexes }))
    .filter(({ hs }) => hs.every((h) => {
      const o = occ.get(hexKey(h));
      return isOnMap(g, h) && (!o || o.id === u.id) && !enemyAdj.has(hexKey(h));
    }))
    .filter(({ hs }) => unitDistance(hs, foesHexes) > d0)
    .sort((a, b) => unitDistance(b.hs, foesHexes) - unitDistance(a.hs, foesHexes));
  return opts[0]?.anchor ?? null;
}

export interface RallyEligibility { ok: boolean; reason?: string }

export function rallyEligible(s: GameState, g: BoardGeometry, u: Unit, l: Leader | null): RallyEligibility {
  if (!u.routed || u.eliminated) return { ok: false, reason: 'not routed' };
  if (u.rallied) return { ok: false, reason: 'already rallied' };
  if (l && !unitInRange(u, commandRangeHexes(s, g, l))) return { ok: false, reason: `out of ${l.name}'s range` };
  if (adjacentToEnemy(s, u)) return { ok: false, reason: 'adjacent to an enemy' };
  if (underEffectiveFire(s, g, u)) return { ok: false, reason: 'within enemy missile range' };
  return { ok: true };
}

export interface RecoveryCheck { hits: number; reason?: string }

/** How many hits Recovery would remove (10.41), or 0 with the reason. Clear terrain assumed (Nemea). */
export function recoveryAmount(s: GameState, g: BoardGeometry, u: Unit): RecoveryCheck {
  if (u.hits === 0) return { hits: 0, reason: 'no hits' };
  if (u.routed || u.engaged) return { hits: 0, reason: u.routed ? 'routed' : 'engaged' };
  if (s.orders && s.orders !== 'move') return { hits: 0, reason: 'only under Move/Fire orders' };
  const act = s.activity?.[u.id];
  if (act) return { hits: 0, reason: `already ${act} this phase` };
  if (u.outOfCommand) return { hits: 0, reason: 'Out of Command' };
  if (s.active?.kind === 'command' && s.active.command !== u.command) return { hits: 0, reason: 'its Command is not active' };
  if (adjacentToEnemy(s, u)) return { hits: 0, reason: 'adjacent to an enemy' };
  return { hits: Math.min(u.hits, underEffectiveFire(s, g, u) ? 1 : 2) };
}

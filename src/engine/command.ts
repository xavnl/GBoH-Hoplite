// Command Range (5.42) and In Command status (5.41, 5.51).
import { footprint, hexKey, isOnMap, neighbors, type BoardGeometry, type Hex } from './hex';
import { effRating } from './ratings';
import type { GameState, Leader, Unit } from './types';

export function occupiedBy(s: GameState): Map<string, Unit> {
  const m = new Map<string, Unit>();
  for (const u of Object.values(s.units)) {
    if (!u.hex || u.eliminated) continue;
    for (const h of footprint(u.hex, u.facing, u.size).hexes) m.set(hexKey(h), u);
  }
  return m;
}

/** Hexes reachable within `range` steps from `from`, not passing through enemy-occupied hexes. key -> steps */
export function tracePath(s: GameState, g: BoardGeometry, from: Hex, side: Unit['side'], range: number): Map<string, number> {
  const occ = occupiedBy(s);
  const dist = new Map<string, number>([[hexKey(from), 0]]);
  let frontier = [from];
  for (let step = 1; step <= range; step++) {
    const next: Hex[] = [];
    for (const h of frontier) {
      for (const n of neighbors(h)) {
        const k = hexKey(n);
        if (dist.has(k) || !isOnMap(g, n)) continue;
        const o = occ.get(k);
        dist.set(k, step);
        // An enemy-occupied hex obstructs the path: it can be reached but not traced through.
        if (o && o.side !== side) continue;
        next.push(n);
      }
    }
    frontier = next;
  }
  return dist;
}

/** Effective command range: wounded −2, halved (round down) if stacked with an Engaged unit (5.43). */
export function effectiveRange(s: GameState, l: Leader): number {
  let r = effRating(l.range, l.wounded);
  if (l.hex) {
    const occ = occupiedBy(s).get(hexKey(l.hex));
    if (occ && occ.engaged) r = Math.floor(r / 2);
  }
  return r;
}

export function commandRangeHexes(s: GameState, g: BoardGeometry, l: Leader, range = effectiveRange(s, l)): Map<string, number> {
  if (!l.hex || l.killed) return new Map();
  const m = tracePath(s, g, l.hex, l.side, range);
  m.delete(hexKey(l.hex)); // the leader's own hex is not counted (but a unit there is in range)
  m.set(hexKey(l.hex), 0);
  return m;
}

export const unitInRange = (u: Unit, hexes: Map<string, number>) =>
  !!u.hex && footprint(u.hex, u.facing, u.size).hexes.some((h) => hexes.has(hexKey(h)));

function adjacentUnits(a: Unit, b: Unit): boolean {
  const ah = footprint(a.hex!, a.facing, a.size).hexes;
  const bh = new Set(footprint(b.hex!, b.facing, b.size).hexes.map(hexKey));
  return ah.some((h) => neighbors(h).some((n) => bh.has(hexKey(n))));
}

/**
 * In Command status for every unit of a command, computed as at the start of an Orders Phase.
 * Led commands: within range of one of its Formation Commanders, or adjacent to another
 * In Command unit of the command (chain, 5.41). Leaderless commands (5.51): within two hexes
 * of another unit of the command.
 */
export function commandStatus(s: GameState, g: BoardGeometry, commandId: string): Record<string, boolean> {
  const cmd = s.commands.find((c) => c.id === commandId);
  const units = Object.values(s.units).filter((u) => u.command === commandId && u.hex && !u.eliminated && !u.routed);
  const status: Record<string, boolean> = Object.fromEntries(units.map((u) => [u.id, false]));
  if (!cmd) return status;

  if (cmd.leaderless) {
    for (const u of units) {
      const reaches = footprint(u.hex!, u.facing, u.size).hexes.map((h) => tracePath(s, g, h, u.side, 2));
      status[u.id] = units.some((o) => o.id !== u.id && reaches.some((r) => unitInRange(o, r)));
    }
    return status;
  }

  const leaders = Object.values(s.leaders).filter((l) => l.commands.includes(commandId) && !l.killed && l.hex);
  for (const l of leaders) {
    const hexes = commandRangeHexes(s, g, l);
    for (const u of units) if (unitInRange(u, hexes)) status[u.id] = true;
  }
  // Chain: adjacent to an In Command unit of the same command.
  let changed = true;
  while (changed) {
    changed = false;
    for (const u of units) {
      if (status[u.id]) continue;
      if (units.some((o) => status[o.id] && adjacentUnits(u, o))) { status[u.id] = true; changed = true; }
    }
  }
  return status;
}

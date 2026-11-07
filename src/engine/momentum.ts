// Momentum (5.24), Trump activation (5.32) and leader replacement (4.23-4.25).
import { unitDistance, unitHexes } from './combat';
import { commandRangeHexes, effectiveRange, occupiedBy } from './command';
import { hexKey, hexToPixel, type BoardGeometry, type Hex } from './hex';
import { effRating } from './ratings';
import type { GameState, Leader, SideId, Unit } from './types';

export interface CommandOption {
  commandId: string;
  /** Leader whose rating is used (null = Leaderless Command, rating 0). */
  leaderId: string | null;
  rating: number;
  note?: string;
}

export const overallCommander = (s: GameState, side: SideId): Leader | null =>
  Object.values(s.leaders).find((l) => l.side === side && l.rank === 'OC' && !l.killed && l.hex) ?? null;

/** Is the leader within the OC's Command Range (5.42)? */
function inOcRange(s: GameState, g: BoardGeometry, oc: Leader, l: Leader): boolean {
  if (!l.hex) return false;
  if (l.id === oc.id) return true;
  return commandRangeHexes(s, g, oc).has(hexKey(l.hex));
}

/**
 * Commands the side may designate for Momentum or activate after a successful Trump:
 * the OC's own command, or one whose Formation Commander is within the OC's range (5.24, 5.32, 5.52).
 * Leaderless commands may be chosen (rating 0; only their units within the OC's range activate, 5.51).
 * Commands whose only leader was killed and not yet replaced cannot (4.25).
 */
export function eligibleCommands(s: GameState, g: BoardGeometry, side: SideId): CommandOption[] {
  const oc = overallCommander(s, side);
  if (!oc) return []; // 4.24: no Momentum or Trump without an OC
  const out: CommandOption[] = [];
  for (const c of s.commands.filter((x) => x.side === side)) {
    const hasUnits = Object.values(s.units).some((u) => u.command === c.id && !u.eliminated && u.hex);
    if (!hasUnits) continue;
    if (c.leaderless) {
      out.push({ commandId: c.id, leaderId: null, rating: 0, note: "only units within the OC's range activate" });
      continue;
    }
    const leaders = Object.values(s.leaders).filter((l) => l.commands.includes(c.id) && !l.killed && l.hex);
    if (leaders.some((l) => l.id === oc.id)) {
      // 5.52: if the OC is one of the leaders, he must be used.
      out.push({ commandId: c.id, leaderId: oc.id, rating: effRating(oc.initiative, oc.wounded) });
      continue;
    }
    const inRange = leaders.filter((l) => inOcRange(s, g, oc, l)).sort((a, b) => effRating(b.initiative, b.wounded) - effRating(a.initiative, a.wounded));
    if (inRange.length) out.push({ commandId: c.id, leaderId: inRange[0].id, rating: effRating(inRange[0].initiative, inRange[0].wounded) });
  }
  return out;
}

/** Units of a Leaderless Command that may act when activated through Momentum/Trump (within the OC's range). */
export function leaderlessActive(s: GameState, g: BoardGeometry, commandId: string, side: SideId): Set<string> {
  const oc = overallCommander(s, side);
  const ids = new Set<string>();
  if (!oc) return ids;
  const range = commandRangeHexes(s, g, oc, effectiveRange(s, oc));
  for (const u of Object.values(s.units)) {
    if (u.command === commandId && u.hex && !u.eliminated && unitHexes(u).some((h) => range.has(hexKey(h)))) ids.add(u.id);
  }
  return ids;
}

/** Can this side attempt a Trump now (5.31, 5.33, 4.24)? */
export function canTrump(s: GameState, side: SideId): string | null {
  if (s.trumpUsed[side]) return 'already used this turn';
  const oc = overallCommander(s, side);
  if (!oc) return 'no Overall Commander';
  const occ = occupiedBy(s).get(hexKey(oc.hex!));
  if (occ && occ.engaged) return 'OC stacked with an Engaged unit (5.33)';
  return null;
}

// ---------------------------------------------------------------------------
// Leaders
// ---------------------------------------------------------------------------

/** Nearest friendly combat unit's hex (4.23). */
export function nearestFriendlyHex(s: GameState, g: BoardGeometry, l: Leader, exclude: Set<string> = new Set()): Hex | null {
  if (!l.hex) return null;
  const p = hexToPixel(g, l.hex);
  let best: Hex | null = null, bd = Infinity;
  for (const u of Object.values(s.units)) {
    if (u.side !== l.side || u.eliminated || !u.hex || u.routed || exclude.has(u.id)) continue;
    for (const h of unitHexes(u)) {
      const q = hexToPixel(g, h);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd) { bd = d; best = h; }
    }
  }
  return best;
}

/** Leaders alone in a hex that an enemy unit is now adjacent to (4.23). */
export function exposedLeaders(s: GameState, mover: Unit): Leader[] {
  const occ = occupiedBy(s);
  const mh = unitHexes(mover);
  return Object.values(s.leaders).filter((l) =>
    l.side !== mover.side && !l.killed && l.hex && !occ.has(hexKey(l.hex)) && unitDistance([l.hex], mh) <= 1);
}

/** Best unit of the command to receive a replacement leader: the most central one. */
export function replacementHost(s: GameState, g: BoardGeometry, commandIds: string[]): Unit | null {
  const units = Object.values(s.units).filter((u) => commandIds.includes(u.command) && u.hex && !u.eliminated && !u.routed);
  if (!units.length) return null;
  const pts = units.map((u) => hexToPixel(g, unitHexes(u)[0]));
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  return units.map((u, i) => ({ u, d: Math.hypot(pts[i].x - cx, pts[i].y - cy) })).sort((a, b) => a.d - b.d)[0].u;
}

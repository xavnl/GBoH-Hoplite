// Reactions of the inactive side to enemy movement and fire:
//  - Orderly Withdrawal (6.6) and Pre-arranged Withdrawal (6.7)
//  - Reaction Facing (6.94) and Reverse Face reaction of a phalanx (6.95)
//  - Entry / Retire reaction fire (7.31, 7.34) and Return Fire (7.35)
// Detection is pure; the reducer offers the reactions and applies the one the player picks.
import { commandRangeHexes, occupiedBy, unitInRange } from './command';
import { hexesInFireArc, inFireArc, unitDistance, unitHexes } from './combat';
import { dirVector, footprint, hexKey, hexToPixel, isOnMap, neighbors, type BoardGeometry, type Hex } from './hex';
import { movementAllowance } from './movement';
import { missileMaxRange } from './tables';
import type { GameState, Reaction, Unit } from './types';

const isInfantry = (u: Unit) => u.type === 'HO' || u.type === 'HI' || u.type === 'MI' || u.type === 'LI' || u.type === 'PL' || u.type === 'SK';
const isCavalry = (u: Unit) => u.type === 'LC' || u.type === 'HC';

const minDist = (a: Hex[], b: Hex[]) => unitDistance(a, b);
const adjacentHexes = (a: Hex[], b: Hex[]) => minDist(a, b) === 1;

/** Approach sector of `hexes` relative to `u`'s facing (6.62[2]); boundaries go to the more forward sector. */
export function approachSector(g: BoardGeometry, u: Unit, hexes: Hex[]): 'front' | 'flank' | 'rear' {
  const mine = unitHexes(u).map((h) => hexToPixel(g, h));
  const c = { x: mine.reduce((s, p) => s + p.x, 0) / mine.length, y: mine.reduce((s, p) => s + p.y, 0) / mine.length };
  // nearest mover hex
  let best = hexToPixel(g, hexes[0]), bd = Infinity;
  for (const h of hexes) { const p = hexToPixel(g, h); const d = Math.hypot(p.x - c.x, p.y - c.y); if (d < bd) { bd = d; best = p; } }
  const dir = dirVector(u.facing * 30);
  const v = { x: best.x - c.x, y: best.y - c.y };
  const ang = (Math.acos(Math.max(-1, Math.min(1, (v.x * dir.x + v.y * dir.y) / (Math.hypot(v.x, v.y) || 1)))) * 180) / Math.PI;
  if (ang <= 60 + 1e-6) return 'front';
  if (ang <= 120 + 1e-6) return 'flank';
  return 'rear';
}

/** Orderly Withdrawal eligibility of `r` against the approaching `mover` (6.61, 6.23, 9.11, 9.33). */
export function owAllowance(r: Unit, mover: Unit): number {
  if (r.routed || r.engaged || r.advance) return 0;
  const rm = movementAllowance(r), mm = movementAllowance(mover);
  if (r.type === 'SK') return rm >= mm ? 2 : 0;
  return Math.max(0, rm - mm);
}

let seq = 0;
const rid = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Reactions triggered by `mover` moving along `trail` (hexes occupied at each step, start first).
 */
export function detectMoveReactions(s: GameState, g: BoardGeometry, moverId: string, trail: Hex[][]): Reaction[] {
  const mover = s.units[moverId];
  if (!mover || trail.length < 2) return [];
  const out: Reaction[] = [];
  const pwLeaders = new Set<string>();

  for (const r of Object.values(s.units)) {
    if (r.side === mover.side || r.eliminated || !r.hex || r.routed) continue;
    const rh = unitHexes(r);
    const dists = trail.map((t) => minDist(t, rh));
    const firstNear = dists.findIndex((d) => d <= 2);

    // Orderly Withdrawal (6.61): mover starts in or moves into a 2-hex range.
    const mp = owAllowance(r, mover);
    if (mp > 0 && firstNear >= 0 && dists[dists.length - 1] > 0) {
      const sector = approachSector(g, r, trail[firstNear]);
      out.push({ id: rid(), kind: 'withdraw', reactorId: r.id, moverId, mp, approach: sector });
    }

    // Pre-arranged Withdrawal (6.73): enemy INFANTRY triggers it for hoplites under a PW order.
    const commandAdvancing = Object.values(s.units).some((u) => u.command === r.command && !u.eliminated && u.advance);
    if (isInfantry(mover) && firstNear >= 0 && r.type === 'HO' && r.tq >= 6 && !r.engaged && !r.outOfCommand && !commandAdvancing) {
      for (const l of Object.values(s.leaders)) {
        if (!s.pwOrders?.[l.id] || l.side !== r.side || !l.commands.includes(r.command) || pwLeaders.has(l.id)) continue;
        if (!unitInRange(r, commandRangeHexes(s, g, l))) continue;
        pwLeaders.add(l.id);
        out.push({ id: rid(), kind: 'pw', reactorId: r.id, moverId, leaderId: l.id });
      }
    }

    if (r.engaged) continue;
    const firstAdj = dists.findIndex((d) => d === 1);

    // Reaction facing (6.94) / reverse face (6.95)
    if (firstAdj >= 1) {
      if (r.size === 2) {
        const rear = new Set(footprint(r.hex, r.facing, 2).rear.map(hexKey));
        if (trail.slice(1).some((t) => t.some((h) => rear.has(hexKey(h))))) {
          out.push({ id: rid(), kind: 'reverseFace', reactorId: r.id, moverId });
        }
      } else {
        out.push({ id: rid(), kind: 'facing', reactorId: r.id, moverId });
      }
    }

    // Reaction fire (7.3)
    if (r.missile && r.missileSupply !== 'no') {
      // The hex adjacent to the firer must itself be one of its front/flank hexes (7.13).
      const arcAdj = (t: Hex[]) => t.some((h) => minDist([h], rh) === 1 && hexesInFireArc(g, r, [h]));
      const entry = trail.slice(1).some(arcAdj);
      if (entry) out.push({ id: rid(), kind: 'entryFire', reactorId: r.id, moverId, range: 1 });
      if (missileMaxRange(r.missile) >= 2) {
        for (let i = 0; i + 1 < trail.length; i++) {
          if (arcAdj(trail[i]) && !adjacentHexes(trail[i + 1], rh)) {
            out.push({ id: rid(), kind: 'retireFire', reactorId: r.id, moverId, range: 2 });
            break;
          }
        }
      }
    }
  }
  return out;
}

/** Return Fire (7.35): the target of an active unit's fire may fire back if able. */
export function detectReturnFire(s: GameState, g: BoardGeometry, firerId: string, targetId: string): Reaction[] {
  const firer = s.units[firerId], t = s.units[targetId];
  if (!firer || !t || t.eliminated || t.routed || t.engaged || !t.missile || t.missileSupply === 'no') return [];
  const range = unitDistance(unitHexes(t), unitHexes(firer));
  if (range > missileMaxRange(t.missile) || !inFireArc(g, t, firer)) return [];
  return [{ id: rid(), kind: 'returnFire', reactorId: t.id, moverId: firerId }];
}

// ---------------------------------------------------------------------------
// Withdrawal destinations
// ---------------------------------------------------------------------------

export interface WithdrawDest {
  anchor: Hex;
  mp: number;
  hexes: Hex[];
  /** Friendly units moved through on the way (6.83: +1 MP; 1 hit to the Hoplite involved). */
  through: string[];
}

/**
 * Positions reachable by withdrawing `mp` Movement Points away from the mover, keeping facing
 * (6.61, 6.62, 6.65): each hex entered must be farther from the mover than the one left;
 * not adjacent to an enemy, not occupied (stacking), on the map (clear terrain only for now).
 */
export function withdrawDestinations(s: GameState, g: BoardGeometry, r: Unit, mover: Unit, mp: number): WithdrawDest[] {
  if (!r.hex) return [];
  const occ = occupiedBy(s);
  const mh = unitHexes(mover);
  const enemyAdj = new Set<string>();
  for (const e of Object.values(s.units)) {
    if (e.side === r.side || e.eliminated || !e.hex) continue;
    for (const h of unitHexes(e)) for (const n of neighbors(h)) enemyAdj.add(hexKey(n));
  }
  const fpAt = (anchor: Hex) => footprint(anchor, r.facing, r.size).hexes;
  /** Friendly units in the hexes, or null if a hex cannot be entered at all. */
  const entry = (hs: Hex[]): Unit[] | null => {
    const friends: Unit[] = [];
    for (const h of hs) {
      if (!isOnMap(g, h) || enemyAdj.has(hexKey(h))) return null;
      const o = occ.get(hexKey(h));
      if (!o || o.id === r.id) continue;
      if (o.side !== r.side || o.engaged || o.depth === 4) return null;
      if (r.type === 'HO' && o.type === 'HO') return null; // never hoplite through hoplite (6.83)
      if (!friends.includes(o)) friends.push(o);
    }
    return friends;
  };
  const offsets = neighbors({ q: 0, r: 0 });
  type Node = WithdrawDest & { endable: boolean };
  const best = new Map<string, Node>([[hexKey(r.hex), { anchor: r.hex, mp: 0, hexes: fpAt(r.hex), through: [], endable: false }]]);
  const queue: Node[] = [best.get(hexKey(r.hex))!];
  while (queue.length) {
    queue.sort((x, y) => x.mp - y.mp);
    const cur = queue.shift()!;
    const d0 = minDist(cur.hexes, mh);
    for (const o of offsets) {
      const anchor = { q: cur.anchor.q + o.q, r: cur.anchor.r + o.r };
      const hs = fpAt(anchor);
      if (minDist(hs, mh) <= d0) continue; // each hex entered must be farther from the mover (6.61)
      const friends = entry(hs);
      if (!friends) continue;
      const cost = cur.mp + 1 + (friends.length ? 1 : 0);
      if (cost > mp) continue;
      const k = hexKey(anchor);
      const prev = best.get(k);
      if (prev && prev.mp <= cost) continue;
      const n: Node = { anchor, mp: cost, hexes: hs, through: [...cur.through, ...friends.map((f) => f.id)], endable: !friends.length };
      best.set(k, n);
      queue.push(n);
    }
  }
  const edge = s.sides[r.side].retreatEdge;
  const edgeScore = (h: Hex) => { const p = hexToPixel(g, h); return edge === 'top' ? -p.y : edge === 'bottom' ? p.y : edge === 'left' ? -p.x : p.x; };
  return [...best.values()].filter((n) => n.endable).map((n) => ({ anchor: n.anchor, mp: n.mp, hexes: n.hexes, through: n.through })).sort((a, b) => minDist(b.hexes, mh) - minDist(a.hexes, mh) || edgeScore(b.anchor) - edgeScore(a.anchor));
}

/** Units that withdraw together under a Pre-arranged Withdrawal order (6.73). */
export function pwUnits(s: GameState, g: BoardGeometry, leaderId: string): Unit[] {
  const l = s.leaders[leaderId];
  if (!l) return [];
  const range = commandRangeHexes(s, g, l);
  return Object.values(s.units).filter((u) => u.side === l.side && l.commands.includes(u.command) && u.type === 'HO' && u.tq >= 6 &&
    !u.engaged && !u.routed && !u.eliminated && !u.advance && unitInRange(u, range));
}

export { isCavalry, isInfantry };

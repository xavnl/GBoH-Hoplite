import type { GameState, Leader, SideId, Unit } from './types';

/** Rout Point value of a combat unit (rule 11.0). */
export function unitRoutPoints(u: Unit): number {
  if (u.type === 'SK') return 1;
  if (u.type === 'CH') return 2;
  if (u.depth === 4) return u.tq * 3; // Theban Massed Phalanx
  if (u.size === 2) return u.tq * 2; // Hoplite Phalanx
  return u.tq;
}

/** Rout Point value of a killed leader (rule 11.0). */
export function leaderRoutPoints(l: Leader): number {
  if (!l.countsForRP) return 0;
  return l.rank === 'OC' ? 5 * (l.charisma ?? 0) : l.initiative;
}

export function sideRoutPoints(s: GameState, side: SideId): number {
  let total = 0;
  for (const u of Object.values(s.units)) if (u.side === side && u.eliminated) total += unitRoutPoints(u);
  for (const l of Object.values(s.leaders)) if (l.side === side && l.killed) total += leaderRoutPoints(l);
  return total;
}

// Standard Charts & Tables transcribed from the Hoplite player aid cards.
// (The "Simple GBoH" cards are a different, optional system and are NOT used.)
import type { AdvanceRate, MissileClass, UnitType } from './types';

// ---------------------------------------------------------------------------
// Shock Combat Results Table (8.43): [attacker hits, defender hits]
// Rows: DR <0, 0..9, >=10. Columns 1..13.
// ---------------------------------------------------------------------------
type R = [number, number];
const row = (s: string): R[] => s.trim().split(/\s+/).map((c) => {
  const m = /^(\d+)\((\d+)\)$/.exec(c);
  if (!m) throw new Error(`bad CRT cell ${c}`);
  return [Number(m[1]), Number(m[2])];
});

export const SHOCK_CRT: R[][] = [
  row('6(0) 5(1) 4(1) 4(1) 3(1) 3(1) 3(1) 3(1) 3(1) 3(1) 2(1) 2(1) 2(1)'), // < 0
  row('6(1) 5(2) 4(2) 3(2) 3(2) 3(2) 3(2) 3(2) 3(2) 3(2) 2(2) 2(2) 2(2)'), // 0
  row('6(1) 4(2) 4(2) 3(2) 3(2) 3(2) 3(2) 3(2) 3(2) 2(2) 2(2) 2(3) 2(3)'), // 1
  row('5(1) 4(2) 4(2) 3(2) 3(2) 3(2) 2(2) 2(2) 2(2) 2(2) 2(3) 2(3) 2(3)'), // 2
  row('5(1) 4(2) 4(2) 3(2) 3(2) 2(2) 2(2) 2(2) 2(2) 2(2) 2(3) 2(3) 2(3)'), // 3
  row('5(2) 4(2) 3(2) 3(2) 3(2) 2(2) 2(2) 2(2) 2(3) 2(3) 2(3) 2(4) 1(3)'), // 4
  row('4(2) 4(2) 3(2) 3(2) 2(2) 2(2) 2(2) 2(3) 2(3) 2(3) 2(3) 2(4) 1(4)'), // 5
  row('4(2) 4(2) 3(2) 2(2) 2(2) 2(2) 2(2) 2(3) 2(3) 2(3) 2(4) 2(4) 1(4)'), // 6
  row('4(2) 4(2) 3(2) 2(2) 2(2) 2(3) 2(3) 2(3) 2(3) 2(3) 2(4) 1(4) 1(4)'), // 7
  row('4(2) 3(2) 2(2) 2(2) 2(2) 2(3) 2(3) 2(3) 2(3) 2(4) 2(4) 1(4) 1(5)'), // 8
  row('3(2) 3(2) 2(2) 2(2) 2(3) 2(4) 2(4) 2(4) 2(4) 2(4) 1(4) 1(4) 0(5)'), // 9
  row('2(2) 2(2) 1(2) 1(2) 1(3) 1(4) 1(4) 1(4) 1(4) 1(4) 0(4) 0(5) 0(6)'), // >= 10
];
export const CRT_MIN_COL = 1;
export const CRT_MAX_COL = 13;

export function shockCrt(column: number, modifiedDr: number): R {
  const col = Math.min(CRT_MAX_COL, Math.max(CRT_MIN_COL, column));
  const r = modifiedDr < 0 ? 0 : modifiedDr >= 10 ? 11 : modifiedDr + 1;
  return SHOCK_CRT[r][col - 1];
}

// ---------------------------------------------------------------------------
// Comparative Weapons System Chart (8.41): base CRT column [defender][attacker].
// null = not allowed. LI and PL share a row/column.
// ---------------------------------------------------------------------------
const ATK_ORDER = ['HO', 'HI', 'MI', 'LI', 'SK', 'HC', 'LC', 'CH'] as const;
const cws = (vals: (number | null)[]) => Object.fromEntries(ATK_ORDER.map((k, i) => [k, vals[i]]));
const X = null;
const CWS_ROWS: Record<string, Record<string, number | null>> = {
  HO: cws([7, 6, 4, 2, X, 5, 2, 2]),
  HI: cws([8, 7, 5, 3, X, 5, 3, 3]),
  MI: cws([9, 8, 7, 5, X, 7, 5, 7]),
  LI: cws([10, 10, 9, 7, X, 9, 6, 5]),
  SK: cws([13, 13, 11, 9, X, 11, 9, 9]),
  HC: cws([9, 8, 7, 6, X, 7, 5, 2]),
  LC: cws([11, 10, 8, 8, X, 9, 7, 3]),
  CH: cws([5, 5, 3, 9, 9, 3, 9, 7]),
};
const lipl = (t: UnitType) => (t === 'PL' ? 'LI' : t);

export function cwsColumn(attacker: UnitType, defender: UnitType): number | null {
  return CWS_ROWS[lipl(defender)][lipl(attacker)] ?? null;
}

// ---------------------------------------------------------------------------
// Shock Superiority Chart (8.42): [defender][attacker] -> 'AS' | 'DS' | null. 'X' = not allowed.
// ---------------------------------------------------------------------------
export type Superiority = 'AS' | 'DS' | null;
const SUP_ATK = ['HO', 'HI', 'MI', 'LI', 'PL', 'SK', 'HC', 'LC', 'CH'] as const;
const sup = (s: string) => Object.fromEntries(s.trim().split(/\s+/).map((v, i) => [SUP_ATK[i], v === '-' ? null : v]));
const SUPERIORITY: Record<string, Record<string, string | null>> = {
  HO: sup('-  -  -  DS DS X  DS DS DS'),
  HI: sup('-  -  -  DS -  X  -  DS -'),
  MI: sup('AS -  -  -  -  X  -  DS -'),
  LI: sup('AS AS -  -  -  X  -  -  -'),
  PL: sup('AS AS -  -  -  X  DS DS DS'),
  SK: sup('AS AS AS AS AS X  AS AS AS'),
  HC: sup('-  -  -  DS -  X  -  -  -'),
  LC: sup('-  -  -  -  -  X  AS -  -'),
  CH: sup('-  -  -  AS -  AS -  -  -'),
};

export function weaponSuperiority(attacker: UnitType, defender: UnitType): Superiority {
  const v = SUPERIORITY[defender][attacker];
  return v === 'AS' || v === 'DS' ? v : null;
}

// ---------------------------------------------------------------------------
// Missile Range & Results Table (7.41). Value = hit if adjusted DR <= value.
// 'two' = a result of 0 or less inflicts 2 hits (the 6* entry).
// ---------------------------------------------------------------------------
export const MISSILE_RANGE: Record<MissileClass, (number | null)[]> = {
  C: [6, 4, 1],
  B: [5, 2, null],
  J: [4, null, null],
  S: [5, null, null],
};
export const missileMaxRange = (m: MissileClass) => MISSILE_RANGE[m].filter((v) => v != null).length;
/** Range-1 Composite Bow inflicts 2 hits on an adjusted DR of 0 or less. */
export const missileDoubleHit = (m: MissileClass, range: number, adjDr: number) => m === 'C' && range === 1 && adjDr <= 0;

// Fire vs. Armor Effects Chart (7.42): DRM by target type [C, B, J, S].
export function fireVsArmor(m: MissileClass, target: UnitType, phalanx: boolean): number {
  const col = { C: 0, B: 1, J: 2, S: 3 }[m];
  const table: Record<string, number[]> = {
    PHALANX: [2, 2, 0, 0],
    HI: [1, 1, 0, 0], // HI and single-sized Hoplite Infantry
    HC: [0, 1, -1, -1],
    MI: [-1, 0, -1, -1], // MI, PL, LC
    LI: [-1, -1, -1, -1],
    SK: [1, 1, 0, 1],
    CH: [-1, 0, -1, 0],
  };
  let key: string;
  if (target === 'HO') key = phalanx ? 'PHALANX' : 'HI';
  else if (target === 'HI') key = 'HI';
  else if (target === 'MI' || target === 'PL' || target === 'LC') key = 'MI';
  else key = target;
  return table[key][col];
}

/** Missile Availability (7.16): unadjusted DR that makes the unit Missile Low. */
export const missileLowOn = (m: MissileClass, dr: number) => (m === 'J' ? dr >= 7 : dr === 9);

// ---------------------------------------------------------------------------
// Hoplite Advance to Combat Table (6.38)
// ---------------------------------------------------------------------------
export function advanceRate(modifiedDr: number): AdvanceRate {
  if (modifiedDr <= 1) return 'walk';
  if (modifiedDr <= 6) return 'trot';
  return 'run';
}
export const ADVANCE_MA: Record<AdvanceRate, number> = { walk: 3, trot: 4, run: 5 };

// ---------------------------------------------------------------------------
// Personal Combat Differential (8.45)
// ---------------------------------------------------------------------------
export type PersonalResult = 'none' | 'stunned' | 'wounded' | 'killed';
export function personalCombat(diff: number): PersonalResult {
  if (diff <= 0) return 'none';
  if (diff <= 2) return 'stunned';
  if (diff <= 6) return 'wounded';
  return 'killed';
}

// ---------------------------------------------------------------------------
// Movement Cost Chart (6.37) — terrain entries used by the movement engine.
// mp: MP to enter (or extra MP for hexsides/elevation, flagged `additive`).
// hits: cohesion hits for [infantry (non-SK), SK, cavalry & leaders, chariots]; 'P' prohibited.
// ---------------------------------------------------------------------------
export type Terrain = 'clear' | 'woods' | 'rocky' | 'marsh' | 'sea';
export type Cost = number | 'P';
export const TERRAIN_COSTS: Record<Terrain, { mp: Cost; hits: [Cost, Cost, Cost, Cost] }> = {
  clear: { mp: 1, hits: [0, 0, 0, 0] },
  woods: { mp: 2, hits: [1, 0, 1, 'P'] },
  rocky: { mp: 2, hits: [1, 0, 1, 'P'] },
  marsh: { mp: 2, hits: [1, 1, 1, 'P'] },
  sea: { mp: 'P', hits: ['P', 'P', 'P', 'P'] },
};

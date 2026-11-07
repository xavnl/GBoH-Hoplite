// Missile (7.0) and Shock (8.0) combat computations. Pure functions: they describe what
// the rules say should happen for a given set of units and die rolls; the reducer applies it.
import { dirVector, distance, footprint, hexToPixel, type BoardGeometry, type Hex } from './hex';
import {
  cwsColumn, fireVsArmor, missileDoubleHit, missileMaxRange, MISSILE_RANGE, shockCrt, weaponSuperiority,
  type Superiority,
} from './tables';
import type { Leader, Unit, UnitType } from './types';

export interface Modifier { label: string; value: number }

// ============================================================================
// Missile fire
// ============================================================================

export interface MissileContext {
  firerMoved?: boolean; // Skirmisher archer/slinger that moved / will move (+1)
  targetInWoods?: boolean;
  targetLowerElevation?: boolean; // and range >= 2 (-1)
  targetLockedShieldsFront?: boolean; // +2
  targetChargeFormation?: boolean; // -1
  /** Reaction fire resolved at a fixed range (Entry 1, Retire/Withdrawal 2: 7.33); arc already checked. */
  rangeOverride?: number;
}

export interface MissileCalc {
  allowed: boolean;
  reasons: string[];
  range: number;
  strength: number | null;
  mods: Modifier[];
  totalMod: number;
}

/** Shortest hex distance between any hex of `a` and any hex of `b`. */
export function unitDistance(a: Hex[], b: Hex[]): number {
  let best = Infinity;
  for (const x of a) for (const y of b) best = Math.min(best, distance(x, y));
  return best;
}

export function unitHexes(u: Unit): Hex[] {
  return u.hex ? footprint(u.hex, u.facing, u.size).hexes : [];
}

/** Is any hex of `target` inside the firer's front + flank arc (7.13)? Chariots fire all around. */
export function inFireArc(g: BoardGeometry, firer: Unit, target: Unit): boolean {
  return hexesInFireArc(g, firer, unitHexes(target));
}

export function hexesInFireArc(g: BoardGeometry, firer: Unit, th: Hex[]): boolean {
  if (firer.type === 'CH') return true;
  const fp = footprint(firer.hex!, firer.facing, firer.size);
  const adj = [...fp.front, ...fp.flank];
  if (th.some((h) => adj.some((a) => a.q === h.q && a.r === h.r))) return true;
  // Beyond adjacency: the LOS must leave through a front/flank hexside, i.e. within ±120° of facing.
  const fc = fp.hexes.map((h) => hexToPixel(g, h));
  const src = { x: fc.reduce((s, p) => s + p.x, 0) / fc.length, y: fc.reduce((s, p) => s + p.y, 0) / fc.length };
  const dir = dirVector(firer.facing * 30);
  return th.some((h) => {
    const p = hexToPixel(g, h);
    const v = { x: p.x - src.x, y: p.y - src.y };
    const len = Math.hypot(v.x, v.y) || 1;
    const cos = (v.x * dir.x + v.y * dir.y) / len;
    return cos >= Math.cos((120 * Math.PI) / 180) - 1e-6;
  });
}

export function missileCalc(g: BoardGeometry, firer: Unit, target: Unit, ctx: MissileContext = {}): MissileCalc {
  const reasons: string[] = [];
  const range = ctx.rangeOverride ?? unitDistance(unitHexes(firer), unitHexes(target));
  const m = firer.missile;
  if (!m) reasons.push('Firer has no missile capability.');
  if (firer.missileSupply === 'no') reasons.push('Firer is Missile No.');
  if (firer.routed) reasons.push('Routed units cannot fire.');
  if (firer.engaged) reasons.push('Engaged units cannot fire (10.31).');
  if (target.engaged) reasons.push('Engaged units cannot be fired upon (7.12).');
  if (firer.side === target.side) reasons.push('Target is friendly.');
  if (m && range > missileMaxRange(m)) reasons.push(`Out of range (${range} > ${missileMaxRange(m)}).`);
  if (ctx.rangeOverride == null && firer.hex && target.hex && !inFireArc(g, firer, target)) reasons.push('Target is not in the front/flank arc (7.13).');

  const mods: Modifier[] = [];
  let strength: number | null = null;
  if (m) {
    strength = MISSILE_RANGE[m][range - 1] ?? null;
    const fva = fireVsArmor(m, target.type, target.size === 2);
    if (fva) mods.push({ label: 'Fire vs. Armor (7.42)', value: fva });
    if (ctx.targetInWoods) mods.push({ label: 'Target in Woods', value: 1 });
    if (ctx.firerMoved && firer.type === 'SK' && (m === 'B' || m === 'C' || m === 'S')) mods.push({ label: 'Skirmisher archer/slinger moved', value: 1 });
    if (firer.type === 'LC' && m === 'J') mods.push({ label: 'Javelin-armed Light Cavalry', value: 1 });
    if (ctx.targetLockedShieldsFront) mods.push({ label: 'Locked Shield-Wall, front', value: 2 });
    if (ctx.targetLowerElevation && range >= 2) mods.push({ label: 'Target on lower elevation', value: -1 });
    if (ctx.targetChargeFormation) mods.push({ label: 'Target in Charge Formation', value: -1 });
  }
  return { allowed: reasons.length === 0 && strength != null, reasons, range, strength, mods, totalMod: mods.reduce((s, x) => s + x.value, 0) };
}

export interface MissileOutcome {
  dr: number;
  adjusted: number;
  hits: 0 | 1 | 2;
  becomesLow: boolean;
  becomesNo: boolean;
  leaderCheck: boolean;
}

export function resolveMissile(calc: MissileCalc, firer: Unit, dr: number): MissileOutcome {
  const adjusted = dr + calc.totalMod;
  const m = firer.missile!;
  let hits: 0 | 1 | 2 = 0;
  if (calc.strength != null && adjusted <= calc.strength) hits = missileDoubleHit(m, calc.range, adjusted) ? 2 : 1;
  const wasLow = firer.missileSupply === 'low';
  const lowOn = m === 'J' ? dr >= 7 : dr === 9;
  return { dr, adjusted, hits, becomesLow: !wasLow && lowOn, becomesNo: wasLow, leaderCheck: dr === 0 };
}

// ============================================================================
// Shock combat
// ============================================================================

export type Approach = 'front' | 'flank' | 'rear';

/** Through which arc of `defender` is `attacker` attacking? Best (for the attacker) arc touched. */
export function attackApproach(attacker: Unit, defender: Unit): Approach | null {
  const dfp = footprint(defender.hex!, defender.facing, defender.size);
  const ah = unitHexes(attacker);
  const hit = (hs: Hex[]) => ah.some((a) => hs.some((h) => h.q === a.q && h.r === a.r));
  const r = hit(dfp.rear), f = hit(dfp.flank), fr = hit(dfp.front);
  if (r) return 'rear';
  if (f) return 'flank';
  if (fr) return 'front';
  return null;
}

/** Is `u` adjacent to `target` through one of u's Front hexes (it can shock it)? */
export function inFrontOf(u: Unit, target: Unit): boolean {
  const fp = footprint(u.hex!, u.facing, u.size);
  return unitHexes(target).some((h) => fp.front.some((f) => f.q === h.q && f.r === h.r));
}

export const isArcher = (u: Unit) => u.missile === 'B' || u.missile === 'C';

/** Can `u` shock-attack at all (8.11)? Skirmishers only versus chariots. */
export function canShock(u: Unit, defenders: Unit[] = []): boolean {
  if (u.routed) return false;
  if ((u.type === 'LI' || u.type === 'LC') && isArcher(u)) return false;
  if (u.type === 'SK') return defenders.length > 0 && defenders.every((d) => d.type === 'CH');
  return true;
}

/** Is the defender "shock capable" for the halving rule (8.17[3], 9.11, 9.12, 9.14)? */
export function defenderShockCapable(d: Unit, attackers: Unit[]): boolean {
  if (d.type === 'SK') return attackers.every((a) => a.type === 'CH');
  if ((d.type === 'LI' || d.type === 'LC') && isArcher(d)) return false;
  return true;
}

export interface ShockInput {
  attackers: Unit[];
  defenders: Unit[];
  /** Leaders stacked with an attacking / defending unit. */
  attackerLeaders: Leader[];
  defenderLeaders: Leader[];
  /** Units whose leaders were stunned/wounded in Personal Combat (their DRM is ignored). */
  ignoredLeaders?: string[];
  /** Attacker advanced at the Run and this is its first shock (+2, 6.24). */
  run: boolean;
  /** Unit types chosen by each side (8.16). Defaults: attacker best column, defender worst for attacker. */
  attackerTypeUnit?: string;
  defenderTypeUnit?: string;
  /** Hoplite Phalanx attacking through both a front and a flank hex (8.17[1]A). */
  phalanxFrontAndFlank?: boolean;
  /** Attacking units that are themselves in the Front hex of another enemy unit (no Position Superiority). */
  pinnedAttackers?: string[];
  defenderInColumn?: boolean;
  terrainShift?: number; // column shift for terrain (negative = left)
}

export interface ShockCalc {
  allowed: boolean;
  reasons: string[];
  attackerType: Unit;
  defenderType: Unit;
  baseColumn: number;
  superiority: Superiority;
  superiorityReason: string;
  positionUnit: Unit | null;
  numericalShift: number;
  attackerCount: number;
  defenderCount: number;
  column: number;
  mods: Modifier[];
  totalMod: number;
}

const leaderDrm = (l: Leader) => {
  const base = l.rank === 'OC' ? l.charisma ?? 0 : 1;
  return l.rank === 'OC' && l.wounded ? Math.max(0, base - 2) : base;
};

/** Counters for Numerical Advantage (8.17[2], 9.61, 9.62). */
function countUnits(units: Unit[], anySingleInCombat: boolean): number {
  return units.reduce((s, u) => {
    if (u.depth) return s + u.depth;
    if (u.size === 2) return s + (anySingleInCombat ? 2 : 1);
    return s + 1;
  }, 0);
}

export function shockCalc(inp: ShockInput): ShockCalc {
  const { attackers, defenders } = inp;
  const reasons: string[] = [];
  if (!attackers.length || !defenders.length) reasons.push('Select at least one attacker and one defender.');
  for (const a of attackers) {
    if (!canShock(a, defenders)) reasons.push(`${a.name} cannot Shock attack.`);
    if (defenders.length && !defenders.some((d) => inFrontOf(a, d))) reasons.push(`${a.name} has no defender in its Front hexes.`);
  }

  // Position Superiority (8.17[1]A)
  let positionUnit: Unit | null = null;
  if (!inp.phalanxFrontAndFlank) {
    for (const a of attackers) {
      if (inp.pinnedAttackers?.includes(a.id)) continue;
      if (defenders.some((d) => { const ap = attackApproach(a, d); return ap === 'flank' || ap === 'rear'; })) { positionUnit = a; break; }
    }
  }

  // Type selection (8.16): attacker picks best column, defender picks worst for the attacker.
  const colFor = (a: Unit, d: Unit) => cwsColumn(a.type, d.type) ?? -99;
  let attackerType = attackers.find((u) => u.id === inp.attackerTypeUnit) ?? positionUnit ?? attackers[0];
  let defenderType = defenders.find((u) => u.id === inp.defenderTypeUnit) ?? defenders[0];
  if (attackers.length && defenders.length) {
    if (!inp.defenderTypeUnit) defenderType = [...defenders].sort((x, y) => colFor(attackerType, x) - colFor(attackerType, y))[0];
    if (!inp.attackerTypeUnit && !positionUnit) attackerType = [...attackers].sort((x, y) => colFor(y, defenderType) - colFor(x, defenderType))[0];
  }
  const base = attackers.length && defenders.length ? cwsColumn(attackerType.type, defenderType.type) : null;
  if (attackers.length && defenders.length && base == null) reasons.push(`${attackerType.type} cannot shock ${defenderType.type} (8.41).`);

  // Superiority
  let superiority: Superiority = null;
  let superiorityReason = 'No superiority';
  const heavyInf = (t: UnitType) => t === 'HO' || t === 'HI' || t === 'MI';
  if (inp.defenderInColumn) { superiority = 'AS'; superiorityReason = 'Defender In Column (6.55)'; }
  else if (positionUnit) {
    if (positionUnit.type === 'LC' && defenders.some((d) => heavyInf(d.type) && !d.routed)) superiorityReason = 'LC flank/rear vs HO/HI/MI: no superiority (9.15)';
    else { superiority = 'AS'; superiorityReason = `Position: ${positionUnit.name} attacks a flank/rear (8.17[1]A)`; }
  } else if (attackers.length && defenders.length) {
    superiority = weaponSuperiority(attackerType.type, defenderType.type);
    if (superiority === 'AS' && attackerType.type === 'HC' && defenderType.type !== 'SK') {
      superiority = null; superiorityReason = 'HC not in Charge Formation (9.31)';
    } else superiorityReason = superiority ? `Weapon system ${attackerType.type} vs ${defenderType.type} (8.42)` : superiorityReason;
  }

  // Column shifts
  const anySingle = [...attackers, ...defenders].some((u) => u.size === 1);
  const ac = countUnits(attackers, anySingle);
  const dc = countUnits(defenders, anySingle);
  const numericalShift = 2 * (ac - dc);
  const column = (base ?? 0) + numericalShift + (inp.terrainShift ?? 0);

  // DRMs
  const mods: Modifier[] = [];
  const ignored = new Set(inp.ignoredLeaders ?? []);
  for (const l of inp.attackerLeaders) if (!ignored.has(l.id)) mods.push({ label: `${l.name} with attacker`, value: leaderDrm(l) });
  for (const l of inp.defenderLeaders) if (!ignored.has(l.id)) mods.push({ label: `${l.name} with defender`, value: -leaderDrm(l) });
  if (inp.run) mods.push({ label: 'Advanced at the Run (6.24)', value: 2 });

  return {
    allowed: reasons.length === 0, reasons, attackerType, defenderType, baseColumn: base ?? 0, superiority, superiorityReason,
    positionUnit, numericalShift, attackerCount: ac, defenderCount: dc, column, mods, totalMod: mods.reduce((s, m) => s + m.value, 0),
  };
}

export interface ShockOutcome {
  dr: number;
  adjusted: number;
  column: number;
  printed: [number, number];
  attackerHits: number;
  defenderHits: number;
  notes: string[];
}

export function resolveShock(calc: ShockCalc, attackers: Unit[], defenders: Unit[], dr: number): ShockOutcome {
  const adjusted = dr + calc.totalMod;
  const column = Math.max(1, Math.min(13, calc.column));
  const printed = shockCrt(column, adjusted);
  let [a, d] = printed;
  const notes: string[] = [];
  if (calc.superiority === 'AS') { d *= 2; notes.push('Attack Superior: defender hits ×2'); }
  if (calc.superiority === 'DS') { a *= 3; notes.push('Defense Superior: attacker hits ×3'); }
  if (!defenderShockCapable(calc.defenderType, attackers)) { a = Math.floor(a / 2); notes.push('Defender not Shock capable: attacker hits ½'); }
  if (attackers.some((x) => x.type === 'LC') && calc.attackerType.type === 'LC' &&
    defenders.some((x) => (x.type === 'HO' || x.type === 'HI' || x.type === 'MI') && !x.routed)) {
    d = Math.floor(d / 2); notes.push('Light Cavalry attacker vs HO/HI/MI: defender hits ½ (9.15)');
  }
  return { dr, adjusted, column, printed, attackerHits: a, defenderHits: d, notes };
}

/**
 * Distribute hits as evenly as possible (10.13). Extra hits go first to the unit used for
 * superiority, then the one used for the CRT column, then in list order.
 */
export function distributeHits(units: Unit[], hits: number, priority: (Unit | null)[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(units.map((u) => [u.id, 0]));
  if (!units.length) return out;
  const each = Math.floor(hits / units.length);
  for (const u of units) out[u.id] = each;
  let extra = hits - each * units.length;
  const order = [...priority.filter((p): p is Unit => !!p && units.some((u) => u.id === p.id)), ...units];
  const seen = new Set<string>();
  for (const u of order) {
    if (extra <= 0) break;
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    out[u.id]++;
    extra--;
  }
  return out;
}

// ============================================================================
// Collapse (8.18)
// ============================================================================

export type CollapseVerdict =
  | { kind: 'ok' }
  | { kind: 'eliminated'; reason: string }
  | { kind: 'rout'; reason: string }
  | { kind: 'phalanxCheck'; target: number; excess: number; attacker: boolean } // roll + excess (+2) > TQ -> rout
  | { kind: 'thresholdCheck' } // hits == TQ-1: roll > TQ -> rout, else remove 1 hit
  | { kind: 'setTo'; hits: number; reason: string };

/**
 * First pass of 8.18[1]: who routs given accumulated hits. When every unit on both sides would
 * rout, only the side with the greater excess routs (the defender on a tie); the other is set to TQ-1.
 */
export function collapseVerdicts(attackers: Unit[], defenders: Unit[], positionSuperiority: boolean): Record<string, CollapseVerdict> {
  const v: Record<string, CollapseVerdict> = {};
  const over = (u: Unit) => u.hits >= u.tq;
  const all = [...attackers, ...defenders];
  let spared: Set<string> = new Set();
  if (all.length && all.every(over)) {
    const ex = (us: Unit[]) => Math.max(...us.map((u) => u.hits - u.tq));
    const routSide = ex(attackers) > ex(defenders) ? 'att' : 'def';
    spared = new Set((routSide === 'att' ? defenders : attackers).map((u) => u.id));
  }
  for (const u of all) {
    const isAtt = attackers.includes(u);
    if (spared.has(u.id)) { v[u.id] = { kind: 'setTo', hits: u.tq - 1, reason: 'All units would rout; the other side routs (8.18[1])' }; continue; }
    if (over(u)) {
      if (u.type === 'SK' || u.type === 'CH') v[u.id] = { kind: 'eliminated', reason: 'Skirmishers/Chariots are eliminated when they rout' };
      else if (u.routed) v[u.id] = { kind: 'eliminated', reason: 'Routed unit taking hits is eliminated (10.26)' };
      else if (u.size === 2 && !(isAtt === false && positionSuperiority)) v[u.id] = { kind: 'phalanxCheck', target: u.tq, excess: u.hits - u.tq, attacker: isAtt };
      else v[u.id] = { kind: 'rout', reason: u.size === 2 ? 'Phalanx defender vs Position Superiority routs without a roll' : 'Hits ≥ TQ' };
    } else if (u.hits === u.tq - 1) v[u.id] = { kind: 'thresholdCheck' };
    else v[u.id] = { kind: 'ok' };
  }
  return v;
}

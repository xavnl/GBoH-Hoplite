// Reducer cases for automated combat steps (missile fire, shock procedure, TQ checks).
// Each step rolls with the game's seeded die and logs what the rules produced.
import { BOARDS } from '../data/boards';
import {
  collapseVerdicts, distributeHits, inFrontOf, unitDistance, unitHexes, missileCalc, resolveMissile, resolveShock, shockCalc,
  type MissileContext, type ShockInput,
} from './combat';
import { occupiedBy } from './command';
import { footprint, hexKey, normFacing, reverseFace, type Hex } from './hex';
import { movementAllowance } from './movement';
import { approachSector, detectReturnFire, pwUnits, withdrawDestinations } from './reactions';
import { commandLeaders, disengageHex, disengageRating, rallyEligible, rallyRating, recoveryAmount, unitsInRange } from './orders';
import type { OrderType } from './types';
import { effRating } from './ratings';
import { rollD10 } from './rng';
import { sideRoutPoints } from './routPoints';
import { advanceAfterCombat, routMove, routStatus } from './rout';
import { advanceRate, personalCombat } from './tables';
import type { GameState, Leader, LogEntry, Unit } from './types';

export type ShockOptions = Omit<ShockInput, 'attackers' | 'defenders' | 'attackerLeaders' | 'defenderLeaders'>;

export type CombatAction =
  | { type: 'missileFire'; firerId: string; targetId: string; ctx?: MissileContext; reaction?: boolean }
  | { type: 'rollAdvance'; id: string; bonus?: number }
  | { type: 'preShockAttacker'; id: string }
  | { type: 'preShockDefender'; id: string; chariot?: boolean; attackerIds?: string[] }
  | { type: 'leaderCasualty'; leaderId: string }
  | { type: 'personalCombat'; attackerLeaderId: string; defenderLeaderId: string }
  | { type: 'resolveShock'; attackerIds: string[]; defenderIds: string[]; options: ShockOptions }
  | { type: 'collapse'; attackerIds: string[]; defenderIds: string[]; positionSuperiority: boolean; superiorId?: string | null }
  | { type: 'tqCheckHits'; id: string; label: string; minHits?: number; exactHits?: number; drm?: number }
  | { type: 'applyHits'; hits: Record<string, number>; reason: string }
  | { type: 'routMove'; id: string; steps: number }
  | { type: 'reactWithdraw'; reactionId: string; anchor: Hex }
  | { type: 'reactPW'; reactionId: string }
  | { type: 'reactFacing'; reactionId: string; delta: number }
  | { type: 'reactFire'; reactionId: string }
  | { type: 'dismissReaction'; reactionId: string }
  | { type: 'setPwOrder'; leaderId: string; on: boolean }
  | { type: 'setOrders'; orders: OrderType }
  | { type: 'disengage'; commandId: string; leaderId: string | null }
  | { type: 'rally'; commandId: string }
  | { type: 'recover'; id: string }
  | { type: 'rollAdvanceCommand'; commandId: string };

const isCombatAction = (t: string) =>
  ['missileFire', 'rollAdvance', 'preShockAttacker', 'preShockDefender', 'leaderCasualty', 'personalCombat',
    'resolveShock', 'collapse', 'tqCheckHits', 'applyHits', 'routMove', 'reactWithdraw', 'reactPW', 'reactFacing',
    'reactFire', 'dismissReaction', 'setPwOrder', 'setOrders', 'disengage', 'rally', 'recover', 'rollAdvanceCommand'].includes(t);
export { isCombatAction };

// ---------- helpers ----------

function log(s: GameState, text: string, kind: LogEntry['kind'] = 'combat'): GameState {
  return { ...s, log: [...s.log, { turn: s.turn, text, kind }] };
}
function roll(s: GameState): [number, GameState] {
  const [r, rng] = rollD10(s.rng);
  return [r, { ...s, rng }];
}
function setUnit(s: GameState, u: Unit): GameState {
  return { ...s, units: { ...s.units, [u.id]: u } };
}
function setLeader(s: GameState, l: Leader): GameState {
  return { ...s, leaders: { ...s.leaders, [l.id]: l } };
}

/** Effective TQ: 1 when routed (10.26). */
export const currentTq = (u: Unit) => (u.routed ? 1 : u.tq);

/** Leaders stacked with a unit. */
export function leadersWith(s: GameState, u: Unit): Leader[] {
  if (!u.hex) return [];
  const hs = new Set(footprint(u.hex, u.facing, u.size).hexes.map(hexKey));
  return Object.values(s.leaders).filter((l) => l.side === u.side && !l.killed && l.hex && hs.has(hexKey(l.hex)));
}

/** Add cohesion hits to a unit, applying 10.14 / 10.26 immediately for routed units, SK and CH. */
export function addHits(s: GameState, id: string, n: number, why: string): GameState {
  const u = s.units[id];
  if (!u || n <= 0 || u.eliminated) return s;
  if (u.routed) {
    const st = setUnit(s, { ...u, eliminated: true, engaged: false });
    return log(st, `${u.name} (routed) takes ${n} hit(s) — ELIMINATED (10.26). ${s.sides[u.side].name}: ${sideRoutPoints(st, u.side)} RP.`);
  }
  const hits = u.hits + n;
  let st = setUnit(s, { ...u, hits });
  st = log(st, `${u.name}: +${n} hit${n > 1 ? 's' : ''} (${why}) → ${hits}/${u.tq}.`);
  return st;
}

/** Rout a unit (10.14) and immediately rout-move it two hexes toward its Retreat Edge (10.21). */
export function routUnit(s: GameState, id: string, why: string, shockEnemies?: string[]): GameState {
  const st = routStatus(s, id, why);
  const u = st.units[id];
  if (!u || u.eliminated) return st;
  return routMove(st, BOARDS[s.boardId].geometry, id, 2, { shockEnemies });
}

function woundOrKill(s: GameState, l: Leader, rollAgain: boolean): GameState {
  let st = s;
  if (l.wounded) return log(setLeader(st, { ...l, killed: true, hex: null }), `${l.name} wounded again — KILLED (8.33).`);
  if (rollAgain) {
    const [r, s1] = roll(st);
    st = s1;
    const rating = effRating(l.initiative, l.wounded);
    if (r > rating) return log(setLeader(st, { ...l, killed: true, hex: null }), `${l.name} hit: second roll ${r} > ${rating} — KILLED.`);
    return log(setLeader(st, { ...l, wounded: true }), `${l.name} hit: second roll ${r} ≤ ${rating} — WOUNDED (ratings −2).`);
  }
  return log(setLeader(st, { ...l, wounded: true }), `${l.name} WOUNDED (ratings −2).`);
}

// ---------- reducer ----------

export function combatReducer(s: GameState, a: CombatAction): GameState {
  const g = BOARDS[s.boardId].geometry;
  switch (a.type) {
    case 'setOrders': {
      const moved = Object.keys(s.activity ?? {}).length > 0;
      if (moved && a.orders !== s.orders) return log(s, 'Orders cannot change once units have acted this phase (5.4).', 'system');
      const label = { move: 'Move/Fire', disengage: 'Disengage', rally: 'Rally' }[a.orders];
      return log({ ...s, orders: a.orders }, `Orders: ${label}.`, 'info');
    }

    case 'rollAdvanceCommand': {
      // 6.22: each hoplite rolls its rate before first moving toward the enemy (Spartans Trot).
      let st = s;
      for (const u of Object.values(s.units)) {
        if (u.command !== a.commandId || u.type !== 'HO' || u.advanceRolled || u.eliminated || u.routed || u.engaged) continue;
        st = combatReducer(st, { type: 'rollAdvance', id: u.id });
      }
      return st === s ? log(s, 'Every hoplite of this Command already has its advance rate.', 'system') : st;
    }

    case 'recover': {
      const u = s.units[a.id];
      if (!u) return s;
      const r = recoveryAmount(s, g, u);
      if (!r.hits) return log(s, `${u.name} cannot Recover: ${r.reason}.`, 'system');
      const st = setUnit(s, { ...u, hits: u.hits - r.hits });
      return log({ ...st, activity: { ...(st.activity ?? {}), [u.id]: 'recovered' } },
        `${u.name} Recovers ${r.hits} hit${r.hits > 1 ? 's' : ''} (10.41) → ${u.hits - r.hits}/${u.tq}.`, 'info');
    }

    case 'disengage': {
      if (s.orders !== 'disengage') return log(s, 'Give Disengage orders first (5.44).', 'system');
      const l = a.leaderId ? s.leaders[a.leaderId] : null;
      const engaged = l
        ? unitsInRange(s, g, l, a.commandId, (u) => u.engaged && !u.routed)
        : Object.values(s.units).filter((u) => u.command === a.commandId && u.engaged && !u.eliminated && !u.routed);
      if (!engaged.length) return log(s, `No Engaged unit ${l ? `in ${l.name}'s range` : 'in this Command'}.`, 'system');
      let st = s;
      const tryUnits = (units: Unit[], target: number, who: string) => {
        const [r, s1] = roll(st);
        st = log(s1, `Disengage (10.33) — ${who}: rolled ${r} vs ${target} → ${r <= target ? 'SUCCESS' : 'failed, units stay Engaged'}.`, 'dice');
        if (r > target) return;
        for (const u0 of units) {
          const u = st.units[u0.id];
          const foes = Object.values(st.units).filter((e) => e.side !== u.side && e.engaged && !e.eliminated && e.hex && unitDistance(unitHexes(e), unitHexes(u)) === 1);
          const hex = disengageHex(st, g, u);
          if (!hex) { st = log(st, `${u.name} has no hex to fall back into and stays Engaged.`, 'info'); continue; }
          const from = unitHexes(u);
          st = setUnit(st, { ...u, hex, engaged: false });
          st = moveLeaders(st, from, hex, u.side);
          st = { ...st, activity: { ...(st.activity ?? {}), [u.id]: 'disengaged' } };
          st = log(st, `${u.name} disengages one hex (10.34).`, 'info');
          for (const f of foes) {
            const fu = st.units[f.id];
            const stillEngaged = Object.values(st.units).some((x) => x.side === u.side && x.engaged && !x.eliminated && x.hex && unitDistance(unitHexes(x), unitHexes(fu)) === 1);
            if (!stillEngaged) st = setUnit(st, { ...fu, engaged: false });
          }
        }
      };
      if (l) tryUnits(engaged, disengageRating(st, l), l.name);
      else for (const u of engaged) tryUnits([u], 0, `${u.name} (Leaderless Command, rating 0)`);
      return st;
    }

    case 'rally': {
      if (s.orders !== 'rally') return log(s, 'Give Rally orders first (5.44).', 'system');
      const cmd = s.commands.find((c) => c.id === a.commandId);
      const leaders = commandLeaders(s, a.commandId);
      let st = s;
      const routed = Object.values(s.units).filter((u) => u.command === a.commandId && u.routed && !u.eliminated && !u.rallied && u.hex);
      if (!routed.length) return log(s, 'No routed unit to Rally in this Command.', 'system');
      for (const u0 of routed) {
        const u = st.units[u0.id];
        // Best leader with the unit in range (5.52); Leaderless Commands use a rating of 0 (5.51).
        const cands = cmd?.leaderless ? [null] : leaders.filter((l) => rallyEligible(st, g, u, l).ok).sort((x, y) => rallyRating(y) - rallyRating(x));
        const l = cands[0] ?? null;
        const elig = rallyEligible(st, g, u, cmd?.leaderless ? null : l ?? leaders[0] ?? null);
        if (!elig.ok || (!cmd?.leaderless && !l)) { st = log(st, `${u.name} cannot Rally: ${elig.reason ?? 'no leader in range'}.`, 'info'); continue; }
        const target = l ? rallyRating(l) : 0;
        const [r, s1] = roll(st);
        st = s1;
        if (r <= target) {
          const [r2, s2] = roll(st);
          st = s2;
          const hits = Math.ceil(r2 / 2);
          if (hits >= u.tq) {
            st = setUnit(st, { ...u, eliminated: true });
            st = log(st, `Rally ${u.name}: ${r} ≤ ${target} rallied, but hit roll ${r2} → ${hits} ≥ TQ — ELIMINATED (10.42).`, 'dice');
          } else {
            st = setUnit(st, { ...u, routed: false, rallied: true, hits });
            st = log(st, `Rally ${u.name}${l ? ` by ${l.name}` : ''}: ${r} ≤ ${target} — RALLIED with ${hits} hit(s); it may be refaced freely and cannot act until next turn.`, 'dice');
          }
        } else if (u.size === 2 || r > u.tq) {
          st = setUnit(st, { ...u, eliminated: true });
          st = log(st, `Rally ${u.name}: ${r} > ${target} — ELIMINATED (10.42). ${s.sides[u.side].name}: ${sideRoutPoints(st, u.side)} RP.`, 'dice');
        } else {
          st = log(st, `Rally ${u.name}: ${r} > ${target} — still routed, rout moves.`, 'dice');
          st = routMove(st, g, u.id, 2);
        }
        st = { ...st, activity: { ...(st.activity ?? {}), [u.id]: 'rallied' } };
      }
      return st;
    }

    case 'setPwOrder': {
      const l = s.leaders[a.leaderId];
      if (!l) return s;
      return log({ ...s, pwOrders: { ...(s.pwOrders ?? {}), [a.leaderId]: a.on } },
        `${l.name}: Pre-arranged Withdrawal order ${a.on ? 'given' : 'cancelled'} for this turn (6.72).`, 'info');
    }

    case 'dismissReaction':
      return { ...s, reactions: (s.reactions ?? []).filter((r) => r.id !== a.reactionId) };

    case 'reactWithdraw': {
      const re = (s.reactions ?? []).find((r) => r.id === a.reactionId);
      if (!re) return s;
      const dest = withdrawDestinations(s, g, s.units[re.reactorId], s.units[re.moverId], re.mp ?? 0)
        .find((d) => d.anchor.q === a.anchor.q && d.anchor.r === a.anchor.r);
      if (!dest) return log(s, 'That withdrawal destination is not legal.', 'system');
      const st = withdrawUnit(s, re.reactorId, re.moverId, a.anchor, re.approach ?? 'front', 'Orderly Withdrawal (6.6)', dest.through);
      return { ...st, reactions: (st.reactions ?? []).filter((r) => r.reactorId !== re.reactorId) };
    }

    case 'reactPW': {
      const re = (s.reactions ?? []).find((r) => r.id === a.reactionId);
      if (!re || !re.leaderId) return s;
      const mover = s.units[re.moverId];
      let st = log(s, `${s.leaders[re.leaderId].name}'s Pre-arranged Withdrawal is revealed (6.73).`, 'info');
      const moved: string[] = [];
      for (const u of pwUnits(st, g, re.leaderId)) {
        const cur = st.units[u.id];
        if (!cur.hex || unitDistance(unitHexes(cur), unitHexes(mover)) > 2) { continue; }
        const dests = withdrawDestinations(st, g, cur, mover, 1);
        if (!dests.length) { st = log(st, `${cur.name} cannot withdraw (blocked).`, 'info'); continue; }
        st = withdrawUnit(st, cur.id, mover.id, dests[0].anchor, approachSector(g, cur, unitHexes(mover)), 'Pre-arranged Withdrawal (6.73)', dests[0].through);
        moved.push(cur.id);
      }
      return { ...st, reactions: (st.reactions ?? []).filter((r) => r.id !== re.id && !moved.includes(r.reactorId)) };
    }

    case 'reactFacing': {
      const re = (s.reactions ?? []).find((r) => r.id === a.reactionId);
      if (!re) return s;
      const u = s.units[re.reactorId], mover = s.units[re.moverId];
      if (!u || !u.hex) return s;
      let st: GameState;
      if (re.kind === 'reverseFace') {
        const rf = reverseFace(u.hex, u.facing);
        st = setUnit(s, { ...u, hex: rf.anchor, facing: rf.facing, advance: null });
      }
      else st = setUnit(s, { ...u, facing: normFacing(u.facing + a.delta), advance: null });
      st = log(st, `${u.name} ${re.kind === 'reverseFace' ? 'reverse-faces (6.95)' : 'changes facing one vertex (6.94)'} as ${mover.name} closes in.`, 'info');
      const cavVsInf = (u.type === 'LC' || u.type === 'HC') && !(mover.type === 'LC' || mover.type === 'HC' || mover.type === 'CH');
      if (!cavVsInf) {
        st = combatReducer(st, {
          type: 'tqCheckHits', id: u.id, label: re.kind === 'reverseFace' ? 'Reverse Face reaction (6.95)' : 'Reaction facing (6.94)',
          minHits: re.kind === 'reverseFace' ? 2 : 1, drm: movementAllowance(mover) - movementAllowance(u),
        });
      }
      return { ...st, reactions: (st.reactions ?? []).filter((r) => r.id !== re.id && !(r.reactorId === u.id && (r.kind === 'facing' || r.kind === 'reverseFace'))) };
    }

    case 'reactFire': {
      const re = (s.reactions ?? []).find((r) => r.id === a.reactionId);
      if (!re) return s;
      const label = re.kind === 'entryFire' ? 'Entry reaction fire (7.34)' : re.kind === 'retireFire' ? 'Retire reaction fire (7.31)' : 'Return Fire (7.35)';
      let st = log(s, `${label}:`, 'info');
      st = combatReducer(st, { type: 'missileFire', firerId: re.reactorId, targetId: re.moverId, ctx: re.range ? { rangeOverride: re.range } : {}, reaction: true });
      // One reaction fire per unit against the same enemy (7.35): drop the others.
      return { ...st, reactions: (st.reactions ?? []).filter((r) => !(r.reactorId === re.reactorId && r.moverId === re.moverId && r.kind.endsWith('Fire'))) };
    }

    case 'routMove': {
      const u = s.units[a.id];
      if (!u || u.eliminated) return s;
      const st = u.routed ? s : routStatus(s, a.id, 'ordered by the player');
      return st.units[a.id].eliminated ? st : routMove(st, g, a.id, a.steps);
    }

    case 'applyHits': {
      let st = s;
      for (const [id, n] of Object.entries(a.hits)) st = addHits(st, id, n, a.reason);
      return st;
    }

    case 'tqCheckHits': {
      const u = s.units[a.id];
      if (!u) return s;
      const [r, st0] = roll(s);
      const tq = currentTq(u);
      const adj = r + (a.drm ?? 0);
      // Only a failed check (DR > TQ) inflicts hits: DR−TQ, raised to `minHits` (6.43, 6.94, 6.95, 10.22),
      // or a fixed `exactHits` (Run, Orderly Withdrawal). A passed check inflicts nothing.
      const hits = adj > tq ? a.exactHits ?? Math.max(a.minHits ?? 1, adj - tq) : 0;
      const st = log(st0, `${a.label} — ${u.name}: rolled ${r}${a.drm ? `${a.drm > 0 ? '+' : ''}${a.drm}=${adj}` : ''} vs TQ ${tq} → ${hits ? `${hits} hit(s)` : 'passed'}.`, 'dice');
      return hits ? routIfBroken(addHits(st, u.id, hits, a.label), u.id) : st;
    }

    case 'rollAdvance': {
      const u = s.units[a.id];
      if (!u || u.type !== 'HO') return s;
      if (u.spartan && !a.bonus) return log(setUnit(s, { ...u, advance: 'trot', advanceRolled: true }), `${u.name} (Spartan) advances at the Trot without a roll (6.22).`, 'dice');
      const [r, st] = roll(s);
      const rate = advanceRate(r + (a.bonus ?? 0));
      if (a.bonus) {
        // 6.27: re-roll after missile fire; only a change to Run applies.
        if (rate !== 'run') return log(st, `${u.name} under missile fire re-rolls advance: ${r}+1 — no change.`, 'dice');
      }
      return log(setUnit(st, { ...u, advance: rate, advanceRolled: true }), `${u.name} Advance to Combat (6.38): rolled ${r}${a.bonus ? '+1' : ''} → ${rate.toUpperCase()}.`, 'dice');
    }

    case 'missileFire': {
      const firer = s.units[a.firerId];
      const target = s.units[a.targetId];
      if (!firer || !target) return s;
      const calc = missileCalc(g, firer, target, a.ctx);
      if (!calc.allowed) return log(s, `Fire ${firer.name} → ${target.name} not allowed: ${calc.reasons.join(' ')}`, 'system');
      const [r, s1] = roll(s);
      let st = s1;
      const out = resolveMissile(calc, firer, r);
      const mods = calc.mods.map((m) => `${m.label} ${m.value > 0 ? '+' : ''}${m.value}`).join(', ');
      st = log(st, `${firer.name} fires (${firer.missile}) at ${target.name}, range ${calc.range}: rolled ${r}${calc.totalMod ? ` ${calc.totalMod > 0 ? '+' : ''}${calc.totalMod} = ${out.adjusted}` : ''} vs ${calc.strength}${mods ? ` [${mods}]` : ''} → ${out.hits ? `${out.hits} hit(s)` : 'no effect'}.`, 'dice');
      const supply = out.becomesNo ? 'no' : out.becomesLow ? 'low' : firer.missileSupply;
      if (supply !== firer.missileSupply) {
        st = setUnit(st, { ...st.units[firer.id], missileSupply: supply });
        st = log(st, `${firer.name} is now Missile ${supply === 'low' ? 'Low' : 'No'} (7.16).`, 'info');
      }
      if (out.hits) st = routIfBroken(addHits(st, target.id, out.hits, 'missile fire'), target.id);
      // Leader casualty (7.18)
      if (out.leaderCheck) {
        for (const l of leadersWith(st, target)) {
          const [r2, s2] = roll(st);
          st = log(s2, `Natural 0 with ${l.name} in the target hex: casualty roll ${r2}${r2 === 0 ? ' — HIT!' : ' — no effect'}.`, 'dice');
          if (r2 === 0) st = woundOrKill(st, st.leaders[l.id], true);
        }
      }
      const tgt = st.units[target.id];
      if (tgt && !tgt.eliminated && tgt.type === 'HO' && (tgt.advance === 'walk' || tgt.advance === 'trot')) {
        st = combatReducer(st, { type: 'rollAdvance', id: tgt.id, bonus: 1 });
      }
      if (!a.reaction) {
        st = { ...st, reactions: [...(st.reactions ?? []), ...detectReturnFire(st, g, firer.id, target.id)] };
        if (st.activity?.[firer.id] !== 'moved') st = { ...st, activity: { ...(st.activity ?? {}), [firer.id]: 'fired' } };
      }
      return st;
    }

    case 'preShockAttacker': {
      const u = s.units[a.id];
      if (!u) return s;
      const [r, st] = roll(s);
      const tq = currentTq(u);
      if (r <= tq) return log(st, `Pre-Shock check ${u.name}: ${r} ≤ ${tq} — attacks.`, 'dice');
      return addHits(log(st, `Pre-Shock check ${u.name}: ${r} > ${tq} — does NOT attack (8.14[1]).`, 'dice'), u.id, 1, 'failed pre-shock check');
    }

    case 'preShockDefender': {
      const u = s.units[a.id];
      if (!u) return s;
      const [r, st0] = roll(s);
      const adj = r + (a.chariot ? 1 : 0);
      const tq = currentTq(u);
      const hits = Math.max(0, adj - tq);
      let st = log(st0, `Pre-Shock defender check ${u.name}: ${r}${a.chariot ? '+1' : ''} vs ${tq} → ${hits ? `${hits} hit(s)` : 'steady'}.`, 'dice');
      if (hits) {
        const vacated = u.hex ? footprint(u.hex, u.facing, u.size).hexes : [];
        st = addHits(st, u.id, hits, 'pre-shock check');
        const after = st.units[u.id];
        let gone = after.eliminated;
        if (!after.eliminated && after.hits >= after.tq) {
          st = routUnit(st, u.id, 'pre-shock check (8.14[2])', a.attackerIds);
          gone = true;
        }
        if (gone && a.attackerIds?.length) {
          st = advanceAfterCombat(st, g, { attackerIds: a.attackerIds, vacated, preShock: true }).state;
        }
      }
      return st;
    }

    case 'leaderCasualty': {
      const l = s.leaders[a.leaderId];
      if (!l || l.killed) return s;
      const [r, st] = roll(s);
      const st2 = log(st, `Leader casualty check ${l.name} (8.15): rolled ${r}${r === 0 ? ' — HIT!' : ' — safe'}.`, 'dice');
      return r === 0 ? woundOrKill(st2, l, true) : st2;
    }

    case 'personalCombat': {
      const al = s.leaders[a.attackerLeaderId];
      const dl = s.leaders[a.defenderLeaderId];
      if (!al || !dl) return s;
      const rating = (l: Leader) => effRating(l.rank === 'OC' ? l.charisma ?? 0 : l.initiative, l.wounded);
      const [ra, s1] = roll(s);
      const [rd, s2] = roll(s1);
      const ta = ra + rating(al), td = rd + rating(dl);
      let st = log(s2, `Personal Combat (8.3): ${al.name} ${ra}+${rating(al)}=${ta} vs ${dl.name} ${rd}+${rating(dl)}=${td}.`, 'dice');
      if (ta === td) return log(st, 'No effect.');
      const loser = ta > td ? dl : al;
      const res = personalCombat(Math.abs(ta - td));
      if (res === 'stunned') st = log(st, `${loser.name} is stunned: ignore his Shock DRM for this combat.`);
      if (res === 'wounded') st = log(woundOrKill(st, loser, false), `${loser.name}'s Shock DRM is ignored for this combat.`);
      if (res === 'killed') st = log(setLeader(st, { ...loser, killed: true, hex: null }), `${loser.name} is KILLED in Personal Combat.`);
      return st;
    }

    case 'resolveShock': {
      const attackers = a.attackerIds.map((id) => s.units[id]).filter((u) => u && !u.eliminated && !u.routed);
      // Defenders that routed away in the pre-shock step are no longer part of this combat.
      const defenders = a.defenderIds.map((id) => s.units[id])
        .filter((u) => u && !u.eliminated && attackers.some((x) => inFrontOf(x, u)));
      const attackerLeaders = uniq(attackers.flatMap((u) => leadersWith(s, u)));
      const defenderLeaders = uniq(defenders.flatMap((u) => leadersWith(s, u)));
      const calc = shockCalc({ ...a.options, attackers, defenders, attackerLeaders, defenderLeaders });
      if (!calc.allowed) return log(s, `Shock not allowed: ${calc.reasons.join(' ')}`, 'system');
      const [r, st0] = roll(s);
      const out = resolveShock(calc, attackers, defenders, r);
      let st = log(st0,
        `SHOCK ${attackers.map((u) => u.name).join(' + ')} → ${defenders.map((u) => u.name).join(' + ')}: ` +
        `${calc.attackerType.type} vs ${calc.defenderType.type} col ${calc.baseColumn}` +
        `${calc.numericalShift ? ` ${calc.numericalShift > 0 ? '+' : ''}${calc.numericalShift}` : ''}${a.options.terrainShift ? ` terrain ${a.options.terrainShift}` : ''} = ${out.column}; ` +
        `rolled ${r}${calc.totalMod ? ` ${calc.totalMod > 0 ? '+' : ''}${calc.totalMod} = ${out.adjusted}` : ''} → ${out.printed[0]}(${out.printed[1]})` +
        `${calc.superiority ? `, ${calc.superiority}` : ''} ⇒ attacker ${out.attackerHits}, defender ${out.defenderHits} hit(s).` +
        (out.notes.length ? ` [${out.notes.join('; ')}]` : ''), 'dice');
      const aHits = distributeHits(attackers, out.attackerHits, [calc.superiority === 'AS' ? calc.positionUnit : null, calc.attackerType]);
      const dHits = distributeHits(defenders, out.defenderHits, [calc.superiority === 'DS' ? calc.defenderType : null, calc.defenderType]);
      for (const [id, n] of Object.entries(aHits)) st = addHits(st, id, n, 'shock');
      for (const [id, n] of Object.entries(dHits)) st = addHits(st, id, n, 'shock');
      // Advancing at the Run only counts for the first shock: clear advance markers on attackers.
      for (const u of attackers) if (st.units[u.id].advance) st = setUnit(st, { ...st.units[u.id], advance: null });
      return st;
    }

    case 'collapse': {
      const attackers = a.attackerIds.map((id) => s.units[id]).filter((u) => u && !u.eliminated);
      const defenders = a.defenderIds.map((id) => s.units[id])
        .filter((u) => u && !u.eliminated && attackers.some((x) => inFrontOf(x, u)));
      const verdicts = collapseVerdicts(attackers, defenders, a.positionSuperiority);
      const defenderHexes = defenders.flatMap((u) => (u.hex ? footprint(u.hex, u.facing, u.size).hexes : []));
      const enemiesOf = (u: Unit) => (attackers.includes(u) ? defenders : attackers).map((x) => x.id);
      let st = s;
      const passedPhalanx = new Set<string>();
      const toRout: { id: string; why: string }[] = [];
      // Step 1: units at or over their TQ.
      for (const u of [...attackers, ...defenders]) {
        const v = verdicts[u.id];
        if (v.kind === 'eliminated') {
          const cur = st.units[u.id];
          st = setUnit(st, { ...cur, eliminated: true, engaged: false });
          st = log(st, `${u.name} ELIMINATED (${v.reason}). ${s.sides[u.side].name}: ${sideRoutPoints(st, u.side)} RP.`);
        } else if (v.kind === 'rout') toRout.push({ id: u.id, why: v.reason });
        else if (v.kind === 'setTo') { st = setUnit(st, { ...st.units[u.id], hits: v.hits }); st = log(st, `${u.name} holds: hits set to ${v.hits} (${v.reason}).`); }
        else if (v.kind === 'phalanxCheck') {
          const [r, s1] = roll(st);
          const total = r + v.excess + (v.attacker ? 2 : 0);
          st = log(s1, `Phalanx collapse check ${u.name}: ${r}+${v.excess}${v.attacker ? '+2' : ''}=${total} vs TQ ${v.target}.`, 'dice');
          if (total > v.target) toRout.push({ id: u.id, why: 'failed phalanx collapse check (8.18[1])' });
          else { st = setUnit(st, { ...st.units[u.id], hits: u.tq - 1 }); passedPhalanx.add(u.id); st = log(st, `${u.name} stands: hits set to ${u.tq - 1}.`); }
        }
      }
      // Rout moves: attacking units first (8.18[1]).
      for (const r of toRout) st = routUnit(st, r.id, r.why, enemiesOf(s.units[r.id]));
      // Step 2: units at TQ-1 still adjacent to an opposing unit of the same combat.
      for (const u of [...attackers, ...defenders]) {
        if (verdicts[u.id].kind !== 'thresholdCheck' || passedPhalanx.has(u.id)) continue;
        const cur = st.units[u.id];
        if (cur.eliminated || cur.routed) continue;
        const opp = (attackers.includes(u) ? defenders : attackers).map((x) => st.units[x.id]).filter((x) => !x.eliminated && !x.routed);
        if (!opp.some((o) => adjacent(cur, o))) continue;
        const [r, s1] = roll(st);
        if (r <= cur.tq) { st = setUnit(log(s1, `Collapse check ${u.name} (hits TQ−1): ${r} ≤ ${cur.tq} — steadies, removes 1 hit.`, 'dice'), { ...cur, hits: cur.hits - 1 }); }
        else st = routUnit(log(s1, `Collapse check ${u.name} (hits TQ−1): ${r} > ${cur.tq}.`, 'dice'), u.id, 'collapse check (8.18[2])', enemiesOf(u));
      }
      // Step 3: Advance after Combat into vacated hexes (8.2), then Engaged markers.
      const occ = occupiedBy(st);
      const vacated = defenderHexes.filter((h) => !occ.has(hexKey(h)));
      let advanced = new Set<string>(), pivoted = new Set<string>();
      if (vacated.length) {
        const adv = advanceAfterCombat(st, g, { attackerIds: a.attackerIds, vacated, superiorId: a.superiorId });
        st = adv.state; advanced = adv.advanced; pivoted = adv.pivoted;
      }
      const aStay = attackers.map((u) => st.units[u.id]).filter((u) => !u.eliminated && !u.routed && (!advanced.has(u.id) || pivoted.has(u.id)));
      const dStay = defenders.map((u) => st.units[u.id]).filter((u) => !u.eliminated && !u.routed);
      const involved = [...attackers, ...defenders].map((u) => st.units[u.id]).filter((u) => !u.eliminated && !u.routed);
      if (aStay.length && dStay.length) {
        for (const u of involved) {
          const keep = aStay.includes(u) || dStay.includes(u);
          st = setUnit(st, { ...st.units[u.id], engaged: keep });
        }
        st = log(st, `Both sides hold — ${[...aStay, ...dStay].map((u) => u.name).join(', ')} are ENGAGED.`, 'info');
      } else {
        for (const u of involved) st = setUnit(st, { ...st.units[u.id], engaged: false });
      }
      return st;
    }
  }
}

/**
 * Withdraw `id` to `anchor` (keeping facing) away from `moverId`, with the 6.62 penalties:
 * [2] +1 hit before withdrawing if approached from flank/rear (skirmishers: rear only),
 * [1] +1 hit for non-skirmisher infantry and chariots, [3] TQ check (not skirmishers): DR > TQ → +1 hit.
 */
export function withdrawUnit(s: GameState, id: string, moverId: string, anchor: Hex, approach: 'front' | 'flank' | 'rear', label: string, through: string[] = []): GameState {
  const u = s.units[id];
  if (!u || !u.hex) return s;
  let st = s;
  // Moving through friends (6.83): the Hoplite involved takes 1 hit.
  for (const fid of new Set(through)) {
    const f = st.units[fid];
    if (u.type === 'HO') st = addHits(st, id, 1, `withdrew through ${f.name} (6.83)`);
    else if (f.type === 'HO') st = routIfBroken(addHits(st, fid, 1, `${u.name} withdrew through it (6.83)`), fid);
  }
  const sk = u.type === 'SK';
  if ((approach === 'rear') || (approach === 'flank' && !sk)) st = addHits(st, id, 1, `approached from the ${approach} (6.62[2])`);
  const from = footprint(u.hex, u.facing, u.size).hexes;
  const fromKeys = new Set(from.map(hexKey));
  st = setUnit(st, { ...st.units[id], hex: anchor });
  for (const l of Object.values(st.leaders)) {
    if (l.side === u.side && !l.killed && l.hex && fromKeys.has(hexKey(l.hex))) st = setLeader(st, { ...l, hex: anchor });
  }
  st = log(st, `${u.name}: ${label} away from ${s.units[moverId].name}.`, 'info');
  if (!sk && u.type !== 'LC' && u.type !== 'HC') st = addHits(st, id, 1, 'withdrawing infantry/chariot (6.62[1])');
  if (!sk) st = combatReducer(st, { type: 'tqCheckHits', id, label: 'Withdrawal TQ check (6.62[3])', exactHits: 1 });
  st = routIfBroken(st, id);
  // Withdrawal fire (7.32): LC / chariot archers may fire at the triggering unit at range 2.
  const after = st.units[id];
  if (!after.eliminated && !after.routed && (after.type === 'LC' || after.type === 'CH') && (after.missile === 'B' || after.missile === 'C') && after.missileSupply !== 'no') {
    st = { ...st, reactions: [...(st.reactions ?? []), { id: `wf${st.log.length}`, kind: 'retireFire', reactorId: id, moverId, range: 2 }] };
  }
  return st;
}

/**
 * Reload Segment (7.17): Missile Low/No units that are not Engaged and not within range & arc of a
 * non-Engaged enemy missile unit that still has missiles get full supply back.
 */
export function reloadSegment(s: GameState): GameState {
  const g = BOARDS[s.boardId].geometry;
  let st = s;
  const reloaded: string[] = [];
  const all = Object.values(s.units).filter((u) => u.hex && !u.eliminated);
  for (const u of all) {
    if (u.missileSupply === 'full' || u.engaged || u.routed) continue;
    const threatened = all.some((e) => e.side !== u.side && e.missile && e.missileSupply !== 'no' && missileCalc(g, e, u).allowed);
    if (threatened) continue;
    st = setUnit(st, { ...st.units[u.id], missileSupply: 'full' });
    reloaded.push(u.name);
  }
  return reloaded.length ? log(st, `Reload (7.17): ${reloaded.join(', ')} back to full missiles.`, 'info') : st;
}

function moveLeaders(s: GameState, from: Hex[], to: Hex, side: Unit['side']): GameState {
  const keys = new Set(from.map(hexKey));
  let st = s;
  for (const l of Object.values(s.leaders)) {
    if (l.side === side && !l.killed && l.hex && keys.has(hexKey(l.hex))) st = setLeader(st, { ...l, hex: to });
  }
  return st;
}

/** Outside Shock combat a unit routs the instant its hits reach its TQ (10.14). */
function routIfBroken(s: GameState, id: string): GameState {
  const u = s.units[id];
  return u && !u.eliminated && !u.routed && u.hits >= u.tq ? routUnit(s, id, 'hits reached TQ (10.14)') : s;
}

function uniq<T extends { id: string }>(xs: T[]): T[] {
  return [...new Map(xs.map((x) => [x.id, x])).values()];
}

function adjacent(a: Unit, b: Unit): boolean {
  const ah = footprint(a.hex!, a.facing, a.size).hexes;
  const bh = footprint(b.hex!, b.facing, b.size).hexes;
  return ah.some((x) => bh.some((y) => Math.abs(x.q - y.q) + Math.abs(x.r - y.r) + Math.abs(x.q + x.r - y.q - y.r) === 2));
}

// Pure game-state reducer. Phase 1 = "assisted board": the app tracks state, rolls dice,
// runs the Activation Marker pool and Rout Points, while the players apply the rules.
// Later phases will add rule validation on top of these same actions.
import type { Hex } from './hex';
import { normFacing, pivotKeepLeft, pivotKeepRight, reverseFace } from './hex';
import { BOARDS } from '../data/boards';
import { combatReducer, reloadSegment, routUnit, type CombatAction } from './combatActions';
import { detectMoveReactions } from './reactions';
import { canTrump, eligibleCommands, exposedLeaders, leaderlessActive, nearestFriendlyHex, replacementHost } from './momentum';
import { adjacentToEnemy } from './orders';
import { routPhase } from './rout';
import { commandStatus } from './command';
import { effRating } from './ratings';
import { randomInt, rollD10 } from './rng';
import { sideRoutPoints } from './routPoints';
import type { ActivationMarker, AdvanceRate, GameState, LogEntry, MissileSupply, SideId, Unit } from './types';

export type UnitFlag = 'routed' | 'rallied' | 'engaged' | 'moved' | 'outOfCommand';

export type Action =
  | { type: 'moveUnit'; id: string; hex: Hex; facing?: number }
  | { type: 'rotateUnit'; id: string; delta: number }
  | { type: 'pivot'; id: string; keep: 'left' | 'right' }
  | { type: 'reverseFace'; id: string }
  | { type: 'setHits'; id: string; hits: number }
  | { type: 'toggleFlag'; id: string; flag: UnitFlag }
  | { type: 'setMissile'; id: string; supply: MissileSupply }
  | { type: 'setAdvance'; id: string; rate: AdvanceRate | null }
  | { type: 'eliminate'; id: string }
  | { type: 'restore'; id: string }
  | { type: 'moveLeader'; id: string; hex: Hex }
  | { type: 'woundLeader'; id: string }
  | { type: 'killLeader'; id: string }
  | { type: 'reviveLeader'; id: string }
  | { type: 'roll'; label: string; target?: number; side?: SideId }
  | { type: 'rollInitiative' }
  | { type: 'pickInitiativeMarker'; marker: ActivationMarker | null }
  | { type: 'drawMarker' }
  | { type: 'endActivation' }
  | { type: 'trump'; side: SideId }
  | { type: 'momentumAttempt'; commandId: string }
  | { type: 'trumpActivate'; commandId: string }
  | { type: 'declineChoice' }
  | { type: 'placeReplacement'; leaderId: string; unitId: string }
  | { type: 'endTurn' }
  | { type: 'note'; text: string }
  | { type: 'refreshCommand'; command: string }
  | { type: 'legalMove'; id: string; hex: Hex; facing: number; mp: number; hits: number; path: string[]; trail?: Hex[][] }
  | CombatAction;

export function allMarkers(s: GameState): ActivationMarker[] {
  const ms: ActivationMarker[] = [];
  for (const c of s.commands) ms.push({ kind: 'command', side: c.side, command: c.id });
  ms.push({ kind: 'momentum', side: 'A' }, { kind: 'momentum', side: 'B' });
  return ms;
}

export function markerLabel(s: GameState, m: ActivationMarker): string {
  const side = s.sides[m.side].name;
  if (m.kind === 'momentum') return `${side} — Momentum`;
  const c = s.commands.find((x) => x.id === m.command);
  return `${side} — ${c?.name ?? m.command}`;
}

export const sameMarker = (a: ActivationMarker, b: ActivationMarker) =>
  a.kind === b.kind && a.side === b.side && (a.kind === 'momentum' || (b.kind === 'command' && a.command === b.command));

function overallCommander(s: GameState, side: SideId) {
  return Object.values(s.leaders).find((l) => l.side === side && l.rank === 'OC' && !l.killed) ?? null;
}

function log(s: GameState, text: string, kind: LogEntry['kind'] = 'info'): GameState {
  return { ...s, log: [...s.log, { turn: s.turn, text, kind }] };
}

function roll(s: GameState): [number, GameState] {
  const [r, rng] = rollD10(s.rng);
  return [r, { ...s, rng }];
}

function updUnit(s: GameState, id: string, f: (u: Unit) => Partial<Unit>): GameState {
  const u = s.units[id];
  if (!u) return s;
  return { ...s, units: { ...s.units, [id]: { ...u, ...f(u) } } };
}

export function reducer(s: GameState, a: Action): GameState {
  switch (a.type) {
    case 'moveUnit':
      return updUnit(s, a.id, (u) => ({ hex: a.hex, facing: a.facing ?? u.facing }));

    case 'rotateUnit':
      return updUnit(s, a.id, (u) => ({ facing: normFacing(u.facing + a.delta) }));

    case 'pivot':
      return updUnit(s, a.id, (u) => (u.hex ? (a.keep === 'left' ? pivotKeepLeft : pivotKeepRight)(u.hex, u.facing) : {}));

    case 'reverseFace':
      return updUnit(s, a.id, (u) => (u.hex ? reverseFace(u.hex, u.facing) : {}));

    case 'setHits': {
      const u = s.units[a.id];
      if (!u) return s;
      const hits = Math.max(0, a.hits);
      let next = updUnit(s, a.id, () => ({ hits }));
      if (hits >= u.tq && !u.routed && hits > u.hits) {
        const elim = u.type === 'SK' || u.type === 'CH';
        next = log(next, `${u.name} reached ${hits} hits (TQ ${u.tq}) — ${elim ? 'eliminated (10.14)' : 'ROUTS (10.14)'}.`, 'combat');
      }
      return next;
    }

    case 'toggleFlag':
      return updUnit(s, a.id, (u) => {
        const v = !u[a.flag];
        const extra: Partial<Unit> = {};
        if (a.flag === 'routed' && v) { extra.hits = 0; extra.engaged = false; extra.rallied = false; }
        if (a.flag === 'rallied' && v) extra.routed = false;
        return { [a.flag]: v, ...extra };
      });

    case 'setMissile':
      return updUnit(s, a.id, () => ({ missileSupply: a.supply }));

    case 'setAdvance':
      return updUnit(s, a.id, () => ({ advance: a.rate }));

    case 'eliminate': {
      const u = s.units[a.id];
      if (!u || u.eliminated) return s;
      const next = updUnit(s, a.id, () => ({ eliminated: true, engaged: false }));
      return log(next, `${u.name} eliminated. ${s.sides[u.side].name}: ${sideRoutPoints(next, u.side)} RP.`, 'combat');
    }

    case 'restore': {
      const u = s.units[a.id];
      if (!u) return s;
      return log(updUnit(s, a.id, () => ({ eliminated: false })), `${u.name} restored to its last position.`);
    }

    case 'moveLeader': {
      const l = s.leaders[a.id];
      if (!l) return s;
      return { ...s, leaders: { ...s.leaders, [a.id]: { ...l, hex: a.hex } } };
    }

    case 'woundLeader': {
      const l = s.leaders[a.id];
      if (!l || l.killed) return s;
      if (l.wounded) return reducer(s, { type: 'killLeader', id: a.id });
      const next = { ...s, leaders: { ...s.leaders, [a.id]: { ...l, wounded: true } } };
      return log(next, `${l.name} is Wounded: all ratings −2 (8.33).`, 'combat');
    }

    case 'killLeader': {
      const l = s.leaders[a.id];
      if (!l || l.killed) return s;
      const next = { ...s, leaders: { ...s.leaders, [a.id]: { ...l, killed: true, hex: null } } };
      return log(next, `${l.name} is KILLED (4.24/4.25).`, 'combat');
    }

    case 'reviveLeader': {
      const l = s.leaders[a.id];
      if (!l) return s;
      return { ...s, leaders: { ...s.leaders, [a.id]: { ...l, killed: false, wounded: false } } };
    }

    case 'roll': {
      const [r, next] = roll(s);
      let text = `${a.label}: rolled ${r}`;
      if (a.target != null) text += r <= a.target ? ` ≤ ${a.target} → PASS` : ` > ${a.target} → FAIL`;
      return log(next, text, 'dice');
    }

    case 'rollInitiative': {
      const ocA = overallCommander(s, 'A');
      const ocB = overallCommander(s, 'B');
      const [rA, s1] = roll(s);
      const [rB, s2] = roll(s1);
      let st = s2;
      const tA = rA + (ocA ? effRating(ocA.initiative, ocA.wounded) : 0);
      const tB = rB + (ocB ? effRating(ocB.initiative, ocB.wounded) : 0);
      const winner: SideId | null = tA > tB ? 'A' : tB > tA ? 'B' : null;
      st = log(st,
        `Initiative (5.1): ${st.sides.A.name} ${rA}+${tA - rA}=${tA} vs ${st.sides.B.name} ${rB}+${tB - rB}=${tB} → ` +
        (winner ? `${st.sides[winner].name} has the Initiative.` : 'tie, nobody has the Initiative.'), 'dice');
      return { ...st, initiativeSide: winner, phase: winner ? 'initiative' : 'activation', pool: winner ? [] : allMarkers(st), initiativePick: null };
    }

    case 'pickInitiativeMarker': {
      const pool = allMarkers(s).filter((m) => !a.marker || !sameMarker(m, a.marker));
      let next: GameState = { ...s, pool, initiativePick: a.marker, active: a.marker, phase: a.marker ? 'orders' : 'activation' };
      if (a.marker) next = log(next, `Initiative pick: ${markerLabel(s, a.marker)} activates first.`, 'info');
      return activate(next, a.marker);
    }

    case 'drawMarker': {
      if (s.active || s.pendingChoice || s.pool.length === 0) return s;
      const [i, rng] = randomInt(s.rng, s.pool.length);
      const m = s.pool[i];
      const pool = s.pool.filter((_, j) => j !== i);
      let st = log({ ...s, rng, pool, active: m, phase: 'orders' }, `Drawn from the pool: ${markerLabel(s, m)}.`, 'info');
      if (m.kind === 'momentum') {
        const oc = overallCommander(st, m.side);
        st = { ...st, pendingChoice: oc ? { kind: 'momentum', side: m.side } : null };
        if (!oc) st = log(st, 'No Overall Commander: the Momentum opportunity is lost (4.24).', 'system');
        return st;
      }
      return activate(st, m);
    }

    case 'momentumAttempt': {
      if (s.pendingChoice?.kind !== 'momentum' || s.active?.kind !== 'momentum') return s;
      const side = s.pendingChoice.side;
      const opt = eligibleCommands(s, BOARDS[s.boardId].geometry, side).find((o) => o.commandId === a.commandId);
      if (!opt) return log(s, 'That Command cannot be designated for Momentum (5.24).', 'system');
      const [r, s1] = roll(s);
      const cmd = s.commands.find((c) => c.id === a.commandId)!;
      const who = opt.leaderId ? s.leaders[opt.leaderId].name : 'Leaderless Command';
      let st = spendMomentum({ ...s1, pendingChoice: null }, side);
      st = log(st, `Momentum (5.24): ${cmd.name} Command, ${who} rolled ${r} vs ${opt.rating} → ${r <= opt.rating ? 'SUCCESS' : 'failed'}.`, 'dice');
      if (r > opt.rating) {
        return log({ ...st, active: null, phase: st.pool.length ? 'activation' : 'rout' },
          'Nothing happens; the Overall Commander may still move (5.46). Draw the next marker.', 'info');
      }
      const m: ActivationMarker = { kind: 'command', side, command: a.commandId, via: 'momentum' };
      return activate({ ...st, active: m }, m);
    }

    case 'declineChoice': {
      if (!s.pendingChoice) return s;
      let st: GameState = { ...s, pendingChoice: null };
      if (s.pendingChoice.kind === 'momentum' && s.active?.kind === 'momentum') {
        st = spendMomentum(st, s.pendingChoice.side);
        st = { ...st, active: null, phase: st.pool.length ? 'activation' : 'rout' };
      }
      return log(st, `${s.sides[s.pendingChoice.side].name} declines the ${s.pendingChoice.kind === 'momentum' ? 'Momentum' : 'Trump'} activation.`, 'info');
    }

    case 'trumpActivate': {
      if (s.pendingChoice?.kind !== 'trump') return s;
      const side = s.pendingChoice.side;
      const opt = eligibleCommands(s, BOARDS[s.boardId].geometry, side).find((o) => o.commandId === a.commandId);
      if (!opt) return log(s, 'That Command cannot be activated by Trump (5.32).', 'system');
      const m: ActivationMarker = { kind: 'command', side, command: a.commandId, via: 'trump' };
      const st = log({ ...s, pendingChoice: null, active: m, phase: 'orders' }, `Trump: ${markerLabel(s, m)} undertakes an Orders Phase.`, 'info');
      return activate(st, m);
    }

    case 'endActivation': {
      if (!s.active) return s;
      let s0: GameState = s;
      if (s.active.kind === 'momentum') s0 = spendMomentum(s0, s.active.side);
      else s0 = { ...s0, used: [...s0.used, s.active] };
      const lag = inertiaLaggards(s);
      if (lag.length) s0 = log(s0, `Law of Inertia (6.28): ${lag.map((u) => u.name).join(', ')} should have moved toward the enemy this phase.`, 'system');
      const next = { ...s0, reactions: [], orders: undefined, activity: {}, pendingChoice: null, active: null, phase: s0.pool.length ? 'activation' : 'rout' } as GameState;
      return next.pool.length ? next : log(next, 'Pool empty — proceed to the Rout, Remove, Replace & Reload Phase.', 'system');
    }

    case 'trump': {
      const why = canTrump(s, a.side);
      if (why) return log(s, `Trump not possible: ${why}.`, 'system');
      const oc = overallCommander(s, a.side)!;
      if (!s.active || s.active.side === a.side) return s;
      const [r, s1] = roll(s);
      let st = s1;
      const target = effRating(oc.initiative, oc.wounded);
      const ok = r <= target;
      const opp = s.active.side;
      st = { ...st, trumpUsed: { ...st.trumpUsed, [a.side]: true } };
      st = log(st, `Trump attempt by ${oc.name} (5.32): rolled ${r} vs Initiative ${target} → ${ok ? 'SUCCESS: the drawn marker is set aside.' : 'FAILED.'}`, 'dice');
      if (ok) {
        return log({ ...st, used: [...st.used, st.active!], active: null, pendingChoice: { kind: 'trump', side: a.side }, reactions: [], activity: {}, orders: undefined },
          `${st.sides[a.side].name} may now activate one Command whose leader is the OC or within his range (or none).`, 'info');
      }
      // Failed: the opponent's Momentum marker goes back into the pool (now, or once it is used).
      const momUsed = st.used.findIndex((m) => m.kind === 'momentum' && m.side === opp);
      if (momUsed >= 0) {
        st = { ...st, used: st.used.filter((_, i) => i !== momUsed), pool: [...st.pool, { kind: 'momentum', side: opp }] };
        st = log(st, `${st.sides[opp].name}'s Momentum marker returns to the pool.`, 'info');
      } else {
        st = { ...st, momentumReturn: { ...(st.momentumReturn ?? {}), [opp]: true } };
        st = log(st, `${st.sides[opp].name}'s Momentum marker will return to the pool after it is used.`, 'info');
      }
      return st;
    }

    case 'endTurn': {
      // D.1 — Rout Movement (10.23).
      let st = routPhase(s, BOARDS[s.boardId].geometry);
      // D.3 — Replacement leaders (4.25).
      for (const l of Object.values(st.leaders)) if (l.killed && l.replacement) st = placeReplacement(st, l.id);
      // D.4 — Reload (7.17).
      st = reloadSegment(st);
      // D.2 — remove Moved/Rallied, flip Out of Command back.
      const units = Object.fromEntries(Object.entries(st.units).map(([id, u]) => [id, { ...u, moved: false, rallied: false, outOfCommand: false }]));
      st = { ...st, units };
      // E — Withdrawal check.
      const rpA = sideRoutPoints(st, 'A');
      const rpB = sideRoutPoints(st, 'B');
      const wA = rpA >= st.sides.A.withdrawalLevel;
      const wB = rpB >= st.sides.B.withdrawalLevel;
      st = log(st, `End of turn ${st.turn}. Rout Points — ${st.sides.A.name}: ${rpA}/${st.sides.A.withdrawalLevel}, ${st.sides.B.name}: ${rpB}/${st.sides.B.withdrawalLevel}.`, 'system');
      if (wA || wB) {
        let winner: SideId | 'draw';
        if (wA && wB) {
          const oA = rpA - st.sides.A.withdrawalLevel, oB = rpB - st.sides.B.withdrawalLevel;
          winner = oA < oB ? 'A' : oB < oA ? 'B' : 'draw';
        } else winner = wA ? 'B' : 'A';
        st = log({ ...st, winner, phase: 'over' }, winner === 'draw' ? 'Both armies withdraw — DRAW.' : `${st.sides[winner === 'A' ? 'B' : 'A'].name} withdraws. ${st.sides[winner].name} WINS!`, 'system');
        return st;
      }
      return { ...st, turn: st.turn + 1, phase: 'initiative', pool: [], used: [], active: null, initiativePick: null, initiativeSide: null, trumpUsed: { A: false, B: false }, reactions: [], pwOrders: {} };
    }

    case 'note':
      return log(s, a.text, 'info');

    case 'placeReplacement':
      return placeReplacement(s, a.leaderId, a.unitId);

    case 'refreshCommand':
      return applyCommandStatus(s, a.command);

    case 'legalMove': {
      const u = s.units[a.id];
      if (!u) return s;
      const formation = u.type === 'HO' || u.type === 'HI' || u.type === 'MI';
      const secondMove = formation && u.moved;
      let st = updUnit(s, a.id, () => ({ hex: a.hex, facing: a.facing, moved: formation ? true : u.moved }));
      st = { ...st, activity: { ...(st.activity ?? {}), [u.id]: 'moved' } };
      const pivots = a.path.filter((p) => p.startsWith('pivot')).length;
      st = log(st, `${u.name} moves (${a.mp} MP${pivots ? `, ${pivots} pivot${pivots > 1 ? 's' : ''}` : ''}).`, 'info');
      if (a.hits) st = combatReducer(st, { type: 'applyHits', hits: { [u.id]: a.hits }, reason: 'Front-to-Flank / moving through friends' });
      if (secondMove) st = combatReducer(st, { type: 'applyHits', hits: { [u.id]: 1 }, reason: 'moved again this turn (6.13)' });
      const after = st.units[u.id];
      if (!after.eliminated && !after.routed && after.hits >= after.tq) st = routUnit(st, u.id, 'movement hits reached TQ (10.14)');
      if (u.advance === 'run') st = log(st, `${u.name} advanced at the Run: make the after-move TQ check (6.24).`, 'system');
      st = displaceLeaders(st, u.id);
      // Reactions of the inactive side to this move (6.6, 6.7, 6.94/6.95, 7.3).
      const fresh = a.trail && !st.units[u.id].eliminated ? detectMoveReactions(st, BOARDS[st.boardId].geometry, u.id, a.trail) : [];
      st = { ...st, reactions: fresh };
      if (fresh.length) st = log(st, `${fresh.length} reaction(s) available to ${st.sides[u.side === 'A' ? 'B' : 'A'].name}.`, 'system');
      return st;
    }

    default:
      return combatReducer(s, a);
  }
}

/** Flip units of an activated Command to In/Out of Command (5.41), computed at the start of its Orders Phase. */
export function applyCommandStatus(s: GameState, commandId: string): GameState {
  const status = commandStatus(s, BOARDS[s.boardId].geometry, commandId);
  const units = { ...s.units };
  const out: string[] = [];
  for (const [id, inCmd] of Object.entries(status)) {
    units[id] = { ...units[id], outOfCommand: !inCmd };
    if (!inCmd) out.push(units[id].name);
  }
  const cmd = s.commands.find((c) => c.id === commandId);
  return log({ ...s, units }, `${cmd?.name ?? commandId} Command: ${out.length ? `Out of Command — ${out.join(', ')}` : 'all units In Command'}.`, 'info');
}

/** A Momentum marker is spent; after a failed enemy Trump it goes back into the pool instead (5.32). */
function spendMomentum(s: GameState, side: SideId): GameState {
  if (s.momentumReturn?.[side]) {
    const st = { ...s, pool: [...s.pool, { kind: 'momentum', side } as ActivationMarker], momentumReturn: { ...s.momentumReturn, [side]: false } };
    return log(st, `${s.sides[side].name}'s Momentum marker returns to the pool (failed enemy Trump).`, 'info');
  }
  return { ...s, used: [...s.used, { kind: 'momentum', side }] };
}

/** Phase D.3 (4.25): put each killed Formation Commander's replacement on a unit of his Command. */
function placeReplacement(s: GameState, leaderId: string, unitId?: string): GameState {
  const l = s.leaders[leaderId];
  if (!l || !l.killed || !l.replacement || s.leaders[`${l.id}-r`]) return s;
  const g = BOARDS[s.boardId].geometry;
  const host = unitId ? s.units[unitId] : replacementHost(s, g, l.commands);
  if (!host?.hex) return log(s, `${l.name}'s replacement cannot be placed: no unit left in the Command.`, 'system');
  const rep = {
    ...l, id: `${l.id}-r`, name: l.replacement.name, image: l.replacement.image, range: l.replacement.range,
    initiative: l.replacement.initiative, killed: false, wounded: false, hex: host.hex, replacement: undefined,
    countsForRP: l.countsForRP,
  };
  return log({ ...s, leaders: { ...s.leaders, [rep.id]: rep } }, `${rep.name} replaces ${l.name}, placed with ${host.name} (4.25).`, 'info');
}

const activate = (s: GameState, m: ActivationMarker | null): GameState => {
  if (!m || m.kind !== 'command') return s;
  let st = applyCommandStatus(s, m.command);
  // Leaderless Command activated by Momentum/Trump: only its units within the OC's range act (5.51).
  const cmd = st.commands.find((c) => c.id === m.command);
  if (cmd?.leaderless && m.via) {
    const ok = leaderlessActive(st, BOARDS[st.boardId].geometry, m.command, m.side);
    const idle = Object.values(st.units).filter((u) => u.command === m.command && !u.eliminated && !ok.has(u.id));
    if (idle.length) {
      st = log({ ...st, activity: Object.fromEntries(idle.map((u) => [u.id, 'inactive' as const])) },
        `Outside the OC's range, ${idle.map((u) => u.name).join(', ')} cannot act this phase (5.51).`, 'system');
      return { ...st, reactions: [], orders: 'move' };
    }
  }
  for (const l of Object.values(st.leaders)) {
    if (st.pwOrders?.[l.id] && l.commands.includes(m.command)) {
      st = log(st, `${l.name} holds a Pre-arranged Withdrawal order: units in his range may not move, Disengage or Rally this phase, only recover hits (6.73).`, 'system');
    }
  }
  return { ...st, reactions: [], orders: 'move', activity: {} };
};

/** 4.23: a leader alone in a hex that an enemy moves next to is placed with the nearest friendly unit. */
function displaceLeaders(s: GameState, moverId: string): GameState {
  const mover = s.units[moverId];
  if (!mover || mover.eliminated) return s;
  let st = s;
  for (const l of exposedLeaders(st, mover)) {
    const to = nearestFriendlyHex(st, BOARDS[st.boardId].geometry, l);
    if (!to) continue;
    st = log({ ...st, leaders: { ...st.leaders, [l.id]: { ...l, hex: to } } }, `${l.name}, alone, falls back to the nearest friendly unit (4.23).`, 'info');
  }
  return st;
}

/** Hellene Law of Inertia (6.28): advancing hoplites of the active Command must be given a move order. */
export function inertiaLaggards(s: GameState): Unit[] {
  if (s.active?.kind !== 'command') return [];
  const cmd = s.active.command;
  return Object.values(s.units).filter((u) => u.command === cmd && u.type === 'HO' && u.advance && !u.spartan &&
    !u.eliminated && !u.routed && !u.engaged && s.activity?.[u.id] !== 'moved' && !adjacentToEnemy(s, u));
}

export { effRating };

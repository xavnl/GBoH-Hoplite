// Heuristic AI for Hoplite. It never touches the state directly: it proposes Actions that go
// through the same reducer as the human player's clicks, so every rule check still applies.
import { BOARDS } from '../data/boards';
import { attackApproach, canShock, inFrontOf, missileCalc, unitDistance, unitHexes } from '../engine/combat';
import { leadersWith } from '../engine/combatActions';
import { footprint, type BoardGeometry } from '../engine/hex';
import { canTrump, eligibleCommands, overallCommander } from '../engine/momentum';
import { legalMoves, type Reach } from '../engine/movement';
import { adjacentToEnemy, commandLeaders, rallyEligible, recoveryAmount } from '../engine/orders';
import { withdrawDestinations } from '../engine/reactions';
import { allMarkers, type Action } from '../engine/reducer';
import { effRating } from '../engine/ratings';
import type { GameState, Reaction, SideId, Unit } from '../engine/types';
import {
  enemiesInFront, exposure, flankSupport, isHeavy, isLight, liveEnemies, missileOdds, nearestEnemyDistance, shockValue,
} from './evaluate';

const geo = (s: GameState): BoardGeometry => BOARDS[s.boardId].geometry;
const other = (side: SideId): SideId => (side === 'A' ? 'B' : 'A');
const cmdUnits = (s: GameState, cmd: string) => Object.values(s.units).filter((u) => u.command === cmd && !u.eliminated && u.hex);
const isHopliteCommand = (s: GameState, cmd: string) => cmdUnits(s, cmd).filter((u) => u.type === 'HO').length >= cmdUnits(s, cmd).length / 2;

// ---------------------------------------------------------------------------
// Single decisions outside the AI's own Orders Phase
// ---------------------------------------------------------------------------

/** Command marker the AI picks when it wins the Initiative: the Hoplite command. */
export function aiInitiativePick(s: GameState, side: SideId): Action {
  const ms = allMarkers(s).filter((m) => m.side === side && m.kind === 'command');
  const best = ms.find((m) => m.kind === 'command' && isHopliteCommand(s, m.command)) ?? ms[0] ?? null;
  return { type: 'pickInitiativeMarker', marker: best };
}

/** Momentum designation / Trump activation: the command with the most fighting value, best rating first. */
export function aiChoice(s: GameState, side: SideId): Action {
  const opts = eligibleCommands(s, geo(s), side);
  if (!opts.length) return { type: 'declineChoice' };
  // Value of an extra Orders Phase: engaged units get another Shock, fresh units can act,
  // but formation infantry that already moved pays a cohesion hit to move again (6.13) —
  // and advancing hoplites would be forced to (6.28).
  const value = (cmd: string) => cmdUnits(s, cmd).filter((u) => !u.routed).reduce((t, u) => {
    if (u.engaged) return t + 3;
    const formation = u.type === 'HO' || u.type === 'HI' || u.type === 'MI';
    if (formation && u.moved) return t - (u.advance && !adjacentToEnemy(s, u) ? 2 : 0.5);
    return t + 1;
  }, 0);
  const scored = opts.map((o) => ({ o, v: value(o.commandId) * (o.rating + 1) / 10 })).sort((a, b) => b.v - a.v);
  if (scored[0].v <= 0.2) return { type: 'declineChoice' };
  const best = scored[0].o;
  return s.pendingChoice?.kind === 'momentum'
    ? { type: 'momentumAttempt', commandId: best.commandId }
    : { type: 'trumpActivate', commandId: best.commandId };
}

/** Should the AI try to Trump the marker the opponent just drew? */
export function aiWantsTrump(s: GameState, side: SideId): boolean {
  const m = s.active;
  if (!m || m.side === side || m.kind !== 'command' || m.via) return false;
  if (s.initiativePick && s.initiativePick.kind === 'command' && s.initiativePick.command === m.command && s.initiativePick.side === m.side) return false;
  if (canTrump(s, side)) return false;
  const oc = overallCommander(s, side)!;
  const chance = (effRating(oc.initiative, oc.wounded) + 1) / 10;
  // Worth it against the enemy's main battle line while ours has not acted yet.
  const ourMainUnused = allMarkers(s).some((x) => x.side === side && x.kind === 'command' && isHopliteCommand(s, x.command) &&
    s.pool.some((p) => p.kind === 'command' && p.command === x.command));
  return chance >= 0.3 && isHopliteCommand(s, m.command) && ourMainUnused;
}

/** Answer one reaction opportunity of the AI side. */
export function aiReaction(s: GameState, r: Reaction): Action {
  const g = geo(s);
  const u = s.units[r.reactorId], m = s.units[r.moverId];
  const skip: Action = { type: 'dismissReaction', reactionId: r.id };
  if (!u || !m || u.eliminated) return skip;
  switch (r.kind) {
    case 'withdraw': {
      // Light troops avoid contact with heavier or faster-hitting enemies.
      if (!(isLight(u) || u.type === 'LI') || isLight(m) && m.type === 'SK') return skip;
      const penalty = (r.approach !== 'front' && (u.type !== 'SK' || r.approach === 'rear') ? 1 : 0) + (u.type === 'SK' || u.type === 'LC' ? 0 : 1) + (u.type === 'SK' ? 0 : 0.6);
      if (u.hits + penalty >= u.tq) return skip;
      const dest = withdrawDestinations(s, g, u, m, r.mp ?? 0)[0];
      return dest ? { type: 'reactWithdraw', reactionId: r.id, anchor: dest.anchor } : skip;
    }
    case 'pw':
      return skip;
    case 'facing': {
      if (inFrontOf(u, m) || u.hits >= u.tq - 2) return skip;
      for (const d of [-2, 2]) {
        const turned = { ...u, facing: (u.facing + d + 12) % 12 };
        if (footprint(turned.hex!, turned.facing, turned.size).front.some((h) => unitHexes(m).some((x) => x.q === h.q && x.r === h.r))) {
          return { type: 'reactFacing', reactionId: r.id, delta: d };
        }
      }
      return skip;
    }
    case 'reverseFace':
      return u.hits + 2 < u.tq ? { type: 'reactFacing', reactionId: r.id, delta: 6 } : skip;
    default: {
      const c = missileCalc(g, u, m, r.range ? { rangeOverride: r.range } : {});
      if (!c.allowed || c.strength == null) return skip;
      const p = Math.max(0, Math.min(10, c.strength - c.totalMod + 1)) / 10;
      return p >= 0.2 ? { type: 'reactFire', reactionId: r.id } : skip;
    }
  }
}

// ---------------------------------------------------------------------------
// The AI's own Orders Phase
// ---------------------------------------------------------------------------

/** Score a position for a unit (higher is better). */
function scorePosition(s: GameState, u: Unit, r: Reach | null): number {
  const g = geo(s);
  const moved: Unit = r ? { ...u, hex: r.anchor, facing: r.facing } : u;
  const s2: GameState = r ? { ...s, units: { ...s.units, [u.id]: moved } } : s;
  // Cohesion paid for this move: pivots/passing friends, moving again (6.13), Run check (6.24, ~expected).
  const formation = u.type === 'HO' || u.type === 'HI' || u.type === 'MI';
  const again = r && formation && u.moved ? 1 : 0;
  const runRisk = r && u.advance === 'run' ? Math.max(0, 9 - u.tq) / 10 : 0;
  const hits = (r?.hits ?? 0) + again + runRisk;
  let score = 0;
  if (u.hits + hits >= u.tq - 1) score -= 10;
  score -= hits * 3;

  if (isLight(u) || u.type === 'LC') {
    // Skirmish: fire from a distance, avoid the heavy infantry's reach, hit weak flanks.
    if (u.missile) {
      let best = 0;
      for (const e of liveEnemies(s2, u.side)) best = Math.max(best, missileOdds(g, moved, e).ev);
      score += best * 6;
    }
    const dHeavy = nearestEnemyDistance(s2, unitHexes(moved), u.side, (e) => isHeavy(e) && !e.engaged);
    if (dHeavy <= 1) score -= 6; else if (dHeavy === 2) score -= 2;
    const front = enemiesInFront(s2, moved);
    if (u.type === 'LC' && !u.missile && front.length) {
      const flankHit = front.some((e) => attackApproach(moved, e) !== 'front');
      score += (flankHit ? 3 : 0) + 4 * shockValue(s2, [moved], front);
    }
    score -= 1.2 * exposure(s2, moved);
    // Stay in the fight: not too far from the enemy.
    const d = nearestEnemyDistance(s2, unitHexes(moved), u.side);
    if (d > 4) score -= (d - 4) * 0.5;
    return score;
  }

  // Line infantry: close in, attack frontally with support, never offer a flank.
  const d = nearestEnemyDistance(s2, unitHexes(moved), u.side);
  score -= Math.min(d, 12) * 1.0;
  const front = enemiesInFront(s2, moved);
  if (front.length) {
    score += 3 + 4 * shockValue(s2, [moved], front);
    if (front.some((e) => attackApproach(moved, e) !== 'front')) score += 3;
  }
  score -= 1.5 * exposure(s2, moved);
  score += 0.7 * flankSupport(s2, moved);
  return score;
}

const prob = (n: number) => Math.max(0, Math.min(10, n)) / 10;

/**
 * Generator driving one Orders Phase of the AI side. Each `yield` proposes an action; the caller
 * applies it with the reducer and passes the new state back in.
 */
export function* aiActivation(start: GameState, side: SideId): Generator<Action, void, GameState> {
  let s = start;
  const g = geo(s);
  if (s.active?.kind !== 'command' || s.active.side !== side) return;
  const cmd = s.active.command;
  const units = () => cmdUnits(s, cmd);

  // --- Orders: Rally when routed units can be rallied and nothing is in contact; otherwise Move/Fire.
  const leaders = commandLeaders(s, cmd);
  const rallyable = units().filter((u) => u.routed && !u.rallied && leaders.some((l) => rallyEligible(s, g, u, l).ok));
  const inContact = units().some((u) => !u.routed && (u.engaged || adjacentToEnemy(s, u)));
  if (rallyable.length && !inContact) {
    s = yield { type: 'setOrders', orders: 'rally' };
    s = yield { type: 'rally', commandId: cmd };
    s = yield* aiShocks(s, side, cmd);
    s = yield { type: 'endActivation' };
    return;
  }

  // --- Hoplites roll their Advance to Combat rate before their first move (6.22).
  if (units().some((u) => u.type === 'HO' && !u.advanceRolled && !u.engaged && !u.routed)) {
    s = yield { type: 'rollAdvanceCommand', commandId: cmd };
  }

  // --- Missile fire from units that are better off firing than moving.
  for (const u0 of units()) {
    const u = s.units[u0.id];
    if (!u.missile || u.missileSupply === 'no' || u.engaged || u.routed || s.activity?.[u.id]) continue;
    let best: { t: Unit; ev: number; p: number } | null = null;
    for (const e of liveEnemies(s, side)) {
      const o = missileOdds(g, u, e);
      if (o.p > 0 && (!best || o.ev > best.ev)) best = { t: e, ...o };
    }
    if (best && best.p >= 0.2) s = yield { type: 'missileFire', firerId: u.id, targetId: best.t.id };
    s = yield* waitReactions(s, side);
  }

  // --- Movement: heavy units first, ordered along the line; light units afterwards.
  const order = units().filter((u) => !u.routed && !u.engaged)
    .sort((a, b) => (isLight(a) ? 1 : 0) - (isLight(b) ? 1 : 0) || a.hex!.q - b.hex!.q);
  for (const u0 of order) {
    const u = s.units[u0.id];
    if (!u || u.eliminated || u.routed || u.engaged || s.activity?.[u.id]) continue;
    const moves = [...legalMoves(s, g, u).values()];
    const forced = u.type === 'HO' && !!u.advance && !u.spartan && moves.length > 0;
    let best: Reach | null = null;
    let bestScore = forced ? -Infinity : scorePosition(s, u, null);
    for (const m of moves) {
      const sc = scorePosition(s, u, m) - m.mp * 0.05;
      if (sc > bestScore) { bestScore = sc; best = m; }
    }
    if (best) {
      s = yield { type: 'legalMove', id: u.id, hex: best.anchor, facing: best.facing, mp: best.mp, hits: best.hits, path: best.path, trail: best.trail };
      s = yield* waitReactions(s, side);
      // Skirmishers and cavalry may fire after moving forward (7.11).
      const mu = s.units[u.id];
      if (mu && !mu.eliminated && mu.missile && mu.missileSupply !== 'no' && !(mu.type === 'LI') && !mu.engaged) {
        let tgt: { t: Unit; ev: number; p: number } | null = null;
        for (const e of liveEnemies(s, side)) { const o = missileOdds(g, mu, e); if (o.p > 0 && (!tgt || o.ev > tgt.ev)) tgt = { t: e, ...o }; }
        if (tgt && tgt.p >= 0.2) { s = yield { type: 'missileFire', firerId: mu.id, targetId: tgt.t.id }; s = yield* waitReactions(s, side); }
      }
    } else {
      const rec = recoveryAmount(s, g, u);
      if (rec.hits) s = yield { type: 'recover', id: u.id };
    }
  }

  // --- Shock Combat Segment.
  s = yield* aiShocks(s, side, cmd);
  s = yield { type: 'endActivation' };
}

/** Pause while the opponent still has reactions to decide (the driver resumes with the new state). */
function* waitReactions(s: GameState, side: SideId): Generator<Action, GameState, GameState> {
  // The opponent's reactions are handled outside the generator; signal with a no-op note if pending.
  let st = s;
  while ((st.reactions ?? []).some((r) => st.units[r.reactorId]?.side === other(side))) {
    st = yield { type: 'note', text: '__wait_reactions__' };
  }
  return st;
}

interface Combat { att: string[]; def: string[]; optional: Set<string> }

/** Build and resolve all Shock combats of the AI's active command (8.11-8.18). */
function* aiShocks(start: GameState, side: SideId, cmd: string): Generator<Action, GameState, GameState> {
  let s = start;
  const combats: Combat[] = [];
  const inCombat = (id: string) => combats.find((c) => c.def.includes(id) || c.att.includes(id));
  const attackers = cmdUnits(s, cmd).filter((u) => !u.routed && !u.rallied && canShock(u, enemiesInFront(s, u)) && enemiesInFront(s, u).length);
  // Must-shock units first (engaged, or moved adjacent this phase), then favourable optional attacks.
  const must = (u: Unit) => u.engaged || s.activity?.[u.id] === 'moved';
  attackers.sort((a, b) => Number(must(b)) - Number(must(a)));
  for (const a of attackers) {
    const fronts = enemiesInFront(s, a).filter((e) => !e.eliminated);
    if (!fronts.length) continue;
    if (!must(a)) {
      const ev = shockValue(s, [a], fronts.filter((e) => !inCombat(e.id)));
      if (ev < 0.3) continue;
    }
    const existing = fronts.map((e) => inCombat(e.id)).find(Boolean);
    const fresh = fronts.filter((e) => !inCombat(e.id)).map((e) => e.id);
    if (existing) { existing.att.push(a.id); existing.def.push(...fresh); if (!must(a)) existing.optional.add(a.id); }
    else combats.push({ att: [a.id], def: fresh, optional: new Set(must(a) ? [] : [a.id]) });
  }

  for (const c of combats) {
    // Pre-shock checks (8.14): optional attackers check, then non-engaged defenders.
    const allSkOrRouted = c.def.every((id) => s.units[id].type === 'SK' || s.units[id].routed);
    let att = [...c.att];
    for (const id of c.att) {
      if (!c.optional.has(id) || allSkOrRouted) continue;
      const before = s.log.length;
      s = yield { type: 'preShockAttacker', id };
      if (s.log.slice(before).some((l) => l.text.includes('does NOT attack'))) att = att.filter((x) => x !== id);
    }
    if (!att.length) continue;
    for (const id of c.def) {
      const d = s.units[id];
      if (d.eliminated || d.engaged) continue;
      const lionsVsLi = d.size === 2 && att.every((x) => s.units[x].type === 'LI' && attackApproach(s.units[x], d) === 'front');
      if (!lionsVsLi) { s = yield { type: 'preShockDefender', id, attackerIds: att }; s = yield* waitReactions(s, side); }
    }
    const atts = att.map((id) => s.units[id]).filter((u) => u && !u.eliminated && !u.routed);
    const defs = c.def.map((id) => s.units[id]).filter((u) => u && !u.eliminated && atts.some((a) => inFrontOf(a, u)));
    if (!atts.length || !defs.length) continue;
    // Leaders (8.15 / 8.3)
    const al = [...new Map(atts.flatMap((u) => leadersWith(s, u)).map((l) => [l.id, l])).values()];
    const dl = [...new Map(defs.flatMap((u) => leadersWith(s, u)).map((l) => [l.id, l])).values()];
    if (al.length && dl.length) s = yield { type: 'personalCombat', attackerLeaderId: al[0].id, defenderLeaderId: dl[0].id };
    else for (const l of [...al, ...dl]) s = yield { type: 'leaderCasualty', leaderId: l.id };
    // Resolution & collapse
    const enemies = liveEnemies(s, side);
    const phalanxFrontAndFlank = atts.some((a) => a.size === 2 && defs.some((d) => attackApproach(a, d) === 'front') && defs.some((d) => attackApproach(a, d) === 'flank'));
    const pinnedAttackers = atts.filter((a) => enemies.some((e) => !defs.includes(e) && inFrontOf(e, a))).map((a) => a.id);
    const run = atts.some((a) => a.advance === 'run');
    const posSup = !phalanxFrontAndFlank && atts.some((a) => !pinnedAttackers.includes(a.id) && defs.some((d) => attackApproach(a, d) !== 'front'));
    s = yield { type: 'resolveShock', attackerIds: atts.map((u) => u.id), defenderIds: defs.map((u) => u.id), options: { run, phalanxFrontAndFlank, pinnedAttackers } };
    s = yield { type: 'collapse', attackerIds: atts.map((u) => u.id), defenderIds: defs.map((u) => u.id), positionSuperiority: posSup, superiorId: null };
    s = yield* waitReactions(s, side);
  }
  return s;
}

/** Fire probability helper exposed for the UI. */
export { prob, unitDistance };

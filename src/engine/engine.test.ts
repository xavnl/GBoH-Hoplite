import { describe, expect, it } from 'vitest';
import { BOARDS } from '../data/boards';
import { NEMEA } from '../data/scenarios/nemea';
import type { VassalSetup } from '../data/scenarios/types';
import nemeaSetup from '../data/setups/nemea.vassal.json';
import { collapseVerdicts, distributeHits, missileCalc, resolveMissile, resolveShock, shockCalc } from './combat';
import { commandStatus, commandRangeHexes } from './command';
import { footprint, hexFromLabel, hexLabel, neighborAt, pivotKeepLeft, pivotKeepRight, reverseFace } from './hex';
import { legalMoves } from './movement';
import { reducer } from './reducer';
import { detectMoveReactions, withdrawDestinations } from './reactions';
import { unitDistance, unitHexes } from './combat';
import { advanceAfterCombat, routMove, routPhase } from './rout';
import { sideRoutPoints } from './routPoints';
import { rollD10 } from './rng';
import { createGame } from './setup';
import { cwsColumn, shockCrt, weaponSuperiority } from './tables';
import type { GameState, Unit } from './types';

const g = BOARDS.blankFull.geometry;
const L = (s: string) => hexFromLabel(g, s);
const lab = (h: { q: number; r: number }) => hexLabel(g, h);

function unit(p: Omit<Partial<Unit>, 'hex'> & { id: string; type: Unit['type']; hex: string; facing?: number }): Unit {
  return {
    name: p.id, image: '', side: 'A', command: 'c', tq: 6, ma: 4, size: 1, hits: 0, routed: false, rallied: false,
    engaged: false, moved: false, outOfCommand: false, missileSupply: 'full', advance: null, eliminated: false,
    ...p, facing: p.facing ?? 0, hex: L(p.hex),
  } as Unit;
}

describe('hex geometry', () => {
  it('round-trips printed hex numbers', () => {
    for (const s of ['4201', '4100', '2217', '3110', '1036']) expect(lab(L(s))).toBe(s);
  });

  it('follows the Drift-to-the-Right example (6.29): 2217/2218 -> 2317/2318 is the right-front move', () => {
    // A phalanx in 2217/2218 facing "south" (map up) moving forward lands in 2317/2318? Front hexes:
    const fp = footprint(L('2217'), 0, 2);
    expect(fp.hexes.map(lab)).toEqual(['2217', '2218']);
    expect(fp.front.map(lab).sort()).toEqual(['2316', '2317', '2318'].sort());
    expect(fp.rear.map(lab).sort()).toEqual(['2116', '2117', '2118'].sort());
    expect(fp.flank.map(lab).sort()).toEqual(['2216', '2219']);
  });

  it('pivots and reverses a phalanx', () => {
    const left = pivotKeepLeft(L('2215'), 0);
    expect(footprint(left.anchor, left.facing, 2).hexes.map(lab)).toEqual(['2215', '2315']);
    const right = pivotKeepRight(L('2215'), 0);
    expect(footprint(right.anchor, right.facing, 2).hexes.map(lab).sort()).toEqual(['2216', '2315']);
    const rev = reverseFace(L('2215'), 0);
    expect(footprint(rev.anchor, rev.facing, 2).hexes.map(lab).sort()).toEqual(['2215', '2216']);
    expect(rev.facing).toBe(6);
  });

  it('neighbour directions are consistent', () => {
    expect(lab(neighborAt(L('2215'), 90))).toBe('2216');
    expect(lab(neighborAt(L('2215'), 270))).toBe('2214');
  });
});

describe('Nemea setup from Vassal', () => {
  const s = createGame(NEMEA, nemeaSetup as VassalSetup, BOARDS.blankFull, 1);
  const at = (name: string) => Object.values(s.units).filter((u) => u.name.startsWith(name)).map((u) => footprint(u.hex!, u.facing, u.size).hexes.map(lab).sort().join('-'));

  it('places every unit of the order of battle', () => {
    expect(Object.values(s.units).filter((u) => u.side === 'B').length).toBe(18);
    expect(Object.values(s.units).filter((u) => u.side === 'A').length).toBe(20);
    expect(Object.keys(s.leaders).length).toBe(4);
  });

  it('matches the scenario hex assignments', () => {
    expect(at('Thebes')).toEqual(['3110-3111']);
    expect(at('Corinth').sort()).toEqual(['3112-3113', '3114-3115']);
    expect(at('Sicyon')).toEqual(['2209-2210']);
    expect(at('Sparta').filter((x) => x.includes('-')).sort()).toEqual(['2227-2228', '2229-2230', '2231-2232', '2233-2234', '2235-2236']);
  });

  it('faces the armies toward each other', () => {
    const thebes = Object.values(s.units).find((u) => u.name.startsWith('Thebes'))!;
    const sicyon = Object.values(s.units).find((u) => u.name.startsWith('Sicyon'))!;
    expect(thebes.facing).toBe(6); // toward 22xx (down the map image)
    expect(sicyon.facing).toBe(0);
  });
});

describe('Shock tables', () => {
  it('reproduces the rule-book CRT examples (8.17)', () => {
    expect(shockCrt(10, 8)).toEqual([2, 4]);
    expect(shockCrt(10, 2)).toEqual([2, 2]);
    expect(shockCrt(1, -3)).toEqual([6, 0]);
    expect(shockCrt(13, 14)).toEqual([0, 6]);
  });

  it('reads the comparative weapons and superiority charts by attacker column', () => {
    expect(cwsColumn('HO', 'LI')).toBe(10);
    expect(cwsColumn('HO', 'MI')).toBe(9);
    expect(cwsColumn('LI', 'HO')).toBe(2);
    expect(cwsColumn('MI', 'HO')).toBe(4);
    expect(cwsColumn('SK', 'HO')).toBeNull();
    expect(weaponSuperiority('HO', 'LI')).toBe('AS');
    expect(weaponSuperiority('LI', 'HO')).toBe('DS');
    expect(weaponSuperiority('CH', 'SK')).toBe('AS');
    expect(weaponSuperiority('SK', 'CH')).toBe('AS');
  });
});

describe('Shock resolution', () => {
  it('Mycale example: Hoplite Phalanx vs two LI at the Run, Persian FC present', () => {
    // Phalanx 4915/4916 is too far north for this blank map; use the same shape elsewhere.
    const ph = unit({ id: 'athens', type: 'HO', size: 2, tq: 7, hex: '2215', facing: 0, hits: 1 });
    const li1 = unit({ id: 'phry1', side: 'B', type: 'LI', tq: 6, hex: '2315', facing: 6 });
    const li2 = unit({ id: 'phry2', side: 'B', type: 'LI', tq: 5, hex: '2316', facing: 6 });
    const fc = { id: 'artayntas', name: 'Artayntas', rank: 'FC', initiative: 1 } as never;
    const calc = shockCalc({ attackers: [ph], defenders: [li1, li2], attackerLeaders: [], defenderLeaders: [fc], run: true });
    expect(calc.allowed).toBe(true);
    expect(calc.baseColumn).toBe(10);
    expect(calc.superiority).toBe('AS');
    expect(calc.numericalShift).toBe(0); // phalanx counts as 2 vs single-sized units
    expect(calc.totalMod).toBe(1);
    const out = resolveShock(calc, [ph], [li1, li2], 7);
    expect(out.printed).toEqual([2, 4]);
    expect(out.attackerHits).toBe(2);
    expect(out.defenderHits).toBe(8);
  });

  it('Example #2: MI front + LI flank -> Position Superiority with the LI column', () => {
    const hop = unit({ id: 'hop', side: 'B', type: 'HO', size: 2, tq: 7, hex: '2215', facing: 0 });
    const mi = unit({ id: 'mi', type: 'MI', tq: 5, hex: '2316', facing: 6 }); // in hop's front
    const li = unit({ id: 'li', type: 'LI', tq: 5, hex: '2217', facing: 10 }); // hop's right flank, facing it
    const calc = shockCalc({ attackers: [mi, li], defenders: [hop], attackerLeaders: [], defenderLeaders: [], run: false });
    expect(calc.positionUnit?.id).toBe('li');
    expect(calc.superiority).toBe('AS');
    expect(calc.baseColumn).toBe(2);
  });

  it('halves attacker hits against skirmishers and distributes hits evenly', () => {
    const ho = unit({ id: 'ho', type: 'HO', size: 2, tq: 6, hex: '2215' });
    const sk = unit({ id: 'sk', side: 'B', type: 'SK', tq: 1, missile: 'S', hex: '2315', facing: 6 });
    const calc = shockCalc({ attackers: [ho], defenders: [sk], attackerLeaders: [], defenderLeaders: [], run: false });
    const out = resolveShock(calc, [ho], [sk], 0);
    expect(out.attackerHits).toBe(Math.floor(out.printed[0] / 2));
    const a = unit({ id: 'a', type: 'LI', hex: '1010' });
    const b = unit({ id: 'b', type: 'LI', hex: '1012' });
    expect(distributeHits([a, b], 5, [b])).toEqual({ a: 2, b: 3 });
  });

  it('collapse: when everyone would rout, the side with the larger excess routs', () => {
    const marines = unit({ id: 'marines', type: 'HO', tq: 6, hits: 6, hex: '2215' });
    const sardis = unit({ id: 'sardis', side: 'B', type: 'LI', tq: 3, hits: 4, hex: '2315' });
    const v = collapseVerdicts([marines], [sardis], false);
    expect(v.sardis.kind).toBe('rout');
    expect(v.marines).toEqual(expect.objectContaining({ kind: 'setTo', hits: 5 }));
  });
});

describe('Missile fire', () => {
  it('composite bow: range 2 needs adjusted 4; range 1 adjusted 0 is two hits', () => {
    const archer = unit({ id: 'arch', type: 'LI', tq: 5, ma: 5, missile: 'C', hex: '2215', facing: 0 });
    const lc = unit({ id: 'lc', side: 'B', type: 'LC', tq: 4, ma: 8, hex: '2416', facing: 6 });
    const c2 = missileCalc(g, archer, lc);
    expect(c2.allowed).toBe(true);
    expect(c2.range).toBe(2);
    expect(c2.strength).toBe(4);
    expect(c2.totalMod).toBe(-1); // MI/PL/LC vs composite bow
    expect(resolveMissile(c2, archer, 5).hits).toBe(1);
    expect(resolveMissile(c2, archer, 6).hits).toBe(0);
    const adj = unit({ id: 'sk', side: 'B', type: 'SK', tq: 1, hex: '2315', facing: 6 });
    const c1 = missileCalc(g, archer, adj);
    expect(c1.totalMod).toBe(1);
    expect(resolveMissile(c1, archer, 0).hits).toBe(1); // adjusted 1 -> one hit
    const ph = unit({ id: 'ph', side: 'B', type: 'HO', size: 2, tq: 6, hex: '2314', facing: 6 });
    expect(missileCalc(g, archer, ph).totalMod).toBe(2);
  });

  it('refuses fire outside the arc and at engaged targets', () => {
    const sling = unit({ id: 's', type: 'SK', tq: 1, ma: 5, missile: 'S', hex: '2215', facing: 0 });
    const behind = unit({ id: 'b', side: 'B', type: 'LI', hex: '2115' });
    expect(missileCalc(g, sling, behind).allowed).toBe(false);
    const eng = unit({ id: 'e', side: 'B', type: 'LI', hex: '2315', engaged: true });
    expect(missileCalc(g, sling, eng).reasons.join()).toMatch(/Engaged/);
  });

  it('javelins go Missile Low on 7-9, bows only on 9', () => {
    const jav = unit({ id: 'j', type: 'PL', missile: 'J', hex: '2215' });
    const t = unit({ id: 't', side: 'B', type: 'HO', size: 2, hex: '2314', facing: 6 });
    expect(resolveMissile(missileCalc(g, jav, t), jav, 7).becomesLow).toBe(true);
    const bow = unit({ id: 'bw', type: 'LI', missile: 'B', hex: '2215' });
    expect(resolveMissile(missileCalc(g, bow, t), bow, 8).becomesLow).toBe(false);
  });
});

describe('Movement (6.0)', () => {
  const base = createGame(NEMEA, nemeaSetup as VassalSetup, BOARDS.blankFull, 1);
  const only = (units: Unit[]) => ({ ...base, units: Object.fromEntries(units.map((u) => [u.id, u])) });
  const dests = (m: Map<string, { anchor: { q: number; r: number }; facing: number; mp: number; hits: number }>) =>
    [...m.values()].map((r) => ({ at: footprint(r.anchor, r.facing, 2).hexes.map(lab).join('/'), f: r.facing, mp: r.mp, hits: r.hits }));

  it('a phalanx advances 4 rows straight ahead with MA 4 and pays 1 hit per pivot', () => {
    const ph = unit({ id: 'ph', type: 'HO', size: 2, tq: 6, hex: '2215', facing: 0 });
    const m = dests(legalMoves(only([ph]), g, ph));
    const ahead = m.filter((d) => d.f === 0 && d.mp === 4);
    expect(ahead.some((d) => d.at.startsWith('26'))).toBe(true);
    expect(m.some((d) => d.at.startsWith('27'))).toBe(false);
    const pivot = m.find((d) => d.at === '2215/2315');
    expect(pivot).toEqual(expect.objectContaining({ mp: 1, hits: 1 }));
  });

  it('Spartan phalanxes pivot without the cohesion hit, and Walk limits MA to 3', () => {
    const sp = unit({ id: 'sp', type: 'HO', size: 2, tq: 7, spartan: true, hex: '2215', facing: 0 });
    expect(dests(legalMoves(only([sp]), g, sp)).find((d) => d.at === '2215/2315')?.hits).toBe(0);
    const walk = unit({ id: 'w', type: 'HO', size: 2, tq: 5, hex: '2215', facing: 0, advance: 'walk' });
    expect(Math.max(...dests(legalMoves(only([walk]), g, walk)).map((d) => d.mp))).toBe(3);
  });

  it('stops on entering an enemy Front hex and cannot enter enemy hexes', () => {
    const ph = unit({ id: 'ph', type: 'HO', size: 2, tq: 6, hex: '2215', facing: 0 });
    const enemy = unit({ id: 'en', side: 'B', type: 'HO', size: 2, tq: 6, hex: '2516', facing: 6 });
    const m = dests(legalMoves(only([ph, enemy]), g, ph));
    // The enemy's front hexes are in row 24; nothing may be reached beyond them along that path.
    expect(m.some((d) => d.at.includes('2516') || d.at.includes('2517'))).toBe(false);
    const inFront = m.filter((d) => d.at.startsWith('24'));
    expect(inFront.length).toBeGreaterThan(0);
  });

  it('Out of Command units cannot move adjacent to the enemy (5.45)', () => {
    const li = unit({ id: 'li', type: 'LI', tq: 5, ma: 5, hex: '2215', facing: 0, outOfCommand: true });
    const enemy = unit({ id: 'en', side: 'B', type: 'LI', tq: 5, hex: '2516', facing: 6 });
    const m = [...legalMoves(only([li, enemy]), g, li).values()].map((r) => lab(r.anchor));
    expect(m).not.toContain('2416');
    expect(m).not.toContain('2417');
    expect(m).toContain('2415'); // not adjacent to 2516
  });
});

describe('Shock procedure through the reducer', () => {
  it('resolves, distributes hits, then collapses or engages — for many seeds', () => {
    const base = createGame(NEMEA, nemeaSetup as VassalSetup, BOARDS.blankFull, 1);
    for (let seed = 1; seed <= 200; seed++) {
      const ph = unit({ id: 'ph', type: 'HO', size: 2, tq: 6, hex: '2215', facing: 0 });
      const d1 = unit({ id: 'd1', side: 'B', type: 'HO', size: 2, tq: 6, hex: '2314', facing: 6 });
      let s: GameState = { ...base, rng: seed, units: { ph, d1 } };
      s = reducer(s, { type: 'resolveShock', attackerIds: ['ph'], defenderIds: ['d1'], options: { run: false } });
      const [a, d] = [s.units.ph.hits, s.units.d1.hits];
      expect(a + d).toBeGreaterThan(0);
      s = reducer(s, { type: 'collapse', attackerIds: ['ph'], defenderIds: ['d1'], positionSuperiority: false });
      const pa = s.units.ph, pd = s.units.d1;
      const bothHold = !pa.routed && !pd.routed;
      expect(pa.engaged && pd.engaged).toBe(bothHold);
      if (bothHold) { expect(pa.hits).toBeLessThan(pa.tq); expect(pd.hits).toBeLessThan(pd.tq); }
    }
  });
});

describe('Rout movement (10.21–10.24)', () => {
  const base = createGame(NEMEA, nemeaSetup as VassalSetup, BOARDS.blankFull, 1);
  const only = (...units: Unit[]): GameState => ({ ...base, rng: 7, leaders: {}, units: Object.fromEntries(units.map((u) => [u.id, u])) });
  const at = (s: GameState, id: string) => footprint(s.units[id].hex!, s.units[id].facing, s.units[id].size).hexes.map(lab).join('/');
  // Side A (Sparta) retreats toward the bottom (10xx) edge, i.e. row numbers decrease.

  it('a single unit routs two hexes straight toward its edge and faces it', () => {
    const li = unit({ id: 'li', type: 'LI', tq: 5, hex: '2215', routed: true });
    const s = routMove(only(li), g, 'li', 2);
    expect(at(s, 'li').slice(0, 2)).toBe('20');
    expect(s.units.li.facing).toBe(6);
  });

  it('hexes adjacent to enemies of the same shock block the path; it sidesteps or is eliminated', () => {
    const li = unit({ id: 'li', type: 'LI', tq: 5, hex: '2215', routed: true });
    const e1 = unit({ id: 'e1', side: 'B', type: 'LI', hex: '2014' });
    const e2 = unit({ id: 'e2', side: 'B', type: 'LI', hex: '2016' });
    const s = routMove(only(li, e1, e2), g, 'li', 2, { shockEnemies: ['e1', 'e2'] });
    // Both 21xx hexes below are adjacent to e1/e2 (row 20) -> blocked; sideways hexes in row 22 too? 2214/2216
    // are not adjacent to row-20 units, so the unit turns one vertex and keeps fleeing.
    expect(s.units.li.eliminated || !at(s, 'li').startsWith('2215')).toBe(true);
  });

  it('a unit routing off the map edge is eliminated and scores Rout Points', () => {
    const li = unit({ id: 'li', type: 'LI', tq: 5, hex: '1015', routed: true });
    const s = routMove(only(li), g, 'li', 2);
    expect(s.units.li.eliminated).toBe(true);
    expect(sideRoutPoints(s, 'A')).toBe(5);
  });

  it('a phalanx facing the enemy reverses face and routs with both halves', () => {
    const ph = unit({ id: 'ph', type: 'HO', size: 2, tq: 6, hex: '2215', facing: 0, routed: true });
    const s = routMove(only(ph), g, 'ph', 2);
    expect(s.units.ph.facing).toBe(6);
    expect(at(s, 'ph').split('/').every((h) => h.startsWith('20'))).toBe(true);
  });

  it('a phalanx boxed in by friendly hoplites front and back is eliminated', () => {
    const ph = unit({ id: 'ph', type: 'HO', size: 2, tq: 6, hex: '2215', facing: 0, routed: true });
    const back1 = unit({ id: 'b1', type: 'HO', size: 2, tq: 6, hex: '2114', facing: 0 });
    const back2 = unit({ id: 'b2', type: 'HO', size: 2, tq: 6, hex: '2116', facing: 0 });
    const front1 = unit({ id: 'f1', type: 'HO', size: 2, tq: 6, hex: '2314', facing: 0 });
    const front2 = unit({ id: 'f2', type: 'HO', size: 2, tq: 6, hex: '2316', facing: 0 });
    const s = routMove(only(ph, back1, back2, front1, front2), g, 'ph', 2);
    expect(s.units.ph.eliminated).toBe(true);
  });

  it('routing through a friendly unit makes it check TQ, and the router does not end stacked', () => {
    const li = unit({ id: 'li', type: 'LI', tq: 5, hex: '2215', routed: true });
    const friend = unit({ id: 'fr', type: 'LC', tq: 4, ma: 8, hex: '2114' });
    const friend2 = unit({ id: 'fr2', type: 'LC', tq: 4, ma: 8, hex: '2115' });
    const s = routMove(only(li, friend, friend2), g, 'li', 2);
    expect(s.log.some((l) => /moved through by routed/.test(l.text))).toBe(true);
    expect(s.units.li.eliminated || at(s, 'li').startsWith('20')).toBe(true);
  });

  it('Rout Movement segment: routed phalanxes are eliminated, others move their full MA', () => {
    const ph = unit({ id: 'ph', type: 'HO', size: 2, tq: 6, hex: '3015', facing: 6, routed: true });
    const lc = unit({ id: 'lc', type: 'LC', tq: 4, ma: 8, hex: '3020', routed: true });
    const s = routPhase(only(ph, lc), g);
    expect(s.units.ph.eliminated).toBe(true);
    expect(at(s, 'lc').slice(0, 2)).toBe('22');
  });
});

describe('Advance after Combat (8.2)', () => {
  const base = createGame(NEMEA, nemeaSetup as VassalSetup, BOARDS.blankFull, 1);
  const only = (...units: Unit[]): GameState => ({ ...base, rng: 3, leaders: {}, units: Object.fromEntries(units.map((u) => [u.id, u])) });
  const at = (s: GameState, id: string) => footprint(s.units[id].hex!, s.units[id].facing, s.units[id].size).hexes.map(lab).join('/');

  it('a phalanx advances with both halves into the vacated hexes', () => {
    const ph = unit({ id: 'ph', type: 'HO', size: 2, tq: 6, hex: '2215', facing: 0 });
    const res = advanceAfterCombat(only(ph), g, { attackerIds: ['ph'], vacated: [L('2314'), L('2315')] });
    expect(at(res.state, 'ph')).toBe('2314/2315');
    expect(res.advanced.has('ph')).toBe(true);
  });

  it('wheels into the centre front hex when an enemy holds one side front hex (8.23)', () => {
    const ph = unit({ id: 'ph', type: 'HO', size: 2, tq: 6, hex: '2215', facing: 0 });
    const enemy = unit({ id: 'en', side: 'B', type: 'HO', size: 2, tq: 6, hex: '2314', facing: 6 }); // holds 2313/2314 (left front)
    const res = advanceAfterCombat(only(ph, enemy), g, { attackerIds: ['ph'], vacated: [L('2315')] });
    expect(res.pivoted.has('ph')).toBe(true);
    expect(at(res.state, 'ph')).toBe('2215/2315');
    expect(res.state.units.ph.hits).toBeGreaterThanOrEqual(1);
  });

  it('a single unit advances into a vacated front hex', () => {
    const li = unit({ id: 'li', type: 'LI', tq: 5, hex: '2215', facing: 0 });
    const res = advanceAfterCombat(only(li), g, { attackerIds: ['li'], vacated: [L('2315')] });
    expect(at(res.state, 'li')).toBe('2315');
  });
});

describe('Reactions (6.6, 6.7, 6.94, 6.95, 7.3)', () => {
  const base = createGame(NEMEA, nemeaSetup as VassalSetup, BOARDS.blankFull, 1);
  const only = (...units: Unit[]): GameState => ({ ...base, rng: 11, leaders: {}, units: Object.fromEntries(units.map((u) => [u.id, u])) });
  const trailOf = (...labels: string[][]) => labels.map((hs) => hs.map(L));
  const kinds = (rs: { kind: string; reactorId: string }[], id: string) => rs.filter((r) => r.reactorId === id).map((r) => r.kind).sort();
  // Side A moves "up" the map image (rows increase); side B faces down.
  const ph = () => unit({ id: 'ph', type: 'HO', size: 2, tq: 6, hex: '2215', facing: 0 });
  const phTrail = trailOf(['2215', '2216'], ['2315', '2316'], ['2415', '2416']);

  it('skirmishers may withdraw 2 MP from slower units; LC by the MA difference; equal-MA infantry not at all', () => {
    const sk = unit({ id: 'sk', side: 'B', type: 'SK', tq: 1, ma: 5, missile: 'S', hex: '2616', facing: 6 });
    const lc = unit({ id: 'lc', side: 'B', type: 'LC', tq: 4, ma: 8, hex: '2614', facing: 6 });
    const ho = unit({ id: 'ho', side: 'B', type: 'HO', size: 2, tq: 6, hex: '2619', facing: 6 });
    const rs = detectMoveReactions(only(ph(), sk, lc, ho), g, 'ph', phTrail);
    expect(rs.find((r) => r.reactorId === 'sk' && r.kind === 'withdraw')?.mp).toBe(2);
    expect(rs.find((r) => r.reactorId === 'lc' && r.kind === 'withdraw')?.mp).toBe(4);
    expect(rs.some((r) => r.reactorId === 'ho' && r.kind === 'withdraw')).toBe(false);
  });

  it('withdrawal destinations move away from the mover and never next to an enemy', () => {
    const sk = unit({ id: 'sk', side: 'B', type: 'SK', tq: 1, ma: 5, missile: 'S', hex: '2616', facing: 6 });
    const s = only({ ...ph(), hex: L('2415') }, sk);
    const dests = withdrawDestinations(s, g, sk, s.units.ph, 2);
    expect(dests.length).toBeGreaterThan(0);
    for (const d of dests) expect(unitDistance(d.hexes, unitHexes(s.units.ph))).toBeGreaterThan(2);
  });

  it('applies Orderly Withdrawal penalties: infantry +1 and a TQ check, skirmishers none from the front', () => {
    const li = unit({ id: 'li', side: 'B', type: 'LI', tq: 5, ma: 5, hex: '2616', facing: 6 });
    let s = only({ ...ph(), hex: L('2415'), ma: 4 }, li);
    s = { ...s, reactions: [{ id: 'x', kind: 'withdraw', reactorId: 'li', moverId: 'ph', mp: 1, approach: 'front' }] };
    const dest = withdrawDestinations(s, g, s.units.li, s.units.ph, 1)[0];
    s = reducer(s, { type: 'reactWithdraw', reactionId: 'x', anchor: dest.anchor });
    expect(s.units.li.hits).toBeGreaterThanOrEqual(1);
    expect(s.units.li.hits).toBeLessThanOrEqual(2);
    expect(s.reactions?.length).toBe(0);
    const sk = unit({ id: 'sk', side: 'B', type: 'SK', tq: 1, ma: 5, hex: '2616', facing: 6 });
    let s2 = only({ ...ph(), hex: L('2415') }, sk);
    s2 = { ...s2, reactions: [{ id: 'y', kind: 'withdraw', reactorId: 'sk', moverId: 'ph', mp: 2, approach: 'front' }] };
    s2 = reducer(s2, { type: 'reactWithdraw', reactionId: 'y', anchor: withdrawDestinations(s2, g, s2.units.sk, s2.units.ph, 2)[0].anchor });
    expect(s2.units.sk.hits).toBe(0);
  });

  it('offers reaction facing to single units and reverse face when a phalanx is entered from the rear', () => {
    const li = unit({ id: 'li', side: 'B', type: 'LI', tq: 5, ma: 5, hex: '2516', facing: 0 });
    expect(kinds(detectMoveReactions(only(ph(), li), g, 'ph', phTrail), 'li')).toContain('facing');
    const enemyPh = unit({ id: 'eph', side: 'B', type: 'HO', size: 2, tq: 6, hex: '2614', facing: 0 }); // faces away
    const rs = detectMoveReactions(only(ph(), enemyPh), g, 'ph', trailOf(['2215', '2216'], ['2315', '2316'], ['2414', '2415'], ['2514', '2515']));
    expect(kinds(rs, 'eph')).toContain('reverseFace');
  });

  it('entry and retire reaction fire need the mover in the fire arc', () => {
    const arch = unit({ id: 'arch', side: 'B', type: 'LI', tq: 5, ma: 5, missile: 'B', hex: '2516', facing: 6 });
    expect(kinds(detectMoveReactions(only(ph(), arch), g, 'ph', phTrail), 'arch')).toContain('entryFire');
    const mover = unit({ id: 'm', type: 'LC', tq: 4, ma: 8, hex: '2416', facing: 6 });
    const rs = detectMoveReactions(only(mover, arch), g, 'm', trailOf(['2416'], ['2316'], ['2216']));
    expect(kinds(rs, 'arch')).toContain('retireFire');
    const behind = unit({ id: 'arch', side: 'B', type: 'LI', tq: 5, ma: 5, missile: 'B', hex: '2516', facing: 0 });
    expect(kinds(detectMoveReactions(only(ph(), behind), g, 'ph', phTrail), 'arch')).not.toContain('entryFire');
  });

  it('Pre-arranged Withdrawal: the ordered hoplites step back one hex together', () => {
    const s0 = createGame(NEMEA, nemeaSetup as VassalSetup, BOARDS.blankFull, 5);
    // Theban hoplites in row 31 facing down; put a Spartan phalanx within 2 hexes of Corinth 6.
    const corinth = Object.values(s0.units).find((u) => u.name.startsWith('Corinth 6'))!;
    const sparta = Object.values(s0.units).find((u) => u.name.startsWith('Sicyon'))!;
    let s: GameState = reducer(s0, { type: 'setPwOrder', leaderId: 'ismenias', on: true });
    s = { ...s, units: { ...s.units, [sparta.id]: { ...sparta, hex: L('2912') } } };
    const rs = detectMoveReactions(s, g, sparta.id, trailOf(['2812', '2813'], ['2912', '2913']));
    const pw = rs.find((r) => r.kind === 'pw');
    expect(pw?.leaderId).toBe('ismenias');
    s = reducer({ ...s, reactions: rs }, { type: 'reactPW', reactionId: pw!.id });
    const moved = footprint(s.units[corinth.id].hex!, s.units[corinth.id].facing, 2).hexes.map(lab);
    expect(moved.every((h) => h.startsWith('32'))).toBe(true);
  });

  it('a unit fired upon may Return Fire if the firer is in range and arc', () => {
    const a1 = unit({ id: 'a1', type: 'LI', tq: 5, ma: 5, missile: 'B', hex: '2215', facing: 0 });
    const b1 = unit({ id: 'b1', side: 'B', type: 'LI', tq: 5, ma: 5, missile: 'B', hex: '2416', facing: 6 });
    const s = reducer(only(a1, b1), { type: 'missileFire', firerId: 'a1', targetId: 'b1' });
    if (!s.units.b1.routed && !s.units.b1.eliminated) expect(s.reactions?.some((r) => r.kind === 'returnFire' && r.reactorId === 'b1')).toBe(true);
  });
});

describe('TQ checks with "hits = DR−TQ, minimum N"', () => {
  it('inflict nothing on a pass and at least N hits on a failure', () => {
    const base = createGame(NEMEA, nemeaSetup as VassalSetup, BOARDS.blankFull, 1);
    for (let seed = 1; seed <= 60; seed++) {
      const u = unit({ id: 'u', type: 'HO', size: 2, tq: 5, hex: '2215' });
      const s = reducer({ ...base, rng: seed, units: { u } }, { type: 'tqCheckHits', id: 'u', label: 'test', minHits: 2 });
      const [r] = rollD10(seed);
      expect(s.units.u.hits + (s.units.u.routed ? 99 : 0)).toBe(r > 5 ? Math.max(2, r - 5) : 0);
    }
  });
});

describe('Law of Inertia (6.28) & Drift to the Right (6.29)', () => {
  const base = createGame(NEMEA, nemeaSetup as VassalSetup, BOARDS.blankFull, 1);
  const only = (...units: Unit[]): GameState => ({ ...base, leaders: {}, units: Object.fromEntries(units.map((u) => [u.id, u])) });
  const enemy = () => unit({ id: 'en', side: 'B', type: 'HO', size: 2, tq: 6, hex: '3015', facing: 6 });

  it('advancing non-Spartan hoplites must spend all MP moving toward the enemy', () => {
    const ph = unit({ id: 'ph', type: 'HO', size: 2, tq: 6, hex: '2215', facing: 0, advance: 'trot' });
    const s = only(ph, enemy());
    const moves = [...legalMoves(s, g, ph).values()];
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((m) => m.mp === 4)).toBe(true);
    const d0 = unitDistance(unitHexes(ph), unitHexes(s.units.en));
    for (const m of moves) expect(unitDistance(footprint(m.anchor, m.facing, 2).hexes, unitHexes(s.units.en))).toBeLessThan(d0);
  });

  it('advancing Spartans may stop short, but still only toward the enemy', () => {
    const sp = unit({ id: 'sp', type: 'HO', size: 2, tq: 7, spartan: true, hex: '2215', facing: 0, advance: 'trot' });
    const moves = [...legalMoves(only(sp, enemy()), g, sp).values()];
    expect(moves.some((m) => m.mp < 4)).toBe(true);
    expect(moves.some((m) => m.path.includes('reverse'))).toBe(false);
  });

  it('a phalanx moving a second time must drift right on its 1st MP', () => {
    const ph = unit({ id: 'ph', type: 'HO', size: 2, tq: 6, hex: '2215', facing: 0, moved: true });
    const one = [...legalMoves(only(ph), g, ph).values()].filter((m) => m.mp === 1 && m.path[0].startsWith('forward'));
    expect(one.map((m) => m.path[0])).toEqual(['forward-right']);
    const sp = { ...ph, spartan: true };
    const spOne = [...legalMoves(only(sp), g, sp).values()].filter((m) => m.mp === 1 && m.path[0].startsWith('forward'));
    expect(spOne.length).toBe(2);
  });
});

describe('Disengage, Rally & Recovery (10.3, 10.4)', () => {
  const base = createGame(NEMEA, nemeaSetup as VassalSetup, BOARDS.blankFull, 1);
  const fc = { ...base.leaders['derkylidas'], hex: L('2215'), commands: ['c'] };
  const mk = (seed: number, ...units: Unit[]): GameState => ({
    ...base, rng: seed, leaders: { derkylidas: fc }, units: Object.fromEntries(units.map((u) => [u.id, u])),
    active: { kind: 'command', side: 'A', command: 'c' }, activity: {},
  });

  it('a successful Disengage pulls engaged units back one hex and frees the enemy', () => {
    let successes = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const a = unit({ id: 'a', type: 'LI', tq: 5, hex: '2215', facing: 0, engaged: true, command: 'c' });
      const b = unit({ id: 'b', side: 'B', type: 'LI', tq: 5, hex: '2315', facing: 6, engaged: true });
      let s = mk(seed, a, b);
      s = reducer(s, { type: 'setOrders', orders: 'disengage' });
      s = reducer(s, { type: 'disengage', commandId: 'c', leaderId: 'derkylidas' });
      if (!s.units.a.engaged) {
        successes++;
        expect(unitDistance(unitHexes(s.units.a), unitHexes(s.units.b))).toBeGreaterThan(1);
        expect(s.units.b.engaged).toBe(false);
      } else expect(s.units.a.hex).toEqual(L('2215'));
    }
    expect(successes).toBeGreaterThan(0);
  });

  it('Rally: success sets hits to half a die (round up); failure eliminates a phalanx', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = unit({ id: 'r', type: 'HO', size: 2, tq: 6, hex: '2015', facing: 6, routed: true, command: 'c' });
      let s = mk(seed, r);
      s = reducer(s, { type: 'setOrders', orders: 'rally' });
      s = reducer(s, { type: 'rally', commandId: 'c' });
      const u = s.units.r;
      expect(u.eliminated || (u.rallied && !u.routed && u.hits <= 5)).toBe(true);
    }
  });

  it('Recovery removes 2 hits in clear terrain away from the enemy, none when adjacent', () => {
    const a = unit({ id: 'a', type: 'LI', tq: 5, hits: 3, hex: '2215', command: 'c' });
    let s = reducer(mk(1, a), { type: 'recover', id: 'a' });
    expect(s.units.a.hits).toBe(1);
    expect(legalMoves(s, g, s.units.a).size).toBe(0); // recovered units cannot also move
    const b = unit({ id: 'b', side: 'B', type: 'LI', tq: 5, hex: '2315' });
    s = reducer(mk(1, { ...a }, b), { type: 'recover', id: 'a' });
    expect(s.units.a.hits).toBe(3);
  });
});

describe('Command range (5.42)', () => {
  it('counts the unit hex but not the leader hex, and is blocked by enemy units', () => {
    const s = createGame(NEMEA, nemeaSetup as VassalSetup, BOARDS.blankFull, 1);
    const d = s.leaders['derkylidas'];
    const range = commandRangeHexes(s, g, d, 5);
    const far = { q: d.hex!.q + 5, r: d.hex!.r };
    const tooFar = { q: d.hex!.q + 6, r: d.hex!.r };
    expect(range.has(`${far.q},${far.r}`)).toBe(true); // 5 hexes along the friendly line
    expect(range.has(`${tooFar.q},${tooFar.r}`)).toBe(false);
    const status = commandStatus(s, g, 'A-HO');
    // Spartan line is contiguous: every hoplite is in command through the chain rule (5.41).
    expect(Object.values(s.units).filter((u) => u.command === 'A-HO').every((u) => status[u.id])).toBe(true);
  });
});

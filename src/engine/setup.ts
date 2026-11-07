import type { Board } from '../data/boards';
import { COUNTERS, LEADERS } from '../data/counters';
import type { ScenarioDef, VassalSetup } from '../data/scenarios/types';
import { anchorFromCenter, normFacing, pixelToHex } from './hex';
import type { GameState, Leader, Unit } from './types';

const TYPE_RE = /^(.*?) (HO PH|DD HO PH|HO|LC|LI|SK|HC|MI|HI|PL|CH)(?: (\d+)(?: - (\d+))?)?(.*)$/;

/** Vassal rotation index (12 steps) -> our facing (clockwise 30° steps). */
export const vassalRotationToFacing = (rot: number) => normFacing(12 - rot);

export function createGame(scn: ScenarioDef, setup: VassalSetup, board: Board, seed: number): GameState {
  const g = board.geometry;
  const units: Record<string, Unit> = {};
  const leaders: Record<string, Leader> = {};
  const nextNumber = new Map<string, number>();
  const idCount = new Map<string, number>();

  for (const p of setup.pieces) {
    if (p.map !== 'Hoplite Maps' || p.x == null || p.y == null) continue;
    const facing = vassalRotationToFacing(p.rotation);

    const unitDef = scn.units[p.image];
    if (unitDef) {
      const stats = COUNTERS[p.image];
      if (!stats) throw new Error(`No counter stats for ${p.image}`);
      const [side, command] = unitDef;
      const name = displayName(p.name, nextNumber);
      const baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const n = (idCount.get(baseId) ?? 0) + 1;
      idCount.set(baseId, n);
      const id = n === 1 ? baseId : `${baseId}-${n}`;
      units[id] = {
        ...stats,
        id,
        name,
        image: p.image,
        side,
        command,
        hex: anchorFromCenter(g, { x: p.x, y: p.y }, facing, stats.size),
        facing,
        hits: 0,
        routed: false,
        rallied: false,
        engaged: false,
        moved: false,
        outOfCommand: false,
        missileSupply: 'full',
        advance: null,
        eliminated: false,
      };
      continue;
    }

    const leaderDef = scn.leaders[p.image];
    if (leaderDef) {
      const stats = LEADERS[p.image];
      const id = p.name.toLowerCase();
      leaders[id] = {
        id,
        name: p.name,
        image: p.image,
        side: leaderDef.side,
        rank: stats.rank,
        commands: leaderDef.commands,
        range: stats.range,
        charisma: stats.charisma,
        initiative: stats.initiative,
        hex: pixelToHex(g, { x: p.x, y: p.y }),
        wounded: false,
        killed: false,
        countsForRP: leaderDef.countsForRP,
        replacement: stats.replacement,
      };
    }
  }

  return {
    scenarioId: scn.id,
    boardId: scn.boardId,
    turn: 1,
    phase: 'initiative',
    sides: scn.sides,
    commands: scn.commands,
    units,
    leaders,
    pool: [],
    initiativePick: null,
    initiativeSide: null,
    active: null,
    used: [],
    trumpUsed: { A: false, B: false },
    rng: seed,
    log: [{ turn: 1, text: `${scn.name} — set up from the Vassal module.`, kind: 'system' }],
    winner: null,
  };
}

/** "Sparta HO PH 6 - 9" -> "Sparta 6 HO", "Sparta 7 HO", ... on successive calls. */
function displayName(vassalName: string, nextNumber: Map<string, number>): string {
  const m = TYPE_RE.exec(vassalName);
  if (!m) return vassalName;
  const [, base, rawType, from, to, rest] = m;
  const type = rawType === 'HO PH' ? 'HO' : rawType === 'DD HO PH' ? 'DD HO' : rawType;
  const cleanBase = base.replace(/^Ch Loc$/, 'Ch-Loc').replace(/^Epid Troezen$/, 'Epid-Troezen')
    .replace(/^Herm Halleis$/, 'Herm-Halleis').replace(/^Acror Lasrn$/, 'Acror-Lasrn')
    .replace(/^Elis Triphyllis$/, 'Elis-Triph');
  const suffix = rest.trim() ? ` ${rest.trim()}` : '';
  if (!from) return `${cleanBase} ${type}${suffix}`;
  const key = vassalName;
  const start = Number(from);
  const end = to ? Number(to) : start;
  const n = nextNumber.get(key) ?? start;
  nextNumber.set(key, Math.min(n + 1, end + 1));
  return `${cleanBase} ${n} ${type}${suffix}`;
}

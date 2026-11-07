import type { Hex } from './hex';

/** Unit types (rule 2.5). */
export type UnitType = 'HO' | 'HI' | 'MI' | 'LI' | 'PL' | 'SK' | 'LC' | 'HC' | 'CH';
/** Missile class: B simple bow, C composite bow, J javelin, S sling. */
export type MissileClass = 'B' | 'C' | 'J' | 'S';
export type MissileSupply = 'full' | 'low' | 'no';
export type AdvanceRate = 'walk' | 'trot' | 'run';
export type SideId = 'A' | 'B';

/** Printed counter values. */
export interface CounterStats {
  type: UnitType;
  tq: number;
  ma: number;
  missile?: MissileClass;
  /** 2 for a double-sized Hoplite Phalanx counter. */
  size: 1 | 2;
  /** Red triangle: Spartan Hoplite. */
  spartan?: boolean;
  /** Units counted for Numerical Advantage (Theban Double Depth = 2, Massed = 4). */
  depth?: number;
}

export interface Unit extends CounterStats {
  id: string;
  name: string;
  image: string;
  side: SideId;
  command: string;
  /** Left half for a phalanx (relative to its facing); null when off-map / eliminated. */
  hex: Hex | null;
  facing: number;
  hits: number;
  routed: boolean;
  rallied: boolean;
  engaged: boolean;
  moved: boolean;
  outOfCommand: boolean;
  missileSupply: MissileSupply;
  advance: AdvanceRate | null;
  /** Has rolled its Advance to Combat rate this battle (6.22 is done only once). */
  advanceRolled?: boolean;
  eliminated: boolean;
}

export interface Leader {
  id: string;
  name: string;
  image: string;
  side: SideId;
  rank: 'OC' | 'FC';
  /** Commands this leader is Formation Commander of (an OC may also be an FC). */
  commands: string[];
  range: number;
  /** OC only. */
  charisma?: number;
  /** OC: Initiative. FC: Capability. */
  initiative: number;
  hex: Hex | null;
  wounded: boolean;
  killed: boolean;
  /** Whether this leader's death counts for Rout Points (scenario specific). */
  countsForRP: boolean;
}

export interface Command {
  id: string;
  side: SideId;
  name: string;
  leaderless: boolean;
}

export type ActivationMarker =
  | { kind: 'command'; side: SideId; command: string }
  | { kind: 'momentum'; side: SideId };

export interface SideInfo {
  id: SideId;
  name: string;
  color: string;
  withdrawalLevel: number;
  /** Map edge the side routs toward: 'top' or 'bottom' of the map image. */
  retreatEdge: 'top' | 'bottom' | 'left' | 'right';
}

export interface LogEntry {
  turn: number;
  text: string;
  kind?: 'dice' | 'info' | 'combat' | 'system';
}

export type OrderType = 'move' | 'disengage' | 'rally';

export type ReactionKind = 'withdraw' | 'pw' | 'facing' | 'reverseFace' | 'entryFire' | 'retireFire' | 'returnFire';

export interface Reaction {
  id: string;
  kind: ReactionKind;
  /** Unit that may react (for 'pw': any unit of the command; see leaderId). */
  reactorId: string;
  /** Enemy unit that triggered the reaction. */
  moverId: string;
  /** Orderly Withdrawal allowance in MP. */
  mp?: number;
  /** Cohesion hit for being approached from the flank/rear (6.62[2]). */
  approach?: 'front' | 'flank' | 'rear';
  /** Pre-arranged Withdrawal: the Formation Commander holding the order. */
  leaderId?: string;
  /** Forced missile range for Retire (2) / Entry (1) reaction fire. */
  range?: number;
}

export type TurnPhase = 'initiative' | 'activation' | 'orders' | 'rout' | 'withdrawal' | 'over';

export interface GameState {
  scenarioId: string;
  boardId: string;
  turn: number;
  phase: TurnPhase;
  sides: Record<SideId, SideInfo>;
  commands: Command[];
  units: Record<string, Unit>;
  leaders: Record<string, Leader>;
  /** Activation markers still in the pool (cup). */
  pool: ActivationMarker[];
  /** Marker chosen via Initiative to start the turn, if any. */
  initiativePick: ActivationMarker | null;
  initiativeSide: SideId | null;
  /** Currently active marker. */
  active: ActivationMarker | null;
  /** Markers already used this turn. */
  used: ActivationMarker[];
  trumpUsed: Record<SideId, boolean>;
  rng: number;
  log: LogEntry[];
  /** Reactions currently available to the inactive side (6.6, 6.7, 6.94/6.95, 7.3). */
  reactions?: Reaction[];
  /** Pre-arranged Withdrawal orders by Formation Commander id, for this turn (6.72). */
  pwOrders?: Record<string, boolean>;
  /** Orders of the active Command for this Orders Phase (5.4). */
  orders?: OrderType;
  /** What each unit did in the current Orders Phase (for Recovery 10.41 and the Law of Inertia 6.28). */
  activity?: Record<string, 'moved' | 'fired' | 'recovered' | 'disengaged' | 'rallied'>;
  winner: SideId | 'draw' | null;
}

import type { Command, SideId, SideInfo } from '../../engine/types';

export interface ScenarioDef {
  id: string;
  name: string;
  boardId: string;
  /** Name of the JSON file in src/data/setups extracted from the Vassal module. */
  vassalSetup: string;
  sides: Record<SideId, SideInfo>;
  commands: Command[];
  units: Record<string, [SideId, string]>;
  leaders: Record<string, { side: SideId; commands: string[]; countsForRP: boolean }>;
  /** Side holding the Initiative on turn 1, or null to roll. */
  initiative: SideId | null;
  notes: string[];
}

export interface VassalPiece {
  image: string;
  name: string;
  map: string | null;
  x: number | null;
  y: number | null;
  rotation: number;
}

export interface VassalSetup {
  id: string;
  board: string;
  boardImage: string | null;
  pieces: VassalPiece[];
}

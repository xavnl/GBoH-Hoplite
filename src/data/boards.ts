import type { BoardGeometry } from '../engine/hex';

export interface Board {
  id: string;
  name: string;
  image: string;
  geometry: BoardGeometry;
}

// Geometry derived from the Vassal HexGrid definitions (Hoplite101.vmod, "sideways" grids)
// and checked against the printed hex numbers.
export const BOARDS: Record<string, Board> = {
  blankFull: {
    id: 'blankFull',
    name: 'Cunaxa-Nemea-Coronea (blank full map)',
    image: 'Blank(full)_Map-150, resized.jpg',
    geometry: {
      originX: 94.7425, // -38 + 88.485 * 1.5
      originY: 92.63, // 16 + 76.63
      hexW: 88.485,
      hexH: 76.6303,
      topRow: 42,
      width: 4080,
      height: 2640,
      margin: 40,
    },
  },
};

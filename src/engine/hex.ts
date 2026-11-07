// Hex geometry for GBoH maps: pointy-top hexes in horizontal rows.
// Coordinates are axial {q, r}; r grows downward on the map image.
//
// Facing is an integer 0..11 in 30° steps, clockwise from "up" on the map image.
//  - even facing  -> the counter's top points to a hex VERTEX (normal formation, rule 6.91)
//  - odd facing   -> the counter's top points to a hex SIDE (In Column, rule 6.53)

export interface Hex { q: number; r: number }
export interface Point { x: number; y: number }

export interface BoardGeometry {
  /** Pixel centre of the hex with axial (0,0). */
  originX: number;
  originY: number;
  /** Horizontal distance between hex centres in a row. */
  hexW: number;
  /** Vertical distance between rows. */
  hexH: number;
  /** Printed row number of r = 0 (labels are RRCC). */
  topRow: number;
  width: number;
  height: number;
  /** Margin (px) a hex centre must keep from the image border to be on-map. */
  margin: number;
}

export const hexKey = (h: Hex) => `${h.q},${h.r}`;
export const hexEq = (a: Hex, b: Hex) => a.q === b.q && a.r === b.r;

/** Neighbour offsets indexed by hexside k = 0..5, at angle 30 + 60k degrees (clockwise from up). */
const SIDE_OFFSETS: Hex[] = [
  { q: 1, r: -1 }, // 30°  upper-right
  { q: 1, r: 0 }, //  90°  right
  { q: 0, r: 1 }, //  150° lower-right
  { q: -1, r: 1 }, // 210° lower-left
  { q: -1, r: 0 }, // 270° left
  { q: 0, r: -1 }, // 330° upper-left
];

export const norm = (deg: number) => ((deg % 360) + 360) % 360;
export const normFacing = (f: number) => ((f % 12) + 12) % 12;

/** Hexside index for a direction angle (must be 30 + 60k). */
export function sideIndex(angleDeg: number): number {
  const a = norm(angleDeg);
  const k = (a - 30) / 60;
  if (!Number.isInteger(k)) throw new Error(`Angle ${angleDeg} is not a hexside direction`);
  return ((k % 6) + 6) % 6;
}

export function neighborAt(h: Hex, angleDeg: number): Hex {
  const o = SIDE_OFFSETS[sideIndex(angleDeg)];
  return { q: h.q + o.q, r: h.r + o.r };
}

export function neighbors(h: Hex): Hex[] {
  return SIDE_OFFSETS.map((o) => ({ q: h.q + o.q, r: h.r + o.r }));
}

export function distance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

// ---------- pixels ----------

export function hexToPixel(g: BoardGeometry, h: Hex): Point {
  return { x: g.originX + g.hexW * (h.q + h.r / 2), y: g.originY + g.hexH * h.r };
}

export function pixelToHex(g: BoardGeometry, p: Point): Hex {
  const rf = (p.y - g.originY) / g.hexH;
  const qf = (p.x - g.originX) / g.hexW - rf / 2;
  return cubeRound(qf, rf);
}

function cubeRound(qf: number, rf: number): Hex {
  const sf = -qf - rf;
  let q = Math.round(qf), r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

/** Unit vector (pixel space) for an angle measured clockwise from up. */
export function dirVector(angleDeg: number): Point {
  const a = (angleDeg * Math.PI) / 180;
  return { x: Math.sin(a), y: -Math.cos(a) };
}

export function isOnMap(g: BoardGeometry, h: Hex): boolean {
  const p = hexToPixel(g, h);
  return p.x >= g.margin && p.x <= g.width - g.margin && p.y >= g.margin && p.y <= g.height - g.margin;
}

/** Printed hex number, e.g. "2217". */
export function hexLabel(g: BoardGeometry, h: Hex): string {
  const row = g.topRow - h.r;
  const col = h.q + Math.floor(h.r / 2);
  return `${String(row).padStart(2, '0')}${String(col).padStart(2, '0')}`;
}

export function hexFromLabel(g: BoardGeometry, label: string): Hex {
  const row = Number(label.slice(0, 2));
  const col = Number(label.slice(2));
  const r = g.topRow - row;
  return { q: col - Math.floor(r / 2), r };
}

// ---------- unit footprints & facing arcs ----------

export interface Footprint {
  /** Occupied hexes. For a double-sized unit, [left half, right half] relative to its facing. */
  hexes: Hex[];
  front: Hex[];
  flank: Hex[];
  rear: Hex[];
}

/** Second hex of a double-sized unit whose left half (relative to facing) is `a`. */
export function phalanxRightHalf(a: Hex, facing: number): Hex {
  return neighborAt(a, facing * 30 + 90);
}

export function footprint(anchor: Hex, facing: number, size: 1 | 2): Footprint {
  const f = normFacing(facing);
  const base = f * 30;
  if (size === 1) {
    if (f % 2 === 0) {
      return {
        hexes: [anchor],
        front: [neighborAt(anchor, base - 30), neighborAt(anchor, base + 30)],
        flank: [neighborAt(anchor, base - 90), neighborAt(anchor, base + 90)],
        rear: [neighborAt(anchor, base - 150), neighborAt(anchor, base + 150)],
      };
    }
    // In Column, facing a hexside: only the hex directly ahead is frontal (6.53).
    return {
      hexes: [anchor],
      front: [neighborAt(anchor, base)],
      flank: [base - 60, base + 60, base - 120, base + 120].map((a) => neighborAt(anchor, a)),
      rear: [neighborAt(anchor, base + 180)],
    };
  }
  const a = anchor;
  const b = phalanxRightHalf(a, f);
  return {
    hexes: [a, b],
    front: [neighborAt(a, base - 30), neighborAt(a, base + 30), neighborAt(b, base + 30)],
    flank: [neighborAt(a, base - 90), neighborAt(b, base + 90)],
    rear: [neighborAt(a, base - 150), neighborAt(a, base + 150), neighborAt(b, base + 150)],
  };
}

/** Pixel centre of a unit counter. */
export function unitCenter(g: BoardGeometry, anchor: Hex, facing: number, size: 1 | 2): Point {
  if (size === 1) return hexToPixel(g, anchor);
  const pa = hexToPixel(g, anchor);
  const pb = hexToPixel(g, phalanxRightHalf(anchor, facing));
  return { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
}

/** Inverse of unitCenter: find the anchor hex for a counter centred near `p`. */
export function anchorFromCenter(g: BoardGeometry, p: Point, facing: number, size: 1 | 2): Hex {
  if (size === 1) return pixelToHex(g, p);
  const axis = dirVector(facing * 30 + 90);
  return pixelToHex(g, { x: p.x - (axis.x * g.hexW) / 2, y: p.y - (axis.y * g.hexW) / 2 });
}

// ---------- Hoplite Phalanx manoeuvres (6.42 / 6.44) ----------

/** Front-to-Flank: the right half steps forward, the left half stays (unit turns left 60°). */
export function pivotKeepLeft(anchor: Hex, facing: number) {
  return { anchor, facing: normFacing(facing - 2) };
}

/** Front-to-Flank: the left half steps forward, the right half stays (unit turns right 60°). */
export function pivotKeepRight(anchor: Hex, facing: number) {
  const b = phalanxRightHalf(anchor, facing);
  return { anchor: neighborAt(b, facing * 30 - 30), facing: normFacing(facing + 2) };
}

/** Reverse Face: same two hexes, opposite direction. */
export function reverseFace(anchor: Hex, facing: number) {
  return { anchor: phalanxRightHalf(anchor, facing), facing: normFacing(facing + 6) };
}

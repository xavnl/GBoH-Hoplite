import { useEffect, useMemo, useRef, useState } from 'react';
import type { Board } from '../data/boards';
import {
  anchorFromCenter, footprint, hexKey, hexLabel, hexToPixel, isOnMap, pixelToHex, unitCenter,
  type Hex, type Point,
} from '../engine/hex';
import { commandRangeHexes } from '../engine/command';
import { legalMoves, stateKey } from '../engine/movement';
import type { Action } from '../engine/reducer';
import type { GameState, Leader, Unit } from '../engine/types';
import { assetUrl } from './assets';

export type Selection = { kind: 'unit' | 'leader'; id: string } | null;

interface Props {
  state: GameState;
  board: Board;
  dispatch: (a: Action) => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
  showArcs: boolean;
  showGrid: boolean;
  showMoves: boolean;
  onHover: (label: string | null) => void;
}

const IMG = assetUrl;
const COUNTER = 70;

type Drag =
  | { kind: 'pan'; start: Point; view: View; moved: boolean }
  | { kind: 'unit' | 'leader'; id: string; grab: Point; pos: Point; moved: boolean };

interface View { x: number; y: number; w: number; h: number }

export function MapView({ state, board, dispatch, selection, onSelect, showArcs, showGrid, showMoves, onHover }: Props) {
  const g = board.geometry;
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, w: g.width, h: g.height });
  const [drag, setDrag] = useState<Drag | null>(null);

  // Fit the map width on first render / resize while keeping aspect ratio of the element.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      setView((v) => ({ ...v, h: (v.w * r.height) / r.width }));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toMap = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: view.x + ((e.clientX - r.left) / r.width) * view.w, y: view.y + ((e.clientY - r.top) / r.height) * view.h };
  };

  // Wheel zoom around the cursor (non-passive listener so we can preventDefault).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setView((v) => {
        const k = Math.exp(e.deltaY * 0.0015);
        const w = Math.min(g.width * 1.5, Math.max(400, v.w * k));
        const h = (w * r.height) / r.width;
        const px = v.x + ((e.clientX - r.left) / r.width) * v.w;
        const py = v.y + ((e.clientY - r.top) / r.height) * v.h;
        return { x: px - ((px - v.x) * w) / v.w, y: py - ((py - v.y) * h) / v.h, w, h };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [g.width]);

  const hexCorners = (c: Point) => {
    const s = g.hexW / Math.sqrt(3);
    return Array.from({ length: 6 }, (_, k) => {
      const a = (k * Math.PI) / 3;
      return `${(c.x + s * Math.sin(a)).toFixed(1)},${(c.y - s * Math.cos(a)).toFixed(1)}`;
    }).join(' ');
  };

  const units = Object.values(state.units).filter((u) => u.hex && !u.eliminated);
  const leaders = Object.values(state.leaders).filter((l) => l.hex && !l.killed);

  const selUnit = selection?.kind === 'unit' ? state.units[selection.id] : undefined;
  const arcs = useMemo(() => (selUnit?.hex ? footprint(selUnit.hex, selUnit.facing, selUnit.size) : null), [selUnit]);

  const moves = useMemo(() => (showMoves && selUnit ? legalMoves(state, g, selUnit) : null), [showMoves, selUnit, state, g]);
  /** Cheapest MP to occupy each hex, keeping the current facing (what a drag can do). */
  const moveHexes = useMemo(() => {
    const m = new Map<string, { hex: Hex; mp: number }>();
    if (!moves || !selUnit) return m;
    for (const r of moves.values()) {
      if (r.facing !== selUnit.facing) continue;
      for (const h of footprint(r.anchor, r.facing, selUnit.size).hexes) {
        const k = hexKey(h);
        if (!m.has(k) || m.get(k)!.mp > r.mp) m.set(k, { hex: h, mp: r.mp });
      }
    }
    return m;
  }, [moves, selUnit]);

  const selLeader = selection?.kind === 'leader' ? state.leaders[selection.id] : undefined;
  const rangeHexes = useMemo(() => {
    if (!selLeader?.hex) return [];
    return [...commandRangeHexes(state, g, selLeader).keys()].map((k) => { const [q, r] = k.split(',').map(Number); return { q, r }; });
  }, [selLeader, state, g]);

  const gridHexes = useMemo(() => {
    if (!showGrid) return [];
    const out: Hex[] = [];
    for (let r = -1; r < g.height / g.hexH + 1; r++) {
      for (let q = -Math.ceil(r / 2) - 1; q < g.width / g.hexW + 1; q++) {
        const h = { q, r };
        if (isOnMap(g, h)) out.push(h);
      }
    }
    return out;
  }, [showGrid, g]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ kind: 'pan', start: { x: e.clientX, y: e.clientY }, view, moved: false });
  };

  const startPieceDrag = (e: React.PointerEvent, kind: 'unit' | 'leader', id: string, center: Point) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    const p = toMap(e);
    setDrag({ kind, id, grab: { x: p.x - center.x, y: p.y - center.y }, pos: center, moved: false });
    onSelect({ kind, id });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toMap(e);
    const h = pixelToHex(g, p);
    onHover(isOnMap(g, h) ? hexLabel(g, h) : null);
    if (!drag) return;
    if (drag.kind === 'pan') {
      const r = svgRef.current!.getBoundingClientRect();
      const dx = ((e.clientX - drag.start.x) / r.width) * drag.view.w;
      const dy = ((e.clientY - drag.start.y) / r.height) * drag.view.h;
      const moved = drag.moved || Math.abs(e.clientX - drag.start.x) + Math.abs(e.clientY - drag.start.y) > 4;
      setView({ ...drag.view, x: drag.view.x - dx, y: drag.view.y - dy });
      if (moved !== drag.moved) setDrag({ ...drag, moved });
    } else {
      setDrag({ ...drag, pos: { x: p.x - drag.grab.x, y: p.y - drag.grab.y }, moved: true });
    }
  };

  const onPointerUp = () => {
    if (!drag) return;
    if (drag.kind === 'pan') {
      if (!drag.moved) onSelect(null);
    } else if (drag.moved) {
      if (drag.kind === 'unit') {
        const u = state.units[drag.id];
        const hex = anchorFromCenter(g, drag.pos, u.facing, u.size);
        const legal = legalMoves(state, g, u).get(stateKey({ anchor: hex, facing: u.facing }));
        if (legal && showMoves) dispatch({ type: 'legalMove', id: u.id, hex, facing: u.facing, mp: legal.mp, hits: legal.hits, path: legal.path, trail: legal.trail });
        else if (footprint(hex, u.facing, u.size).hexes.every((h) => isOnMap(g, h))) dispatch({ type: 'moveUnit', id: u.id, hex });
      } else {
        const hex = pixelToHex(g, drag.pos);
        if (isOnMap(g, hex)) dispatch({ type: 'moveLeader', id: drag.id, hex });
      }
    }
    setDrag(null);
  };

  const unitPos = (u: Unit): Point =>
    drag && drag.kind === 'unit' && drag.id === u.id && drag.moved ? drag.pos : unitCenter(g, u.hex!, u.facing, u.size);
  const leaderPos = (l: Leader): Point => {
    if (drag && drag.kind === 'leader' && drag.id === l.id && drag.moved) return drag.pos;
    const c = hexToPixel(g, l.hex!);
    // Offset leaders sharing a hex so they stay visible.
    const same = leaders.filter((x) => x.hex && hexKey(x.hex) === hexKey(l.hex!));
    const i = same.findIndex((x) => x.id === l.id);
    return { x: c.x - 22 + i * 16, y: c.y - 22 + i * 16 };
  };

  return (
    <svg
      ref={svgRef}
      className="map"
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => onHover(null)}
    >
      <image href={IMG(board.image)} x={0} y={0} width={g.width} height={g.height} />

      {showGrid && (
        <g className="grid">
          {gridHexes.map((h) => {
            const c = hexToPixel(g, h);
            return (
              <g key={hexKey(h)}>
                <polygon points={hexCorners(c)} />
                <text x={c.x} y={c.y + 30}>{hexLabel(g, h)}</text>
              </g>
            );
          })}
        </g>
      )}

      {moveHexes.size > 0 && (
        <g className="moves">
          {[...moveHexes.values()].map(({ hex, mp }) => {
            const c = hexToPixel(g, hex);
            return (
              <g key={hexKey(hex)}>
                <polygon points={hexCorners(c)} />
                <text x={c.x} y={c.y + 36}>{mp}</text>
              </g>
            );
          })}
        </g>
      )}

      {rangeHexes.length > 0 && (
        <g className="cmd-range">
          {rangeHexes.map((h) => <polygon key={hexKey(h)} points={hexCorners(hexToPixel(g, h))} />)}
        </g>
      )}

      {showArcs && arcs && (
        <g className="arcs">
          {arcs.front.map((h) => <polygon key={'f' + hexKey(h)} className="arc-front" points={hexCorners(hexToPixel(g, h))} />)}
          {arcs.flank.map((h) => <polygon key={'l' + hexKey(h)} className="arc-flank" points={hexCorners(hexToPixel(g, h))} />)}
          {arcs.rear.map((h) => <polygon key={'r' + hexKey(h)} className="arc-rear" points={hexCorners(hexToPixel(g, h))} />)}
        </g>
      )}

      {units.map((u) => {
        const c = unitPos(u);
        const w = COUNTER * u.size;
        const selected = selection?.kind === 'unit' && selection.id === u.id;
        return (
          <g key={u.id} className={`counter${selected ? ' selected' : ''}${u.routed ? ' routed' : ''}`}
            onPointerDown={(e) => startPieceDrag(e, 'unit', u.id, unitCenter(g, u.hex!, u.facing, u.size))}>
            <g transform={`translate(${c.x} ${c.y}) rotate(${u.facing * 30})`}>
              <rect x={-w / 2 - 2} y={-COUNTER / 2 - 2} width={w + 4} height={COUNTER + 4} rx={5} className="counter-frame"
                style={{ stroke: state.sides[u.side].color }} />
              <image href={IMG(u.image)} x={-w / 2} y={-COUNTER / 2} width={w} height={COUNTER} />
              {u.outOfCommand && <rect x={-w / 2} y={-COUNTER / 2} width={w} height={COUNTER} className="ooc-veil" />}
            </g>
            <UnitBadges u={u} c={c} />
          </g>
        );
      })}

      {leaders.map((l) => {
        const c = leaderPos(l);
        const selected = selection?.kind === 'leader' && selection.id === l.id;
        return (
          <g key={l.id} className={`leader${selected ? ' selected' : ''}`}
            onPointerDown={(e) => startPieceDrag(e, 'leader', l.id, leaderPos(l))}>
            <rect x={c.x - 24} y={c.y - 24} width={48} height={48} rx={4} className="counter-frame"
              style={{ stroke: state.sides[l.side].color }} />
            <image href={IMG(l.image)} x={c.x - 23} y={c.y - 23} width={46} height={46} />
            {l.wounded && <text x={c.x} y={c.y + 36} className="badge-text wounded">WOUNDED</text>}
          </g>
        );
      })}
    </svg>
  );
}

function UnitBadges({ u, c }: { u: Unit; c: Point }) {
  const badges: { text: string; cls: string }[] = [];
  if (u.hits > 0) badges.push({ text: String(u.hits), cls: 'hits' });
  if (u.routed) badges.push({ text: 'ROUTED', cls: 'routed' });
  if (u.rallied) badges.push({ text: 'RALLIED', cls: 'rallied' });
  if (u.engaged) badges.push({ text: 'ENG', cls: 'engaged' });
  if (u.moved) badges.push({ text: 'MOVED', cls: 'moved' });
  if (u.advance) badges.push({ text: u.advance.toUpperCase(), cls: 'advance' });
  if (u.missileSupply !== 'full') badges.push({ text: u.missileSupply === 'low' ? 'MSL LOW' : 'MSL NO', cls: 'missile' });
  if (!badges.length) return null;
  let x = c.x + 10;
  return (
    <g className="badges" pointerEvents="none">
      {badges.map((b) => {
        const w = b.cls === 'hits' ? 26 : b.text.length * 9 + 10;
        const el = (
          <g key={b.cls}>
            <rect x={x} y={c.y - 48} width={w} height={22} rx={4} className={`badge ${b.cls}`} />
            <text x={x + w / 2} y={c.y - 32} className="badge-text">{b.text}</text>
          </g>
        );
        x += w + 3;
        return el;
      })}
    </g>
  );
}

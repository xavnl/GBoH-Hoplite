import { useEffect, useState } from 'react';
import { BOARDS } from './data/boards';
import { newGame, SCENARIOS, useGame } from './game/useGame';
import { MapView, type Selection } from './ui/MapView';
import { Sidebar } from './ui/Sidebar';

export default function App() {
  const { state, dispatch, undo, redo, reset, canUndo, canRedo } = useGame();
  const [selection, setSelection] = useState<Selection>(null);
  const [showArcs, setShowArcs] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [showMoves, setShowMoves] = useState(true);
  const [hover, setHover] = useState<string | null>(null);
  const board = BOARDS[state.boardId];
  const scenario = SCENARIOS[state.scenarioId].def;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && t.closest('input, select, textarea')) return;
      if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
      if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (e.key === 'Escape') { setSelection(null); return; }
      if (selection?.kind !== 'unit') return;
      const u = state.units[selection.id];
      if (!u) return;
      const k = e.key.toLowerCase();
      if (k === 'q') dispatch(u.size === 2 ? { type: 'pivot', id: u.id, keep: 'left' } : { type: 'rotateUnit', id: u.id, delta: -2 });
      else if (k === 'e') dispatch(u.size === 2 ? { type: 'pivot', id: u.id, keep: 'right' } : { type: 'rotateUnit', id: u.id, delta: 2 });
      else if (k === 'r' && e.shiftKey && u.size === 2) dispatch({ type: 'reverseFace', id: u.id });
      else if (k === '+' || k === '=') dispatch({ type: 'setHits', id: u.id, hits: u.hits + 1 });
      else if (k === '-') dispatch({ type: 'setHits', id: u.id, hits: u.hits - 1 });
      else if (k === 'm') dispatch({ type: 'toggleFlag', id: u.id, flag: 'moved' });
      else if (k === 'g') dispatch({ type: 'toggleFlag', id: u.id, flag: 'engaged' });
      else if (k === 't') dispatch({ type: 'roll', label: `TQ check ${u.name}`, target: u.routed ? 1 : u.tq });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, state.units, dispatch, undo, redo]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Hoplite</h1>
        <span className="scenario">{scenario.name}</span>
        <div className="spacer" />
        <label><input type="checkbox" checked={showArcs} onChange={(e) => setShowArcs(e.target.checked)} />Facing arcs</label>
        <label title="Highlight legal destinations; dropping on one applies its cohesion costs and the Moved marker">
          <input type="checkbox" checked={showMoves} onChange={(e) => setShowMoves(e.target.checked)} />Legal moves</label>
        <label><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />Hex grid</label>
        <button disabled={!canUndo} onClick={undo} title="Ctrl+Z">↶ Undo</button>
        <button disabled={!canRedo} onClick={redo} title="Ctrl+Y">↷ Redo</button>
        <button onClick={() => { if (confirm('Start a new game of Nemea? The current game will be lost.')) { reset(newGame('nemea')); setSelection(null); } }}>New game</button>
      </header>
      <main className="main">
        <div className="map-wrap">
          <MapView state={state} board={board} dispatch={dispatch} selection={selection} onSelect={setSelection}
            showArcs={showArcs} showGrid={showGrid} showMoves={showMoves} onHover={setHover} />
          <div className="statusbar">
            {hover ? `Hex ${hover}` : ' '}
            <span className="muted"> · Q/E rotate or pivot · Shift+R reverse · +/− hits · M moved · G engaged · T TQ check · Esc deselect</span>
          </div>
        </div>
        <Sidebar state={state} board={board} dispatch={dispatch} selection={selection} onSelect={setSelection} />
      </main>
    </div>
  );
}

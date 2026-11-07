import { useEffect, useRef } from 'react';
import type { Board } from '../data/boards';
import { footprint, hexLabel } from '../engine/hex';
import { BOARDS } from '../data/boards';
import { canTrump, eligibleCommands } from '../engine/momentum';
import { commandLeaders, disengageRating, rallyRating, recoveryAmount } from '../engine/orders';
import { allMarkers, effRating, inertiaLaggards, markerLabel, sameMarker, type Action } from '../engine/reducer';
import { sideRoutPoints, unitRoutPoints } from '../engine/routPoints';
import type { GameState, Leader, SideId, Unit } from '../engine/types';
import { CombatPanel } from './CombatPanel';
import { PwOrders, ReactionsPanel } from './ReactionsPanel';
import type { Selection } from './MapView';

interface Props {
  state: GameState;
  board: Board;
  dispatch: (a: Action) => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
}

export function Sidebar({ state, board, dispatch, selection, onSelect }: Props) {
  const unit = selection?.kind === 'unit' ? state.units[selection.id] : undefined;
  const leader = selection?.kind === 'leader' ? state.leaders[selection.id] : undefined;
  return (
    <aside className="sidebar">
      <TurnPanel state={state} dispatch={dispatch} />
      {state.phase === 'initiative' && <section className="panel"><PwOrders state={state} board={board} dispatch={dispatch} /></section>}
      <ReactionsPanel state={state} board={board} dispatch={dispatch} />
      <RoutPanel state={state} />
      {unit && <UnitPanel u={unit} state={state} board={board} dispatch={dispatch} />}
      {leader && <LeaderPanel l={leader} state={state} board={board} dispatch={dispatch} />}
      {!unit && !leader && <p className="hint">Click a counter to select it. Drag to move, wheel to zoom, drag the map to pan.</p>}
      <CombatPanel state={state} board={board} dispatch={dispatch} selected={unit} />
      <DicePanel dispatch={dispatch} />
      <EliminatedPanel state={state} dispatch={dispatch} onSelect={onSelect} />
      <LogPanel state={state} />
    </aside>
  );
}

function TurnPanel({ state, dispatch }: { state: GameState; dispatch: (a: Action) => void }) {
  const s = state;
  const phaseName: Record<GameState['phase'], string> = {
    initiative: 'A · Initiative', activation: 'B · Activation', orders: 'C · Orders',
    rout: 'D · Rout / Remove / Replace / Reload', withdrawal: 'E · Withdrawal', over: 'Game over',
  };
  return (
    <section className="panel">
      <h2>Turn {s.turn} <span className="phase">{phaseName[s.phase]}</span></h2>

      {s.phase === 'initiative' && !s.initiativeSide && (
        <button className="primary" onClick={() => dispatch({ type: 'rollInitiative' })}>Roll Initiative (5.1)</button>
      )}

      {s.phase === 'initiative' && s.initiativeSide && (
        <div>
          <p><b style={{ color: s.sides[s.initiativeSide].color }}>{s.sides[s.initiativeSide].name}</b> has the Initiative: choose the Command to start the turn.</p>
          <div className="btn-col">
            {allMarkers(s).filter((m) => m.side === s.initiativeSide && m.kind === 'command').map((m) => (
              <button key={markerLabel(s, m)} onClick={() => dispatch({ type: 'pickInitiativeMarker', marker: m })}>{markerLabel(s, m)}</button>
            ))}
          </div>
        </div>
      )}

      {(s.phase === 'activation' || s.phase === 'orders') && (
        <>
          <div className="pool">
            <span>Pool: {s.pool.length} marker{s.pool.length === 1 ? '' : 's'}</span>
            <span className="muted">{s.used.length} used</span>
          </div>
          {s.active ? (
            <div className="active-marker" style={{ borderColor: s.sides[s.active.side].color }}>
              <div className="muted">Active</div>
              <b>{markerLabel(s, s.active)}</b>
              {s.active.kind === 'command' && s.active.via && <div className="muted small">activated by {s.active.via === 'momentum' ? 'Momentum' : 'Trump'}</div>}
              {s.pendingChoice?.kind === 'momentum' && <ChoiceBlock state={s} dispatch={dispatch} />}
              {s.active.kind === 'command' && <OrdersBlock state={s} dispatch={dispatch} commandId={s.active.command} />}
              <div className="btn-row">
                <button className="primary" onClick={() => dispatch({ type: 'endActivation' })}>End Orders Phase</button>
                {(s.initiativePick && sameMarker(s.initiativePick, s.active)) || (s.active.kind === 'command' && s.active.via) ? null : (
                  (['A', 'B'] as SideId[]).filter((sd) => sd !== s.active!.side && !s.trumpUsed[sd]).map((sd) => {
                    const why = canTrump(s, sd);
                    return <button key={sd} disabled={!!why} title={why ?? 'Roll ≤ OC Initiative to cancel this marker (5.32)'}
                      onClick={() => dispatch({ type: 'trump', side: sd })}>Trump ({s.sides[sd].name})</button>;
                  })
                )}
              </div>
            </div>
          ) : s.pendingChoice?.kind === 'trump' ? (
            <div className="active-marker" style={{ borderColor: s.sides[s.pendingChoice.side].color }}>
              <ChoiceBlock state={s} dispatch={dispatch} />
            </div>
          ) : (
            <button className="primary" disabled={!s.pool.length} onClick={() => dispatch({ type: 'drawMarker' })}>Draw Activation Marker</button>
          )}
        </>
      )}

      {s.phase === 'rout' && (
        <div>
          <ol className="small">
            <li>Rout Movement (auto): routed Hoplite Phalanxes are eliminated, other routed units move their full MA (10.23).</li>
            <li>Moved / Rallied / Out of Command markers are cleared (auto).</li>
            <li>Replacement leaders for killed Formation Commanders are placed on a central unit of their Command (4.25) — auto.</li>
            <li>Reload Missile Low/No units out of enemy missile reach (7.17) — auto.</li>
          </ol>
          <button className="primary" onClick={() => dispatch({ type: 'endTurn' })}>Run phases D & E, next turn</button>
        </div>
      )}

      {s.phase === 'over' && <p className="winner">{s.winner === 'draw' ? 'Draw.' : `${s.sides[s.winner as SideId].name} wins!`}</p>}
    </section>
  );
}

/** Momentum designation (5.24) or the free activation won by a successful Trump (5.32). */
function ChoiceBlock({ state, dispatch }: { state: GameState; dispatch: (a: Action) => void }) {
  const choice = state.pendingChoice!;
  const opts = eligibleCommands(state, BOARDS[state.boardId].geometry, choice.side);
  const name = (id: string) => state.commands.find((c) => c.id === id)?.name ?? id;
  return (
    <div className="orders">
      <div className="small">
        <b style={{ color: state.sides[choice.side].color }}>{state.sides[choice.side].name}</b>{' '}
        {choice.kind === 'momentum'
          ? 'Momentum (5.24): designate a Command (leader = OC or in his range) and roll ≤ its rating, or decline. The OC may move either way (5.46).'
          : 'Trump succeeded: activate one Command (leader = OC or in his range), or none.'}
      </div>
      <div className="btn-col">
        {opts.map((o) => (
          <button key={o.commandId} title={o.note}
            onClick={() => dispatch(choice.kind === 'momentum' ? { type: 'momentumAttempt', commandId: o.commandId } : { type: 'trumpActivate', commandId: o.commandId })}>
            {name(o.commandId)}{choice.kind === 'momentum' ? ` — roll ≤ ${o.rating}` : ''}{o.leaderId ? ` (${state.leaders[o.leaderId].name})` : ' (leaderless)'}
          </button>
        ))}
        {!opts.length && <span className="muted small">No eligible Command.</span>}
        <button onClick={() => dispatch({ type: 'declineChoice' })}>Decline</button>
      </div>
    </div>
  );
}

function OrdersBlock({ state, dispatch, commandId }: { state: GameState; dispatch: (a: Action) => void; commandId: string }) {
  const orders = state.orders ?? 'move';
  const cmd = state.commands.find((c) => c.id === commandId);
  const leaders = commandLeaders(state, commandId);
  const units = Object.values(state.units).filter((u) => u.command === commandId && !u.eliminated);
  const engaged = units.filter((u) => u.engaged).length;
  const routed = units.filter((u) => u.routed && !u.rallied).length;
  const toRoll = units.filter((u) => u.type === 'HO' && !u.advanceRolled && !u.engaged && !u.routed).length;
  const lag = inertiaLaggards(state);
  const acted = Object.keys(state.activity ?? {}).length > 0;
  return (
    <div className="orders">
      <div className="row wrap small">
        <span className="muted">Orders (5.4):</span>
        {(['move', 'disengage', 'rally'] as const).map((o) => (
          <label key={o}>
            <input type="radio" name="orders" checked={orders === o} disabled={acted && orders !== o}
              onChange={() => dispatch({ type: 'setOrders', orders: o })} />
            {{ move: 'Move/Fire', disengage: `Disengage (${engaged})`, rally: `Rally (${routed})` }[o]}
          </label>
        ))}
      </div>
      {orders === 'move' && toRoll > 0 && (
        <button className="small" onClick={() => dispatch({ type: 'rollAdvanceCommand', commandId })}>Roll Advance to Combat ({toRoll} hoplites, 6.22)</button>
      )}
      {orders === 'disengage' && (
        <div className="btn-row">
          {cmd?.leaderless
            ? <button onClick={() => dispatch({ type: 'disengage', commandId, leaderId: null })}>Disengage (one roll per unit, rating 0)</button>
            : leaders.map((l) => (
              <button key={l.id} onClick={() => dispatch({ type: 'disengage', commandId, leaderId: l.id })}>
                {l.name}: roll ≤ {disengageRating(state, l)}
              </button>
            ))}
        </div>
      )}
      {orders === 'rally' && (
        <div className="btn-row">
          <button onClick={() => dispatch({ type: 'rally', commandId })}>Rally routed units ({routed})</button>
          <span className="muted small">{cmd?.leaderless ? 'rating 0' : leaders.map((l) => `${l.name} ≤ ${rallyRating(l)}`).join(', ')}</span>
        </div>
      )}
      {lag.length > 0 && (
        <div className="warn small">Law of Inertia (6.28): {lag.map((u) => u.name).join(', ')} must move toward the enemy.</div>
      )}
    </div>
  );
}

function RoutPanel({ state }: { state: GameState }) {
  return (
    <section className="panel rout">
      {(['A', 'B'] as SideId[]).map((sd) => {
        const side = state.sides[sd];
        const rp = sideRoutPoints(state, sd);
        const pct = Math.min(100, (rp / side.withdrawalLevel) * 100);
        return (
          <div key={sd} className="rout-row">
            <div className="rout-label"><b style={{ color: side.color }}>{side.name}</b><span>{rp} / {side.withdrawalLevel} RP</span></div>
            <div className="bar"><div style={{ width: `${pct}%`, background: side.color }} /></div>
          </div>
        );
      })}
    </section>
  );
}

function UnitPanel({ u, state, board, dispatch }: { u: Unit; state: GameState; board: Board; dispatch: (a: Action) => void }) {
  const cmd = state.commands.find((c) => c.id === u.command);
  const fp = u.hex ? footprint(u.hex, u.facing, u.size) : null;
  const where = fp ? fp.hexes.map((h) => hexLabel(board.geometry, h)).join('/') : 'off map';
  const tq = u.routed ? 1 : u.tq;
  return (
    <section className="panel">
      <h2 style={{ color: state.sides[u.side].color }}>{u.name}</h2>
      <div className="stats">
        <span><b>{u.type}</b>{u.size === 2 ? ' Phalanx' : ''}{u.spartan ? ' · Spartan' : ''}{u.depth ? ` · counts ×${u.depth}` : ''}</span>
        <span>TQ <b>{u.tq}</b>{u.routed ? ' (1 routed)' : ''}</span>
        <span>MA <b>{u.ma}</b></span>
        {u.missile && <span>Missile <b>{u.missile}</b></span>}
        <span>RP {unitRoutPoints(u)}</span>
      </div>
      <div className="muted small">{cmd?.name} Command · hex {where} · facing {u.facing * 30}°</div>

      <div className="row">
        <span>Cohesion hits</span>
        <button onClick={() => dispatch({ type: 'setHits', id: u.id, hits: u.hits - 1 })}>−</button>
        <b className={`hits-value${u.hits >= u.tq - 1 ? ' danger' : ''}`}>{u.hits}</b>
        <button onClick={() => dispatch({ type: 'setHits', id: u.id, hits: u.hits + 1 })}>+</button>
      </div>

      <div className="row wrap">
        {u.size === 2 ? (
          <>
            <button title="Front-to-Flank: right half steps forward (Q)" onClick={() => dispatch({ type: 'pivot', id: u.id, keep: 'left' })}>⟲ Pivot left</button>
            <button title="Front-to-Flank: left half steps forward (E)" onClick={() => dispatch({ type: 'pivot', id: u.id, keep: 'right' })}>Pivot right ⟳</button>
            <button title="Reverse Face 6.44 (Shift+R)" onClick={() => dispatch({ type: 'reverseFace', id: u.id })}>Reverse</button>
          </>
        ) : (
          <>
            <button title="One vertex left (Q)" onClick={() => dispatch({ type: 'rotateUnit', id: u.id, delta: -2 })}>⟲ Face left</button>
            <button title="One vertex right (E)" onClick={() => dispatch({ type: 'rotateUnit', id: u.id, delta: 2 })}>Face right ⟳</button>
            <button title="Half step, to face a hexside (column)" onClick={() => dispatch({ type: 'rotateUnit', id: u.id, delta: 1 })}>±30°</button>
          </>
        )}
      </div>

      <div className="row wrap toggles">
        {([['engaged', 'Engaged'], ['moved', 'Moved'], ['outOfCommand', 'Out of Cmd'], ['routed', 'Routed'], ['rallied', 'Rallied']] as const).map(([f, label]) => (
          <label key={f}><input type="checkbox" checked={u[f]} onChange={() => dispatch({ type: 'toggleFlag', id: u.id, flag: f })} />{label}</label>
        ))}
      </div>

      {u.type === 'HO' && (
        <div className="row">
          <span>Advance</span>
          <select value={u.advance ?? ''} onChange={(e) => dispatch({ type: 'setAdvance', id: u.id, rate: (e.target.value || null) as Unit['advance'] })}>
            <option value="">—</option><option value="walk">Walk (MA 3)</option><option value="trot">Trot (MA 4)</option><option value="run">Run (MA 5)</option>
          </select>
        </div>
      )}
      {u.missile && (
        <div className="row">
          <span>Missiles</span>
          <select value={u.missileSupply} onChange={(e) => dispatch({ type: 'setMissile', id: u.id, supply: e.target.value as Unit['missileSupply'] })}>
            <option value="full">Full</option><option value="low">Missile Low</option><option value="no">Missile No</option>
          </select>
        </div>
      )}

      {u.type === 'HO' && !u.advanceRolled && !u.advance && (
        <div className="row">
          <button onClick={() => dispatch({ type: 'rollAdvance', id: u.id })}>Roll Advance to Combat (6.22)</button>
        </div>
      )}

      <details className="checks">
        <summary>Cohesion events</summary>
        <div className="btn-col small">
          <button onClick={() => dispatch({ type: 'applyHits', hits: { [u.id]: 1 }, reason: 'Moved unit moves again (6.13)' })}>Moved again: +1 hit (6.13)</button>
          {u.size === 2 && !u.spartan && <button onClick={() => dispatch({ type: 'applyHits', hits: { [u.id]: 1 }, reason: 'Front-to-Flank (6.42)' })}>Front-to-Flank pivot: +1 hit</button>}
          <button onClick={() => dispatch({ type: 'tqCheckHits', id: u.id, label: 'Run move check (6.24)', exactHits: 1 })}>After a Run move: TQ check, 1 hit</button>
          {u.size === 2 && <button onClick={() => dispatch({ type: 'tqCheckHits', id: u.id, label: 'Wheeling (6.43)', minHits: 1 })}>Wheeling: hits = DR−TQ (min 1)</button>}
          <button onClick={() => dispatch({ type: 'tqCheckHits', id: u.id, label: 'Orderly Withdrawal (6.62[3])', exactHits: 1 })}>Orderly Withdrawal TQ check</button>
          <button onClick={() => dispatch({ type: 'tqCheckHits', id: u.id, label: 'Moved through by routed unit (10.22)', minHits: 1 })}>Moved through by routed unit</button>
        </div>
      </details>

      <div className="row wrap">
        {(() => {
          const rec = recoveryAmount(state, board.geometry, u);
          return (
            <button disabled={!rec.hits} title={rec.hits ? 'Remove hits instead of moving or firing (10.41)' : `Recovery not possible: ${rec.reason}`}
              onClick={() => dispatch({ type: 'recover', id: u.id })}>Recover{rec.hits ? ` −${rec.hits}` : ''}</button>
          );
        })()}
        <button title="Rout this unit now and move it 2 hexes toward its Retreat Edge (10.21)"
          onClick={() => dispatch({ type: 'routMove', id: u.id, steps: 2 })}>{u.routed ? 'Rout move 2' : 'Rout!'}</button>
        <button onClick={() => dispatch({ type: 'roll', label: `TQ check ${u.name}`, target: tq })}>TQ check (≤{tq})</button>
        <button className="danger" onClick={() => dispatch({ type: 'eliminate', id: u.id })}>Eliminate</button>
      </div>
    </section>
  );
}

function LeaderPanel({ l, state, board, dispatch }: { l: Leader; state: GameState; board: Board; dispatch: (a: Action) => void }) {
  const r = (v: number) => effRating(v, l.wounded);
  return (
    <section className="panel">
      <h2 style={{ color: state.sides[l.side].color }}>{l.name} <span className="phase">{l.rank === 'OC' ? 'Overall Commander' : 'Formation Commander'}</span></h2>
      <div className="stats">
        <span>Range <b>{r(l.range)}</b></span>
        {l.rank === 'OC' && <span>Charisma <b>{r(l.charisma ?? 0)}</b></span>}
        <span>{l.rank === 'OC' ? 'Initiative' : 'Capability'} <b>{r(l.initiative)}</b></span>
      </div>
      <div className="muted small">
        {l.commands.map((c) => state.commands.find((x) => x.id === c)?.name).join(', ')} Command · hex {l.hex ? hexLabel(board.geometry, l.hex) : '—'}
        {l.wounded && ' · WOUNDED'}
      </div>
      <div className="row wrap">
        <button onClick={() => dispatch({ type: 'roll', label: `${l.name} ${l.rank === 'OC' ? 'Initiative' : 'Capability'} check`, target: r(l.initiative) })}>Roll ≤ {l.rank === 'OC' ? 'Initiative' : 'Capability'}</button>
        <button onClick={() => dispatch({ type: 'woundLeader', id: l.id })}>Wound</button>
        <button className="danger" onClick={() => dispatch({ type: 'killLeader', id: l.id })}>Kill</button>
      </div>
    </section>
  );
}

function DicePanel({ dispatch }: { dispatch: (a: Action) => void }) {
  return (
    <section className="panel row">
      <button onClick={() => dispatch({ type: 'roll', label: 'd10' })}>🎲 Roll d10</button>
      <span className="muted small">0 counts as zero (2.3)</span>
    </section>
  );
}

function EliminatedPanel({ state, dispatch, onSelect }: { state: GameState; dispatch: (a: Action) => void; onSelect: (s: Selection) => void }) {
  const dead = Object.values(state.units).filter((u) => u.eliminated);
  const killed = Object.values(state.leaders).filter((l) => l.killed);
  if (!dead.length && !killed.length) return null;
  return (
    <section className="panel">
      <h3>Eliminated</h3>
      <ul className="elim">
        {dead.map((u) => (
          <li key={u.id}><span style={{ color: state.sides[u.side].color }}>{u.name}</span> ({unitRoutPoints(u)} RP)
            <button className="link" onClick={() => { dispatch({ type: 'restore', id: u.id }); onSelect(null); }}>undo</button></li>
        ))}
        {killed.map((l) => (
          <li key={l.id}><span style={{ color: state.sides[l.side].color }}>{l.name}</span> (killed)
            <button className="link" onClick={() => dispatch({ type: 'reviveLeader', id: l.id })}>undo</button></li>
        ))}
      </ul>
    </section>
  );
}

function LogPanel({ state }: { state: GameState }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [state.log.length]);
  return (
    <section className="panel log-panel">
      <h3>Log</h3>
      <div className="log" ref={ref}>
        {state.log.map((e, i) => <div key={i} className={`log-${e.kind ?? 'info'}`}><span className="muted">T{e.turn}</span> {e.text}</div>)}
      </div>
    </section>
  );
}

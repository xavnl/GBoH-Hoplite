import type { Board } from '../data/boards';
import { missileCalc } from '../engine/combat';
import { hexLabel } from '../engine/hex';
import { pwUnits, withdrawDestinations } from '../engine/reactions';
import type { Action } from '../engine/reducer';
import type { GameState, Reaction, SideId } from '../engine/types';

interface Props { state: GameState; board: Board; dispatch: (a: Action) => void }

const TITLE: Record<Reaction['kind'], string> = {
  withdraw: 'Orderly Withdrawal (6.6)',
  pw: 'Pre-arranged Withdrawal (6.7)',
  facing: 'Reaction facing (6.94)',
  reverseFace: 'Reverse Face reaction (6.95)',
  entryFire: 'Entry reaction fire (7.34)',
  retireFire: 'Retire / Withdrawal fire (7.31-7.33)',
  returnFire: 'Return Fire (7.35)',
};

export function ReactionsPanel({ state, board, dispatch }: Props) {
  const list = state.reactions ?? [];
  if (!list.length) return null;
  const g = board.geometry;
  return (
    <section className="panel reactions">
      <h3>Reactions available</h3>
      <ul>
        {list.map((r) => {
          const u = state.units[r.reactorId];
          const m = state.units[r.moverId];
          if (!u || !m) return null;
          const color = state.sides[u.side].color;
          let body: React.ReactNode = null;
          if (r.kind === 'withdraw') {
            const dests = withdrawDestinations(state, g, u, m, r.mp ?? 0).slice(0, 6);
            const penalty = [r.approach !== 'front' && (u.type !== 'SK' || r.approach === 'rear') ? `+1 (${r.approach})` : null,
              u.type !== 'SK' && u.type !== 'LC' && u.type !== 'HC' ? '+1 infantry' : null, u.type !== 'SK' ? 'TQ check' : null].filter(Boolean).join(', ');
            body = (
              <>
                <div className="muted small">{r.mp} MP away from {m.name}{penalty ? ` · ${penalty}` : ''}</div>
                <div className="btn-row">
                  {dests.length ? dests.map((d) => (
                    <button key={`${d.anchor.q},${d.anchor.r}`} onClick={() => dispatch({ type: 'reactWithdraw', reactionId: r.id, anchor: d.anchor })}>
                      → {d.hexes.map((h) => hexLabel(g, h)).join('/')}
                    </button>
                  )) : <span className="muted small">no legal withdrawal hex</span>}
                </div>
              </>
            );
          } else if (r.kind === 'pw') {
            const l = state.leaders[r.leaderId!];
            const units = pwUnits(state, g, r.leaderId!);
            body = (
              <>
                <div className="muted small">{l?.name}: {units.map((x) => x.name).join(', ')} withdraw 1 hex together</div>
                <div className="btn-row"><button onClick={() => dispatch({ type: 'reactPW', reactionId: r.id })}>Withdraw the line</button></div>
              </>
            );
          } else if (r.kind === 'facing') {
            body = (
              <div className="btn-row">
                <button onClick={() => dispatch({ type: 'reactFacing', reactionId: r.id, delta: -2 })}>⟲ one vertex</button>
                <button onClick={() => dispatch({ type: 'reactFacing', reactionId: r.id, delta: 2 })}>one vertex ⟳</button>
              </div>
            );
          } else if (r.kind === 'reverseFace') {
            body = <div className="btn-row"><button onClick={() => dispatch({ type: 'reactFacing', reactionId: r.id, delta: 6 })}>Reverse face (fail: ≥2 hits)</button></div>;
          } else {
            const c = missileCalc(g, u, m, r.range ? { rangeOverride: r.range } : {});
            body = (
              <div className="btn-row">
                <button disabled={!c.allowed} title={c.reasons.join(' ')} onClick={() => dispatch({ type: 'reactFire', reactionId: r.id })}>
                  Fire at range {c.range} (≤{c.strength}{c.totalMod ? `, DR ${c.totalMod > 0 ? '+' : ''}${c.totalMod}` : ''})
                </button>
              </div>
            );
          }
          return (
            <li key={r.id}>
              <div className="reaction-head">
                <span><b style={{ color }}>{u.name}</b> — {TITLE[r.kind]}</span>
                <button className="link" onClick={() => dispatch({ type: 'dismissReaction', reactionId: r.id })}>skip</button>
              </div>
              {body}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Pre-arranged Withdrawal orders are given at the start of the turn (6.72). */
export function PwOrders({ state, dispatch }: Props) {
  const fcs = Object.values(state.leaders).filter((l) => !l.killed && l.commands.some((c) =>
    Object.values(state.units).some((u) => u.command === c && u.type === 'HO' && u.tq >= 6 && !u.eliminated)));
  if (!fcs.length) return null;
  return (
    <details className="checks">
      <summary>Pre-arranged Withdrawal orders (6.72)</summary>
      {(['A', 'B'] as SideId[]).map((sd) => (
        <div key={sd} className="small">
          {fcs.filter((l) => l.side === sd).map((l) => (
            <label key={l.id} style={{ marginRight: 10 }}>
              <input type="checkbox" checked={!!state.pwOrders?.[l.id]} onChange={(e) => dispatch({ type: 'setPwOrder', leaderId: l.id, on: e.target.checked })} />
              <span style={{ color: state.sides[sd].color }}>{l.name}</span>
            </label>
          ))}
        </div>
      ))}
      <div className="muted small">Only hoplites with TQ ≥ 6 in the leader's range, and not while the formation has Advancing hoplites.</div>
    </details>
  );
}

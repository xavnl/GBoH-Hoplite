import { useMemo, useState } from 'react';
import type { Board } from '../data/boards';
import { attackApproach, canShock, inFrontOf, missileCalc, shockCalc } from '../engine/combat';
import { leadersWith } from '../engine/combatActions';
import type { Action } from '../engine/reducer';
import type { GameState, Unit } from '../engine/types';

interface Props {
  state: GameState;
  board: Board;
  dispatch: (a: Action) => void;
  selected: Unit | undefined;
}

export function CombatPanel(props: Props) {
  const [tab, setTab] = useState<'shock' | 'missile'>('shock');
  return (
    <section className="panel combat">
      <div className="tabs">
        <button className={tab === 'shock' ? 'on' : ''} onClick={() => setTab('shock')}>⚔ Shock</button>
        <button className={tab === 'missile' ? 'on' : ''} onClick={() => setTab('missile')}>🏹 Missile</button>
      </div>
      {tab === 'shock' ? <ShockWizard {...props} /> : <MissilePanel {...props} />}
    </section>
  );
}

// ---------------------------------------------------------------------------

function MissilePanel({ state, board, dispatch, selected }: Props) {
  const [moved, setMoved] = useState(false);
  if (!selected?.missile) return <p className="muted small">Select a missile unit (B, C, J or S) to see its targets.</p>;
  const enemies = Object.values(state.units).filter((u) => u.side !== selected.side && u.hex && !u.eliminated);
  const options = enemies
    .map((t) => ({ t, c: missileCalc(board.geometry, selected, t, { firerMoved: moved }) }))
    .filter((x) => x.c.range <= 3)
    .sort((a, b) => a.c.range - b.c.range);
  return (
    <div>
      <div className="small"><b>{selected.name}</b> — {selected.missile}, supply {selected.missileSupply}</div>
      {selected.type === 'SK' && selected.missile !== 'J' && (
        <label className="small"><input type="checkbox" checked={moved} onChange={(e) => setMoved(e.target.checked)} />moved / will move (+1)</label>
      )}
      {!options.length && <p className="muted small">No enemy within 3 hexes.</p>}
      <ul className="targets">
        {options.map(({ t, c }) => (
          <li key={t.id} className={c.allowed ? '' : 'disabled'}>
            <span>{t.name} <span className="muted">r{c.range}</span></span>
            {c.allowed ? (
              <>
                <span className="muted small">≤{c.strength}{c.totalMod ? ` (DR ${c.totalMod > 0 ? '+' : ''}${c.totalMod})` : ''}</span>
                <button onClick={() => dispatch({ type: 'missileFire', firerId: selected.id, targetId: t.id, ctx: { firerMoved: moved } })}>Fire</button>
              </>
            ) : <span className="muted small" title={c.reasons.join(' ')}>{c.reasons[0]}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ShockWizard({ state, dispatch, selected }: Props) {
  const [attIds, setAttIds] = useState<string[]>([]);
  const [defIds, setDefIds] = useState<string[]>([]);
  const [run, setRun] = useState<boolean | null>(null);
  const [mustCheck, setMustCheck] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState<Record<string, boolean>>({});

  const attackers = attIds.map((id) => state.units[id]).filter((u) => u && !u.eliminated && !u.routed);
  // A defender that routed away (e.g. in the pre-shock check) drops out of the combat.
  const defenders = defIds.map((id) => state.units[id])
    .filter((u) => u && !u.eliminated && (!attackers.length || attackers.some((a) => inFrontOf(a, u))));
  const runEff = run ?? attackers.some((u) => u.advance === 'run');

  const prepared = useMemo(() => {
    if (!attackers.length || !defenders.length) return null;
    const attackerLeaders = attackers.flatMap((u) => leadersWith(state, u));
    const defenderLeaders = defenders.flatMap((u) => leadersWith(state, u));
    const phalanxFrontAndFlank = attackers.some((a) => a.size === 2 && defenders.some((d) => attackApproach(a, d) === 'front') && defenders.some((d) => attackApproach(a, d) === 'flank'));
    const enemies = Object.values(state.units).filter((u) => u.side !== attackers[0].side && u.hex && !u.eliminated);
    const pinnedAttackers = attackers.filter((a) => enemies.some((e) => !defenders.includes(e) && inFrontOf(e, a))).map((a) => a.id);
    const options = { run: runEff, phalanxFrontAndFlank, pinnedAttackers };
    return { options, calc: shockCalc({ attackers, defenders, attackerLeaders, defenderLeaders, ...options }) };
  }, [attackers, defenders, state, runEff]);
  const calc = prepared?.calc ?? null;

  const reset = () => { setAttIds([]); setDefIds([]); setRun(null); setMustCheck({}); setDone({}); };

  const autoFromSelected = () => {
    if (!selected) return;
    const enemies = Object.values(state.units).filter((u) => u.side !== selected.side && u.hex && !u.eliminated && inFrontOf(selected, u));
    reset();
    setAttIds([selected.id]);
    setDefIds(enemies.map((u) => u.id));
  };

  const add = (list: 'att' | 'def') => {
    if (!selected) return;
    const [ids, set] = list === 'att' ? [attIds, setAttIds] : [defIds, setDefIds];
    if (!ids.includes(selected.id)) set([...ids, selected.id]);
  };

  // Pre-shock exceptions (8.11, 8.14)
  const defendersAllSkOrRouted = defenders.length > 0 && defenders.every((d) => d.type === 'SK' || d.routed);
  const defenderChecks = defenders.filter((d) => !d.engaged && !(d.size === 2 && attackers.every((a) => a.type === 'LI' && attackApproach(a, d) === 'front')));
  const attackerChecks = attackers.filter((a) => mustCheck[a.id] && !defendersAllSkOrRouted && !a.engaged);

  const aLeaders = [...new Map(attackers.flatMap((u) => leadersWith(state, u)).map((l) => [l.id, l])).values()];
  const dLeaders = [...new Map(defenders.flatMap((u) => leadersWith(state, u)).map((l) => [l.id, l])).values()];

  const step = (k: string, f: () => void) => { f(); setDone((d) => ({ ...d, [k]: true })); };

  return (
    <div>
      <div className="btn-row">
        <button disabled={!selected || !canShock(selected)} onClick={autoFromSelected} title="Selected unit attacks every enemy in its Front hexes">From selected</button>
        <button disabled={!selected} onClick={() => add('att')}>+ Attacker</button>
        <button disabled={!selected} onClick={() => add('def')}>+ Defender</button>
        <button onClick={reset}>Clear</button>
      </div>

      <div className="sides">
        <div>
          <div className="muted small">Attackers</div>
          {attackers.map((u) => (
            <div key={u.id} className="small chip">
              {u.name} <span className="muted">({u.hits}/{u.tq})</span>
              <label title="Unit stayed adjacent all phase or changed facing: must pass a Pre-Shock TQ check (8.11)">
                <input type="checkbox" checked={!!mustCheck[u.id]} onChange={(e) => setMustCheck({ ...mustCheck, [u.id]: e.target.checked })} />check
              </label>
              <button className="link" onClick={() => setAttIds(attIds.filter((x) => x !== u.id))}>×</button>
            </div>
          ))}
        </div>
        <div>
          <div className="muted small">Defenders</div>
          {defenders.map((u) => (
            <div key={u.id} className="small chip">
              {u.name} <span className="muted">({u.hits}/{u.tq}){u.engaged ? ' eng' : ''}</span>
              <button className="link" onClick={() => setDefIds(defIds.filter((x) => x !== u.id))}>×</button>
            </div>
          ))}
        </div>
      </div>

      {calc && (
        <div className="calc small">
          <div>{calc.attackerType.type} vs {calc.defenderType.type}: column <b>{calc.baseColumn}</b>
            {calc.numericalShift ? <> · numbers {calc.attackerCount}:{calc.defenderCount} → {calc.numericalShift > 0 ? '+' : ''}{calc.numericalShift}</> : null}
            {' '}⇒ <b>col {Math.max(1, Math.min(13, calc.column))}</b></div>
          <div>{calc.superiority ? <b>{calc.superiority}</b> : 'No superiority'} <span className="muted">— {calc.superiorityReason}</span></div>
          <div>DRM {calc.totalMod >= 0 ? '+' : ''}{calc.totalMod}{calc.mods.length ? <span className="muted"> ({calc.mods.map((m) => `${m.label} ${m.value > 0 ? '+' : ''}${m.value}`).join(', ')})</span> : null}</div>
          <label><input type="checkbox" checked={runEff} onChange={(e) => setRun(e.target.checked)} />Attacker advanced at the Run (+2, first shock only)</label>
          {!calc.allowed && <div className="warn">{calc.reasons.join(' ')}</div>}
        </div>
      )}

      {calc?.allowed && (
        <ol className="steps">
          <li className={done.pre ? 'done' : ''}>
            Pre-Shock TQ checks (8.14)
            <div className="btn-row">
              <button disabled={done.pre} onClick={() => step('pre', () => {
                attackerChecks.forEach((u) => dispatch({ type: 'preShockAttacker', id: u.id }));
                defenderChecks.forEach((u) => dispatch({ type: 'preShockDefender', id: u.id, attackerIds: attackers.map((x) => x.id) }));
              })}>Roll ({attackerChecks.length} att, {defenderChecks.length} def)</button>
            </div>
          </li>
          <li className={done.leaders ? 'done' : ''}>
            Leaders (8.15 / 8.3)
            <div className="btn-row">
              {aLeaders.length && dLeaders.length ? (
                <button disabled={done.leaders} onClick={() => step('leaders', () => dispatch({ type: 'personalCombat', attackerLeaderId: aLeaders[0].id, defenderLeaderId: dLeaders[0].id }))}>
                  Personal Combat: {aLeaders[0].name} vs {dLeaders[0].name}
                </button>
              ) : [...aLeaders, ...dLeaders].length ? (
                <button disabled={done.leaders} onClick={() => step('leaders', () => [...aLeaders, ...dLeaders].forEach((l) => dispatch({ type: 'leaderCasualty', leaderId: l.id })))}>
                  Casualty check: {[...aLeaders, ...dLeaders].map((l) => l.name).join(', ')}
                </button>
              ) : <span className="muted">no leaders involved</span>}
            </div>
          </li>
          <li className={done.resolve ? 'done' : ''}>
            Resolve (8.16-8.17)
            <div className="btn-row">
              <button className="primary" disabled={done.resolve} onClick={() => step('resolve', () => dispatch({
                type: 'resolveShock', attackerIds: attackers.map((u) => u.id), defenderIds: defenders.map((u) => u.id),
                options: prepared!.options,
              }))}>Roll Shock</button>
            </div>
          </li>
          <li className={done.collapse ? 'done' : ''}>
            Collapse (8.18)
            <div className="btn-row">
              <button disabled={done.collapse || !done.resolve} onClick={() => step('collapse', () => dispatch({
                type: 'collapse', attackerIds: attIds, defenderIds: defIds, positionSuperiority: !!calc.positionUnit && calc.superiority === 'AS',
                superiorId: calc.superiority === 'AS' ? (calc.positionUnit ?? calc.attackerType).id : null,
              }))}>Collapse, rout & advance</button>
            </div>
          </li>
        </ol>
      )}
      <p className="muted small">Routed units move 2 hexes toward their Retreat Edge and attackers advance into vacated hexes automatically. A single unit that advanced may still change facing one vertex (8.22).</p>
    </div>
  );
}

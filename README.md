# Hoplite — solo & AI play for GMT's *Great Battles of History: Hoplite*

Local web app (Vite + React + TypeScript) to play Hoplite solo, and later against a digital opponent.
You must own the game: maps and counters are extracted from your own copy of the Vassal module
and are **never committed or published** (`public/assets/` and `src/data/setups/` are git-ignored).

## Setup

```bash
npm install
npm run assets   # extracts maps, counters & setups from ../Hoplites/Hoplite101.vmod
npm run dev      # http://localhost:5173
```

## Roadmap

1. **Assisted board** ✅ — Nemea set up from the Vassal module; drag/rotate/pivot counters,
   facing arcs, cohesion hits & status markers, d10 roller, Initiative / Activation Marker pool / Trump,
   Rout Points & Army Withdrawal, log, undo/redo, autosave.
2. **Rules engine** *(in progress)*
   - ✅ Standard charts transcribed (`src/engine/tables.ts`): Shock CRT, Comparative Weapons,
     Superiority, Missile Range & Results, Fire vs. Armor, Advance to Combat, Personal Combat.
   - ✅ Missile fire (range, arc, DRMs, supply, leader casualty, 6.27 advance re-roll).
   - ✅ Shock procedure wizard: pre-shock checks, leaders, resolution (column, numbers, superiority,
     halving), hit distribution (10.13), collapse (8.18), Engaged markers.
   - ✅ Command range & In/Out of Command on activation (5.41/5.42/5.51).
   - ✅ Legal moves on clear terrain (front hexes, facing, phalanx forward/pivot/reverse,
     enemy front hexes, stacking, Out of Command, advance rates) with costs applied on drop.
   - ✅ Rout movement (10.21–10.24: path priorities, blocking, moving through friends, off-map
     elimination, phalanx reverse-face), Rout Movement segment (10.23), Reload (7.17),
     Advance after Combat (8.2/8.23 incl. wheeling, 8.24 order), leaders move with their unit.
   - ✅ Reactions offered after each legal move (Reactions panel): Orderly Withdrawal (6.6, incl.
     moving through friends and the 6.62 penalties), Pre-arranged Withdrawal orders & execution (6.7),
     Reaction facing (6.94) / phalanx Reverse Face (6.95), Entry & Retire reaction fire (7.31/7.34),
     Return Fire (7.35), LC/chariot archer Withdrawal fire (7.32).
   - Rules interpretation: "hits = DR−TQ, minimum N" (wheeling, reaction facing, reverse face,
     moved through by routers) applies only when the check fails (DR > TQ); a passed check costs
     nothing beyond the manoeuvre's own fixed cost (e.g. the Front-to-Flank hit).
   - ✅ Orders per activation (5.4): Move/Fire, Disengage (10.32-10.34, OC Charisma bonus, leaderless
     per-unit rolls), Rally (10.42), Recovery (10.41); restrictions on what units may do under each order,
     LI archers move OR fire, recovered units cannot move.
   - ✅ Advance to Combat rolls per command (6.22), Hellene Law of Inertia (6.28: only toward the enemy,
     non-Spartans spend all MP, warning at end of phase), Drift to the Right on second moves (6.29).
   - ⏳ Still manual: facing change after a single-unit advance (8.22), cavalry pursuit (9.4),
     Cavalry Command Withdrawal (6.68), reactions to moves made by free placement, H&D fire (7.2),
     multi-leader orders split (5.52), PW movement ban when activated, LOS blocking by units,
     Momentum resolution, leader replacement (4.25), terrain.
3. **AI opponent** — heuristics first, then search on top of the same engine.
4. More battles — terrain must be encoded per map (it only exists in the map art).

## Layout

- `src/engine/` — pure game logic (hex geometry, state, reducer, RNG). No React.
- `src/data/` — boards, counter stats (transcribed from counter art), scenario definitions.
- `src/ui/` — map (SVG) and sidebar.
- `tools/` — Vassal `.vmod` / `.vsav` readers and the asset extractor.

## Notes

- Hex numbers follow the printed map (`RRCC`). Facing is 0–11 in 30° steps clockwise from map-up;
  even = vertex (normal), odd = hexside (In Column).
- Vassal rotation → facing mapping (`vassalRotationToFacing`) is only verified for 0/180° (Nemea);
  re-check it when adding scenarios with oblique setups.

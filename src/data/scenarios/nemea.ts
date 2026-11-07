import type { ScenarioDef } from './types';

// Nemea (394 BCE) — Scenario Book p. 30-32. Played on the Cunaxa-Nemea-Coronea map,
// which is flat (the Vassal module uses the blank full map).
export const NEMEA: ScenarioDef = {
  id: 'nemea',
  name: 'Nemea (394 BCE)',
  boardId: 'blankFull',
  vassalSetup: 'nemea',
  sides: {
    A: { id: 'A', name: 'Sparta & Allies', color: '#b33a2b', withdrawalLevel: 55, retreatEdge: 'bottom' },
    B: { id: 'B', name: 'Thebes & Allies', color: '#3a5fa8', withdrawalLevel: 65, retreatEdge: 'top' },
  },
  commands: [
    { id: 'A-HO', side: 'A', name: 'Hoplite', leaderless: false },
    { id: 'A-CS', side: 'A', name: 'Cavalry-Skirmisher', leaderless: true },
    { id: 'B-HO', side: 'B', name: 'Hoplite', leaderless: false },
    { id: 'B-CAV', side: 'B', name: 'Cavalry', leaderless: true },
  ],
  /** Image file -> side & command. */
  units: {
    'Sparta HO PH 4 - 5.png': ['A', 'A-HO'],
    'Sparta HO PH 6 - 9.png': ['A', 'A-HO'],
    'Sicyon HO PH (Sparta).png': ['A', 'A-HO'],
    'Elis Triphyllis HO PH.png': ['A', 'A-HO'],
    'Acror Lasrn HO PH.png': ['A', 'A-HO'],
    'Mantinea HO PH 4 - 5.png': ['A', 'A-HO'],
    'Epid Troezen HO PH.png': ['A', 'A-HO'],
    'Herm Halleis HO PH.png': ['A', 'A-HO'],
    'Tegea HO PH 2 - 3.png': ['A', 'A-HO'],
    'Sparta LC 1 - 2.png': ['A', 'A-CS'],
    'Crete LI.png': ['A', 'A-CS'],
    'Mrgnia SK.png': ['A', 'A-CS'],
    'Amphip SK.png': ['A', 'A-CS'],
    'Letria SK.png': ['A', 'A-CS'],
    'Thebes DD HO PH.png': ['B', 'B-HO'],
    'Corinth HO PH 6.png': ['B', 'B-HO'],
    'Corinth HO PH 7.png': ['B', 'B-HO'],
    'Argos HO PH 1.png': ['B', 'B-HO'],
    'Argos HO PH 2 - 3.png': ['B', 'B-HO'],
    'Argos HO PH 4.png': ['B', 'B-HO'],
    'Euboea HO PH 1 - 3.png': ['B', 'B-HO'],
    'Athens HO PH 4.png': ['B', 'B-HO'],
    'Athens HO PH 9 - 10.png': ['B', 'B-HO'],
    'Boeotia LC 5.png': ['B', 'B-CAV'],
    'Boeotia LC 6 - 7.png': ['B', 'B-CAV'],
    'Ch Loc LC.png': ['B', 'B-CAV'],
    'Athens LC 4 - 5.png': ['B', 'B-CAV'],
  },
  leaders: {
    'Aristodemus.png': { side: 'A', commands: ['A-HO'], countsForRP: true },
    'Derkylidas.png': { side: 'A', commands: ['A-HO'], countsForRP: false },
    'Ismenias.png': { side: 'B', commands: ['B-HO'], countsForRP: false },
    'Timolaus.png': { side: 'B', commands: ['B-HO'], countsForRP: false },
  },
  initiative: null, // by die roll every turn
  notes: [
    'Theban units retreat toward the south (42xx) edge; Spartan units toward the north (10xx) edge.',
    'Only Aristodemus counts for Rout Points if killed.',
    'Both Hoplite Commands have two Formation Commanders (5.52). Cavalry commands are Leaderless (5.51).',
    'Optional: exempt the Theban Double Depth phalanx from Drift to the Right as a balancing aid.',
  ],
};

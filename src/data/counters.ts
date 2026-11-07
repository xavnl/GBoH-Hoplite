import type { CounterStats } from '../engine/types';

// Printed values transcribed from the counter images (keyed by Vassal image file).
// TQ = big left number, MA = right number in the black box.

const HO = (tq: number, extra: Partial<CounterStats> = {}): CounterStats => ({ type: 'HO', tq, ma: 4, size: 2, ...extra });
const LC = (tq: number, extra: Partial<CounterStats> = {}): CounterStats => ({ type: 'LC', tq, ma: 8, size: 1, ...extra });

export const COUNTERS: Record<string, CounterStats> = {
  // --- Sparta & allies ---
  'Sparta HO PH 4 - 5.png': HO(7, { spartan: true }),
  'Sparta HO PH 6 - 9.png': HO(6, { spartan: true }),
  'Sicyon HO PH (Sparta).png': HO(5),
  'Elis Triphyllis HO PH.png': HO(5),
  'Acror Lasrn HO PH.png': HO(5),
  'Mantinea HO PH 4 - 5.png': HO(5),
  'Epid Troezen HO PH.png': HO(5),
  'Herm Halleis HO PH.png': HO(5),
  'Tegea HO PH 2 - 3.png': HO(5),
  'Sparta LC 1 - 2.png': LC(4),
  'Crete LI.png': { type: 'LI', tq: 5, ma: 5, missile: 'B', size: 1 },
  'Mrgnia SK.png': { type: 'SK', tq: 1, ma: 5, missile: 'S', size: 1 },
  'Amphip SK.png': { type: 'SK', tq: 1, ma: 5, missile: 'S', size: 1 },
  'Letria SK.png': { type: 'SK', tq: 1, ma: 5, missile: 'S', size: 1 },
  // --- Thebes, Boeotia & allies ---
  'Thebes DD HO PH.png': HO(8, { depth: 2 }),
  'Corinth HO PH 6.png': HO(7),
  'Corinth HO PH 7.png': HO(6),
  'Euboea HO PH 1 - 3.png': HO(6),
  'Boeotia LC 5.png': LC(4),
  'Boeotia LC 6 - 7.png': LC(3),
  'Ch Loc LC.png': LC(3),
  // --- Athens ---
  'Argos HO PH 1.png': HO(7),
  'Argos HO PH 2 - 3.png': HO(6),
  'Argos HO PH 4.png': HO(5),
  'Athens HO PH 4.png': HO(7),
  'Athens HO PH 9 - 10.png': HO(6),
  'Athens LC 4 - 5.png': LC(4),
};

export interface LeaderStats {
  rank: 'OC' | 'FC';
  range: number;
  charisma?: number;
  /** OC Initiative / FC Capability. */
  initiative: number;
}

// OC counters read: Command Range, Charisma, Initiative (yellow box). FC: Range, Capability.
export const LEADERS: Record<string, LeaderStats> = {
  'Aristodemus.png': { rank: 'OC', range: 7, charisma: 3, initiative: 2 },
  'Derkylidas.png': { rank: 'FC', range: 5, initiative: 1 },
  'Ismenias.png': { rank: 'OC', range: 5, charisma: 1, initiative: 1 },
  'Timolaus.png': { rank: 'FC', range: 5, initiative: 1 },
};

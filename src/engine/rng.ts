// Deterministic d10 (0..9) so games can be replayed and searched by an AI.
// mulberry32 PRNG; the state is a uint32 kept in GameState.rng.

export function nextRandom(state: number): [value: number, next: number] {
  let t = (state + 0x6d2b79f5) >>> 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, next];
}

/** Roll a ten-sided die: 0..9 ('0' is zero, rule 2.3). */
export function rollD10(state: number): [roll: number, next: number] {
  const [v, n] = nextRandom(state);
  return [Math.floor(v * 10), n];
}

export function randomInt(state: number, maxExclusive: number): [value: number, next: number] {
  const [v, n] = nextRandom(state);
  return [Math.floor(v * maxExclusive), n];
}

export const newSeed = () => (Math.random() * 4294967296) >>> 0;

// Extracts maps, counter images and scenario setups from the Hoplite Vassal module
// into public/assets (images) and src/data/setups (JSON). Personal use only:
// the generated assets are GMT Games artwork and are git-ignored.
//
// Usage: node tools/extract-assets.mjs [path/to/Hoplite101.vmod]
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openZip, deobfuscate, parseSavedPieces } from './vmod.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vmodPath = process.argv[2] ?? resolve(root, '..', 'Hoplites', 'Hoplite101.vmod');
const imgOut = join(root, 'public', 'assets', 'images');
const setupOut = join(root, 'src', 'data', 'setups');
mkdirSync(imgOut, { recursive: true });
mkdirSync(setupOut, { recursive: true });

const vmod = openZip(vmodPath);

// Scenarios to extract: id -> saved game file inside the module.
const SCENARIOS = {
  nemea: 'Nemea set up.vsav',
};

// Boards used by those scenarios.
const BOARDS = {
  'Blank full map': 'Blank(full)_Map-150, resized.jpg',
};

const neededImages = new Set(Object.values(BOARDS));

for (const [id, file] of Object.entries(SCENARIOS)) {
  const get = vmod.get(file);
  if (!get) throw new Error(`Missing ${file} in module`);
  const save = openZip(get());
  const decoded = deobfuscate(save.get('savedGame')().toString('latin1'));
  const board = /BoardPicker\t([^\t]+)\t0\t0/.exec(decoded)?.[1] ?? null;
  const pieces = parseSavedPieces(decoded);
  pieces.forEach((p) => neededImages.add(p.image));
  writeFileSync(
    join(setupOut, `${id}.vassal.json`),
    JSON.stringify({ id, board, boardImage: BOARDS[board] ?? null, pieces }, null, 1),
  );
  console.log(`${id}: ${pieces.length} pieces on "${board}"`);
}

// Also grab the generic markers we use in the UI.
for (const m of ['Engaged, v3.jpg', 'Routed, version 6.gif', 'Rallied, version 4.gif',
  'Out of Command, v10.png', 'Low missile, v6.png', 'No missile, v5.png', 'Moved, vxxx9.png']) {
  neededImages.add(m);
}

let copied = 0;
for (const name of neededImages) {
  const get = vmod.get(`images/${name}`);
  if (!get) { console.warn(`  ! image not found: ${name}`); continue; }
  // Keep in sync with assetUrl() in src/ui/assets.ts.
  const dest = join(imgOut, name.replace(/[^A-Za-z0-9._-]/g, '_'));
  if (!existsSync(dest)) { writeFileSync(dest, get()); copied++; }
}
console.log(`images: ${neededImages.size} referenced, ${copied} newly copied to public/assets/images`);

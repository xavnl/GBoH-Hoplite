// Minimal readers for Vassal module (.vmod) and saved game (.vsav) files.
// Both are ZIP archives; this avoids any extra dependency.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/** Read a ZIP file and return a Map<entryName, () => Buffer>. */
export function openZip(pathOrBuffer) {
  const buf = Buffer.isBuffer(pathOrBuffer) ? pathOrBuffer : readFileSync(pathOrBuffer);
  const path = Buffer.isBuffer(pathOrBuffer) ? '<buffer>' : pathOrBuffer;
  // Locate End Of Central Directory record (scan backwards).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`Not a zip file: ${path}`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, () => {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`Unsupported compression ${method} for ${name}`);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Decode Vassal's "!VCSK" obfuscation. */
export function deobfuscate(text) {
  if (!text.startsWith('!VCSK')) return text;
  const key = parseInt(text.slice(5, 7), 16);
  let out = '';
  for (let i = 7; i + 1 < text.length; i += 2) {
    out += String.fromCharCode(parseInt(text.slice(i, i + 2), 16) ^ key);
  }
  return out;
}

/**
 * Parse the pieces of a decoded saved game.
 * Returns [{ image, name, map, x, y, rotation }].
 */
export function parseSavedPieces(decoded) {
  const pieces = [];
  for (const rec of decoded.split('\x1b')) {
    if (!rec.startsWith('+/')) continue;
    const pm = /piece;;;([^;]*);([^/\t]*)\/([^\t]*)/.exec(rec);
    if (!pm) continue;
    // Location: "<mapName>;<x>;<y>;" — take the last occurrence.
    const locRe = /(Hoplite Maps|Activation Markers Pool|Army Withdrawal and Rout Levels);(-?\d+);(-?\d+)/g;
    let loc = null, m;
    while ((m = locRe.exec(rec))) loc = m;
    // Rotation: outermost trait is "rotate;12;..." and its state is the first state token.
    let rotation = 0;
    if (/^\+\/\d+\/rotate;12;/.test(rec)) {
      const r = /^\d+/.exec(pm[3]);
      if (r) rotation = Number(r[0]);
    }
    pieces.push({
      image: pm[1],
      name: pm[2],
      map: loc ? loc[1] : null,
      x: loc ? Number(loc[2]) : null,
      y: loc ? Number(loc[3]) : null,
      rotation,
    });
  }
  return pieces;
}

// Optional first-party public-API conformance. Run from Slopesmith with:
// node --import tsx ../tools/board-audio-reference.mjs <native-test-executable>
import { spawnSync } from 'node:child_process';
import { boardBedFrame, DEFAULT_BOARD_SOUND, BOARD_BEND_SPAN } from '../Slopesmith/src/core/audio/board-sound.ts';
import { readFileSync } from 'node:fs';
const contract = JSON.parse(readFileSync(new URL('../Contracts/board-audio-v1.json', import.meta.url), 'utf8'));
if (JSON.stringify(contract.mix) !== JSON.stringify(DEFAULT_BOARD_SOUND) || contract.bend.span !== BOARD_BEND_SPAN)
  throw new Error('Authored mix/bend contract differs from the public interface');
const rows = [];
for (let group = 0; group < 10; group++)
  for (const slip of [-1, 0, 75, 150, 300, 301])
    for (const lean of [-1, 0, 25, 50, 100, 101])
      for (const speed of [-1, 0, .25, .5, 1, 2]) rows.push([group, slip, lean, speed]);
let seed = 619027;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
for (let i = 0; i < 5000; i++) rows.push([Math.floor(random() * 10), random() * 450 - 30, random() * 150 - 15, random() * 1.6 - .3]);
const result = spawnSync(process.argv[2], ['--bed'], { input: JSON.stringify(rows), encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
if (result.status !== 0 || result.error) throw result.error ?? new Error(result.stderr);
const native = JSON.parse(result.stdout);
let worst = 0;
for (let i = 0; i < rows.length; i++) {
  const r = boardBedFrame(...rows[i]);
  const expected = [r.glideVol, r.glideBend, r.carveVol, r.carveBend];
  if (!native[i] || native[i].length !== 4) throw new Error(`Missing response ${i}`);
  for (let j = 0; j < 4; j++) {
    const error = Math.abs(native[i][j] - expected[j]);
    worst = Math.max(worst, error);
    if (!(error < 1e-12)) throw new Error(`Response mismatch ${JSON.stringify(rows[i])}: ${JSON.stringify(native[i])} vs ${JSON.stringify(expected)}`);
  }
}
console.log(`PASS: ${rows.length} public-API bed comparisons across ten families; maximum absolute error ${worst}; mix/bend defaults match`);

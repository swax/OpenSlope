import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

/**
 * Replay an AUTOTEST4 instrument run through OpenSlope's project-authored board-bed curve. The report keeps
 * the measured Slip/Dig/Lean distributions visible beside the authored glide/carve response, which makes it
 * useful for tuning without reproducing or evaluating the retail SNOW.INF expression programs.
 *
 *   npx tsx tools/ride-study/board-bed-study.ts                 newest instrument report
 *   npx tsx tools/ride-study/board-bed-study.ts run-....json    a specific report
 */

import { boardAudioGroup, boardBedFrame } from '../../src/core/audio/board-sound';
import { readBoardSoundIndex } from '../../src/server/routes/audio';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTS = path.resolve(HERE, '..', '..', '..', 'Trailmap', 'temp', 'autotest');
const GLIDE_MIN_SPEED = 1.5;
const GLIDE_FULL_SPEED = 18;
const STRIP_MARGIN_M = 15;
const KEEP_STATE = 2;
const GROUP_NAMES = ['PACK', 'POWDER', 'LOOSE', 'ICE', 'METAL', 'WOOD', 'RAIL', 'ROCK', 'GLASS', 'CHUTE'];

interface Strip { label: string; surface: number; fromM: number; toM: number }
interface Anchor { location: number[]; distanceM: number }

const percentile = (values: number[], q: number): number => {
  if (!values.length) return NaN;
  const ordered = [...values].sort((a, b) => a - b);
  const index = (ordered.length - 1) * q;
  const lo = Math.floor(index), hi = Math.ceil(index);
  return lo === hi ? ordered[lo] : ordered[lo] + (ordered[hi] - ordered[lo]) * (index - lo);
};
const spread = (values: number[]): string =>
  [0.1, 0.5, 0.9].map(q => percentile(values, q).toFixed(1).padStart(6)).join('/');

function newestReport(): string {
  const names = readdirSync(REPORTS).filter(name => /^run-.*-autotest4\.json$/.test(name)).sort();
  if (!names.length) throw new Error(`no instrument report under ${REPORTS}; ride AUTOTEST4 first`);
  return path.join(REPORTS, names[names.length - 1]);
}

const argPath = process.argv[2];
const reportPath = !argPath ? newestReport()
  : path.isAbsolute(argPath) || argPath.includes('/') || argPath.includes('\\')
    ? path.resolve(argPath) : path.join(REPORTS, argPath);
const doc = JSON.parse(readFileSync(reportPath, 'utf8')) as {
  strips?: Strip[]; anchors?: Anchor[]; riderPath?: number[][];
  ended?: string; steered?: unknown; samplesPerGameSecond?: number;
};
const strips = doc.strips ?? [];
const rows = doc.riderPath ?? [];
const anchors = doc.anchors ?? [];
if (!strips.length || !rows.length || rows[0].length < 14 || anchors.length < 2)
  throw new Error(`${reportPath} is not a current AUTOTEST4 instrument report`);

const [first, second] = anchors;
const delta = [second.location[0] - first.location[0], second.location[1] - first.location[1]];
const span = Math.hypot(delta[0], delta[1]) || 1;
const down = [delta[0] / span, delta[1] / span];
const scale = (second.distanceM - first.distanceM) / span;
const distanceM = (row: number[]): number =>
  first.distanceM + ((row[1] - first.location[0]) * down[0] + (row[2] - first.location[1]) * down[1]) * scale;

const surfaceGroups = (await readBoardSoundIndex())?.SurfaceGroups;
if (!surfaceGroups) throw new Error('Maps/Shared/Audio/BoardSoundIndex.json is required; run `snowknife shared`.');

console.log(`report: ${path.basename(reportPath)}   ended ${doc.ended ?? 'complete'}, `
  + `${doc.samplesPerGameSecond} samples/game-second${doc.steered ? `, steered: ${JSON.stringify(doc.steered)}` : ''}`);
console.log('measured inputs are p10/p50/p90; outputs are medians from OpenSlope\'s authored curve\n');
console.log('strip      family     n  speed m/s        Dig              Slip             Lean       glide carve gPitch cPitch');

for (const strip of strips) {
  const selected = rows.filter(row => {
    const m = distanceM(row);
    return m >= strip.fromM + STRIP_MARGIN_M && m < strip.toM - STRIP_MARGIN_M
      && (row.length < 15 || Math.trunc(row[14]) === KEEP_STATE);
  });
  const group = boardAudioGroup(strip.surface, surfaceGroups);
  const speeds: number[] = [], digs: number[] = [], slips: number[] = [], leans: number[] = [];
  const outputs = { glideVol: [] as number[], carveVol: [] as number[],
    glideBend: [] as number[], carveBend: [] as number[] };
  for (const row of selected) {
    const [vx, vy, vz] = [row[4], row[5], row[6]];
    const magnitude = Math.hypot(vx, vy, vz);
    const along = row[11] * vx + row[12] * vy + row[13] * vz;
    const slip = Math.sqrt(Math.max(0, magnitude * magnitude - along * along));
    const lean = Math.abs(row[10]) * 127;
    const speed = magnitude / 100;
    const speed01 = Math.min(1, Math.max(0,
      (speed - GLIDE_MIN_SPEED) / (GLIDE_FULL_SPEED - GLIDE_MIN_SPEED)));
    const frame = boardBedFrame(group, slip, lean, speed01);
    speeds.push(speed); digs.push(Math.abs(row[9])); slips.push(slip); leans.push(lean);
    for (const key of Object.keys(outputs) as (keyof typeof outputs)[]) outputs[key].push(frame[key]);
  }
  const median = (values: number[]) => percentile(values, 0.5).toFixed(2).padStart(5);
  console.log(`${strip.label.padEnd(10)} ${GROUP_NAMES[group].padEnd(7)} ${String(selected.length).padStart(4)}  `
    + `${percentile(speeds, 0.5).toFixed(1).padStart(7)}  ${spread(digs)}  ${spread(slips)}  ${spread(leans)}  `
    + `${median(outputs.glideVol)} ${median(outputs.carveVol)} ${median(outputs.glideBend)} ${median(outputs.carveBend)}`);
}

console.log('\nNo retail expression sequence or expected-output table is embedded in this tool.');

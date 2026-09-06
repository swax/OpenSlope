/**
 * Report — and optionally repair — the triangle winding of stored imported-prop records.
 *
 * A prop's normals come from its stored winding (`computeVertexNormals` over the raw buffer,
 * prop-assets.ts) and the hardware lights each face as `ambient + Σ max(0, N·L)·key` against that normal,
 * identically from both sides (docs/028). A record wound inside-out therefore draws ambient-only dark from
 * every view — in the editor's PS2 shading preview and on the ISO — while still drawing, because prop
 * meshes are double-sided. The selection's facing arrows are the visible symptom: they point inward.
 *
 * Orientation is read as the SIGN OF THE ENCLOSED VOLUME in raw space, which is the same convention retail
 * ships: every measured shipped prop (GARI's boulders, SNOW's snow blower and pipe runs) encloses a
 * positive volume. Negative means inside-out.
 *
 * The measure is exact only for a closed mesh, and prop art often is not — a model with open backs or
 * unclosed shells scores near zero and is reported as INCONCLUSIVE rather than guessed at, because
 * flipping a correct record is exactly as bad as leaving a broken one.
 *
 * Records are rewritten IN PLACE, keeping their `id`: placements persist the model number, so repairing a
 * record must not renumber it (a re-import would land as `<name>_2` and orphan every placement).
 *
 *   npx tsx scripts/fix-imported-winding.ts            # report only
 *   npx tsx scripts/fix-imported-winding.ts --apply    # rewrite the inverted ones
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { currentProject } from '../src/server/projects';
import { migrateLegacyProjectAssets } from '../src/server/project-assets';

const APPLY = process.argv.includes('--apply');

/** Base64 → typed array, the packing the wire format and the record store share. */
function unpack<T extends Float32Array | Uint32Array>(
  b64: string, Ctor: new (b: ArrayBuffer) => T): T {
  const bin = Buffer.from(b64, 'base64');
  return new Ctor(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
}

const pack = (view: ArrayBufferView): string =>
  Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64');

/** Six times the enclosed volume: Σ v0 · (v1 × v2). Sign is what matters, not magnitude. */
function volume6(pos: Float32Array, idx: Uint32Array): number {
  let sum = 0;
  for (let k = 0; k + 2 < idx.length; k += 3) {
    const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
    const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return sum;
}

/** The scale the volume is judged against: the bounding box's own volume. A shell that encloses under a
 *  thousandth of its box is not making a claim about its orientation either way. */
function boxVolume(pos: Float32Array): number {
  if (!pos.length) return 0;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], pos[i + k]);
      hi[k] = Math.max(hi[k], pos[i + k]);
    }
  }
  return Math.max(0, hi[0] - lo[0]) * Math.max(0, hi[1] - lo[1]) * Math.max(0, hi[2] - lo[2]);
}

interface Sub { mat: number; pos: string; uv: string; idx: string }
interface Record { id: number; name: string; subs: Sub[]; [k: string]: unknown }

async function main() {
  const project = await currentProject();
  if (!project) throw new Error('open a mountain before inspecting its imported props');
  await migrateLegacyProjectAssets(project);
  const dir = join(project.project.folder, 'assets', 'props');
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter(f => /\.json$/i.test(f)).sort();
  if (!files.length) { console.log(`no records under ${dir}`); return; }

  console.log(`${dir}\n`);
  console.log(`${'record'.padEnd(28)}${'tris'.padStart(8)}${'volume / box'.padStart(16)}  verdict`);
  let inverted = 0, repaired = 0, unclear = 0;

  for (const file of files) {
    const path = join(dir, file);
    let record: Record;
    try { record = JSON.parse(await readFile(path, 'utf8')) as Record; }
    catch { console.log(`${file.padEnd(28)}${'—'.padStart(8)}${'—'.padStart(16)}  unreadable, skipped`); continue; }

    let v6 = 0, box = 0, tris = 0;
    for (const sub of record.subs ?? []) {
      const pos = unpack(sub.pos, Float32Array);
      const idx = unpack(sub.idx, Uint32Array);
      v6 += volume6(pos, idx);
      box += boxVolume(pos);
      tris += idx.length / 3;
    }
    const ratio = box > 0 ? v6 / 6 / box : 0;
    // 1e-3 of the bounding box: comfortably above float noise, far below any genuinely closed shell
    const verdict = Math.abs(ratio) < 1e-3 ? 'inconclusive' : ratio < 0 ? 'INVERTED' : 'ok';
    let note = verdict;

    if (verdict === 'INVERTED') {
      inverted++;
      if (APPLY) {
        for (const sub of record.subs) {
          const idx = unpack(sub.idx, Uint32Array);
          for (let k = 0; k + 2 < idx.length; k += 3) {
            const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t;
          }
          sub.idx = pack(idx);
        }
        await writeFile(path, JSON.stringify(record));
        repaired++;
        note = 'INVERTED → repaired';
      } else {
        note = 'INVERTED (run with --apply)';
      }
    } else if (verdict === 'inconclusive') {
      unclear++;
      note = 'inconclusive — open shell, left alone';
    }

    console.log(`${file.replace(/\.json$/, '').padEnd(28)}${String(tris).padStart(8)}`
      + `${ratio.toFixed(4).padStart(16)}  ${note}`);
  }

  console.log(`\n${files.length} record(s): ${inverted} inverted, ${unclear} inconclusive`
    + (APPLY ? `, ${repaired} repaired` : ''));
  if (inverted && !APPLY) console.log('re-run with --apply to rewrite them in place (ids and placements are kept)');
  if (unclear) console.log('inconclusive records enclose ~no volume (open backs); check those with the F arrows in the editor');
}

void main();

// Measure what a course asks a rider to do — and read the retail SSX Tricky courses so authored courses can
// be held against them. One module keeps retail and authored routes on the SAME operator; a curvature number is only
// comparable to another one measured the same way, at the same baseline.
//
// The retail side parses `.aip`, per Trailmap/specs/250-paths-aip-sop.md. Section 2 holds the race lines —
// the ordered course spine. Section 1 holds the AI paths, whose lateral spread is a corridor-width proxy.
// Points are ACCUMULATED STEPS, not positions: pos[k] = pos[k-1] + (X*W, Y*W, Z*W), seeded at PathPos.
// Source X-Y is the ground plane and Z is up (002-conventions); units are centimetres.
//
// Retail levels are read from an extraction of the retail discs, so this only runs where that extraction
// exists; `loadRetail` returns null rather than throwing when it does not.

import fs from 'node:fs'
import path from 'node:path'

function accumulate(dv, at, n, seed) {
  const pts = []
  let cur = seed.slice()
  for (let k = 0; k < n; k++) {
    const o = at + k * 16
    const W = dv.getFloat32(o + 12, true)
    cur = [cur[0] + dv.getFloat32(o, true) * W, cur[1] + dv.getFloat32(o + 4, true) * W,
      cur[2] + dv.getFloat32(o + 8, true) * W]
    pts.push(cur)
  }
  return pts
}

export function readAip(file) {
  const buf = fs.readFileSync(file)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (dv.getUint32(0, true) !== 0x0a0a0a0a) throw new Error(`bad magic in ${file}`)

  // ---- section 1: AI paths ----
  let o = 16 + dv.getUint32(0x08, true)
  const aiCount = dv.getUint32(o, true)
  o += 8 + dv.getUint32(o + 4, true) * 4
  const ai = []
  for (let i = 0; i < aiCount; i++) {
    const nPts = dv.getUint32(o + 0x1c, true), nEv = dv.getUint32(o + 0x20, true)
    const seed = [dv.getFloat32(o + 0x24, true), dv.getFloat32(o + 0x28, true), dv.getFloat32(o + 0x2c, true)]
    ai.push({ index: i, rating: dv.getUint32(o + 0x0c, true), pts: accumulate(dv, o + 0x48, nPts, seed) })
    o += 0x48 + nPts * 16 + nEv * 16
  }

  // ---- section 2: race lines ----
  o = 16 + dv.getUint32(0x0c, true)
  const lineCount = dv.getUint32(o + 8, true)
  o += 16
  const lines = []
  for (let i = 0; i < lineCount; i++) {
    const nPts = dv.getUint32(o + 0x10, true), nEv = dv.getUint32(o + 0x14, true)
    const seed = [dv.getFloat32(o + 0x18, true), dv.getFloat32(o + 0x1c, true), dv.getFloat32(o + 0x20, true)]
    lines.push({ index: i, dtf: dv.getFloat32(o + 0x0c, true), pts: accumulate(dv, o + 0x3c, nPts, seed) })
    o += 0x3c + nPts * 16 + nEv * 16
  }
  return { ai, lines }
}

// The main course is the chain of race lines that joins end-to-end. Branch alternates carry intermediate
// distance-to-finish values, so ordering by DTF alone stitches them in and invents corners at every splice;
// requiring the next line to START where the last one ENDED is what separates the spine from the alternates.
export function spineOf(lines, joinTol = 3000) {
  const pool = lines.filter(l => l.pts.length > 1).slice().sort((a, b) => b.dtf - a.dtf)
  if (!pool.length) return []
  const chain = [pool.shift()]
  for (;;) {
    const tail = chain[chain.length - 1].pts.at(-1)
    let best = -1, bestD = Infinity
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].dtf >= chain[chain.length - 1].dtf) continue
      const h = pool[i].pts[0]
      const d = Math.hypot(h[0] - tail[0], h[1] - tail[1], h[2] - tail[2])
      if (d < bestD) { bestD = d; best = i }
    }
    if (best < 0 || bestD > joinTol) break
    chain.push(pool.splice(best, 1)[0])
  }
  const pts = []
  for (const l of chain) for (const q of l.pts) {
    const b = pts[pts.length - 1]
    if (b && Math.hypot(q[0] - b[0], q[1] - b[1], q[2] - b[2]) < 100) continue
    pts.push(q)
  }
  return { pts, used: chain.map(l => l.index) }
}

// ---- the shared measurement, applied to retail AND to europa so the numbers mean the same thing ----

export function resamplePlan(pts, step = 2) {
  const out = []
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (seg < 1e-6) continue
    let t = carry
    while (t < seg) {
      const u = t / seg
      out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u])
      t += step
    }
    carry = t - seg
  }
  return out
}

// Plan radius over a fixed BASELINE in metres, as the exact circle through three points spanning that
// baseline (Menger curvature). A circle fit is unambiguous: for points genuinely on an arc it returns the
// arc's radius whatever the window, so there is no half-window bookkeeping to get wrong.
//
// The baseline is the physical question. A rider at 25 m/s holding an edge for two seconds covers ~50 m of
// ground, so ~60 m is one carve. Measuring tighter than the authored point spacing (12-18 m on retail) reads
// the polyline's own kinks instead of the course.
export function radiiOf(sampled, step, baseline = 60) {
  const half = Math.max(1, Math.round(baseline / 2 / step))
  const out = new Array(sampled.length).fill(Infinity)
  for (let i = half; i + half < sampled.length; i++) {
    const a = sampled[i - half], m = sampled[i], b = sampled[i + half]
    const ab = Math.hypot(m[0] - a[0], m[1] - a[1])
    const bc = Math.hypot(b[0] - m[0], b[1] - m[1])
    const ca = Math.hypot(b[0] - a[0], b[1] - a[1])
    const area2 = Math.abs((m[0] - a[0]) * (b[1] - a[1]) - (m[1] - a[1]) * (b[0] - a[0]))
    out[i] = area2 < 1e-9 ? Infinity : (ab * bc * ca) / (2 * area2)
  }
  return out
}

export function gradesOf(sampled, step, baseline = 60) {
  const half = Math.max(1, Math.round(baseline / 2 / step))
  const out = new Array(sampled.length).fill(0)
  for (let i = half; i + half < sampled.length; i++) {
    const a = sampled[i - half], b = sampled[i + half]
    const run = Math.hypot(b[0] - a[0], b[1] - a[1])
    out[i] = (Math.atan2(a[2] - b[2], Math.max(1e-6, run)) * 180) / Math.PI
  }
  return out
}

export const pctOf = (arr, t) => {
  const v = arr.filter(Number.isFinite).sort((a, b) => a - b)
  return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * t))] : NaN
}

// Corridor width proxy: at each station, how far do the AI racing lines spread either side of the spine?
// The AI field is the authored set of lines a rider might take, so its envelope is the part of the course
// that is actually raced. It is a floor on the corridor, not the terrain's full width.
export function corridorOf(sampled, step, aiPts, reach = 60) {
  const cell = 100
  const grid = new Map()
  const key = (a, b) => `${a}|${b}`
  for (let i = 0; i < sampled.length; i++) {
    const g = key(Math.floor(sampled[i][0] / cell), Math.floor(sampled[i][1] / cell))
    if (!grid.has(g)) grid.set(g, [])
    grid.get(g).push(i)
  }
  const left = new Array(sampled.length).fill(0), right = new Array(sampled.length).fill(0)
  for (const p of aiPts) {
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell)
    let bi = -1, bd = Infinity
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of grid.get(key(cx + dx, cy + dy)) || []) {
        const d = Math.hypot(sampled[i][0] - p[0], sampled[i][1] - p[1])
        if (d < bd) { bd = d; bi = i }
      }
    }
    if (bi < 0 || bd > reach) continue
    const a = sampled[Math.max(0, bi - 1)], b = sampled[Math.min(sampled.length - 1, bi + 1)]
    const tx = b[0] - a[0], ty = b[1] - a[1]
    const L = Math.hypot(tx, ty) || 1
    const side = ((p[0] - sampled[bi][0]) * -ty + (p[1] - sampled[bi][1]) * tx) / L
    if (side > 0) left[bi] = Math.max(left[bi], side)
    else right[bi] = Math.max(right[bi], -side)
  }
  // smooth over ~40 m so a single stray point is not a wide corridor
  const w = Math.round(20 / step)
  const out = new Array(sampled.length).fill(0)
  for (let i = 0; i < sampled.length; i++) {
    let l = 0, r = 0
    for (let k = -w; k <= w; k++) {
      const j = i + k
      if (j < 0 || j >= sampled.length) continue
      l = Math.max(l, left[j]); r = Math.max(r, right[j])
    }
    out[i] = l + r
  }
  return out
}

const OPEN_SLOPE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
export const RETAIL_ROOT = process.env.SLOPESMITH_RETAIL_ROOT?.trim()
  || path.join(OPEN_SLOPE_ROOT, 'temp', 'patch-trailer-retail')
export const RETAIL_NAMES = {
  ALASKA: 'Alaska', ALOHA: 'Aloha Ice Jam', ELYSIUM: 'Elysium Alps', GARI: 'Garibaldi',
  MEGAPLE: 'Tokyo Megaplex', MERQUER: 'Merqury City', MESA: 'Mesablanca', PIPE: 'Pipedream',
  SNOW: 'Snowdream', TRICK: 'Trick park', UNTRACK: 'Untracked',
}

export function loadRetail(dir, retailRoot = RETAIL_ROOT) {
  const models = path.join(retailRoot, dir, 'data', 'models')
  if (!fs.existsSync(models)) return null
  const aip = fs.readdirSync(models).find(f => f.toLowerCase().endsWith('.aip'))
  if (!aip) return null
  const { ai, lines } = readAip(path.join(models, aip))
  const sp = spineOf(lines)
  if (!sp.pts || sp.pts.length < 10) return null
  const M = q => [q[0] / 100, q[1] / 100, q[2] / 100]
  return { dir, name: RETAIL_NAMES[dir] || dir, lineCount: lines.length, used: sp.used,
    pts: sp.pts.map(M), ai: ai.flatMap(a => a.pts.map(M)) }
}

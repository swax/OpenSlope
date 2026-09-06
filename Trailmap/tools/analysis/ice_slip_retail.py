#!/usr/bin/env python3
"""Retail ice slip study (tools/analysis/ice_slip_retail.py).

Recovers slip_equilibrium(lean) on SurfaceType 5 from the PCSX2 rider-telemetry v4 captures. For every
grounded ice frame it computes the signed slip angle between travel and the board's contact-plane tangent,
against the engine's OWN lean field (`control.leanSlew[0]`) rather than a stick value reconstructed through
a port's slew law. [Trailmap: 330-carving]

Two estimators, because the ice captures are fragmented (the longest contiguous ice run is ~100 frames and
most are under 25, so sustained plateaus are scarce):

  holds      - frames inside a sustained |lean| plateau; the classic settled measurement, but it only ever
               lands on the pad extremes, so on its own it gives two points and no curve
  stationary - frames where d(slip)/dt crosses zero. Slip is momentarily AT its equilibrium for whatever
               lean is being held, so a 20-frame fragment still contributes a point, and the mid-lean bins
               the plateaus never reach get populated

Reads `ResearchData/telemetry/gari-ice-turn-retail-*.jsonl`, which a fresh checkout does not carry — see
`ResearchData/README.md` and `Trailmap/research/rider-telemetry.md` for regenerating them from your own disc.

Usage: python tools/analysis/ice_slip_retail.py [telemetry-dir]

Units: the capture is engine units, 100 units = 1 m.
"""
import json, math, sys, os, statistics as st
from collections import defaultdict

TRACES = [
    'gari-ice-turn-retail-20260720-153000.jsonl',
    'gari-ice-turn-retail-20260720-153219.jsonl',
    'gari-ice-turn-retail-keyboard-20260720-160415.jsonl',
]
ROOT = sys.argv[1] if len(sys.argv) > 1 else '.'


def dot(a, b):
    return sum(x * y for x, y in zip(a[:3], b[:3]))


def load(fn):
    out = []
    for line in open(os.path.join(ROOT, fn)):
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        if r.get('kind') != 'frame':
            continue
        c, m, s = r['contact'], r['motion'], r['state']
        if c['surfaceType'] != 5 or s.get('motionName') != 'ground':
            continue
        v = m['velocity']
        speed = math.sqrt(dot(v, v)) / 100.0
        if speed < 3.0:                      # travel direction is noise below this
            continue
        vt, vl = dot(v, c['tangent']), dot(v, c['lateral'])
        if vt * vt + vl * vl < 1e-6:
            continue
        out.append({
            'frame': r['frame'],
            'lean': m and r['control']['leanSlew'][0],
            'slip': math.degrees(math.atan2(vl, vt)),
            'speed': speed,
            'src': fn,
        })
    return out


def runs(rows):
    """Split into contiguous game-frame runs."""
    if not rows:
        return []
    out, cur = [], [rows[0]]
    for a, b in zip(rows, rows[1:]):
        if b['frame'] == a['frame'] + 1:
            cur.append(b)
        else:
            out.append(cur)
            cur = [b]
    out.append(cur)
    return out


def main() -> None:
    """Run the study over the capture files named in TRACES."""
    rows = []
    for fn in TRACES:
        try:
            r = load(fn)
        except FileNotFoundError:
            print(f'  (missing {fn})')
            continue
        print(f'  {fn}: {len(r)} grounded ice frames')
        rows += r

    allruns = [r for t in TRACES for r in runs([x for x in rows if x['src'] == t])]
    print(f'\ncontiguous ice runs: {len(allruns)}  lengths: '
          f'{sorted((len(r) for r in allruns), reverse=True)[:12]}')

    # ---- sign convention -------------------------------------------------------
    lp = [r for r in rows if r['lean'] > 0.6]
    ln = [r for r in rows if r['lean'] < -0.6]
    print(f'\nsign check: lean>+0.6 -> slip mean {st.mean([r["slip"] for r in lp]):+.2f} deg (n={len(lp)})')
    print(f'            lean<-0.6 -> slip mean {st.mean([r["slip"] for r in ln]):+.2f} deg (n={len(ln)})')

    # ---- estimator 1: sustained lean plateaus ---------------------------------
    holds = []
    for run in allruns:
        i = 0
        while i < len(run):
            j = i + 1
            while j < len(run) and abs(run[j]['lean'] - run[i]['lean']) < 0.05:
                j += 1
            if j - i >= 12:                       # >= 0.2 s held
                holds.append(run[i:j])
            i = j
    print(f'\nlean plateaus >=12 frames: {len(holds)}')

    # ---- estimator 2: slip stationary points -----------------------------------
    stat = []
    for run in allruns:
        for a, b, c in zip(run, run[1:], run[2:]):
            d0, d1 = b['slip'] - a['slip'], c['slip'] - b['slip']
            if d0 == 0 and d1 == 0:
                continue
            if d0 * d1 <= 0 and abs(b['lean']) > 0.02:   # slope crosses zero -> at equilibrium
                stat.append(b)
    print(f'slip stationary points:    {len(stat)}')

    # ---- the curve -------------------------------------------------------------
    BINS = [(0.0, 0.15), (0.15, 0.30), (0.30, 0.45), (0.45, 0.60),
            (0.60, 0.75), (0.75, 0.86), (0.86, 0.91)]


    def report(name, sample):
        print(f'\n--- slip equilibrium vs |lean|  ({name}, n={len(sample)}) ---')
        print(f'{"|lean| bin":>14} {"n":>4} {"|slip| deg":>12} {"sd":>6} {"speed m/s":>10}')
        curve = []
        for lo, hi in BINS:
            sel = [r for r in sample if lo <= abs(r['lean']) < hi]
            if len(sel) < 4:
                print(f'{lo:5.2f}-{hi:<5.2f}  {len(sel):>4}  {"-":>11}')
                continue
            sl = [abs(r['slip']) for r in sel]
            sd = st.pstdev(sl) if len(sl) > 1 else 0.0
            sp = st.mean([r['speed'] for r in sel])
            lm = st.mean([abs(r['lean']) for r in sel])
            print(f'{lo:5.2f}-{hi:<5.2f}  {len(sel):>4}  {st.median(sl):>11.2f} {sd:>6.2f} {sp:>10.2f}')
            curve.append((lm, st.median(sl)))
        return curve


    for name, sample in (('lean plateaus', [r for h in holds for r in h[len(h) // 2:]]),
                         ('stationary pts', stat)):
        curve = report(name, sample)
        if len(curve) >= 3:
            # slope through the origin: slip = k * |lean|
            k = sum(l * s for l, s in curve) / sum(l * l for l, _ in curve)
            resid = max(abs(s - k * l) for l, s in curve)
            print(f'  linear-through-origin fit: slip = {k:.2f} deg * |lean|   (max resid {resid:.2f} deg)')

    # ---- speed dependence at high lean ----------------------------------------
    hi = [r for r in stat if abs(r['lean']) > 0.7]
    print(f'\n--- speed dependence at |lean|>0.7 (stationary, n={len(hi)}) ---')
    for lo, up in [(3, 10), (10, 13), (13, 16), (16, 20), (20, 40)]:
        sel = [r for r in hi if lo <= r['speed'] < up]
        if len(sel) < 4:
            continue
        print(f'  {lo:2d}-{up:2d} m/s  n={len(sel):>4}  |slip| median {st.median([abs(r["slip"]) for r in sel]):6.2f} deg')


if __name__ == "__main__":
    main()

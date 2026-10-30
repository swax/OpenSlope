import type { AuthoredAiPath, V3 } from '../../core/doc/types';
import { horizontalDistance, AI_PATH_AUTHORING } from '../../core/doc/ai-paths';
import type { RideTelemetryTick } from './telemetry';

export const AI_RECORDING_DEFAULTS = AI_PATH_AUTHORING;
export type RecordedAiSection = Omit<AuthoredAiPath, 'id' | 'name'>;
type Sample = { pos: V3; arc: number; safe: boolean; charging: boolean; pin: boolean };
type Jump = { start: number; end: number; speed: number };

/** Fixed-tick capture followed by distance sampling, bounded-error detail and safe, overlapping sections. */
export function createAiPathRecording() {
  let samples: Sample[] = [],
    jumps: Jump[] = [],
    chargeStart: number | null = null;
  const completed: RecordedAiSection[] = [];
  let active = false;
  let distance = 0;

  function add(tick: RideTelemetryTick) {
    if (!active) return;
    const state = tick.closing;
    const pos: V3 = [...state.position];
    if (!pos.every(Number.isFinite) || !Number.isFinite(state.speed)) return;
    const previous = samples.at(-1);
    const step = previous ? horizontalDistance(previous.pos, pos) : 0;
    // Respawns/warps are discontinuities, never a connecting line through the world.
    if (previous && Math.hypot(...pos.map((v, i) => v - previous.pos[i])) > Math.max(5, state.speed * tick.dt * 4)) {
      breakPath();
    }
    const last = samples.at(-1);
    if (!last && (!state.grounded || state.railIndex >= 0 || state.charging)) return;
    const arc = last ? last.arc + horizontalDistance(last.pos, pos) : 0;
    const charging = state.charging;
    // Button edges happen between ticks. The opening pose is the release/press location, before this tick moves.
    const edgeArc =
      last && tick.opening.position ? last.arc + horizontalDistance(last.pos, tick.opening.position) : arc;
    const safe = state.grounded && state.railIndex < 0 && !charging;
    const transition = !!last && (last.charging !== charging || last.safe !== safe);
    if (!last && charging) chargeStart = 0;
    if (last && !last.charging && charging) {
      chargeStart = edgeArc;
      last.pin = true;
    }
    if (last?.charging && !charging && chargeStart !== null) {
      jumps.push({ start: chargeStart, end: edgeArc, speed: tick.opening.speed });
      last.pin = true;
      chargeStart = null;
    }
    // Retain stationary charge edges but avoid unbounded idle captures.
    if (last && step < 0.01 && !transition) return;
    samples.push({ pos, arc, safe, charging, pin: transition });
    distance += last ? horizontalDistance(last.pos, pos) : 0;
  }

  function compile() {
    if (samples.length < 2 || samples.at(-1)!.arc < 12) return;
    const total = samples.at(-1)!.arc;
    let begin = 0;
    while (begin < samples.length - 1) {
      const from = samples[begin].arc;
      let end = begin + 1;
      // Stay on the same section until a grounded, uncharged exit after the nominal length.
      while (
        end < samples.length - 1 &&
        (samples[end].arc < from + AI_RECORDING_DEFAULTS.sectionLength || !samples[end].safe)
      )
        end++;
      if (samples[end].arc - from < 12) break;
      const kept = new Set([begin, end]);
      let previous = begin;
      for (let i = begin + 1; i < end; i++) {
        if (samples[i].pin || samples[i].arc - samples[previous].arc >= AI_RECORDING_DEFAULTS.spacing) {
          kept.add(i);
          previous = i;
        }
      }
      // Refine each chord against the capture, including vertical flight arcs and tight turns.
      const refine = (a: number, b: number) => {
        const p = samples[a].pos,
          q = samples[b].pos;
        const d = q.map((v, k) => v - p[k]);
        const den = d.reduce((s, v) => s + v * v, 0);
        let worst = -1;
        let error: number = AI_RECORDING_DEFAULTS.maxError;
        for (let i = a + 1; i < b; i++) {
          const x = samples[i].pos;
          const t = den ? Math.max(0, Math.min(1, d.reduce((s, v, k) => s + v * (x[k] - p[k]), 0) / den)) : 0;
          const e = Math.hypot(...x.map((v, k) => v - p[k] - d[k] * t));
          if (e > error) {
            error = e;
            worst = i;
          }
        }
        if (worst >= 0) {
          kept.add(worst);
          refine(a, worst);
          refine(worst, b);
        }
      };
      const rough = [...kept].sort((a, b) => a - b);
      for (let i = 1; i < rough.length; i++) refine(rough[i - 1], rough[i]);
      const nodes = [...kept].sort((a, b) => a - b);
      const points = nodes.map(i => [...samples[i].pos] as V3);
      const arcs = [0];
      for (let i = 1; i < points.length; i++) arcs.push(arcs[i - 1] + horizontalDistance(points[i - 1], points[i]));
      const station = (raw: number) => {
        for (let i = 1; i < nodes.length; i++) {
          const lo = samples[nodes[i - 1]].arc,
            hi = samples[nodes[i]].arc;
          if (raw <= hi)
            return arcs[i - 1] + (arcs[i] - arcs[i - 1]) * Math.max(0, (raw - lo) / Math.max(1e-9, hi - lo));
        }
        return arcs.at(-1)!;
      };
      const events: AuthoredAiPath['events'] = jumps
        .filter(j => j.start >= from && j.end <= samples[end].arc)
        .map(j => ({
          type: 100,
          value: Math.round(j.speed * 3.6) << 2,
          start: station(j.start),
          end: Math.min(arcs.at(-1)!, station(j.end) + 0.5),
        }));
      completed.push({ points, events, rating: 50, respawnable: true });
      if (end === samples.length - 1) break;
      const overlap = samples[end].arc - AI_RECORDING_DEFAULTS.overlap;
      let next = end;
      while (next > begin + 1 && (samples[next].arc > overlap || !samples[next].safe)) next--;
      // Avoid starting the next route in a jump or making zero progress.
      while (next < end && !samples[next].safe) next++;
      begin = next > begin ? next : end;
      if (total - samples[begin].arc < 12) break;
    }
  }

  function breakPath() {
    // Do not keep an unfinished charge/air tail at a reset or manual stop.
    while (samples.length && !samples.at(-1)!.safe) samples.pop();
    const end = samples.at(-1)?.arc ?? 0;
    jumps = jumps.filter(j => j.end <= end);
    compile();
    samples = [];
    jumps = [];
    chargeStart = null;
  }

  return {
    start() {
      samples = [];
      jumps = [];
      completed.length = 0;
      distance = 0;
      chargeStart = null;
      active = true;
    },
    ingest: add,
    breakPath,
    finish() {
      breakPath();
      active = false;
      return completed.splice(0);
    },
    get active() {
      return active;
    },
    get distance() {
      return distance;
    },
  };
}

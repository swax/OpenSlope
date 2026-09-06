import * as THREE from 'three';

/** A showoff checkpoint in the ridden world's frame. Route-specific copies share `group`. `dtf` is optional
 *  recovered retail data; authored checkpoints are projected from their course-knot position. */
export interface RideCheckpoint {
  pos: THREE.Vector3;
  bonusSeconds: number;
  group?: number;
  dtf?: number;
}

export interface CheckpointAward {
  group: number;
  bonusSeconds: number;
}

export interface CheckpointTracker {
  /** Feed the rider position once per physics tick. Only forward station crossings award time. */
  step(pos: THREE.Vector3): CheckpointAward[];
}

/** Closest horizontal-arc station on the course. Segment selection is 3D to distinguish stacked/folded runs,
 *  while returned progress is horizontal, matching SOP EventStart and the engine's DTF ruler. */
export function nearestCourseStation(course: readonly THREE.Vector3[], pos: THREE.Vector3): number {
  let arc = 0, best = Infinity, station = 0;
  for (let i = 1; i < course.length; i++) {
    const a = course[i - 1], b = course[i];
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len2 = dx * dx + dy * dy + dz * dz;
    const t = len2 > 1e-9 ? THREE.MathUtils.clamp(
      ((pos.x - a.x) * dx + (pos.y - a.y) * dy + (pos.z - a.z) * dz) / len2, 0, 1,
    ) : 0;
    const qx = a.x + dx * t, qy = a.y + dy * t, qz = a.z + dz * t;
    const d = (pos.x - qx) ** 2 + (pos.y - qy) ** 2 + (pos.z - qz) ** 2;
    if (d < best) { best = d; station = arc + Math.hypot(dx, dz) * t; }
    arc += Math.hypot(dx, dz);
  }
  return station;
}

/** The path-event query retail uses, expressed over Slopesmith's recovered/sampled course polyline. Starting
 *  down-course does not retroactively award passed checkpoints; reversing below a station and crossing it
 *  forward again can fire it again, matching an edge-triggered path event. */
export function createCheckpointTracker(course: readonly THREE.Vector3[] | undefined,
  checkpoints: readonly RideCheckpoint[] | undefined): CheckpointTracker | null {
  if (!course || course.length < 2 || !checkpoints?.length) return null;
  let total = 0;
  for (let i = 1; i < course.length; i++) total += Math.hypot(
    course[i].x - course[i - 1].x, course[i].z - course[i - 1].z,
  );

  const grouped = new Map<number, { candidates: Array<{ station: number; pos: THREE.Vector3; bonusSeconds: number }> }>();
  checkpoints.forEach((checkpoint, index) => {
    if (!(checkpoint.bonusSeconds > 0)) return;
    const group = checkpoint.group ?? index;
    const station = checkpoint.dtf !== undefined && Number.isFinite(checkpoint.dtf)
      ? THREE.MathUtils.clamp(total - checkpoint.dtf, 0, total)
      : nearestCourseStation(course, checkpoint.pos);
    const item = grouped.get(group) ?? { candidates: [] };
    item.candidates.push({ station, pos: checkpoint.pos, bonusSeconds: checkpoint.bonusSeconds });
    grouped.set(group, item);
  });
  const events = [...grouped].map(([group, item]) => ({
    group, candidates: item.candidates,
    // Alternate lines represent the same DTF station. Averaging their projections damps small stitching drift.
    station: item.candidates.reduce((sum, candidate) => sum + candidate.station, 0) / item.candidates.length,
  })).sort((a, b) => a.station - b.station);
  let previous: number | null = null;
  return {
    step(pos) {
      const current = nearestCourseStation(course, pos);
      if (previous === null) { previous = current; return []; }
      const before = previous;
      previous = current;
      if (current <= before + 1e-4) return [];
      return events.filter(event => event.station > before + 1e-4 && event.station <= current + 1e-4)
        .map(event => {
          // One logical checkpoint can offer route-dependent values (MEGAPLEX). The active race line is the
          // route nearest the rider at the crossing, so choose that event rather than summing its alternatives.
          let chosen = event.candidates[0], best = chosen.pos.distanceToSquared(pos);
          for (let i = 1; i < event.candidates.length; i++) {
            const distance = event.candidates[i].pos.distanceToSquared(pos);
            if (distance < best) { best = distance; chosen = event.candidates[i]; }
          }
          return { group: event.group, bonusSeconds: chosen.bonusSeconds };
        });
    },
  };
}

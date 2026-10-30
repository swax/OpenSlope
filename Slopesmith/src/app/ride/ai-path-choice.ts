import * as THREE from 'three';

/** Native board-class values, independent of event mode or the avatar's visual riding style. */
export type AiBoardClass = 0 | 1 | 2;

export interface AiChoicePath {
  pts: readonly THREE.Vector3[];
  cum: Float64Array;
  total: number;
  bounds: THREE.Box3;
  rating: number;
  respawnable: boolean;
}

const AHEAD = 8;
const END_MARGIN = 2;
const RATING_WEIGHT = 2.3187357421875;
const SKILL_DIVISOR = 1.1039999723434448;
const CLASS_ZERO_BOOST_FLOOR = 0.10337617248296738;
const OTHER_BOOST_FLOOR = 0.3118690252304077;

/** Maximum axis gap from the full 3-D bounding box ([Trailmap: 395-score]). */
function boxDistance(bounds: THREE.Box3, point: THREE.Vector3): number {
  return Math.max(
    0,
    bounds.min.x - point.x,
    point.x - bounds.max.x,
    bounds.min.y - point.y,
    point.y - bounds.max.y,
    bounds.min.z - point.z,
    point.z - bounds.max.z,
  );
}

/** Form the shortlist BEFORE filtering the incumbent or paths near their ends. Ties keep source order. */
export function aiPathCandidates(paths: readonly AiChoicePath[], query: THREE.Vector3, respawnOnly = false): number[] {
  return paths
    .map((path, index) => ({
      index,
      distance: respawnOnly && !path.respawnable ? Infinity : boxDistance(path.bounds, query),
    }))
    .filter(candidate => Number.isFinite(candidate.distance))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 6)
    .map(candidate => candidate.index);
}

/** Native closest-foot search is horizontal; the selector subsequently scores the real 3-D points. */
export function aiPathProjection(path: AiChoicePath, query: THREE.Vector3): { arc: number; point: THREE.Vector3 } {
  let best = Infinity,
    arc = 0;
  const point = path.pts[0].clone();
  for (let i = 1; i < path.pts.length; i++) {
    const a = path.pts[i - 1],
      b = path.pts[i];
    const dx = b.x - a.x,
      dz = b.z - a.z;
    const squared = dx * dx + dz * dz;
    if (squared < 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((query.x - a.x) * dx + (query.z - a.z) * dz) / squared));
    const distance = (query.x - a.x - t * dx) ** 2 + (query.z - a.z - t * dz) ** 2;
    if (distance < best) {
      best = distance;
      arc = path.cum[i - 1] + t * (path.cum[i] - path.cum[i - 1]);
      point.lerpVectors(a, b, t);
    }
  }
  return { arc, point };
}

function pointAt(path: AiChoicePath, station: number): THREE.Vector3 {
  const s = Math.max(0, Math.min(path.total, station));
  for (let i = 1; i < path.pts.length; i++)
    if (s <= path.cum[i])
      return new THREE.Vector3().lerpVectors(
        path.pts[i - 1],
        path.pts[i],
        (s - path.cum[i - 1]) / Math.max(1e-9, path.cum[i] - path.cum[i - 1]),
      );
  return path.pts.at(-1)!.clone();
}

/** Query ahead in carried velocity, comparing the candidate's foot against the rider's actual position. */
export function chooseAiPath(
  paths: readonly AiChoicePath[],
  position: THREE.Vector3,
  velocity: THREE.Vector3,
  mood: number,
  exclude = -1,
): { path: number; arc: number; score: number } | null {
  // Zero velocity has no direction; keep a finite query at the rider instead of inventing a facing offset.
  const query = velocity.clone().normalize().multiplyScalar(AHEAD).add(position);
  let winner: { path: number; arc: number; score: number } | null = null;
  for (const index of aiPathCandidates(paths, query)) {
    if (index === exclude) continue;
    const path = paths[index],
      foot = aiPathProjection(path, query);
    if (path.total - foot.arc < END_MARGIN) continue;
    const score =
      position.distanceToSquared(foot.point) +
      query.distanceToSquared(pointAt(path, foot.arc + AHEAD)) -
      (100 - Math.abs(path.rating - mood)) * RATING_WEIGHT;
    if (!winner || score < winner.score) winner = { path: index, arc: foot.arc, score };
  }
  return winner;
}

/** Board class, zero-based placement, live meter and inclusive integer skill roll ([Trailmap: 395-mood]). */
export function aiPathMood(
  boardClass: AiBoardClass,
  place: number,
  boostMeter: number,
  skill: number,
  roll: number,
  skillEnabled = true,
): number {
  const meter = Math.fround(boostMeter),
    skillValue = Math.fround(skill);
  let wanted: number;
  if (boardClass === 2) wanted = place === 0 ? 0 : meter < 0 ? 100 : 50;
  else if (boardClass === 0) wanted = meter < CLASS_ZERO_BOOST_FLOOR ? 100 : place === 2 || place === 3 ? 0 : 50;
  else wanted = meter < OTHER_BOOST_FLOOR ? 100 : place === 3 || place === 4 ? 0 : 50;
  const percent = !skillEnabled ? 0 : skillValue === 1 ? 1 : Math.fround(skillValue / SKILL_DIVISOR);
  const threshold = Math.trunc(Math.fround(percent * 100));
  return roll > threshold ? 50 : wanted;
}

import type { SurfaceObject } from './types';

/** Treat invalid authoring metadata as absent while preserving the actual terrain in the file. */
export function normalizeSurfaces(value: unknown): SurfaceObject[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>();
  const point = (p: unknown) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
  const names = (p: unknown) => Array.isArray(p) && p.every(id => typeof id === 'string' && id.length > 0);
  const knotVector = (knots: unknown, count: number) =>
    Array.isArray(knots) &&
    knots.length === count + 4 &&
    knots.every((n, i) => Number.isFinite(n) && (!i || n >= knots[i - 1])) &&
    knots.slice(0, 4).every(n => n === knots[0]) &&
    knots.slice(-4).every(n => n === knots.at(-1)) &&
    knots[3] < knots[count] &&
    knots.slice(4, -4).every(n => n > knots[3] && n < knots[count] && knots.filter(k => k === n).length <= 3);
  const guideHistory = (s: SurfaceObject) => {
    if (
      !Array.isArray(s.guides) ||
      s.guides.length < 1 ||
      s.guides.length !== s.controls.length ||
      s.controls.flat().length > 4096 ||
      (s.interpolation !== undefined && s.interpolation !== 'natural') ||
      s.controls.some(row => !names(row) || row.length < 2 || new Set(row).size !== row.length) ||
      (s.curvature !== undefined && (!Number.isFinite(s.curvature) || s.curvature < 0 || s.curvature > 2))
    )
      return false;
    if (
      s.guides.some(
        (g, i) =>
          !g ||
          !['U', 'V'].includes(g.axis) ||
          !Number.isFinite(g.at) ||
          g.at < 0 ||
          g.at > 1 ||
          !Array.isArray(g.knots) ||
          g.knots.length !== s.controls[i].length ||
          g.knots[0] !== 0 ||
          g.knots.at(-1) !== 1 ||
          g.knots.some((t, j) => !Number.isFinite(t) || (j > 0 && t <= g.knots[j - 1])) ||
          (g.reference !== undefined &&
            (!Array.isArray(g.reference) ||
              g.reference.length !== g.knots.length - 1 ||
              g.reference.some(cp => !Array.isArray(cp) || cp.length !== 4 || cp.some(p => !point(p))))) ||
          s.guides!.some((h, j) => j < i && h.axis === g.axis && Math.abs(h.at - g.at) < 1e-8),
      )
    )
      return false;
    return (
      s.seed === undefined ||
      (Array.isArray(s.seed) &&
        s.seed.length > 0 &&
        s.seed.length <= 4096 &&
        s.seed.every(
          p =>
            p &&
            Array.isArray(p.domain) &&
            p.domain.length === 4 &&
            p.domain.every(t => Number.isFinite(t) && t >= 0 && t <= 1) &&
            p.domain[0] < p.domain[1] &&
            p.domain[2] < p.domain[3] &&
            Array.isArray(p.controls) &&
            p.controls.length === 16 &&
            p.controls.every(point),
        ))
    );
  };
  const result = value.filter((raw): raw is SurfaceObject => {
    if (!raw || typeof raw !== 'object') return false;
    const s = raw as SurfaceObject;
    if (
      typeof s.id !== 'string' ||
      !s.id ||
      ids.has(s.id) ||
      typeof s.name !== 'string' ||
      !['profiles', 'boundary', 'legacy'].includes(s.origin) ||
      !Number.isFinite(s.patchSizeM) ||
      s.patchSizeM < 0.5 ||
      (s.fitToleranceM !== undefined &&
        (!Number.isFinite(s.fitToleranceM) || s.fitToleranceM <= 0 || s.fitToleranceM > s.patchSizeM)) ||
      !Array.isArray(s.controls) ||
      s.controls.length > 1024 ||
      (s.guides
        ? !guideHistory(s)
        : s.controls.length < 4 ||
          s.controls.some(row => !names(row) || row.length < 4 || row.length !== s.controls[0].length) ||
          s.controls.length * s.controls[0].length > 4096 ||
          new Set(s.controls.flat()).size !== s.controls.flat().length ||
          !knotVector(s.knotsU, s.controls[0].length) ||
          !knotVector(s.knotsV, s.controls.length)) ||
      !names(s.vertices) ||
      (s.outputKeys !== undefined && (!names(s.outputKeys) || s.outputKeys.length !== s.vertices.length)) ||
      (s.fitted !== undefined &&
        (!Array.isArray(s.fitted) ||
          !s.fitted.length ||
          s.fitted.length > 16384 ||
          s.fitted.some(
            p =>
              !p ||
              !Array.isArray(p.domain) ||
              p.domain.length !== 4 ||
              p.domain.some(t => !Number.isFinite(t) || t < 0 || t > 1) ||
              p.domain[0] >= p.domain[1] ||
              p.domain[2] >= p.domain[3] ||
              !Array.isArray(p.controls) ||
              p.controls.length !== 16 ||
              p.controls.some(v => !point(v)),
          ))) ||
      (s.stitches !== undefined &&
        (!Array.isArray(s.stitches) ||
          s.stitches.length > 128 ||
          s.stitches.some(
            (st, i) =>
              !st ||
              typeof st.id !== 'string' ||
              !st.id ||
              s.stitches!.some((other, j) => j < i && other.id === st.id) ||
              !['u0', 'u1', 'v0', 'v1'].includes(st.side) ||
              !['smooth', 'crease'].includes(st.continuity) ||
              !Array.isArray(st.range) ||
              st.range.length !== 2 ||
              st.range.some(t => !Number.isFinite(t) || t < 0 || t > 1) ||
              st.range[0] >= st.range[1] ||
              !st.target ||
              ('vertices' in st.target
                ? !names(st.target.vertices) ||
                  st.target.vertices.length < 2 ||
                  st.target.vertices.length > 1024 ||
                  new Set(st.target.vertices).size !== st.target.vertices.length
                : typeof st.target.surface !== 'string' ||
                  !st.target.surface ||
                  !['u0', 'u1', 'v0', 'v1'].includes(st.target.side) ||
                  !Array.isArray(st.target.range) ||
                  st.target.range.length !== 2 ||
                  st.target.range.some(t => !Number.isFinite(t) || t < 0 || t > 1) ||
                  st.target.range[0] === st.target.range[1]),
          ))) ||
      !names(s.inputs) ||
      !s.evaluated ||
      !Number.isFinite(s.evaluated.patchSizeM) ||
      !Array.isArray(s.evaluated.points) ||
      s.evaluated.points.length !== s.controls.length ||
      s.evaluated.points.some(
        (row, i) =>
          !Array.isArray(row) ||
          row.length !== (s.guides ? (s.controls[i].length - 1) * 4 : s.controls[0].length) ||
          row.some(p => !point(p)),
      ) ||
      !Array.isArray(s.patches) ||
      s.patches.some(
        p =>
          !p ||
          typeof p.quad !== 'string' ||
          !names(p.corners) ||
          p.corners.length !== 4 ||
          (p.key !== undefined && (typeof p.key !== 'string' || !p.key)) ||
          (p.uv !== undefined &&
            (!Array.isArray(p.uv) ||
              p.uv.length !== 4 ||
              p.uv.some(
                uv =>
                  !Array.isArray(uv) ||
                  uv.length !== 2 ||
                  uv.some(t => !Number.isFinite(t) || t < -1e-7 || t > 1 + 1e-7),
              ))) ||
          !Array.isArray(p.domain) ||
          p.domain.length !== 4 ||
          !p.domain.every(Number.isFinite) ||
          p.domain[0] >= p.domain[1] ||
          p.domain[2] >= p.domain[3] ||
          !Array.isArray(p.base) ||
          p.base.length !== 16 ||
          p.base.some(v => !point(v)),
      )
    )
      return false;
    ids.add(s.id);
    return true;
  });
  return result.length ? result : undefined;
}

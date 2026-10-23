import type { LoftSurface } from './types';

/** Invalid authoring metadata never prevents opening the ordinary terrain carried in the same file. */
export function normalizeLofts(value: unknown): LoftSurface[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>();
  const point = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  const domain = (v: unknown) =>
    Array.isArray(v) && v.length === 4 && v.every(Number.isFinite) && v[1] > v[0] && v[3] > v[2];
  const result = value.filter((raw): raw is LoftSurface => {
    if (!raw || typeof raw !== 'object') return false;
    const l = raw as LoftSurface;
    if (
      typeof l.id !== 'string' ||
      !l.id ||
      ids.has(l.id) ||
      typeof l.name !== 'string' ||
      !Number.isFinite(l.patchSizeM) ||
      l.patchSizeM < 0.5 ||
      !Number.isFinite(l.curvature) ||
      l.curvature < 0 ||
      l.curvature > 2 ||
      !Array.isArray(l.profiles) ||
      l.profiles.length < 2 ||
      l.profiles.some(p => !Array.isArray(p) || p.length < 2 || p.some(id => typeof id !== 'string')) ||
      !Array.isArray(l.vertices) ||
      l.vertices.some(id => typeof id !== 'string') ||
      !Array.isArray(l.source) ||
      l.source.length !== l.profiles.length ||
      l.source.some(p => !Array.isArray(p) || !p.length || p.length % 4 || p.some(v => !point(v))) ||
      !l.evaluated ||
      !Number.isFinite(l.evaluated.patchSizeM) ||
      !Number.isFinite(l.evaluated.curvature) ||
      (l.detail !== undefined &&
        (!Array.isArray(l.detail) ||
          l.detail.some(
            p =>
              !p ||
              !domain(p.domain) ||
              !Array.isArray(p.controls) ||
              p.controls.length !== 16 ||
              p.controls.some(v => !point(v)),
          ))) ||
      !Array.isArray(l.patches) ||
      l.patches.some(
        p =>
          !p ||
          typeof p.quad !== 'string' ||
          !Array.isArray(p.corners) ||
          p.corners.length !== 4 ||
          p.corners.some(id => typeof id !== 'string') ||
          !domain(p.domain) ||
          !Array.isArray(p.base) ||
          p.base.length !== 16 ||
          p.base.some(v => !point(v)),
      )
    )
      return false;
    ids.add(l.id);
    return true;
  });
  return result.length ? result : undefined;
}

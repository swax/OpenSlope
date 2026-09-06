/**
 * Sky composition is driven by `Skybox/Ring.json`, which Snowknife measures from the user's extracted
 * meshes and texture pages.  This module owns only the coordinate transforms and resampling math.
 */

/** The panorama seam is an authoring coordinate choice: its left edge is azimuth 180° and x grows as
 * azimuth decreases, the same direction as a ring panel's U. */
const PANORAMA_SEAM_AZ = 180;

export interface SkyGeometry {
  radius: number;
  topZ: number;
  midZ: number;
  bottomZ: number;
  groundUvRadius: number;
}

/** A deliberately generic preview shape used before any extracted ring is available. It is not a measured
 * game ring and is never used to cut an ISO export once a target has been selected. */
export const AUTHORING_SKY_GEOMETRY: SkyGeometry = {
  radius: 1,
  topZ: 0.5,
  midZ: 0,
  bottomZ: -0.5,
  groundUvRadius: 0.5,
};

/** Where an azimuth (degrees) falls across a panorama, 0..1 left to right. */
export function panoramaX(azDeg: number): number {
  const x = (((PANORAMA_SEAM_AZ - azDeg) % 360) + 360) % 360;
  return x / 360;
}

/** Where a ring height falls down a panorama, 0 at the open top and 1 at the ground rim. */
export function panoramaY(z: number, geometry: SkyGeometry): number {
  return (geometry.topZ - z) / (geometry.topZ - geometry.bottomZ);
}

/** The natural panorama size for square upper-panel pages on this measured ring. */
export function panoramaSize(upperTile: number, ring: SkyRing): { w: number; h: number } {
  const upperPanels = ring.panels.filter(panel => panel.band === 'upper').length;
  const upperFraction = (ring.topZ - ring.midZ) / (ring.topZ - ring.bottomZ);
  return { w: upperTile * upperPanels, h: Math.round(upperTile / upperFraction) };
}

/** One wall panel: its texture slot and the azimuth span mapped by U=0..1. */
export interface SkyPanel {
  index: number;
  band: 'upper' | 'lower';
  azFrom: number;
  azTo: number;
}

/** A level's measured sky ring and texture slots. */
export interface SkyRing extends SkyGeometry {
  groundIndex: number;
  panels: SkyPanel[];
  tiles: { w: number; h: number }[];
}

/** On-disk `Skybox/Ring.json` shape. */
export interface SkyRingDocument {
  Schema: 'openslope-sky-ring/v1';
  Radius: number;
  TopZ: number;
  MidZ: number;
  BottomZ: number;
  GroundIndex: number;
  GroundUvRadius: number;
  Panels: { Index: number; Band: 'upper' | 'lower'; AzFrom: number; AzTo: number }[];
  Tiles: { Width: number; Height: number }[];
}

/** Validate and normalize generated metadata at the untyped filesystem/API boundary. */
export function skyRingFromDocument(value: unknown): SkyRing | null {
  const d = value as Partial<SkyRingDocument> | null;
  if (!d || d.Schema !== 'openslope-sky-ring/v1'
      || !finitePositive(d.Radius) || !finite(d.TopZ) || !finite(d.MidZ) || !finite(d.BottomZ)
      || !(d.TopZ! > d.MidZ! && d.MidZ! > d.BottomZ!)
      || !Number.isInteger(d.GroundIndex) || d.GroundIndex! < 0 || !finitePositive(d.GroundUvRadius)
      || !Array.isArray(d.Panels) || !d.Panels.length || !Array.isArray(d.Tiles) || !d.Tiles.length
      || d.GroundIndex! >= d.Tiles.length) return null;
  const panels: SkyPanel[] = [];
  const panelSlots = new Set<number>();
  for (const panel of d.Panels) {
    if (!panel || !Number.isInteger(panel.Index) || panel.Index < 0 || panel.Index >= d.Tiles.length
        || panel.Index === d.GroundIndex || panelSlots.has(panel.Index)
        || (panel.Band !== 'upper' && panel.Band !== 'lower')
        || !finite(panel.AzFrom) || !finite(panel.AzTo)) return null;
    panelSlots.add(panel.Index);
    panels.push({ index: panel.Index, band: panel.Band, azFrom: panel.AzFrom, azTo: panel.AzTo });
  }
  const tiles = d.Tiles.map(tile => ({ w: tile?.Width, h: tile?.Height }));
  if (tiles.some(tile => !Number.isInteger(tile.w) || tile.w <= 0 || !Number.isInteger(tile.h) || tile.h <= 0))
    return null;
  if (panels.length !== tiles.length - 1 || !panels.some(panel => panel.band === 'upper')
      || !panels.some(panel => panel.band === 'lower')) return null;
  return {
    radius: d.Radius!, topZ: d.TopZ!, midZ: d.MidZ!, bottomZ: d.BottomZ!,
    groundIndex: d.GroundIndex!, groundUvRadius: d.GroundUvRadius!, panels, tiles,
  };
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const finitePositive = (value: unknown): value is number => finite(value) && value > 0;

/** Fold an angle into (-180, 180]. */
export function wrapAz(deg: number): number {
  let a = ((deg + 180) % 360 + 360) % 360 - 180;
  if (a <= -180) a += 360;
  return a;
}

/** Authored texture budgets. These are editor presets; the selected ring supplies their slot layout. */
export type SkyTier = 'standard' | 'high';
export interface SkyTileSizes { upper: number; lower: number; ground: number }
export const SKY_TIERS: Record<SkyTier, SkyTileSizes> = {
  standard: { upper: 128, lower: 64, ground: 256 },
  high: { upper: 256, lower: 128, ground: 256 },
};

export function tileSizes(tier: SkyTileSizes, ring: SkyRing): { w: number; h: number }[] {
  const sizes = ring.tiles.map(() => ({ w: tier.lower, h: tier.lower }));
  for (const panel of ring.panels) {
    const n = panel.band === 'upper' ? tier.upper : tier.lower;
    sizes[panel.index] = { w: n, h: n };
  }
  sizes[ring.groundIndex] = { w: tier.ground, h: tier.ground };
  return sizes;
}

/** The rect of a panorama (unit coordinates, y down) sampled by one wall panel. */
export interface PanelRect { x0: number; x1: number; y0: number; y1: number }

export function panelRect(p: SkyPanel, ring: SkyRing): PanelRect {
  const x0 = panoramaX(p.azFrom);
  const x1 = panoramaX(p.azTo) || 1;
  const [zTop, zBot] = p.band === 'upper' ? [ring.topZ, ring.midZ] : [ring.midZ, ring.bottomZ];
  return { x0, x1, y0: panoramaY(zTop, ring), y1: panoramaY(zBot, ring) };
}

/** Inverse of the measured ground disc's radial UV projection. */
export function groundTexelDir(u: number, v: number, geometry: SkyGeometry): { az: number; r: number } {
  const dx = u - 0.5, dy = v - 0.5;
  return { az: (Math.atan2(dy, dx) * 180) / Math.PI, r: Math.hypot(dx, dy) / geometry.groundUvRadius };
}

/** Equirectangular source row that meets the ring's open top. */
export function ringTopEquirectV(geometry: SkyGeometry): number {
  return 0.5 - Math.atan2(geometry.topZ, geometry.radius) / Math.PI;
}

/** A drawable piece of the backdrop, independent of Three.js. */
export interface SkyMeshData {
  positions: number[];
  uvs: number[];
  indices: number[];
}

export interface SkyBackdrop {
  wall: SkyMeshData;
  ground: SkyMeshData;
  top: SkyMeshData;
}

function toWorld(azDeg: number, z: number, radius: number, geometry: SkyGeometry): [number, number, number] {
  const scale = radius / geometry.radius;
  const a = (azDeg * Math.PI) / 180;
  return [-geometry.radius * Math.cos(a) * scale, z * scale, geometry.radius * Math.sin(a) * scale];
}

/** Smooth editor backdrop using either a measured ring profile or the generic pre-extraction preview. */
export function skyBackdrop(radius: number, geometry: SkyGeometry = AUTHORING_SKY_GEOMETRY,
  segments = 96): SkyBackdrop {
  const scale = radius / geometry.radius;
  const wall: SkyMeshData = { positions: [], uvs: [], indices: [] };
  for (let i = 0; i <= segments; i++) {
    const az = PANORAMA_SEAM_AZ - (360 * i) / segments;
    const u = i / segments;
    for (const z of [geometry.bottomZ, geometry.midZ, geometry.topZ]) {
      wall.positions.push(...toWorld(az, z, radius, geometry));
      wall.uvs.push(u, 1 - panoramaY(z, geometry));
    }
    if (i > 0) {
      const a = (i - 1) * 3, b = i * 3;
      for (const k of [0, 1]) wall.indices.push(a + k, b + k, b + k + 1, a + k, b + k + 1, a + k + 1);
    }
  }

  const ground: SkyMeshData = { positions: [0, geometry.bottomZ * scale, 0], uvs: [0.5, 0.5], indices: [] };
  const top: SkyMeshData = { positions: [0, geometry.topZ * scale, 0], uvs: [0.5, 0.5], indices: [] };
  for (let i = 0; i <= segments; i++) {
    const az = -180 + (360 * i) / segments;
    const a = (az * Math.PI) / 180;
    ground.positions.push(...toWorld(az, geometry.bottomZ, radius, geometry));
    ground.uvs.push(0.5 + geometry.groundUvRadius * Math.cos(a), 0.5 + geometry.groundUvRadius * Math.sin(a));
    top.positions.push(...toWorld(az, geometry.topZ, radius, geometry));
    top.uvs.push(0.5, 0.5);
    if (i > 0) { ground.indices.push(0, i, i + 1); top.indices.push(0, i + 1, i); }
  }
  return { wall, ground, top };
}

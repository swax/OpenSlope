/**
 * SUN GOD-RAYS — the beams that fan across the view when you look toward the sun
 * ([Trailmap: 400-rendering], the celestial-glare section). This is the data half: OpenSlope's procedural
 * spoke pattern and the independently learned geometry law that turns a sun position into the fan. The drawing half is
 * `app/viewport/scene/god-rays.ts`; the Unity realization of the same law is [Unity: 046-sun-god-rays].
 *
 * The engine rebuilds the glare every frame as a flat triangle fan in SCREEN space, centred on the sun's
 * projected position. Each spoke runs from that centre out to the edge of the screen, the four screen
 * corners are folded in so the polygon stays convex, and the whole thing is composited additively with no
 * depth at all — which is why the beams read as light shining THROUGH the mountain rather than as
 * geometry in it. Slopesmith reproduces that faithfully in a flat browser view; WebXR takes Unity's
 * sky-anchored billboard compromise so the effect has a real stereo direction instead of sticking to the lenses.
 *
 * Imported course settings remain map data. The ray selection itself is generated from an original formula
 * so no arbitrary retail-authored angle/intensity table is shipped.
 */

/** One generated spoke: an angle around the sun, and how bright that ray is. */
export interface GodRaySpoke {
  /** Degrees, counter-clockwise from screen +X. */
  deg: number;
  /** Normalized brightness at the rim. */
  amp: number;
}

/**
 * OpenSlope's ray pattern. A golden-angle phase drives small angular offsets and two independent brightness
 * waves, producing clumps without carrying a hand-authored selection. The offset stays below half a base
 * step, so the array is already in angular order and remains deterministic across runs.
 */
const GODRAY_SPOKE_COUNT = 32;
const GOLDEN_PHASE = Math.PI * (3 - Math.sqrt(5));
export const GODRAY_SPOKES: readonly GodRaySpoke[] = Array.from({ length: GODRAY_SPOKE_COUNT }, (_, i) => ({
  deg: i * (360 / GODRAY_SPOKE_COUNT) + Math.sin(i * GOLDEN_PHASE) * 3.2,
  // Keep the independently generated selection close to the engine table's measured contrast and mean:
  // deep gaps matter as much as bright spokes, or an additive fan becomes an even wash.
  amp: 0.18
    + 0.24 * (1 + Math.sin(i * GOLDEN_PHASE + 0.9))
    + 0.12 * (1 + Math.sin(i * 1.173 + 2.1)),
}));

export const GODRAY_LAW = {
  /**
   * The engine's falloff clamp: a rim vertex's brightness is scaled by `(C − min(d², C)) / C`, where d is
   * its NDC distance from the sun. A screen half-diagonal is √2, so d² tops out at 2 in the corners — the
   * clamp only softens the very longest rays, and a beam that crosses the whole screen to reach a far
   * corner arrives visibly dimmer than one leaving through a near edge.
   */
  falloffClamp: 3,
  /** Metres a sight line travels before the sun counts as clear (docs/049, the occlusion section). */
  sightRange: 600,
  /** Half-angle of the 5-ray sight cone - the sun's apparent size, so a rim over a ridge gives partial credit. */
  sightSpreadDegrees: 3,
  /** How fast the fade eases, per frame. ~0.03 is a graceful half-second swing at 60 fps. */
  fadePerFrame: 0.03,
  /** In stereo the screen-filling console fan becomes a sky-anchored disc, matching the Unity VR treatment. */
  xrReachDegrees: 40,
  /** Fade only the outer sliver of the XR disc so its circular boundary never reads as geometry. */
  xrEdgeStart: 0.72,
  /** Imported world-configuration distances/sizes are centimetres; Slopesmith's scene is metres. */
  worldScale: 0.01,
  /** Untextured GS colours use 128 as unity, then land in an 8-bit display buffer. */
  fanDisplayGain: 128 / 255,
  /** The white 255-valued corona texture nearly doubles a 128-unity GS modulate/additive contribution. */
  coronaDisplayGain: 255 / 128,
} as const;

/**
 * A course's glare settings — the mountain-level values, NOT engine constants. These are map data: an
 * imported course carries what it shipped with (snowknife reads the world-configuration record off the disc
 * into `Maps/<NAME>/World.json`), and an authored mountain carries whatever its author set. Nothing here is
 * hard-coded per course; the procedural spoke pattern above is OpenSlope-authored.
 */
export interface GodRayCourse {
  /** Whether this course has a sun at all. Off is the common case: nine of thirteen shipped courses. */
  enabled: boolean;
  /** Retail `CoreColour`: the uniform tint of the triangle fan, 0–255 per channel. */
  core: readonly [number, number, number];
  /** Per-course multiplier for the screen-space triangle fan ([Trailmap: 400-celestial-params]). */
  fanIntensity: number;
  /** Retail `RimColour`: the soft corona sprite tint, 0–255 per channel. */
  rim: readonly [number, number, number];
  /** Per-course multiplier for the authored-radius corona sprite ([Trailmap: 400-celestial-params]). */
  spriteIntensity: number;
  /**
   * The sun's own azimuth/elevation in degrees. A SEPARATE setting from the course's lighting sun that does
   * not have to agree with it — Mesablanca lights from high up but puts its glare 2.5° off the horizon,
   * which is the whole point of a sun you ride toward. The angle convention matches `sunDirFromElAz`
   * exactly (elevation on the up axis), so these feed it unchanged.
   */
  az: number;
  el: number;
  /** How far along that direction the sun sits, in map units. Short by design — a few hundred metres. */
  distance: number;
  /** World size of the sun's own sprite, in map units. Not the reach of the beams. */
  size: number;
}

/** Project-authored starting point for a new glare: a low amber fan with a subdued brown lens-star. */
export const DEFAULT_GODRAY_COURSE: GodRayCourse = {
  enabled: false,
  core: [255, 184, 92],
  fanIntensity: 0.37,
  rim: [112, 72, 38],
  spriteIntensity: 0.45,
  az: 32,
  el: 8,
  distance: 24000,
  size: 7200,
};

/**
 * Convert a course's native sun placement to the metre-scale presentation shared by desktop and WebXR.
 * A shallow camera pulls the sun under its far plane and shrinks it by the same ratio, preserving its authored
 * angular size. The XR ray disc has its own fixed angular reach; the console's desktop fan still fills the view.
 */
export function godRayPresentation(course: GodRayCourse, cameraFar: number): {
  distance: number;
  sunRadius: number;
  xrRayRadius: number;
} {
  const authoredDistance = Math.max(0.01, course.distance * GODRAY_LAW.worldScale);
  const far = Number.isFinite(cameraFar) && cameraFar > 0 ? cameraFar : authoredDistance / 0.9;
  const distance = Math.min(authoredDistance, far * 0.9);
  const distanceScale = distance / authoredDistance;
  return {
    distance,
    // The builder offsets two camera-plane points by -SizeUnits and +SizeUnits: this field is a radius.
    sunRadius: Math.max(0, course.size * GODRAY_LAW.worldScale) * distanceScale,
    xrRayRadius: distance * Math.tan((GODRAY_LAW.xrReachDegrees * Math.PI) / 180),
  };
}

/** Sanitize editor/document glare values and fill a newly-authored partial value from the authoring defaults. */
export function normalizeGodRayCourse(raw: Partial<GodRayCourse> | null | undefined): GodRayCourse {
  const rgb = (v: unknown, fb: readonly [number, number, number]): [number, number, number] =>
    Array.isArray(v) && v.length >= 3
      ? [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0]
      : [fb[0], fb[1], fb[2]];
  const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
  return {
    enabled: !!raw?.enabled,
    core: rgb(raw?.core, DEFAULT_GODRAY_COURSE.core),
    fanIntensity: Math.max(0, num(raw?.fanIntensity, DEFAULT_GODRAY_COURSE.fanIntensity)),
    rim: rgb(raw?.rim, DEFAULT_GODRAY_COURSE.rim),
    spriteIntensity: Math.max(0, num(raw?.spriteIntensity, DEFAULT_GODRAY_COURSE.spriteIntensity)),
    az: num(raw?.az, DEFAULT_GODRAY_COURSE.az),
    el: num(raw?.el, DEFAULT_GODRAY_COURSE.el),
    distance: num(raw?.distance, DEFAULT_GODRAY_COURSE.distance),
    size: num(raw?.size, DEFAULT_GODRAY_COURSE.size),
  };
}

/**
 * The glare sun's azimuth/elevation → a SCENE-space unit direction toward it.
 *
 * Two conversions, and skipping either is a 180° error. The angles are in the GAME's own frame
 * (`raw = (cos az·cos el, sin az·cos el, sin el)`, third axis up), which reaches editor space through the
 * same rotation every other reference dataset uses — `editorFromRaw`'s `(-x, z, -y)`. Z then flips again
 * because the god-ray layer draws at SCENE root while editor coordinates live under `worldRoot`, which
 * mirrors Z to the game's handedness.
 *
 * Deliberately NOT `sunDirFromElAz`: that measures its azimuth in EDITOR space, so feeding it the game's
 * raw azimuth flips both horizontal axes and puts the sun exactly opposite.
 */
export function sceneDirFromGlareAzEl(azDeg: number, elDeg: number): [number, number, number] {
  const a = (azDeg * Math.PI) / 180;
  const e = (elDeg * Math.PI) / 180;
  const raw: [number, number, number] = [Math.cos(a) * Math.cos(e), Math.sin(a) * Math.cos(e), Math.sin(e)];
  const editor: [number, number, number] = [-raw[0], raw[2], -raw[1]];   // editorFromRaw's rotation
  return [editor[0], editor[1], -editor[2]];                             // …and worldRoot's Z mirror
}

/** One fan vertex in NDC, with the brightness the engine gives it. */
export interface GodRayVertex {
  x: number;
  y: number;
  /** 1 at the centre; at a rim vertex, the spoke's authored intensity times the distance falloff. */
  amp: number;
}

const TAU = Math.PI * 2;

/** Smallest positive t placing `centre + t·dir` on the NDC border, or 0 when the ray never reaches it. */
function borderT(cx: number, cy: number, dx: number, dy: number): number {
  let best = Infinity;
  if (Math.abs(dx) > 1e-9) {
    const t = ((dx > 0 ? 1 : -1) - cx) / dx;
    if (t > 0) best = Math.min(best, t);
  }
  if (Math.abs(dy) > 1e-9) {
    const t = ((dy > 0 ? 1 : -1) - cy) / dy;
    if (t > 0) best = Math.min(best, t);
  }
  return Number.isFinite(best) ? best : 0;
}

/** The authored intensity at an arbitrary angle, linearly interpolated between its two neighbouring spokes. */
export function spokeIntensityAt(rad: number): number {
  const a = ((rad % TAU) + TAU) % TAU;
  const n = GODRAY_SPOKES.length;
  for (let i = 0; i < n; i++) {
    const a0 = (GODRAY_SPOKES[i].deg * Math.PI) / 180;
    const next = GODRAY_SPOKES[(i + 1) % n];
    const a1 = i === n - 1 ? (next.deg * Math.PI) / 180 + TAU : (next.deg * Math.PI) / 180;
    if (a < a0 || a > a1) continue;
    const span = a1 - a0;
    const f = span < 1e-9 ? 0 : (a - a0) / span;
    return GODRAY_SPOKES[i].amp + (next.amp - GODRAY_SPOKES[i].amp) * f;
  }
  // Below the first spoke's angle: the wrap segment from the last spoke round through 0.
  const last = GODRAY_SPOKES[n - 1];
  const a0 = (last.deg * Math.PI) / 180 - TAU;
  const a1 = (GODRAY_SPOKES[0].deg * Math.PI) / 180;
  const f = (a - a0) / (a1 - a0);
  return last.amp + (GODRAY_SPOKES[0].amp - last.amp) * f;
}

/**
 * Build the fan's rim, in angular order, for a sun at `sunNdc`. Returns the border vertices only; the
 * centre is the sun itself, at full amplitude. The four screen corners are spliced in wherever they fall
 * — that is what keeps the polygon convex and gapless right into the corners, and it is why the rim is
 * rebuilt per frame rather than baked: the corner angles move as the sun crosses the view.
 */
export function buildGodRayRim(sunNdc: { x: number; y: number }): GodRayVertex[] {
  const { x: cx, y: cy } = sunNdc;
  const angles: { rad: number; amp: number }[] = GODRAY_SPOKES.map(s => ({
    rad: (s.deg * Math.PI) / 180,
    amp: s.amp,
  }));
  for (const [gx, gy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]] as const) {
    const rad = ((Math.atan2(gy - cy, gx - cx) % TAU) + TAU) % TAU;
    // A corner carries no brightness of its own; it inherits the ramp between its neighbouring spokes.
    angles.push({ rad, amp: spokeIntensityAt(rad) });
  }
  angles.sort((a, b) => a.rad - b.rad);

  const clamp = GODRAY_LAW.falloffClamp;
  return angles.map(({ rad, amp }) => {
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const t = borderT(cx, cy, dx, dy);
    const x = cx + dx * t;
    const y = cy + dy * t;
    const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    return { x, y, amp: amp * ((clamp - Math.min(d2, clamp)) / clamp) };
  });
}

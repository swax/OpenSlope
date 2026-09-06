import * as THREE from 'three';
import type { PlayerGear, PlayerSnowboardStance } from '../../core/session/player-pose';

/**
 * What the rider is standing on: a snowboard, or a pair of skis.
 *
 * Both are built to real numbers here and NEITHER is simulated. The physics under a ride knows about one deck
 * frame — a position, a normal and a nose axis — and never asks what is drawn in it, so skis ride exactly as a
 * snowboard rides, which is the same bargain the VRChat world already struck with the same pair of skis
 * (Unity docs/vrchat/017). What changes with the gear is the model, where the two feet sit over the deck,
 * and how the carve roll reaches the snow.
 *
 * A snowboard is one rigid deck. Its plan is a sidecut — narrowest at the waist, widest at the two contact
 * points, rounding off to a blunt tip — and its base is flat between the contact points and kicks up beyond
 * them. That shape is the reason the drawn deck reads as a snowboard from a chase camera: the tips catch the
 * light, and the edge line under a carve is a curve. The whole thing rolls to the carve, so the rider's feet go
 * over with the edge. Binding and proxy-boot meshes are deliberately omitted: the avatar supplies the visible
 * footwear, and an unobstructed topsheet keeps custom equipment art legible.
 *
 * Skis are the same craft twice, and the difference is not only that there are two of them. A ski is
 * asymmetric fore and aft — a long turned-up shovel, a shorter squarer tail, the foot seat behind centre —
 * and the pair may not roll as a unit. Rolled about the pair's centre a 50° carve would lift the outside ski a
 * hand's width clear of the snow and bury the inside one; a skier edges each ski about its OWN centreline
 * instead, so both stay planted and edge in parallel. `seat` below is where that distinction lives, and it is
 * the only thing about the drawn gear the rest of the ride has to know.
 *
 * The rider standing on all this is `rider.ts`, which is handed the two ankle points and nothing else about
 * what is under them — except which gear it is, because a snowboarder stands ACROSS their deck and a skier
 * stands along their skis, and that is a different body out of the same solver.
 */

/** Defined by the multiplayer pose contract, which has to carry it: everyone in a session sees everyone
 *  else's kit, so the two spellings may not drift apart. */
export type RideGear = PlayerGear;
export const DEFAULT_RIDE_GEAR: RideGear = 'snowboard';

/** Which foot leads on a snowboard. `goofy` preserves Slopesmith's original right-foot-forward body. */
export type SnowboardStance = PlayerSnowboardStance;
export const DEFAULT_SNOWBOARD_STANCE: SnowboardStance = 'goofy';

export function isRideGear(value: unknown): value is RideGear {
  return value === 'snowboard' || value === 'skis';
}

export function isSnowboardStance(value: unknown): value is SnowboardStance {
  return value === 'standard' || value === 'goofy';
}

/** The catalogue the Test panel offers. Fixed and built in — there is nothing on disk to wait for. */
export function rideGearOptions(): ReadonlyArray<{ id: RideGear; label: string }> {
  return [{ id: 'snowboard', label: 'Snowboard' }, { id: 'skis', label: 'Skis' }];
}

export function snowboardStanceOptions(): ReadonlyArray<{ id: SnowboardStance; label: string }> {
  return [{ id: 'standard', label: 'Standard' }, { id: 'goofy', label: 'Goofy' }];
}

/** Account presentation consumed by a board model. URLs are same-origin authenticated image routes. */
export interface EquipmentAppearance {
  snowboardTextureUrl?: string;
  skiTextureUrl?: string;
  edgeColor?: string;
}

/** One labelled image region and the exact normalized plan outline its UVs occupy (image origin: top-left). */
export interface EquipmentTextureRegion {
  label: string;
  points: ReadonlyArray<readonly [number, number]>;
}

/** Boot sole to ankle joint: the last term of both gears' stacks, and the same boot in each case. */
const SOLE_TO_ANKLE = 0.112;

/** An axis-aligned box in deck-local metres. Both gears describe their reachable outline as one of these. */
export interface DeckBox {
  center: THREE.Vector3;
  half: THREE.Vector3;
}

/**
 * The emissive lift a grabbable deck wears. Warm on purpose: everything else in front of a rider reaching for
 * their board is blue-white snow and a cyan topsheet, so an amber glow is the one hue that cannot be mistaken
 * for a highlight the terrain put there.
 */
const GRAB_GLOW = 0x7a5410;

/** One switch over every material a gear model owns, so a highlight costs nothing while it is off. */
function highlightSwitch(materials: readonly THREE.MeshLambertMaterial[]) {
  let on = false;
  return (next: boolean) => {
    if (next === on) return;
    on = next;
    for (const material of materials) material.emissive.setHex(next ? GRAB_GLOW : 0x000000);
  };
}

// ---- the snowboard (board-local: +Z nose, +Y deck up, +X the toe edge) ----
// A 186 cm deck: 35.0 cm waist, 41.72 cm at the contact points, 1.44 m of effective edge, and a
// 7 cm kick at each tip. Thickness is the core, not the profile — 14 mm reads right and hides no contact.
const BOARD_LEN = 1.86, BOARD_HALF = BOARD_LEN / 2;
const WAIST_HALF = 0.175, TIP_HALF = 0.2086, BOARD_THICK = 0.014;
const CONTACT_HALF = 0.72;   // half the effective edge: where the sidecut ends and the tip round begins
const FLAT_HALF = 0.60;      // where the base stops being flat and the kick starts
const TIP_RISE = 0.072;
const TIP_BLUNT = 0.0182;    // the tips are rounded, never knife-edged
const STANCE_HALF = 0.27;    // 54 cm stance
/** Snowboard foot angles about the deck up. The rider reads them too: an open stance turns the pelvis with it. */
export const BINDING_ANGLE_FRONT = 15, BINDING_ANGLE_REAR = -3;
/** Preserve the established avatar fit while the former 18 mm binding stand is no longer rendered. */
const FOOT_CLEARANCE = 0.018;
const BOARD_STATIONS = 56;

/**
 * Both gears put the rider's ankle joint exactly this far above the base that touches the snow, and they get
 * there the same way: the deck's own core, a small invisible stance clearance, then the avatar foot below the
 * ankle. The clearance preserves the established character fit even though the old binding/boot proxies are
 * no longer rendered.
 * Keeping the two identical is deliberate — every generated and imported character is modelled to this height
 * (`tools/character-models/figure.ts`), so switching gear mid-run cannot leave a body hovering or sunk. The
 * ski uses the same seat height, which is what makes that hold.
 */
export const ANKLE_ABOVE_BASE = BOARD_THICK + FOOT_CLEARANCE + SOLE_TO_ANKLE;

// ---- the skis (ski-local: +Z nose, +Y top, origin at the boot centre) ----
// A 204 cm ski: 129 mm underfoot, a 186 mm shovel, a 162 mm tail, and 13 mm of core under the
// foot tapering to almost nothing at the tips. The foot is mounted 8.4 cm BEHIND the ski's midpoint, which is
// where an all-mountain ski is mounted and why the tip runs so much further out in front than the tail does
// behind — a ski seen from a chase camera is mostly shovel.
const SKI_AHEAD = 1.104, SKI_BEHIND = 0.936;    // 2.04 m in total, split about the foot
const SKI_WAIST_HALF = 0.0645, SHOVEL_HALF = 0.093, SKI_TAIL_HALF = 0.081;
const SHOVEL_Z = 0.816, SKI_TAIL_Z = 0.696;     // where the sidecut reaches its widest, each way
const SKI_TIP_BLUNT = 0.0165, SKI_TAIL_BLUNT = 0.045; // a shovel rounds off; a tail stays square
const SKI_FLAT_AHEAD = 0.72, SKI_FLAT_BEHIND = 0.696; // where the base stops being flat
const SKI_TIP_RISE = 0.062, SKI_TAIL_RISE = 0.016;   // early rise at the shovel, a token kick at the tail
const SKI_THICK_WAIST = 0.013, SKI_THICK_TIP = 0.005;
const SKI_STATIONS = 44;
/**
 * Half the distance between the two skis' centrelines — a 21 cm stance, which is a natural hip-width one and
 * the same half-span the on-foot walker stands at, so getting off a pair of skis moves nothing sideways.
 */
const SKI_SPAN_HALF = 0.105;
/** Half-width of the snowboard's plan outline at `a` = |z|: a sidecut out to the contact points, then an
 *  elliptical tip. */
function halfWidth(a: number): number {
  if (a <= CONTACT_HALF) {
    const t = a / CONTACT_HALF;
    return WAIST_HALF + (TIP_HALF - WAIST_HALF) * t * t;
  }
  const t = (a - CONTACT_HALF) / (BOARD_HALF - CONTACT_HALF);
  return Math.max(TIP_BLUNT, TIP_HALF * Math.sqrt(Math.max(0, 1 - t * t)));
}

/** Height of the snowboard's base at `a` = |z|: flat underfoot, kicking up past the contact points. */
function baseY(a: number): number {
  if (a <= FLAT_HALF) return 0;
  const t = (a - FLAT_HALF) / (BOARD_HALF - FLAT_HALF);
  return TIP_RISE * t * t;
}

/** Half-width of one ski at `z` — measured from the BOOT, so the two sides of the sidecut are different
 *  lengths and different widths, which is most of what makes a ski read as a ski rather than a narrow board. */
function skiHalfWidth(z: number): number {
  if (z >= 0) {
    if (z <= SHOVEL_Z) {
      const t = z / SHOVEL_Z;
      return SKI_WAIST_HALF + (SHOVEL_HALF - SKI_WAIST_HALF) * t * t;
    }
    const t = (z - SHOVEL_Z) / (SKI_AHEAD - SHOVEL_Z);
    return Math.max(SKI_TIP_BLUNT, SHOVEL_HALF * Math.sqrt(Math.max(0, 1 - t * t)));
  }
  const a = -z;
  if (a <= SKI_TAIL_Z) {
    const t = a / SKI_TAIL_Z;
    return SKI_WAIST_HALF + (SKI_TAIL_HALF - SKI_WAIST_HALF) * t * t;
  }
  const t = (a - SKI_TAIL_Z) / (SKI_BEHIND - SKI_TAIL_Z);
  return Math.max(SKI_TAIL_BLUNT, SKI_TAIL_HALF * (1 - 0.5 * t * t));
}

/** Height of one ski's base at `z`: flat through the running length, a long early rise at the shovel and a
 *  token kick at the tail. */
function skiBaseY(z: number): number {
  if (z > SKI_FLAT_AHEAD) {
    const t = (z - SKI_FLAT_AHEAD) / (SKI_AHEAD - SKI_FLAT_AHEAD);
    return SKI_TIP_RISE * t * t;
  }
  if (z < -SKI_FLAT_BEHIND) {
    const t = (-z - SKI_FLAT_BEHIND) / (SKI_BEHIND - SKI_FLAT_BEHIND);
    return SKI_TAIL_RISE * t * t;
  }
  return 0;
}

/** Core thickness of one ski at `z`: thickest under the boot, almost nothing at either tip. */
function skiThickness(z: number): number {
  const t = Math.min(1, Math.abs(z) / (z >= 0 ? SKI_AHEAD : SKI_BEHIND));
  return SKI_THICK_WAIST + (SKI_THICK_TIP - SKI_THICK_WAIST) * t * t;
}

/** The account editor's overlay is generated from the same sidecut functions and extents as these meshes. */
export function equipmentTextureRegions(gear: RideGear): EquipmentTextureRegion[] {
  const regions = gear === 'snowboard'
    ? [{ label: 'TOP', offset: 0, width: 0.5 }, { label: 'BOTTOM', offset: 0.5, width: 0.5 }]
    : [
      { label: 'L FRONT', offset: 0, width: 0.25 }, { label: 'R FRONT', offset: 0.25, width: 0.25 },
      { label: 'L BACK', offset: 0.5, width: 0.25 }, { label: 'R BACK', offset: 0.75, width: 0.25 },
    ];
  const stations = gear === 'snowboard' ? BOARD_STATIONS : SKI_STATIONS;
  const zMin = gear === 'snowboard' ? -BOARD_HALF : -SKI_BEHIND;
  const zMax = gear === 'snowboard' ? BOARD_HALF : SKI_AHEAD;
  const maxHalf = gear === 'snowboard' ? TIP_HALF : SHOVEL_HALF;
  const halfAt = (z: number) => gear === 'snowboard' ? halfWidth(Math.abs(z)) : skiHalfWidth(z);
  return regions.map(region => {
    const side = (sign: -1 | 1) => Array.from({ length: stations }, (_, i) => {
      // Walk nose to tail on one side and tail to nose on the other to make one closed, non-crossing polygon.
      const t = sign === 1 ? 1 - i / (stations - 1) : i / (stations - 1);
      const z = zMin + (zMax - zMin) * t;
      const u = region.offset + region.width * (0.5 + sign * halfAt(z) / (2 * maxHalf));
      const y = 1 - (z - zMin) / (zMax - zMin);
      return [u, y] as const;
    });
    return { label: region.label, points: [...side(1), ...side(-1)] };
  });
}

type Ring = readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];

/** One station's four corners: base-left, base-right, top-right, top-left. */
function ring(z: number, half: number, y: number, thick: number): Ring {
  return [
    new THREE.Vector3(-half, y, z), new THREE.Vector3(half, y, z),
    new THREE.Vector3(half, y + thick, z), new THREE.Vector3(-half, y + thick, z),
  ];
}

/**
 * Sweep a solid from a stack of four-corner rings running tail to nose, quads between them, flat-shaded —
 * a deck's facets ARE how a tip catches the light, so nothing here is smoothed.
 *
 * Three draw groups come out: 0 is the base, 1 the topsheet, and 2 the untextured sidewalls/end caps. UVs on
 * the first two are normalized across the gear's full plan bounds; per-material texture transforms below put
 * that plan into the board's two halves or the skis' four strips.
 */
function sweptDeck(rings: readonly Ring[], maxHalf: number): THREE.BufferGeometry {
  const base: number[] = [], top: number[] = [], edge: number[] = [];
  const zMin = rings[0][0].z, zMax = rings[rings.length - 1][0].z;
  const quad = (out: number[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
    out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
  };
  for (let i = 0; i < rings.length - 1; i++) {
    const [al, ar] = rings[i], [bl, br] = rings[i + 1];
    quad(base, al, bl, br, ar);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    const [abl, abr, atr, atl] = rings[i], [bbl, bbr, btr, btl] = rings[i + 1];
    quad(top, atl, atr, btr, btl);
    quad(edge, abr, bbr, btr, atr);   // toe wall
    quad(edge, abl, atl, btl, bbl);   // heel wall
  }
  for (const cap of [rings[0], rings[rings.length - 1]]) quad(edge, cap[0], cap[1], cap[2], cap[3]);

  const geo = new THREE.BufferGeometry();
  const positions = base.concat(top, edge);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const uv: number[] = [];
  for (let at = 0; at < positions.length; at += 3) {
    if (at < base.length + top.length) {
      uv.push(0.5 + positions[at] / (2 * maxHalf), (positions[at + 2] - zMin) / (zMax - zMin));
    } else uv.push(0, 0);
  }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.addGroup(0, base.length / 3, 0);
  geo.addGroup(base.length / 3, top.length / 3, 1);
  geo.addGroup((base.length + top.length) / 3, edge.length / 3, 2);
  geo.computeVertexNormals();
  return geo;
}

function deckGeometry(): THREE.BufferGeometry {
  return sweptDeck(Array.from({ length: BOARD_STATIONS }, (_, i) => {
    const z = -BOARD_HALF + BOARD_LEN * (i / (BOARD_STATIONS - 1));
    return ring(z, halfWidth(Math.abs(z)), baseY(Math.abs(z)), BOARD_THICK);
  }), TIP_HALF);
}

function skiGeometry(): THREE.BufferGeometry {
  return sweptDeck(Array.from({ length: SKI_STATIONS }, (_, i) => {
    const z = -SKI_BEHIND + (SKI_AHEAD + SKI_BEHIND) * (i / (SKI_STATIONS - 1));
    return ring(z, skiHalfWidth(z), skiBaseY(z), skiThickness(z));
  }), SHOVEL_HALF);
}

export interface BoardModel {
  /** Which kit this is. The rider reads it: a snowboarder stands across their deck, a skier along their skis. */
  gear: RideGear;
  /** The drawn deck, seated in world space by `seat`. */
  group: THREE.Group;
  /** Where the rider's shins meet the boots, in deck-local metres with the deck flat. */
  ankleFront: THREE.Vector3;
  ankleRear: THREE.Vector3;
  /**
   * The whole kit as ONE box in deck-local metres — what a VR hand reaches toward and takes hold of
   * (`board-grab.ts`). Not a collider and nothing is simulated against it: it answers "is my hand near the
   * deck" and "which point of the deck is my hand nearest to", and both questions want the outline a person
   * sees rather than the sidecut curve or the gap between two skis. Its existing height reaches to the ankle
   * plane so removing the binding visuals does not make a board lying on the snow harder to grab.
   */
  grabBox: DeckBox;
  /**
   * Light the deck up while a hand is close enough to take it — the affordance that makes a grab in a headset
   * something you aim rather than guess at. Each model owns its own materials, so this tints one deck and
   * never every deck on the mountain.
   */
  highlight(on: boolean): void;
  /**
   * Seat the drawn deck for this frame and write the two world-space ankle points the rider is bolted to.
   *
   * `flat` is the deck's facing basis — nose down-course, deck up, plus any flip — and `rolled` is that same
   * basis carrying the carve roll about the nose axis. A snowboard simply takes `rolled`: it is one rigid deck
   * and its feet go over with its edge. A pair of skis takes `flat` on the pair and gives the roll to each
   * ski's own centreline pivot instead, so the two edge in parallel and both stay on the snow.
   *
   * Either way the ankle splits the same two ways — a lift that rides the ROLLED frame, because a boot goes
   * over with the edge under it, and a span that rides the FLAT one. On a snowboard the span runs along the
   * nose axis, which the roll leaves fixed, so the split says nothing new; on skis it is the whole difference.
   */
  seat(position: THREE.Vector3, flat: THREE.Quaternion, rolled: THREE.Quaternion,
       ankleFrontOut: THREE.Vector3, ankleRearOut: THREE.Vector3): void;
  /** Replace the account-owned art/edge colour in place; live physics and pose remain untouched. */
  setAppearance(appearance?: EquipmentAppearance): void;
  dispose(): void;
}

interface TextureSlot {
  material: THREE.MeshLambertMaterial;
  offset: number;
  width: number;
  defaultColor: number;
}

/** Owns one model's asynchronously loaded account texture and all per-region GPU clones of it. */
function createGearSkin(gear: RideGear, slots: readonly TextureSlot[], edge: THREE.MeshLambertMaterial,
                        defaultEdge: number) {
  let generation = 0;
  const clearMaps = () => {
    const maps = new Set<THREE.Texture>();
    for (const slot of slots) {
      if (slot.material.map) maps.add(slot.material.map);
      slot.material.map = null;
      slot.material.color.setHex(slot.defaultColor);
      slot.material.needsUpdate = true;
    }
    maps.forEach(map => map.dispose());
  };
  const setAppearance = (appearance: EquipmentAppearance = {}) => {
    const thisGeneration = ++generation;
    clearMaps();
    edge.color.set(appearance.edgeColor && /^#[0-9a-f]{6}$/i.test(appearance.edgeColor)
      ? appearance.edgeColor : defaultEdge);
    const url = gear === 'snowboard' ? appearance.snowboardTextureUrl : appearance.skiTextureUrl;
    if (!url) return;
    new THREE.TextureLoader().load(url, source => {
      if (thisGeneration !== generation) { source.dispose(); return; }
      source.colorSpace = THREE.SRGBColorSpace;
      source.wrapS = source.wrapT = THREE.ClampToEdgeWrapping;
      slots.forEach((slot, index) => {
        const texture = index === 0 ? source : source.clone();
        texture.offset.set(slot.offset, 0);
        texture.repeat.set(slot.width, 1);
        texture.needsUpdate = true;
        slot.material.map = texture;
        slot.material.color.setHex(0xffffff);
        slot.material.needsUpdate = true;
      });
    });
  };
  return {
    setAppearance,
    dispose: () => {
      generation++;
      clearMaps();
      for (const slot of slots) slot.material.dispose();
      edge.dispose();
    },
  };
}

export function createBoard(gear: RideGear = DEFAULT_RIDE_GEAR,
                            stance: SnowboardStance = DEFAULT_SNOWBOARD_STANCE,
                            appearance?: EquipmentAppearance): BoardModel {
  return gear === 'skis' ? createSkis(appearance) : createSnowboard(stance, appearance);
}

function createSnowboard(stance: SnowboardStance, appearance?: EquipmentAppearance): BoardModel {
  const group = new THREE.Group();
  const mats = [
    new THREE.MeshLambertMaterial({ color: 0xe4ecf4, side: THREE.DoubleSide }), // base
    new THREE.MeshLambertMaterial({ color: 0x18d0e0, side: THREE.DoubleSide }), // topsheet
    new THREE.MeshLambertMaterial({ color: 0x18d0e0, side: THREE.DoubleSide }), // sidewalls + ends
  ];
  const skin = createGearSkin('snowboard', [
    { material: mats[0], offset: 0.5, width: 0.5, defaultColor: 0xe4ecf4 },
    { material: mats[1], offset: 0, width: 0.5, defaultColor: 0x18d0e0 },
  ], mats[2], 0x18d0e0);
  skin.setAppearance(appearance);
  group.add(new THREE.Mesh(deckGeometry(), mats));
  // Standard/goofy changes which anatomical foot owns each invisible stance seat. Foot yaw is applied by the
  // rider/character rig; the gear model contains only the deck so neither avatar feet nor topsheet art is hidden.
  const frontZ = stance === 'standard' ? -STANCE_HALF : STANCE_HALF;
  const rearZ = -frontZ;

  return {
    gear: 'snowboard',
    group,
    ankleFront: new THREE.Vector3(0, ANKLE_ABOVE_BASE, frontZ),
    ankleRear: new THREE.Vector3(0, ANKLE_ABOVE_BASE, rearZ),
    // The plan outline at its widest and full length, with the legacy reach height retained for easy VR grabs.
    grabBox: {
      center: new THREE.Vector3(0, ANKLE_ABOVE_BASE / 2, 0),
      half: new THREE.Vector3(TIP_HALF, ANKLE_ABOVE_BASE / 2, BOARD_HALF),
    },
    highlight: highlightSwitch(mats),
    seat: (position, flat, rolled, ankleFrontOut, ankleRearOut) => {
      group.position.copy(position);
      group.quaternion.copy(rolled);
      seatAnkle(ankleFrontOut, position, flat, rolled, 0, frontZ);
      seatAnkle(ankleRearOut, position, flat, rolled, 0, rearZ);
    },
    setAppearance: skin.setAppearance,
    dispose: () => { skin.dispose(); disposeTree(group); },
  };
}

function createSkis(appearance?: EquipmentAppearance): BoardModel {
  const group = new THREE.Group();
  const edge = new THREE.MeshLambertMaterial({ color: 0xf0563a, side: THREE.DoubleSide });
  const surface = (color: number) => new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
  const leftBase = surface(0xe4ecf4), leftTop = surface(0xf0563a);
  const rightBase = surface(0xe4ecf4), rightTop = surface(0xf0563a);
  const leftMats = [leftBase, leftTop, edge], rightMats = [rightBase, rightTop, edge];
  const skin = createGearSkin('skis', [
    { material: leftBase, offset: 0.5, width: 0.25, defaultColor: 0xe4ecf4 },
    { material: leftTop, offset: 0, width: 0.25, defaultColor: 0xf0563a },
    { material: rightBase, offset: 0.75, width: 0.25, defaultColor: 0xe4ecf4 },
    { material: rightTop, offset: 0.25, width: 0.25, defaultColor: 0xf0563a },
  ], edge, 0xf0563a);
  skin.setAppearance(appearance);
  // The two skis are the same shape — a ski is symmetric about its own centreline, so there is no left and no
  // right — and both wear the same materials, so a pair costs one geometry and one tint.
  const geo = skiGeometry();
  /** Each ski hangs under its own roll pivot, placed on that ski's centreline. `seat` turns these. */
  const pivots = [SKI_SPAN_HALF, -SKI_SPAN_HALF].map((x, index) => {
    const pivot = new THREE.Group();
    pivot.position.x = x;
    pivot.add(new THREE.Mesh(geo, index === 0 ? rightMats : leftMats));
    group.add(pivot);
    return pivot;
  });

  // `ankleFront` is the rider's anatomical LEFT and `ankleRear` their right: front/rear means nose/tail on a
  // board and left/right whenever the feet are side by side, which is the convention `rider.ts` already walks
  // on foot. Putting the left foot on the −X ski is what makes the solver's own toe axis come out facing down
  // the fall line instead of across it.
  const localRoll = new THREE.Quaternion();
  return {
    gear: 'skis',
    group,
    // Both skis as one outline — a hand reaching for a pair lying on the snow is reaching for the pair. The
    // foot seat sits behind centre on a ski, so the box is offset forward by half the fore/aft difference.
    grabBox: {
      center: new THREE.Vector3(0, ANKLE_ABOVE_BASE / 2, (SKI_AHEAD - SKI_BEHIND) / 2),
      half: new THREE.Vector3(SKI_SPAN_HALF + SHOVEL_HALF, ANKLE_ABOVE_BASE / 2,
        (SKI_AHEAD + SKI_BEHIND) / 2),
    },
    highlight: highlightSwitch([leftBase, leftTop, rightBase, rightTop, edge]),
    ankleFront: new THREE.Vector3(-SKI_SPAN_HALF, ANKLE_ABOVE_BASE, 0),
    ankleRear: new THREE.Vector3(SKI_SPAN_HALF, ANKLE_ABOVE_BASE, 0),
    seat: (position, flat, rolled, ankleFrontOut, ankleRearOut) => {
      group.position.copy(position);
      group.quaternion.copy(flat);
      // The pair carries facing; the roll between the two frames is what each ski takes about its own +Z.
      localRoll.copy(flat).invert().multiply(rolled);
      for (const pivot of pivots) pivot.quaternion.copy(localRoll);
      seatAnkle(ankleFrontOut, position, flat, rolled, -SKI_SPAN_HALF, 0);
      seatAnkle(ankleRearOut, position, flat, rolled, SKI_SPAN_HALF, 0);
    },
    setAppearance: skin.setAppearance,
    dispose: () => { skin.dispose(); disposeTree(group); },
  };
}

/** `position + rolled·(0, ankle, 0) + flat·(x, 0, z)` — the split `seat` documents, without allocating. */
function seatAnkle(out: THREE.Vector3, position: THREE.Vector3, flat: THREE.Quaternion,
                   rolled: THREE.Quaternion, x: number, z: number) {
  out.set(0, ANKLE_ABOVE_BASE, 0).applyQuaternion(rolled).add(position);
  out.add(_span.set(x, 0, z).applyQuaternion(flat));
}

function disposeTree(root: THREE.Object3D) {
  const geos = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>();
  root.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    geos.add(o.geometry);
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m);
  });
  geos.forEach(g => g.dispose());
  mats.forEach(m => m.dispose());
}

// scratch — seating runs every frame, for every rider on the mountain, and allocates nothing
const _span = new THREE.Vector3();

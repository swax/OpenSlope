import type { BoardSoundMix } from '../doc/types';

/** The board-ride sound contract: which shared `zboard` bank slot the board is riding right now.
 *
 * The continuous sound of a board on snow is not one-shots but a **matrix** in the level-independent Board
 * bank — a row per surface FAMILY, and within it a mode slot (carve, glide, air-glide) at `family·8 + mode`
 * [Trailmap: 190-audio-data, 420-audio-runtime]. The retail runtime picks the family from the SurfaceType
 * under the board (`SnowAudio_SurfaceTypeToGroup`), then performs the loop continuously from the live ride
 * signals — slip, dig, lean — writing a volume and a pitch bend onto the node every tick.
 *
 * This module owns everything that is pure data: the family map, the slot arithmetic, and OpenSlope's
 * project-authored volume/pitch response (`boardBedFrame` below). The retail signal and bank interfaces are
 * interoperability facts; the response curve is deliberately original. See Slopesmith docs/034-board-sound.md. */

/** The ten surface families, in bank-row order — the index is the `family` in `family·8 + mode`. */
export const BOARD_AUDIO_GROUPS = [
  'PACK', 'POWDER', 'LOOSE', 'ICE', 'METAL', 'WOOD', 'RAIL', 'ROCK', 'GLASS', 'CHUTE',
] as const;

export type BoardAudioGroup = typeof BOARD_AUDIO_GROUPS[number];

/** Disc-global sidecar written under Maps/Shared/Audio by `snowknife shared` (or board-sound-index). */
export interface BoardSoundIndex {
  Schema: 'openslope-board-sound-index/v1';
  SourceExecutable: string;
  SurfaceGroups: number[];
}

/** The RAIL family. The terrain mapper never returns it — retail selects the grind loop through a
 *  rail-specific path that is not traced [Trailmap: 420-audio-runtime] — so the grind layer reaches for it
 *  directly whenever the board is locked to a rail. */
export const BOARD_RAIL_GROUP = 6;

/** Which family the board is riding. Missing/unusable local metadata and unknown surfaces safely ride PACK. */
export function boardAudioGroup(surfaceType: number, surfaceGroups?: readonly number[] | null): number {
  const type = Math.trunc(surfaceType);
  const group = type >= 0 && surfaceGroups && type < surfaceGroups.length ? surfaceGroups[type] : 0;
  return Number.isInteger(group) && group >= 0 && group < BOARD_AUDIO_GROUPS.length ? group : 0;
}

/** The edge-bite loop (mode +3). */
export const boardCarveSlot = (group: number): number => group * 8 + 3;
/** The slide loop (mode +4). */
export const boardGlideSlot = (group: number): number => group * 8 + 4;
/** The simplified glide variant retail selects for riders without the primary flag (mode +6). Unused here —
 *  the test ride has exactly one board and it is the player's. */
export const boardAirGlideSlot = (group: number): number => group * 8 + 6;

/** Families sharing one broad material character. This keeps the decoded bank grouping while the response
 *  within each group is OpenSlope-authored rather than a copy of a retail configuration program. */
const HARD_BLOCK = new Set([0, 3, 4, 7, 9]);   // PACK, ICE, METAL, ROCK, CHUTE
const SOFT_BLOCK = new Set([1, 2]);            // POWDER, LOOSE

/** One tick of the board-bed performance, everything normalized to 0..1. */
export interface BoardBedFrame { glideVol: number; glideBend: number; carveVol: number; carveBend: number }

const bound = (value: number, lo: number, hi: number): number => value < lo ? lo : value > hi ? hi : value;
const smooth01 = (value: number): number => {
  const v = bound(value, 0, 1);
  return v * v * (3 - 2 * v);
};

/**
 * OpenSlope's board-bed curve over the independently measured interface signals. It intentionally does not
 * reproduce the retail SNOW.INF instruction sequence. Speed opens the bed smoothly; the stronger of lean
 * and lateral skid hands energy from glide to carve; material families only change that broad balance.
 *
 * `slip` is lateral speed in engine cm/s, `lean` is the engine's 0..127 absolute lean scale, and `speed01`
 * is the ride's normalized glide-speed band.
 */
export function boardBedFrame(group: number, slip: number, lean: number, speed01: number): BoardBedFrame {
  const motion = smooth01(speed01);
  const skid = bound(slip / 300, 0, 1);
  const tilt = bound(lean / 100, 0, 1);
  const handoff = smooth01(Math.max(skid, tilt));
  let glideVol: number, carveVol: number;
  if (HARD_BLOCK.has(group)) {
    glideVol = motion * (1 - handoff);
    carveVol = motion * handoff;
  } else if (SOFT_BLOCK.has(group)) {
    glideVol = motion * (0.35 + 0.65 * (1 - handoff));
    carveVol = motion * handoff * 0.7;
  } else {                                     // WOOD / RAIL / GLASS: emphasize audible lateral texture
    const texture = 0.3 + 0.7 * skid;
    glideVol = motion * texture * (1 - 0.5 * handoff);
    carveVol = motion * texture * (0.15 + 0.85 * handoff);
  }
  return {
    glideVol: bound(glideVol, 0, 1),
    glideBend: bound(0.7 * skid + 0.1 * tilt, 0, 1),
    carveVol: bound(carveVol, 0, 1),
    carveBend: bound(0.35 * skid + 0.2 * tilt, 0, 1),
  };
}

/** How far a full project-authored pitch response takes a loop's playback rate. */
export const BOARD_BEND_SPAN = 0.5;

/** The primary rider's traced BOARD-family transients: +2 on air-state entry, +1 on snow contact. (+5 is the
 * alternate/non-primary landing variant.) PACK is family zero, so these are slots 2 and 1 respectively. */
export const BOARD_OLLIE_SLOT = 2;
export const BOARD_LAND_SLOT = 1;

/** ---- Game-event cues: the MAIN bank (`zbxsfx`, sound group 0) ------------------------------------------
 *
 *  Gem chimes and boost/trick pads are NOT sounds in the effect graph. The graph node applies the gameplay —
 *  MainType 14 score multiplier, 17 speed pad, 18 trick pad — and engine code on that same apply path plays a
 *  fixed MAIN-bank slot, gated to the local human rider, bypassing the prop-collision event-id resolver
 *  entirely [Trailmap: 390-pickups-and-race "Scoring sounds", 420-audio-runtime]. So they are the rider's own
 *  feedback rather than anything the level authored, which is why they live here beside the board bed and not
 *  in the effects runtime's positional one-shots. */

/** MainType 17, the speed pad. */
export const SPEED_PAD_SLOT = 115;
/** MainType 18, the trick pad. */
export const TRICK_PAD_SLOT = 114;

/** The per-tier gem chime: 116, +1 from ×3, +2 from ×5 — the engine's own thresholds on the multiplier
 *  value, not on a tier index, so an authored ×4 gem chimes like a ×3. */
export function gemChimeSlot(multiplier: number): number {
  return 116 + (multiplier >= 5 ? 2 : multiplier >= 3 ? 1 : 0);
}

/** The held-boost roar, at the three meter tiers 120/121/122; the test ride runs no boost meter, so it always
 *  plays the full-meter clip the way a pinned meter would [Trailmap: 420-audio-runtime]. */
export const BOARD_BOOST_SLOT = 120;

/** Focused-rider big-air wind. Retail starts this MAIN-bank loop only when the landing predictor says the
 * current flight will exceed 1.5 seconds; it is neither a map bed nor weather audio. */
export const BIG_AIR_WIND_SLOT = 32;
export const BIG_AIR_MIN_PREDICTED_SECONDS = 1.5;
export function bigAirWindActive(predictedAirSeconds: number): boolean {
  return Number.isFinite(predictedAirSeconds) && predictedAirSeconds > BIG_AIR_MIN_PREDICTED_SECONDS;
}

/** Extracted bank folders under `Maps/<LEVEL>/Audio/SFX`. Both are shared/level-independent. */
export const BOARD_BANK = 'zboard';
export const BOOST_BANK = 'zbxsfx';

export const DEFAULT_BOARD_SOUND: BoardSoundMix = {
  enabled: true,
  volume: 0.8,
  glide: 0.7,
  carve: 0.8,
  transients: 0.7,
  cues: 0.8,
};

/** Read an authored mix off a saved document, clamping every trim to 0..1. */
export function normalizeBoardSound(value: unknown): BoardSoundMix {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const trim = (field: keyof BoardSoundMix, fallback: number): number => {
    const v = raw[field];
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
  };
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_BOARD_SOUND.enabled,
    volume: trim('volume', DEFAULT_BOARD_SOUND.volume),
    glide: trim('glide', DEFAULT_BOARD_SOUND.glide),
    carve: trim('carve', DEFAULT_BOARD_SOUND.carve),
    transients: trim('transients', DEFAULT_BOARD_SOUND.transients),
    cues: trim('cues', DEFAULT_BOARD_SOUND.cues),
  };
}

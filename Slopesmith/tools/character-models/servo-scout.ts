#!/usr/bin/env -S npx tsx
/**
 * Servo Scout: a friendly treaded utility robot, generated from a parts table like the other built-ins.
 *
 *   npx tsx tools/character-models/servo-scout.ts [OUT.glb]
 *
 * writes `public/characters/servo-scout-rigged.glb` (part of the client build) and refuses to write a file
 * that would fail `check.ts`. The skeleton, the solid builders and the export are in `figure.ts`.
 *
 * ## What it is
 *
 * The archetype is the wide-eyed 1980s service robot: a big sensor head carried on a stalk, two camera eyes
 * under a hinged brow shade that does all the expression work, an antenna, exposed frame and hydraulics
 * instead of bodywork, three-fingered grippers, and rubber tracks instead of feet. It is an ORIGINAL design
 * in that idiom — no model, insignia, colour scheme, proportion set or name is taken from any particular
 * robot, on screen or otherwise. What is borrowed is the idiom itself, the way Alpine Exo borrows "powered
 * armour" without being anybody's powered armour.
 *
 * ## What is fixed and what is free
 *
 * Fixed: the joints. The driver rotates an imported skeleton without re-proportioning it (docs/030), so the
 * segment lengths are the procedural rider's 1.70 m anthropometry. Free: everything the driver never
 * measures — and this figure spends nearly all of it on the HEAD. A 0.29 m sensor head against a 0.32 m
 * chest is roughly twice the head a person has, and it is what makes the silhouette read as a machine from a
 * chase camera rather than as a small rider in a helmet. The body is deliberately thin around it: exposed
 * frame tubes, visible piston rods, and a chest no wider than the yoke its arms hang from.
 *
 * ## The tracks, and the one thing they are not allowed to change
 *
 * The rig has legs, so this robot has legs. What it does not have is boots: each foot carries a rubber track
 * on a metal frame, and the ankle joint sits INSIDE it — which works out honestly, because `ANKLE_RISE` is
 * 11.5 cm and a track unit 13.2 cm tall swallows exactly that. The track's underside is the one surface that
 * touches y = 0, and it is what the ride seats on the binding; anything authored below it is daylight under
 * the rider. `test/servo-scout.test.ts` pins that to the texel.
 *
 * Bind pose is a 14-degree A-pose. The driver sets each bone's world rotation outright, so bind ORIENTATION
 * costs nothing at ride time; what it buys is room for the forearm pistons and the grippers to hang clear of
 * the hip frame instead of inside it. Every clearance below is quoted against that angle.
 */

import { Group } from 'three';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  CLAVICLE_Y, HELMET_Y, HIP_SOCKET_Y, KNEE_Y, SHOULDER_Y,
  DigitSpec, FigurePart, FigureSpec, PaletteEntry, ShapeMesh, Tile, V2, V3,
  armChain, box, buildFigure, chamferProfile, exportCharacterGlb, extrude, hexahedron, limb, mirroredX,
  legChain, riderBones, roundProfile, runCharacterBuild,
} from './figure';
import { LIGHT_CELL, feed, feedStrip, lightAtlas } from './servo-scout-lights';

/** Degrees the arms hang out from vertical in bind — see the note above. */
const ARM_SPREAD = 14;
/** Ankle to track centre-line, and wrist to knuckles. With articulated digits the hand bone IS the palm and
 *  the fingers continue from it, which is how a Mixamo skeleton is shaped and what the runtime's palm frame
 *  expects to find. */
const FOOT_LENGTH = 0.22, HAND_LENGTH = 0.080;

/**
 * The gripper's digits, in the hand bone's own frame (+X the way the palm faces, +Y down the fingers, +Z
 * across the palm toward the thumb). One table serves both hands.
 *
 * THREE digits, not five, and that is the design rather than a saving: a two-finger claw with an opposed
 * thumb is what a machine built to pick things up has, and it is the part of this archetype that is most
 * immediately readable at gripper scale. The runtime matches digits by Mixamo name and simply never finds
 * `ring` or `pinky` (app/ride/character-rig.ts), so the two it does find behave exactly as they would on a
 * five-fingered hand — including under optical hand tracking, where the missing digits' curls go nowhere.
 *
 * The thumb gets TWO segments where the fingers get three, and that is a constraint from the driver rather
 * than from anatomy: it bends segment 1 by 1.15 rad and segment 2 by 1.45 rad whatever digit they belong to,
 * so a three-segment thumb would fold through 218 degrees and bury itself in the palm.
 */
const DIGITS: DigitSpec[] = [
  // The thumb's BASE is load-bearing beyond where the thumb looks: the driver builds the whole hand's palm
  // normal from `middle1 × thumb1`, so a base lifted out of the palm plane tilts that normal — and with it
  // the curl plane of both fingers, which then slide sideways across the palm as they close instead of
  // shutting straight. Keeping it in the palm plane (x ≈ 0) is what makes the recovered normal the authored
  // one, and `test/servo-scout.test.ts` measures exactly that.
  { digit: 'thumb', base: [0.002, 0.030, 0.050], direction: [0.30, 0.56, 0.77], segments: [0.036, 0.029] },
  // The two fingers sit symmetrically about the palm's centre-line rather than in a human's fan, because a
  // gripper closes onto its own pad rather than into a fist.
  { digit: 'index', base: [0.004, 0.076, 0.026], direction: [0.02, 1, 0.05], segments: [0.034, 0.026, 0.020] },
  { digit: 'middle', base: [0.004, 0.078, -0.026], direction: [0.02, 1, -0.05], segments: [0.034, 0.026, 0.020] },
];

export const BONES = riderBones({
  footLength: FOOT_LENGTH, handLength: HAND_LENGTH, armSpread: ARM_SPREAD, digits: DIGITS,
});

const arm = armChain('L', ARM_SPREAD, HAND_LENGTH);
const leg = legChain('L', FOOT_LENGTH);
/** The head bone's own tail, and the centre of the procedural rider's helmet: the sensor head hangs off this. */
const H = HELMET_Y;

/**
 * `limb()` cross-sections are in the BONE's local frame, and a bone that points downward has its local +X
 * pointing inboard. Multiplying an offset by this puts a part outboard on the left side, which is the only
 * side authored here — `mirror()` takes care of the other one.
 */
const OUT = -1;
/** Roll for a solid whose own axis runs across the body or forward, where the default facing roll would be
 *  degenerate or would read backwards in a table. */
const UP: V3 = [0, 1, 0];
const FACING: V3 = [0, 0, 1];

/* ── Materials ─────────────────────────────────────────────────────────────────────────────────────────
 * Flat colours, no image textures beyond the two emissive masks, so the GLB stays self-contained and a
 * repaint is one hex digit. Metalness stays low even on `Chrome`: Slopesmith lights a rider with a sun and a
 * sky rather than with a reflection probe, and a fully metallic surface with nothing to reflect renders as a
 * hole in the figure.
 *
 * Mid steel rather than the bright silver the archetype suggests, because the archetype was not photographed
 * on a snowfield. A near-white robot on a white slope from a chase camera is a silhouette with no interior,
 * so the shell drops to a value that still reads against snow and the dark `Frame` underneath does the
 * drawing. Hazard yellow is the one saturated colour and it is rationed: crown, kneecaps, belt, ear caps.
 *
 * The three emissive entries are what make the figure legible at night. Their `emissive` colour is the light
 * itself and their mask decides its shape, so an eye is a lit lens with a pupil rather than a slab of flat
 * cyan — and because emissive is added after shading, they are the parts of the rider that stay visible when
 * the sun preset is `Night` and everything else has gone to silhouette. The colours are deliberately
 * near-white in one channel: at full brightness a saturated emissive clips to its own hue and loses all the
 * shape the mask just gave it.
 */
const PALETTE: PaletteEntry[] = [
  { name: 'Shell', color: 0x9aa3ab, metalness: 0.28, roughness: 0.42 },
  { name: 'Frame', color: 0x3c434b, metalness: 0.22, roughness: 0.55 },
  { name: 'Rubber', color: 0x191c20, metalness: 0, roughness: 0.95 },
  { name: 'Chrome', color: 0xd2d8dd, metalness: 0.45, roughness: 0.22 },
  { name: 'Hazard', color: 0xe2a01f, metalness: 0.05, roughness: 0.5 },
  { name: 'Iris', color: 0x0f1c26, emissive: 0xbfe9ff, emissiveTexture: 'optics', metalness: 0, roughness: 0.2 },
  { name: 'Signal', color: 0x2a2318, emissive: 0xffd48a, emissiveTexture: 'optics', metalness: 0, roughness: 0.3 },
  // Negative v because a texture offset moves the PATTERN the other way: this sends the packets toward each
  // solid's tail, which is up the pack's spine and outward along the limbs — data leaving the head.
  {
    name: 'Feed', color: 0x111a15, emissive: 0x86ffa6, emissiveTexture: 'feed',
    scroll: [0, -0.62], metalness: 0, roughness: 0.6,
  },
];

/** The profile most of the bodywork is extruded from: a rectangle with its corners cut, which keeps flat
 *  facets exactly at the half-extents (so the table below still says where a plate stops) while reading as a
 *  bevelled panel rather than as a box. */
const PLATE = chamferProfile(0.28);
/** A softer one for narrow ridges and channels, where a 28% chamfer would eat the whole face. */
const RIDGE = chamferProfile(0.5);
/** Finger segments are small enough that a chamfer costs more triangles than it shows. */
const FINGER = chamferProfile(0);
const ROD = roundProfile(6);
const DOME = roundProfile(8);

/**
 * A track's side outline: long flat runs top and bottom with rounded ends, in the same winding every other
 * profile here uses (up the −u edge, across the top, down the +u edge, back along the bottom). Extruded
 * ACROSS the foot rather than along it, so this shape lies in the plane the track actually rolls in.
 */
const TRACK: readonly V2[] = [
  [-1, -0.52], [-1, 0.52], [-0.86, 0.88], [-0.52, 1], [0.52, 1], [0.86, 0.88],
  [1, 0.52], [1, -0.52], [0.86, -0.88], [0.52, -1], [-0.52, -1], [-0.86, -0.88],
];

/* The track unit, in world numbers, because five solids share them and a drift between any two of them is a
 * wheel hanging off the side of a track. `TRACK_Y` is half the unit's height AND its centre height, which is
 * what puts its underside exactly on the ground plane. */
const TRACK_Y = 0.066, TRACK_Z = 0.095, TRACK_HALF = 0.140;
/** Outboard face of the rubber band and of the frame it wraps; the frame is wider, so it shows on both
 *  sides of the band the way a road wheel's carrier does. */
const BAND_IN = 0.052, BAND_OUT = 0.168, FRAME_IN = 0.038, FRAME_OUT = 0.182;

const part = (name: string, bone: string, material: string, shape: ShapeMesh, tile?: Tile): FigurePart =>
  ({ name, bone, material, shape, ...(tile ? { tile } : {}) });

/** Mirror a left-side entry onto the right. */
function mirror(entry: FigurePart): FigurePart {
  return {
    name: entry.name.replace(/\.L$/, '.R'),
    bone: entry.bone.replace(/\.L$/, '.R'),
    material: entry.material,
    shape: mirroredX(entry.shape),
    ...(entry.tile ? { tile: entry.tile } : {}),
  };
}

/* ── Head ──────────────────────────────────────────────────────────────────────────────────────────────
 * This is the character. Everything else is a chassis to carry it, and the budget is spent accordingly: a
 * wide sensor housing, a hinged brow shade cantilevered forward over two camera barrels, ear pods, a crown
 * strip, an antenna and a small lamp barrel. Everything hangs off `H`, so re-proportioning the rider carries
 * the whole assembly instead of leaving a head floating where the old one used to be.
 *
 * The brow is the expression. It is a wedge that slopes DOWN toward the front, so its leading edge sits
 * slightly over the top of each lens — which is the single feature that turns two lit circles into a face,
 * and the reason it is worth four solids' worth of overlap with the eyes rather than clearing them.
 */
const HEAD_PARTS: FigurePart[] = [
  part('Skull', 'Head', 'Shell', extrude(PLATE, [
    // The bottom section is the neck socket, and it is what makes this solid enclose the head bone's head at
    // 1.545: a housing that started at the eyes would leave the bone's own root outside its only geometry.
    { y: H - 0.122, scale: [0.052, 0.050], offset: [0, 0.006] },
    { y: H - 0.086, scale: [0.112, 0.092], offset: [0, 0.014] },
    { y: H - 0.028, scale: [0.144, 0.110], offset: [0, 0.020] },
    { y: H + 0.052, scale: [0.146, 0.112], offset: [0, 0.020] },
    { y: H + 0.090, scale: [0.112, 0.090], offset: [0, 0.014] },
  ])),
  part('Brow', 'Head', 'Frame', hexahedron([
    [-0.152, H + 0.064, 0.022], [-0.138, H + 0.030, 0.198],
    [0.138, H + 0.030, 0.198], [0.152, H + 0.064, 0.022],
    [-0.152, H + 0.096, 0.022], [-0.138, H + 0.060, 0.198],
    [0.138, H + 0.060, 0.198], [0.152, H + 0.096, 0.022],
  ])),
  part('Crown', 'Head', 'Hazard', extrude(PLATE, [
    { y: H + 0.084, scale: [0.098, 0.064], offset: [0, -0.032] },
    { y: H + 0.110, scale: [0.080, 0.052], offset: [0, -0.030] },
  ])),
  // One antenna and one lamp barrel, on opposite sides. Nothing else about this figure is asymmetric, which
  // is what makes them read as fitted equipment rather than as a modelling slip.
  part('Antenna', 'Head', 'Chrome', extrude(ROD, [
    { y: H + 0.098, scale: 0.010, offset: [-0.058, -0.044] },
    { y: H + 0.222, scale: 0.006, offset: [-0.064, -0.048] },
  ])),
  part('AntennaTip', 'Head', 'Hazard', extrude(ROD, [
    { y: H + 0.216, scale: 0.013, offset: [-0.064, -0.048] },
    { y: H + 0.246, scale: 0.007, offset: [-0.065, -0.049] },
  ])),
  // `UP` as the roll because this solid's own axis IS the character's facing, and a roll parallel to the
  // axis it is rolling about has no meaning.
  part('LampBarrel', 'Head', 'Frame', limb([0.054, H + 0.108, 0.010], [0.054, H + 0.108, 0.112], DOME, [
    { t: 0.00, scale: 0.026 },
    { t: 0.82, scale: 0.024 },
    { t: 1.00, scale: 0.020 },
  ], UP)),
  part('LampLens', 'Head', 'Signal', limb([0.054, H + 0.108, 0.010], [0.054, H + 0.108, 0.112], DOME, [
    { t: 0.88, scale: 0.019 },
    { t: 1.06, scale: 0.017 },
  ], UP), LIGHT_CELL.beam),
];

/**
 * One eye, and the pod beside it. The barrels stand 3 cm proud of the housing because a lens flush with a
 * face is a painted circle; standing out is what lets the brow shade above it cast the line that makes the
 * head read as looking at something.
 */
const HEAD_SIDE: FigurePart[] = [
  part('EyeBarrel.L', 'Head', 'Frame', limb([0.072, H - 0.010, 0.056], [0.072, H - 0.010, 0.164], DOME, [
    { t: 0.00, scale: 0.054 },
    { t: 0.66, scale: 0.052 },
    { t: 0.90, scale: 0.048 },
    { t: 1.00, scale: 0.042 },
  ], UP)),
  part('EyeRim.L', 'Head', 'Chrome', limb([0.072, H - 0.010, 0.056], [0.072, H - 0.010, 0.164], DOME, [
    { t: 0.86, scale: 0.052 },
    { t: 0.99, scale: 0.049 },
  ], UP)),
  part('EyeLens.L', 'Head', 'Iris', limb([0.072, H - 0.010, 0.056], [0.072, H - 0.010, 0.164], DOME, [
    { t: 0.94, scale: 0.041 },
    { t: 1.08, scale: 0.038 },
  ], UP), LIGHT_CELL.iris),
  // Ear pods: an axis across the body, so `FACING` is the roll here rather than `UP`.
  part('EarPod.L', 'Head', 'Frame', limb([0.132, H + 0.006, 0.010], [0.172, H + 0.006, 0.010], DOME, [
    { t: 0.00, scale: 0.050 },
    { t: 0.70, scale: 0.048 },
    { t: 1.00, scale: 0.040 },
  ], FACING)),
  part('EarCap.L', 'Head', 'Hazard', limb([0.132, H + 0.006, 0.010], [0.172, H + 0.006, 0.010], DOME, [
    { t: 0.74, scale: 0.043 },
    { t: 0.96, scale: 0.038 },
  ], FACING)),
  part('EarDot.L', 'Head', 'Signal', limb([0.132, H + 0.006, 0.010], [0.172, H + 0.006, 0.010], DOME, [
    { t: 0.92, scale: 0.022 },
    { t: 1.06, scale: 0.020 },
  ], FACING), LIGHT_CELL.dot),
];

/* ── Neck and torso ────────────────────────────────────────────────────────────────────────────────────
 * The neck is a visible stalk rather than a sealed gorget, because a head this size wants to look CARRIED.
 * The column has to swallow the whole neck bone all the same: there is nothing else between the housing and
 * the chest, and a gap here is a hole straight through the character.
 *
 * The chest is narrow on purpose. The yoke that spans the shoulders is 0.41 m wide and the chassis under it
 * is 0.32 m, so the arms hang off a beam rather than out of a torso — which is the difference between a
 * machine and a person in a suit, and it is nearly free because the driver measures none of it.
 */
const TORSO_PARTS: FigurePart[] = [
  part('NeckColumn', 'Neck', 'Frame', extrude(DOME, [
    { y: CLAVICLE_Y - 0.024, scale: 0.044 },
    { y: CLAVICLE_Y + 0.016, scale: 0.038 },
    { y: H - 0.090, scale: 0.034 },
  ])),
  part('NeckRing', 'Neck', 'Chrome', extrude(DOME, [
    { y: 1.492, scale: 0.042 },
    { y: 1.514, scale: 0.041 },
  ])),
  part('Chassis', 'Chest', 'Shell', extrude(PLATE, [
    { y: 1.204, scale: [0.116, 0.092] },
    { y: 1.258, scale: [0.148, 0.112] },
    { y: 1.352, scale: [0.160, 0.118] },
    { y: 1.442, scale: [0.152, 0.112] },
    { y: 1.486, scale: [0.114, 0.086] },
  ])),
  // The access hatch: a panel standing 2 cm proud of the chest with a readout on it. It is the one place a
  // viewer's eye lands after the head, so it gets the only lit thing on the front of the body.
  part('ChestHatch', 'Chest', 'Frame', extrude(PLATE, [
    { y: 1.266, scale: [0.088, 0.018], offset: [0, 0.112] },
    { y: 1.316, scale: [0.096, 0.020], offset: [0, 0.118] },
    { y: 1.412, scale: [0.090, 0.019], offset: [0, 0.114] },
  ])),
  part('Readout', 'Chest', 'Signal', box([-0.046, 1.316, 0.132], [0.046, 1.386, 0.146]), LIGHT_CELL.bars),
  // The shoulder yoke, and the reason this figure has no pauldrons: the arms hang from the ends of a beam
  // that is visibly wider than the chest. Authored across the body, so `UP` is the roll.
  part('Yoke', 'Chest', 'Frame', limb([-0.206, 1.436, -0.006], [0.206, 1.436, -0.006], PLATE, [
    { t: 0.00, scale: [0.030, 0.034] },
    { t: 0.10, scale: [0.036, 0.040] },
    { t: 0.90, scale: [0.036, 0.040] },
    { t: 1.00, scale: [0.030, 0.034] },
  ], UP)),
  // The pack is what says "machine" from behind, which is the angle this game spends most of its time at.
  // Bound to the chest, so it swings with the torso rather than sitting on the hips like luggage.
  part('Pack', 'Chest', 'Shell', extrude(PLATE, [
    { y: 1.238, scale: [0.112, 0.058], offset: [0, -0.164] },
    { y: 1.296, scale: [0.126, 0.066], offset: [0, -0.172] },
    { y: 1.424, scale: [0.126, 0.066], offset: [0, -0.172] },
    { y: 1.470, scale: [0.104, 0.056], offset: [0, -0.164] },
  ])),
  // The data feed, and the reason the pack has a spine at all: a channel up the back that pulses. It is
  // tiled three times over its length, so the flow reads as motion rather than as one slow blink.
  part('PackFeed', 'Chest', 'Feed', extrude(RIDGE, [
    { y: 1.252, scale: [0.026, 0.020], offset: [0, -0.244] },
    { y: 1.456, scale: [0.030, 0.022], offset: [0, -0.248] },
  ]), feed(3)),
  part('PackRail', 'Chest', 'Chrome', box([-0.116, 1.330, -0.252], [0.116, 1.352, -0.230])),
  part('Waist', 'Spine', 'Frame', extrude(DOME, [
    { y: 1.152, scale: 0.084 },
    { y: 1.202, scale: 0.090 },
    { y: 1.250, scale: 0.086 },
  ])),
  /** A machined collar in the one gap the panels leave: the detail that makes the waist read as an actual
   *  articulation rather than as a missing piece of bodywork. */
  part('WaistRing', 'Spine', 'Chrome', extrude(DOME, [
    { y: 1.188, scale: 0.094 },
    { y: 1.214, scale: 0.093 },
  ])),
  part('Hip', 'Hips', 'Shell', extrude(PLATE, [
    { y: 1.006, scale: [0.126, 0.100] },
    { y: 1.070, scale: [0.140, 0.110] },
    { y: 1.150, scale: [0.132, 0.104] },
    { y: 1.190, scale: [0.108, 0.086] },
  ])),
  part('HipBelt', 'Hips', 'Hazard', extrude(PLATE, [
    { y: 1.058, scale: [0.144, 0.113] },
    { y: 1.086, scale: [0.142, 0.112] },
  ])),
  part('PowerCell', 'Hips', 'Frame', extrude(PLATE, [
    { y: 1.010, scale: [0.070, 0.028], offset: [0, -0.126] },
    { y: 1.084, scale: [0.076, 0.030], offset: [0, -0.132] },
  ])),
  // Bridges the notch the two thigh frames leave under the belt. Without it the figure reads as two legs
  // bolted to a box from the front, and as a hole in a crouch.
  part('HipBridge', 'Hips', 'Frame', extrude(PLATE, [
    { y: 0.896, scale: [0.078, 0.084], offset: [0, 0.012] },
    { y: 0.958, scale: [0.090, 0.094], offset: [0, 0.014] },
    { y: 1.016, scale: [0.100, 0.100], offset: [0, 0.010] },
  ])),
];

const TORSO_SIDE: FigurePart[] = [
  part('YokeEnd.L', 'Chest', 'Hazard', limb([0.176, 1.436, -0.006], [0.212, 1.436, -0.006], PLATE, [
    { t: 0.00, scale: [0.038, 0.042] },
    { t: 1.00, scale: [0.034, 0.038] },
  ], UP)),
  part('PackLamp.L', 'Chest', 'Signal', box([0.044, 1.396, -0.250], [0.080, 1.428, -0.234]), LIGHT_CELL.dot),
  // Front feeds flanking the hatch, so the rider is lit from the camera's side too — the pack's spine is
  // only visible from behind, and a chase camera is not the only camera.
  part('ChestFeed.L', 'Chest', 'Feed', extrude(RIDGE, [
    { y: 1.256, scale: [0.014, 0.012], offset: [0.084, 0.112] },
    { y: 1.336, scale: [0.015, 0.013], offset: [0.090, 0.116] },
    { y: 1.420, scale: [0.014, 0.012], offset: [0.086, 0.112] },
  ]), feed(2)),
  part('RibVent.L', 'Chest', 'Rubber', extrude(RIDGE, [
    { y: 1.268, scale: [0.014, 0.052], offset: [0.152, 0.010] },
    { y: 1.400, scale: [0.015, 0.054], offset: [0.156, 0.010] },
  ])),
  part('NeckCable.L', 'Neck', 'Rubber', extrude(ROD, [
    { y: 1.452, scale: 0.011, offset: [0.032, -0.048] },
    { y: 1.536, scale: 0.010, offset: [0.026, -0.040] },
  ])),
  // A short side plate, kept inboard of the arms: a full hanging skirt would swing straight through a thigh
  // the moment the rider crouched, and a crouch is the pose this character is in most of the time.
  part('HipGuard.L', 'Hips', 'Shell', hexahedron([
    [0.096, 0.912, -0.086], [0.096, 0.912, 0.098], [0.156, 0.912, 0.092], [0.156, 0.912, -0.080],
    [0.104, 1.020, -0.096], [0.104, 1.020, 0.110], [0.170, 1.020, 0.104], [0.170, 1.020, -0.090],
  ])),
];

/* ── Arms ──────────────────────────────────────────────────────────────────────────────────────────────
 * Authored along the bone with `limb()`, so the A-pose is free: nothing here has to know that the arm hangs
 * at 14 degrees. Sections outside t = 0..1 are the overlaps that keep the joints closed, which matters more
 * on an exposed frame than on armour — there is no sleeve to hide a gap in.
 *
 * The shoulder and elbow hinges are authored ACROSS the body instead, as cylinders whose axis is the axis
 * they actually turn about. That is the whole reason this arm reads as a mechanism: a rigidly skinned joint
 * that looks like a hinge is a joint whose lack of deformation is the correct behaviour.
 */
const ARM_PARTS: FigurePart[] = [
  part('ShoulderCan.L', 'UpperArm.L', 'Frame', limb([0.140, SHOULDER_Y, 0], [0.244, SHOULDER_Y, 0], DOME, [
    { t: 0.00, scale: 0.052 },
    { t: 0.14, scale: 0.062 },
    { t: 0.86, scale: 0.062 },
    { t: 1.00, scale: 0.052 },
  ], FACING)),
  part('ShoulderCap.L', 'UpperArm.L', 'Chrome', limb([0.140, SHOULDER_Y, 0], [0.244, SHOULDER_Y, 0], DOME, [
    { t: 0.90, scale: 0.050 },
    { t: 1.06, scale: 0.042 },
  ], FACING)),
  part('UpperArmFrame.L', 'UpperArm.L', 'Shell', limb(arm.shoulder, arm.elbow, PLATE, [
    { t: -0.10, scale: [0.040, 0.044] },
    { t: 0.16, scale: [0.048, 0.052] },
    { t: 0.66, scale: [0.045, 0.049] },
    { t: 1.10, scale: [0.040, 0.043] },
  ])),
  part('ArmRail.L', 'UpperArm.L', 'Chrome', limb(arm.shoulder, arm.elbow, ROD, [
    { t: 0.12, scale: 0.011, offset: [OUT * 0.046, -0.030] },
    { t: 0.92, scale: 0.010, offset: [OUT * 0.044, -0.028] },
  ])),
  part('ElbowCan.L', 'LowerArm.L', 'Frame', limb(
    [arm.elbow[0] - 0.046, arm.elbow[1], 0], [arm.elbow[0] + 0.046, arm.elbow[1], 0], DOME, [
      { t: 0.00, scale: 0.044 },
      { t: 0.16, scale: 0.052 },
      { t: 0.84, scale: 0.052 },
      { t: 1.00, scale: 0.044 },
    ], FACING)),
  part('ForearmFrame.L', 'LowerArm.L', 'Shell', limb(arm.elbow, arm.wrist, PLATE, [
    { t: -0.16, scale: [0.042, 0.046] },
    { t: 0.14, scale: [0.046, 0.050] },
    { t: 0.72, scale: [0.040, 0.044] },
    { t: 1.10, scale: [0.038, 0.041] },
  ])),
  // Rod and sleeve overlap the wrist from opposite sides, so a flexed hand shortens the visible rod instead
  // of opening a gap — the same trick as the knee, at a quarter the scale.
  part('ArmRod.L', 'LowerArm.L', 'Chrome', limb(arm.elbow, arm.wrist, ROD, [
    { t: -0.06, scale: 0.013, offset: [OUT * 0.040, -0.036] },
    { t: 0.62, scale: 0.012, offset: [OUT * 0.038, -0.034] },
  ])),
  part('ArmSleeve.L', 'LowerArm.L', 'Frame', limb(arm.elbow, arm.wrist, ROD, [
    { t: 0.52, scale: 0.017, offset: [OUT * 0.038, -0.034] },
    { t: 1.02, scale: 0.016, offset: [OUT * 0.036, -0.032] },
  ])),
  // The forearm feed tracks the frame's own taper, so it stays a channel cut into the panel rather than a
  // bar floating off it where the arm narrows.
  part('ArmFeed.L', 'LowerArm.L', 'Feed', limb(arm.elbow, arm.wrist, RIDGE, [
    { t: 0.06, scale: [0.012, 0.011], offset: [OUT * 0.044, 0.014] },
    { t: 0.50, scale: [0.012, 0.011], offset: [OUT * 0.042, 0.012] },
    { t: 0.88, scale: [0.010, 0.009], offset: [OUT * 0.038, 0.010] },
  ]), feed(2)),
  part('WristRing.L', 'LowerArm.L', 'Chrome', limb(arm.elbow, arm.wrist, PLATE, [
    { t: 0.94, scale: [0.042, 0.045] },
    { t: 1.06, scale: [0.039, 0.042] },
  ])),
  // The palm. Its own sections are in the same frame the digits are authored in: x is the palm normal and z
  // crosses the hand, so a plate on the back of the hand is a negative x offset on both hands.
  part('Palm.L', 'Hand.L', 'Shell', limb(arm.wrist, arm.fingertip, PLATE, [
    { t: -0.26, scale: [0.038, 0.048] },
    { t: 0.24, scale: [0.044, 0.058] },
    { t: 0.78, scale: [0.042, 0.058] },
    { t: 1.14, scale: [0.036, 0.052] },
  ])),
  // The gripper pad, and the surface the two fingers are checked to close ONTO rather than through.
  part('PalmPad.L', 'Hand.L', 'Rubber', limb(arm.wrist, arm.fingertip, PLATE, [
    { t: 0.02, scale: [0.014, 0.046], offset: [0.046, 0] },
    { t: 1.02, scale: [0.012, 0.048], offset: [0.044, 0] },
  ])),
  part('Knuckle.L', 'Hand.L', 'Frame', limb(arm.wrist, arm.fingertip, PLATE, [
    { t: 0.84, scale: [0.026, 0.056], offset: [-0.024, 0] },
    { t: 1.16, scale: [0.022, 0.051], offset: [-0.020, 0] },
  ])),
];

/* ── Legs ──────────────────────────────────────────────────────────────────────────────────────────────
 * The one part of the figure a snowboard actually constrains. The thigh and shin frames each swallow their
 * whole bone; the hinge cans and the two piston halves overlap their joints from opposite sides, so a deep
 * crouch shortens the visible rod instead of opening one. Both taper — a thigh thickest at the hip and a
 * shin thickest just below the knee are what stop a leg reading as a length of pipe.
 */
const LEG_PARTS: FigurePart[] = [
  part('HipCan.L', 'UpperLeg.L', 'Frame', limb([0.062, HIP_SOCKET_Y, 0], [0.166, HIP_SOCKET_Y, 0], DOME, [
    { t: 0.00, scale: 0.052 },
    { t: 0.16, scale: 0.062 },
    { t: 0.84, scale: 0.062 },
    { t: 1.00, scale: 0.052 },
  ], FACING)),
  part('HipCap.L', 'UpperLeg.L', 'Chrome', limb([0.062, HIP_SOCKET_Y, 0], [0.166, HIP_SOCKET_Y, 0], DOME, [
    { t: 0.88, scale: 0.050 },
    { t: 1.04, scale: 0.042 },
  ], FACING)),
  part('ThighFrame.L', 'UpperLeg.L', 'Shell', limb(leg.hip, leg.knee, PLATE, [
    { t: -0.10, scale: [0.054, 0.060] },
    { t: 0.14, scale: [0.062, 0.068] },
    { t: 0.66, scale: [0.056, 0.062] },
    { t: 1.08, scale: [0.050, 0.055] },
  ])),
  part('ThighRod.L', 'UpperLeg.L', 'Chrome', limb(leg.hip, leg.knee, ROD, [
    { t: 0.50, scale: 0.017, offset: [OUT * 0.050, -0.062] },
    { t: 1.04, scale: 0.016, offset: [OUT * 0.050, -0.058] },
  ])),
  // Without this the figure's night silhouette is all head and chest, with nothing below the belt but two
  // track markers — which reads as a floating torso rather than as a rider.
  part('ThighFeed.L', 'UpperLeg.L', 'Feed', limb(leg.hip, leg.knee, RIDGE, [
    { t: 0.14, scale: [0.013, 0.012], offset: [OUT * 0.060, 0.012] },
    { t: 0.52, scale: [0.013, 0.012], offset: [OUT * 0.056, 0.010] },
    { t: 0.84, scale: [0.011, 0.010], offset: [OUT * 0.052, 0.008] },
  ]), feed(2)),
  part('KneeCan.L', 'LowerLeg.L', 'Frame', limb([0.062, KNEE_Y, 0], [0.166, KNEE_Y, 0], DOME, [
    { t: 0.00, scale: 0.048 },
    { t: 0.16, scale: 0.058 },
    { t: 0.84, scale: 0.058 },
    { t: 1.00, scale: 0.048 },
  ], FACING)),
  part('KneeCap.L', 'LowerLeg.L', 'Hazard', limb([0.062, KNEE_Y, 0], [0.166, KNEE_Y, 0], DOME, [
    { t: 0.86, scale: 0.052 },
    { t: 1.02, scale: 0.044 },
  ], FACING)),
  part('ShinFrame.L', 'LowerLeg.L', 'Shell', limb(leg.knee, leg.ankle, PLATE, [
    { t: -0.06, scale: [0.050, 0.056] },
    { t: 0.26, scale: [0.058, 0.064] },
    { t: 0.74, scale: [0.048, 0.053] },
    { t: 1.06, scale: [0.042, 0.046] },
  ])),
  part('ShinSleeve.L', 'LowerLeg.L', 'Frame', limb(leg.knee, leg.ankle, ROD, [
    { t: -0.08, scale: 0.024, offset: [OUT * 0.050, -0.060] },
    { t: 0.32, scale: 0.022, offset: [OUT * 0.050, -0.056] },
  ])),
  part('ShinBand.L', 'LowerLeg.L', 'Hazard', limb(leg.knee, leg.ankle, PLATE, [
    { t: 0.34, scale: [0.060, 0.066] },
    { t: 0.44, scale: [0.058, 0.064] },
  ])),
  part('ShinVent.L', 'LowerLeg.L', 'Rubber', limb(leg.knee, leg.ankle, RIDGE, [
    { t: 0.50, scale: [0.012, 0.040], offset: [OUT * 0.052, 0] },
    { t: 0.82, scale: [0.011, 0.036], offset: [OUT * 0.048, 0] },
  ])),
];

/**
 * The track unit. Authored in world axes rather than along the bone, because the foot bone runs FORWARD
 * rather than down and its local frame reads backwards in a table.
 *
 * `Track` is the one solid that touches y = 0, and that is not cosmetic: standing height is measured off it
 * and the driver seats it on the deck from the solver's ankle, so daylight authored under it is daylight
 * under the rider. Its centre is exactly one half-height up, which is what makes its underside land on the
 * plane rather than near it.
 *
 * The band is extruded ACROSS the foot with `UP` as its roll, so the profile above lies in the plane a track
 * rolls in. `TrackFrame` uses the same axis but is wider and smaller: it shows past the rubber on both faces
 * and nowhere else, which is how a road-wheel carrier inside a track actually presents itself.
 */
const BOOT_PARTS: FigurePart[] = [
  part('Track.L', 'Foot.L', 'Rubber',
    limb([BAND_IN, TRACK_Y, TRACK_Z], [BAND_OUT, TRACK_Y, TRACK_Z], TRACK, [
      { t: 0.00, scale: [TRACK_HALF - 0.004, TRACK_Y - 0.004] },
      { t: 0.14, scale: [TRACK_HALF, TRACK_Y] },
      { t: 0.86, scale: [TRACK_HALF, TRACK_Y] },
      { t: 1.00, scale: [TRACK_HALF - 0.004, TRACK_Y - 0.004] },
    ], UP)),
  part('TrackFrame.L', 'Foot.L', 'Shell',
    limb([FRAME_IN, TRACK_Y, TRACK_Z], [FRAME_OUT, TRACK_Y, TRACK_Z], TRACK, [
      { t: 0.00, scale: [0.112, 0.046] },
      { t: 0.10, scale: [0.118, 0.050] },
      { t: 0.90, scale: [0.118, 0.050] },
      { t: 1.00, scale: [0.112, 0.046] },
    ], UP)),
  part('Hub.L', 'Foot.L', 'Chrome',
    limb([FRAME_OUT, TRACK_Y, TRACK_Z - 0.065], [FRAME_OUT + 0.016, TRACK_Y, TRACK_Z - 0.065], DOME, [
      { t: 0.00, scale: 0.040 },
      { t: 0.70, scale: 0.038 },
      { t: 1.00, scale: 0.032 },
    ], UP)),
  part('Idler.L', 'Foot.L', 'Chrome',
    limb([FRAME_OUT, TRACK_Y, TRACK_Z + 0.081], [FRAME_OUT + 0.014, TRACK_Y, TRACK_Z + 0.081], DOME, [
      { t: 0.00, scale: 0.030 },
      { t: 0.72, scale: 0.028 },
      { t: 1.00, scale: 0.023 },
    ], UP)),
  // The binding clamp, straddling the top of the track. It is the only part of this figure that admits a
  // snowboard exists, and it is hazard-coloured for the same reason a real one is.
  part('Clamp.L', 'Foot.L', 'Hazard', extrude(PLATE, [
    { y: 0.100, scale: [0.076, 0.030], offset: [0.110, TRACK_Z - 0.009] },
    { y: 0.146, scale: [0.070, 0.028], offset: [0.110, TRACK_Z - 0.009] },
  ])),
  part('Shock.L', 'Foot.L', 'Chrome', extrude(ROD, [
    { y: 0.104, scale: 0.014, offset: [0.110, -0.014] },
    { y: 0.182, scale: 0.013, offset: [0.110, -0.010] },
  ])),
  // A marker light on the outside of each track, in the gap the two wheels leave. Low down and outboard is
  // where it is still visible when the rider is laid over in a carve and the torso lights have rotated away.
  part('MarkerLight.L', 'Foot.L', 'Signal',
    box([FRAME_OUT - 0.002, 0.050, TRACK_Z - 0.002], [FRAME_OUT + 0.012, 0.082, TRACK_Z + 0.044]),
    LIGHT_CELL.slot),
];

/**
 * One plate per finger bone, built FROM the bones rather than beside them.
 *
 * Every other part of this figure is a table of numbers that has to agree with the skeleton; sixteen finger
 * segments would be sixteen chances to disagree. Reading `head`/`tail` off the bone instead makes that class
 * of mistake impossible, and it is also why these are not mirrored: both hands' bones already exist, so each
 * plate is built in place and the handedness takes care of itself.
 *
 * The last segment of each digit tapers hard to a chrome point. That is what makes three digits read as a
 * GRIPPER rather than as a hand missing two fingers, and it costs nothing — the taper is one scale.
 */
const FINGER_NAME = /^(Left|Right)Hand(Thumb|Index|Middle)(\d)$/;

function digitPlates(): FigurePart[] {
  const plates: FigurePart[] = [];
  for (const bone of BONES) {
    const match = FINGER_NAME.exec(bone.name);
    if (!match) continue;
    const [, side, digit, index] = match;
    const segment = Number(index);
    const tip = !BONES.some(other => other.name === `${side}Hand${digit}${segment + 1}`);
    const taper = 1 - 0.14 * (segment - 1);
    const wide = (digit === 'Thumb' ? 0.019 : 0.017) * taper;
    const deep = (digit === 'Thumb' ? 0.020 : 0.018) * taper;
    plates.push(part(`${bone.name}Plate`, bone.name, tip ? 'Chrome' : 'Frame',
      limb(bone.head, bone.tail, FINGER, [
        { t: -0.16, scale: [deep * 0.92, wide * 0.92] },
        { t: 0.45, scale: [deep, wide] },
        { t: 1.10, scale: tip ? [deep * 0.34, wide * 0.30] : [deep * 0.82, wide * 0.84] },
      ], bone.roll ?? UP)));
  }
  return plates;
}

const LEFT_PARTS: FigurePart[] = [...HEAD_SIDE, ...TORSO_SIDE, ...ARM_PARTS, ...LEG_PARTS, ...BOOT_PARTS];

export const PARTS: readonly FigurePart[] = [
  ...HEAD_PARTS,
  ...TORSO_PARTS,
  ...LEFT_PARTS,
  ...LEFT_PARTS.map(mirror),
  ...digitPlates(),
];

export const SERVO_SCOUT: FigureSpec = {
  name: 'ServoScout',
  meshName: 'ServoScoutMesh',
  rigProfile: 'slopesmith-character-servo-v1',
  generatedBy: 'Slopesmith/tools/character-models/servo-scout.ts',
  bones: BONES,
  palette: PALETTE,
  parts: PARTS,
  textures: [lightAtlas(), feedStrip()],
};

/** The three.js figure, for previews and posed renders. The emissive masks live in the exported bytes
 *  rather than on these materials, so a direct render of this group shows the flat colours only. */
export function buildServoScout(): Group {
  return buildFigure(SERVO_SCOUT);
}

export async function exportServoScoutGlb(): Promise<Uint8Array> {
  return exportCharacterGlb(SERVO_SCOUT);
}

/** The bind pose the parts table was authored against, so a check can measure the same thing. */
export const BIND = {
  armSpread: ARM_SPREAD, arm, leg, footLength: FOOT_LENGTH, handLength: HAND_LENGTH,
  trackHeight: TRACK_Y * 2, trackOuter: FRAME_OUT,
};

const DEFAULT_OUTPUT = fileURLToPath(new URL('../../public/characters/servo-scout-rigged.glb', import.meta.url));

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCharacterBuild(DEFAULT_OUTPUT, exportServoScoutGlb)
    .catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}

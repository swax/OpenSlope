#!/usr/bin/env -S npx tsx
/**
 * Alpine Exo: a heavy powered-armour rider, generated from a parts table like the blocky rider.
 *
 *   npx tsx tools/character-models/alpine-exo.ts [OUT.glb]
 *
 * writes `public/characters/alpine-exo-rigged.glb` (part of the client build) and refuses to write a file
 * that would fail `check.ts`. The skeleton, the solid builders and the export are in `figure.ts`.
 *
 * ## Why powered armour and rigid skinning are the same idea
 *
 * A generated character binds each solid to exactly ONE bone at a weight of 1. For a soft body that is a
 * compromise — a joint gets no smooth deformation and has to be hidden inside overlapping blocks. For a
 * suit of articulated plate it is simply what the thing IS: hard shells that slide over each other at the
 * knee and the elbow with a black bodyglove showing through the gap. So this figure leans into the
 * constraint instead of working around it. Every plate overhangs its joint at both ends (`limb()` sections
 * outside t = 0..1), and where two plates part company there is a `Suit` sleeve underneath to be seen —
 * `KneeSeal` and `ElbowSeal` are bound to the parent limb precisely so the two hard shells slide over that
 * rather than over each other.
 *
 * ## What is fixed and what is free
 *
 * Fixed: the joints. The driver rotates an imported skeleton without re-proportioning it (docs/030), so the
 * segment lengths are the procedural rider's 1.70 m anthropometry, and Alpine Exo cannot be made taller by
 * lengthening its shins — that is boots through the deck. Free: everything the driver never measures. This
 * figure spends all of it on BREADTH — 0.86 m across the pauldrons against a 0.32 m waist, a backpack, and
 * plate thick enough to bury the bones inside it. Broad rather than tall is the honest reading of the
 * archetype anyway, and it is the half of it a shared skeleton can actually deliver.
 *
 * Bind pose is a 17-degree A-pose. The driver sets each bone's world rotation outright, so bind ORIENTATION
 * costs nothing at ride time; what it buys is room for arms this thick to hang clear of the belt and the
 * thigh plates instead of intersecting them. Every clearance below is quoted against that angle.
 *
 * The design is original: no insignia, iconography, colour scheme or naming borrowed from any existing
 * setting. The chest sigil is a mountain peak, which is what this game is about.
 */

import { Group } from 'three';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  CLAVICLE_Y, HEAD_BONE_Y, HELMET_Y,
  DigitSpec, FigurePart, FigureSpec, PaletteEntry, ShapeMesh, Tile, V3,
  armChain, box, buildFigure, chamferProfile, exportCharacterGlb, extrude, hexahedron, limb, mirroredX,
  legChain, placed, riderBones, roundProfile, runCharacterBuild,
} from './figure';
import { LIGHT_CELL, conduit, conduitStrip, lightAtlas } from './alpine-exo-lights';

/** Degrees the arms hang out from vertical in bind — see the note above. */
const ARM_SPREAD = 17;
/** Wrist to knuckles. With articulated digits the hand bone IS the palm and the fingers continue from it,
 *  which is how a Mixamo skeleton is shaped and what the runtime's palm frame expects to find. */
const FOOT_LENGTH = 0.19, HAND_LENGTH = 0.084;

/**
 * The gauntlet's digits, in the hand bone's own frame (+X the way the palm faces, +Y down the fingers, +Z
 * across the palm toward the thumb). One table serves both hands.
 *
 * The thumb gets TWO segments where the fingers get three, and that is a constraint from the driver rather
 * than from anatomy: it bends segment 1 by 1.15 rad and segment 2 by 1.45 rad whatever digit they belong to
 * (app/ride/character-rig.ts), so a three-segment thumb would fold through 218 degrees and bury itself in
 * the palm. Two puts a closed fist's thumb across the fingers instead of inside them.
 */
const DIGITS: DigitSpec[] = [
  // The thumb's BASE is load-bearing beyond where the thumb looks: the driver builds the whole hand's palm
  // normal from `middle1 × thumb1`, so an base lifted toward the palm tilts that normal — and with it the
  // curl plane of every finger, which then slides sideways across the palm as it closes instead of shutting
  // straight. Keeping it in the palm plane (x ≈ 0) is what makes the recovered normal the authored one.
  { digit: 'thumb', base: [0.002, 0.036, 0.054], direction: [0.30, 0.56, 0.77], segments: [0.034, 0.027] },
  { digit: 'index', base: [0.004, 0.078, 0.050], direction: [0.02, 1, 0.05], segments: [0.031, 0.024, 0.019] },
  { digit: 'middle', base: [0.004, 0.083, 0.017], direction: [0.02, 1, 0.00], segments: [0.034, 0.026, 0.020] },
  { digit: 'ring', base: [0.004, 0.078, -0.017], direction: [0.02, 1, -0.03], segments: [0.031, 0.024, 0.019] },
  { digit: 'pinky', base: [0.004, 0.068, -0.050], direction: [0.02, 1, -0.07], segments: [0.027, 0.020, 0.017] },
];

export const BONES = riderBones({
  footLength: FOOT_LENGTH, handLength: HAND_LENGTH, armSpread: ARM_SPREAD, digits: DIGITS,
});

const arm = armChain('L', ARM_SPREAD, HAND_LENGTH);
const leg = legChain('L', FOOT_LENGTH);
/** The head bone's own tail, and the centre of the procedural rider's helmet: the head hangs off this. */
const H = HELMET_Y;

/**
 * `limb()` cross-sections are in the BONE's local frame, and a bone that points downward has its local +X
 * pointing inboard. Multiplying an offset by this puts a plate outboard on the left side, which is the only
 * side authored here — `mirror()` takes care of the other one.
 */
const OUT = -1;
/** Roll for a solid whose own axis runs forward, where the default facing roll would be degenerate. */
const UP: V3 = [0, 1, 0];

/* ── Materials ─────────────────────────────────────────────────────────────────────────────────────────
 * Flat colours, no textures and no images, so the GLB stays self-contained and a repaint is one hex digit.
 * Metalness stays low even on `Metal`: Slopesmith lights a rider with a sun and a sky rather than with a
 * reflection probe, and a fully metallic surface with nothing to reflect renders as a hole in the figure.
 *
 * Storm grey against hazard orange rather than a heroic primary: it is the scheme that stays readable on a
 * white slope from a chase camera, which is where this model is actually looked at.
 */
/**
 * The three emissive entries are what make the figure legible at night. Their `emissive` colour is the light
 * itself and their mask decides its shape, so a lens is a lit lens rather than a slab of flat cyan — and
 * because emissive is added after shading, they are the parts of the rider that stay visible when the sun
 * preset is `Night` and everything else has gone to silhouette.
 *
 * The colours are deliberately near-white in one channel: at full brightness a saturated emissive clips to
 * its own hue and loses all the shape the mask just gave it.
 */
const PALETTE: PaletteEntry[] = [
  { name: 'Plate', color: 0x3f4d5e, metalness: 0.12, roughness: 0.55 },
  { name: 'Trim', color: 0xd2762a, metalness: 0.05, roughness: 0.5 },
  { name: 'Suit', color: 0x15191f, metalness: 0, roughness: 0.95 },
  { name: 'Metal', color: 0x97a1ac, metalness: 0.25, roughness: 0.4 },
  { name: 'Mark', color: 0xe3e9ef, metalness: 0, roughness: 0.7 },
  { name: 'Lens', color: 0x18323d, emissive: 0x7fe8ff, emissiveTexture: 'lights', metalness: 0, roughness: 0.2 },
  { name: 'Lamp', color: 0x2a2a26, emissive: 0xffeccc, emissiveTexture: 'lights', metalness: 0, roughness: 0.3 },
  // Negative v because a texture offset moves the PATTERN the other way: this sends the pulses toward each
  // solid's tail, which is up the pack's spine and outward along the limbs — power leaving the reactor.
  {
    name: 'Core', color: 0x1d1710, emissive: 0xff9538, emissiveTexture: 'conduit',
    scroll: [0, -0.55], metalness: 0, roughness: 0.6,
  },
];

/** The profile almost everything is extruded from: a rectangle with its corners cut, which keeps flat
 *  facets exactly at the half-extents (so the table below still says where a plate stops) while reading as
 *  a bevelled sheet of armour rather than as a box. */
const PLATE = chamferProfile(0.28);
/** A rounder cut, for the shoulder and knee domes. */
const SHELL = chamferProfile(0.42);
/** A softer one for narrow ridges, where a 28% chamfer would eat the whole face. */
const RIDGE = chamferProfile(0.5);
/** Finger segments are small enough that a chamfer costs more triangles than it shows; a plain rectangle
 *  also happens to be exactly what an armoured finger plate looks like. */
const FINGER = chamferProfile(0);
const ROD = roundProfile(6);
const DOME = roundProfile(8);

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
 * The helmet is what a rider is recognised from, so it carries the most detail per gram: a tapering skull,
 * a respirator jutting out under a heavy brow, four vent bars, two lenses angled outward, and a crest that
 * changes the head's outline as the rider turns — which is the only thing that reads as a head at all from
 * a chase camera. Everything hangs off `H`, so re-proportioning the rider carries the whole assembly
 * instead of leaving a helmet floating where the old head used to be.
 */
const HEAD_PARTS: FigurePart[] = [
  part('Helm', 'Head', 'Plate', extrude(PLATE, [
    { y: H - 0.135, scale: [0.100, 0.112], offset: [0, 0.010] },
    { y: H - 0.075, scale: [0.136, 0.152], offset: [0, 0.012] },
    { y: H + 0.022, scale: [0.144, 0.158], offset: [0, 0.012] },
    { y: H + 0.100, scale: [0.128, 0.138], offset: [0, 0.008] },
    { y: H + 0.142, scale: [0.076, 0.088], offset: [0, 0.004] },
  ])),
  // The respirator: the front face stays vertical so the vent bars can stand proud of it without slicing
  // through, and the flare goes on the sides and the top instead.
  part('Respirator', 'Head', 'Metal', hexahedron([
    [-0.060, H - 0.130, 0.086], [-0.060, H - 0.130, 0.190], [0.060, H - 0.130, 0.190], [0.060, H - 0.130, 0.086],
    [-0.082, H - 0.020, 0.086], [-0.082, H - 0.020, 0.190], [0.082, H - 0.020, 0.190], [0.082, H - 0.020, 0.086],
  ])),
  part('Brow', 'Head', 'Plate', hexahedron([
    [-0.136, H + 0.048, 0.094], [-0.136, H + 0.048, 0.184], [0.136, H + 0.048, 0.184], [0.136, H + 0.048, 0.094],
    [-0.125, H + 0.100, 0.094], [-0.125, H + 0.100, 0.152], [0.125, H + 0.100, 0.152], [0.125, H + 0.100, 0.094],
  ])),
  part('Crest', 'Head', 'Trim', hexahedron([
    [-0.023, H + 0.102, -0.126], [-0.023, H + 0.102, 0.158], [0.023, H + 0.102, 0.158], [0.023, H + 0.102, -0.126],
    [-0.011, H + 0.184, -0.062], [-0.011, H + 0.184, 0.104], [0.011, H + 0.184, 0.104], [0.011, H + 0.184, -0.062],
  ])),
];

const HEAD_SIDE: FigurePart[] = [
  part('Lens.L', 'Head', 'Lens', placed(
    box([0.026, H + 0.006, 0.146], [0.120, H + 0.056, 0.180]),
    { pivot: [0.073, H + 0.031, 0], rotateZ: 9 },
  ), LIGHT_CELL.visor),
  part('VentBar.L', 'Head', 'Suit', box([0.008, H - 0.122, 0.184], [0.026, H - 0.036, 0.200])),
  part('VentBar2.L', 'Head', 'Suit', box([0.034, H - 0.122, 0.184], [0.052, H - 0.036, 0.200])),
  part('Cowl.L', 'Head', 'Metal', hexahedron([
    [0.130, H - 0.064, -0.060], [0.130, H - 0.064, 0.064], [0.164, H - 0.064, 0.052], [0.164, H - 0.064, -0.048],
    [0.130, H + 0.062, -0.060], [0.130, H + 0.062, 0.064], [0.158, H + 0.062, 0.052], [0.158, H + 0.062, -0.048],
  ])),
  // A side readout rather than a dark slot: from a chase camera it is the only lit thing on the head that is
  // not the visor, which is what stops a night silhouette reading as two floating eyes.
  part('CowlSlot.L', 'Head', 'Lens', box([0.156, H - 0.032, -0.022], [0.172, H + 0.036, 0.028]),
    LIGHT_CELL.bars),
];

/* ── Neck and torso ────────────────────────────────────────────────────────────────────────────────────
 * The gorget is the primary Neck solid and has to swallow the whole neck bone, because there is nothing
 * else between the helmet and the chest: a gap here is a hole straight through the character.
 *
 * The V is deliberate and it is also load-bearing. A 0.46 m chest over a 0.32 m waist is the archetype's
 * silhouette, and it is what leaves an arm this thick somewhere to hang at 17 degrees without ending up
 * inside the pelvis.
 */
const TORSO_PARTS: FigurePart[] = [
  part('NeckSeal', 'Neck', 'Suit', extrude(DOME, [
    { y: CLAVICLE_Y - 0.030, scale: 0.086 },
    { y: HEAD_BONE_Y + 0.016, scale: 0.078 },
  ])),
  part('Gorget', 'Neck', 'Plate', extrude(PLATE, [
    { y: CLAVICLE_Y - 0.048, scale: [0.152, 0.148] },
    { y: CLAVICLE_Y + 0.016, scale: [0.128, 0.126] },
    { y: HEAD_BONE_Y + 0.014, scale: [0.107, 0.109] },
  ])),
  part('GorgetTrim', 'Neck', 'Trim', extrude(PLATE, [
    { y: CLAVICLE_Y - 0.062, scale: [0.160, 0.155] },
    { y: CLAVICLE_Y - 0.034, scale: [0.154, 0.150] },
  ])),
  // The cuirass stops at 1.205 and the pelvis starts at 1.185, so the dark `Waist` beneath shows through a
  // two-centimetre inset band. Overlapping them instead — which is what the first draft did — welds the
  // whole torso into one grey mass with no waist at all, and a figure with no waist has no V to read.
  part('Cuirass', 'Chest', 'Plate', extrude(PLATE, [
    { y: 1.205, scale: [0.152, 0.130] },
    { y: 1.272, scale: [0.204, 0.160] },
    { y: 1.360, scale: [0.230, 0.174] },
    { y: 1.445, scale: [0.222, 0.166] },
    { y: 1.500, scale: [0.176, 0.138] },
  ])),
  part('CollarTrim', 'Chest', 'Trim', extrude(PLATE, [
    { y: 1.452, scale: [0.220, 0.164] },
    { y: 1.484, scale: [0.196, 0.150] },
  ])),
  part('Sternum', 'Chest', 'Trim', extrude(RIDGE, [
    { y: 1.360, scale: [0.056, 0.030], offset: [0, 0.172] },
    { y: 1.432, scale: [0.062, 0.034], offset: [0, 0.180] },
    { y: 1.484, scale: [0.044, 0.026], offset: [0, 0.154] },
  ])),
  part('ChestVent', 'Chest', 'Suit', extrude(RIDGE, [
    { y: 1.262, scale: [0.086, 0.026], offset: [0, 0.164] },
    { y: 1.300, scale: [0.092, 0.028], offset: [0, 0.168] },
  ])),
  // The backpack is what says "powered armour" from behind, which is the angle this game spends most of its
  // time at. Bound to the chest, so it swings with the torso rather than sitting on the hips like luggage.
  part('Pack', 'Chest', 'Plate', extrude(PLATE, [
    { y: 1.180, scale: [0.148, 0.082], offset: [0, -0.216] },
    { y: 1.286, scale: [0.170, 0.098], offset: [0, -0.226] },
    { y: 1.462, scale: [0.170, 0.098], offset: [0, -0.226] },
    { y: 1.526, scale: [0.138, 0.080], offset: [0, -0.212] },
  ])),
  // The power conduit, and the reason the pack has a spine at all: a channel up the back that pulses. It is
  // tiled three times over its length, so the flow reads as motion rather than as one slow blink.
  part('PackSpine', 'Chest', 'Core', extrude(RIDGE, [
    { y: 1.208, scale: [0.028, 0.022], offset: [0, -0.322] },
    { y: 1.486, scale: [0.032, 0.024], offset: [0, -0.326] },
  ]), conduit(3)),
  // One antenna, on one side. Nothing else about this figure is asymmetric, which is what makes it read as
  // a fitted piece of equipment rather than as a modelling slip.
  part('Antenna', 'Chest', 'Metal', extrude(ROD, [
    { y: 1.470, scale: 0.013, offset: [-0.132, -0.238] },
    { y: 1.760, scale: 0.007, offset: [-0.140, -0.244] },
  ])),
  part('AntennaTip', 'Chest', 'Trim', extrude(ROD, [
    { y: 1.756, scale: 0.014, offset: [-0.140, -0.244] },
    { y: 1.786, scale: 0.008, offset: [-0.141, -0.245] },
  ])),
  part('Waist', 'Spine', 'Suit', extrude(PLATE, [
    { y: 1.140, scale: [0.130, 0.114] },
    { y: 1.200, scale: [0.138, 0.120] },
    { y: 1.252, scale: [0.146, 0.126] },
  ])),
  /** A machined collar in the one gap the plates leave: the detail that makes the waist read as an actual
   *  articulation rather than as a missing piece of armour. */
  part('WaistRing', 'Spine', 'Metal', extrude(PLATE, [
    { y: 1.182, scale: [0.142, 0.123] },
    { y: 1.208, scale: [0.144, 0.125] },
  ])),
  part('Pelvis', 'Hips', 'Plate', extrude(PLATE, [
    { y: 0.996, scale: [0.152, 0.140] },
    { y: 1.080, scale: [0.160, 0.146] },
    { y: 1.185, scale: [0.146, 0.132] },
  ])),
  part('Belt', 'Hips', 'Suit', extrude(PLATE, [
    { y: 0.990, scale: [0.164, 0.150] },
    { y: 1.054, scale: [0.168, 0.153] },
  ])),
  part('Buckle', 'Hips', 'Trim', box([-0.056, 0.994, 0.142], [0.056, 1.058, 0.172])),
  // Bridges the notch the two thigh plates leave under the belt. Without it the figure reads as two legs
  // bolted to a box from the front, and as a hole in a crouch.
  part('Codpiece', 'Hips', 'Plate', extrude(PLATE, [
    { y: 0.888, scale: [0.082, 0.088], offset: [0, 0.024] },
    { y: 0.950, scale: [0.094, 0.100], offset: [0, 0.026] },
    { y: 1.010, scale: [0.104, 0.108], offset: [0, 0.022] },
  ])),
  part('RearPouch', 'Hips', 'Suit', extrude(PLATE, [
    { y: 1.004, scale: [0.070, 0.030], offset: [0, -0.158] },
    { y: 1.072, scale: [0.076, 0.032], offset: [0, -0.164] },
  ])),
];

/**
 * The chest sigil: a mountain peak, built from one bar that `mirror()` completes. It sits below the sternum
 * ridge on the flat front facet of the cuirass, where the chamfered profile still leaves something flat for
 * it to lie on.
 */
const TORSO_SIDE: FigurePart[] = [
  part('Peak.L', 'Chest', 'Mark', placed(
    box([0.000, 1.328, 0.170], [0.122, 1.354, 0.192]),
    { pivot: [0, 1.341, 0], rotateZ: -30 },
  )),
  part('PackVent.L', 'Chest', 'Metal', box([0.036, 1.296, -0.330], [0.130, 1.334, -0.306])),
  part('PackVent2.L', 'Chest', 'Metal', box([0.036, 1.350, -0.330], [0.130, 1.388, -0.306])),
  // On the pack's outer-REAR corner, not inside it. Centred on the pack they were entirely swallowed by it
  // and only their caps showed, which is three solids of geometry spent on a nub.
  part('Stack.L', 'Chest', 'Metal', extrude(DOME, [
    { y: 1.372, scale: 0.048, offset: [0.150, -0.300] },
    { y: 1.560, scale: 0.046, offset: [0.150, -0.300] },
    { y: 1.664, scale: 0.036, offset: [0.150, -0.300] },
  ])),
  part('StackRing.L', 'Chest', 'Trim', extrude(DOME, [
    { y: 1.578, scale: 0.051, offset: [0.150, -0.300] },
    { y: 1.612, scale: 0.049, offset: [0.150, -0.300] },
  ])),
  part('StackCap.L', 'Chest', 'Suit', extrude(DOME, [
    { y: 1.656, scale: 0.038, offset: [0.150, -0.300] },
    { y: 1.682, scale: 0.032, offset: [0.150, -0.300] },
  ])),
  part('PackLight.L', 'Chest', 'Lens', box([0.058, 1.238, -0.332], [0.096, 1.272, -0.312]), LIGHT_CELL.dot),
  // Front conduits flanking the sternum, so the rider is lit from the camera's side too — the pack's spine
  // is only visible from behind, and a chase camera is not the only camera.
  part('ChestConduit.L', 'Chest', 'Core', extrude(RIDGE, [
    { y: 1.238, scale: [0.016, 0.014], offset: [0.088, 0.166] },
    { y: 1.310, scale: [0.017, 0.015], offset: [0.094, 0.174] },
    { y: 1.404, scale: [0.016, 0.014], offset: [0.090, 0.170] },
  ]), conduit(2)),
  // A short side plate, kept inboard of the arms: a full hanging tasset would swing straight through a
  // thigh the moment the rider crouched, and a crouch is the pose this character is in most of the time.
  part('HipGuard.L', 'Hips', 'Plate', hexahedron([
    [0.100, 0.896, -0.098], [0.100, 0.896, 0.114], [0.168, 0.896, 0.108], [0.168, 0.896, -0.092],
    [0.108, 1.006, -0.110], [0.108, 1.006, 0.128], [0.182, 1.006, 0.122], [0.182, 1.006, -0.104],
  ])),
];

/* ── Arms ──────────────────────────────────────────────────────────────────────────────────────────────
 * Authored along the bone with `limb()`, so the A-pose is free: nothing here has to know that the arm hangs
 * at 17 degrees. Sections outside t = 0..1 are the overlaps that keep the joints closed.
 */
const ARM_PARTS: FigurePart[] = [
  // The pauldron is the silhouette, and the numbers that matter are the ones at the TOP: the crown rises
  // above the collar, beside the neck, and leans outboard as it goes so it clears the helmet's jaw rather
  // than growing into it. Bound to the upper arm, so it swings with the shoulder as a strapped-on plate does.
  part('Pauldron.L', 'UpperArm.L', 'Plate', limb(arm.shoulder, arm.elbow, SHELL, [
    { t: -0.46, scale: [0.052, 0.060], offset: [OUT * 0.126, 0] },
    { t: -0.30, scale: [0.098, 0.106], offset: [OUT * 0.128, 0] },
    { t: -0.08, scale: [0.126, 0.134], offset: [OUT * 0.128, 0] },
    { t: 0.16, scale: [0.134, 0.142], offset: [OUT * 0.126, 0] },
    { t: 0.32, scale: [0.130, 0.136], offset: [OUT * 0.120, 0] },
    { t: 0.44, scale: [0.104, 0.112], offset: [OUT * 0.108, 0] },
  ])),
  part('PauldronRim.L', 'UpperArm.L', 'Trim', limb(arm.shoulder, arm.elbow, SHELL, [
    { t: 0.30, scale: [0.140, 0.146], offset: [OUT * 0.122, 0] },
    { t: 0.46, scale: [0.112, 0.120], offset: [OUT * 0.108, 0] },
  ])),
  part('PauldronBand.L', 'UpperArm.L', 'Mark', limb(arm.shoulder, arm.elbow, SHELL, [
    { t: -0.04, scale: [0.130, 0.138], offset: [OUT * 0.128, 0] },
    { t: 0.06, scale: [0.133, 0.141], offset: [OUT * 0.127, 0] },
  ])),
  part('PauldronStud.L', 'UpperArm.L', 'Metal', limb(arm.shoulder, arm.elbow, DOME, [
    { t: -0.34, scale: 0.030, offset: [OUT * 0.128, 0] },
    { t: -0.24, scale: 0.036, offset: [OUT * 0.136, 0] },
    { t: -0.16, scale: 0.026, offset: [OUT * 0.132, 0] },
  ])),
  // A shoulder lamp: the one light on this figure that exists to be USEFUL rather than decorative, which is
  // why it points along the pauldron's own facing and swings with the arm the way a mounted lamp would.
  // `UP` as the roll because this solid's own axis IS the character's facing, and a roll parallel to the
  // axis it is rolling about has no meaning.
  part('LampHousing.L', 'UpperArm.L', 'Metal', limb([0.330, 1.352, 0.072], [0.330, 1.352, 0.188], DOME, [
    { t: 0.00, scale: 0.035 },
    { t: 0.82, scale: 0.033 },
    { t: 1.00, scale: 0.029 },
  ], UP)),
  part('LampLens.L', 'UpperArm.L', 'Lamp', limb([0.330, 1.352, 0.072], [0.330, 1.352, 0.188], DOME, [
    { t: 0.86, scale: 0.027 },
    { t: 1.02, scale: 0.025 },
  ], UP), LIGHT_CELL.lamp),
  part('Rerebrace.L', 'UpperArm.L', 'Plate', limb(arm.shoulder, arm.elbow, PLATE, [
    { t: -0.10, scale: [0.080, 0.084] },
    { t: 0.18, scale: [0.096, 0.100] },
    { t: 0.62, scale: [0.098, 0.101] },
    { t: 0.94, scale: [0.089, 0.092] },
    { t: 1.14, scale: [0.078, 0.081] },
  ])),
  part('ElbowSeal.L', 'UpperArm.L', 'Suit', limb(arm.shoulder, arm.elbow, DOME, [
    { t: 0.86, scale: 0.077 },
    { t: 1.24, scale: 0.074 },
  ])),
  part('Vambrace.L', 'LowerArm.L', 'Plate', limb(arm.elbow, arm.wrist, PLATE, [
    { t: -0.14, scale: [0.088, 0.092] },
    { t: 0.16, scale: [0.096, 0.100] },
    { t: 0.70, scale: [0.086, 0.090] },
    { t: 1.04, scale: [0.092, 0.095] },
    { t: 1.12, scale: [0.083, 0.086] },
  ])),
  part('ElbowCop.L', 'LowerArm.L', 'Plate', limb(arm.elbow, arm.wrist, SHELL, [
    { t: -0.26, scale: [0.068, 0.072], offset: [OUT * 0.012, -0.008] },
    { t: -0.06, scale: [0.108, 0.112], offset: [OUT * 0.012, 0] },
    { t: 0.14, scale: [0.106, 0.109], offset: [OUT * 0.009, 0] },
    { t: 0.28, scale: [0.090, 0.094] },
  ])),
  part('CuffTrim.L', 'LowerArm.L', 'Trim', limb(arm.elbow, arm.wrist, PLATE, [
    { t: 0.96, scale: [0.099, 0.102] },
    { t: 1.10, scale: [0.090, 0.093] },
  ])),
  // The forearm conduit tracks the vambrace's own taper, so it stays a channel cut into the plate rather
  // than a bar floating off it where the arm narrows.
  part('ArmConduit.L', 'LowerArm.L', 'Core', limb(arm.elbow, arm.wrist, RIDGE, [
    { t: 0.08, scale: [0.014, 0.013], offset: [OUT * 0.092, 0] },
    { t: 0.45, scale: [0.014, 0.013], offset: [OUT * 0.090, 0] },
    { t: 0.86, scale: [0.012, 0.011], offset: [OUT * 0.086, 0] },
  ]), conduit(2)),
  // The palm. Its own sections are in the same frame the digits are authored in: x is the palm normal and z
  // crosses the hand, so a plate on the back of the hand is a negative x offset on both hands.
  part('Palm.L', 'Hand.L', 'Plate', limb(arm.wrist, arm.fingertip, PLATE, [
    { t: -0.24, scale: [0.049, 0.063] },
    { t: 0.20, scale: [0.056, 0.074] },
    { t: 0.75, scale: [0.054, 0.076] },
    { t: 1.12, scale: [0.047, 0.072] },
  ])),
  part('PalmPad.L', 'Hand.L', 'Suit', limb(arm.wrist, arm.fingertip, PLATE, [
    { t: 0.02, scale: [0.013, 0.058], offset: [0.047, 0] },
    { t: 1.02, scale: [0.011, 0.060], offset: [0.043, 0] },
  ])),
  part('Knuckle.L', 'Hand.L', 'Metal', limb(arm.wrist, arm.fingertip, PLATE, [
    { t: 0.86, scale: [0.031, 0.072], offset: [-0.029, 0] },
    { t: 1.16, scale: [0.027, 0.067], offset: [-0.025, 0] },
  ])),
];

/* ── Legs ──────────────────────────────────────────────────────────────────────────────────────────────
 * The one part of the figure a snowboard actually constrains. The cuisse and the greave each swallow their
 * whole bone; the knee cop and the two piston halves overlap the joint from opposite sides, so a deep
 * crouch shortens the visible gap instead of opening one. Both taper — a thigh that is thickest at the hip
 * and a calf thickest just below the knee are what stop a leg reading as a length of pipe.
 */
const LEG_PARTS: FigurePart[] = [
  part('Cuisse.L', 'UpperLeg.L', 'Plate', limb(leg.hip, leg.knee, PLATE, [
    { t: -0.12, scale: [0.090, 0.102] },
    { t: 0.10, scale: [0.098, 0.110] },
    { t: 0.62, scale: [0.090, 0.101] },
    { t: 1.10, scale: [0.082, 0.093] },
  ])),
  part('ThighGuard.L', 'UpperLeg.L', 'Plate', limb(leg.hip, leg.knee, RIDGE, [
    { t: 0.04, scale: [0.072, 0.032], offset: [0, 0.100] },
    { t: 0.52, scale: [0.078, 0.034], offset: [0, 0.104] },
    { t: 0.80, scale: [0.060, 0.026], offset: [0, 0.094] },
  ])),
  part('ThighTrim.L', 'UpperLeg.L', 'Trim', limb(leg.hip, leg.knee, PLATE, [
    { t: 0.20, scale: [0.100, 0.112] },
    { t: 0.30, scale: [0.098, 0.110] },
  ])),
  part('KneeSeal.L', 'UpperLeg.L', 'Suit', limb(leg.hip, leg.knee, DOME, [
    { t: 0.86, scale: 0.086 },
    { t: 1.22, scale: 0.083 },
  ])),
  // Without this the figure's night silhouette is all torso and helmet, with nothing below the belt but two
  // boot markers — which reads as a floating chest rather than as a rider.
  part('LegConduit.L', 'UpperLeg.L', 'Core', limb(leg.hip, leg.knee, RIDGE, [
    { t: 0.16, scale: [0.015, 0.014], offset: [OUT * 0.096, -0.010] },
    { t: 0.55, scale: [0.015, 0.014], offset: [OUT * 0.092, -0.010] },
    { t: 0.84, scale: [0.013, 0.012], offset: [OUT * 0.088, -0.010] },
  ]), conduit(2)),
  part('PistonRod.L', 'UpperLeg.L', 'Metal', limb(leg.hip, leg.knee, ROD, [
    { t: 0.52, scale: 0.020, offset: [OUT * 0.046, -0.100] },
    { t: 1.04, scale: 0.019, offset: [OUT * 0.046, -0.094] },
  ])),
  part('Greave.L', 'LowerLeg.L', 'Plate', limb(leg.knee, leg.ankle, PLATE, [
    { t: -0.06, scale: [0.086, 0.093] },
    { t: 0.30, scale: [0.097, 0.104] },
    { t: 0.78, scale: [0.084, 0.090] },
    { t: 1.06, scale: [0.078, 0.084] },
  ])),
  part('KneeCop.L', 'LowerLeg.L', 'Plate', limb(leg.knee, leg.ankle, SHELL, [
    { t: -0.24, scale: [0.078, 0.084], offset: [0, 0.014] },
    { t: -0.05, scale: [0.108, 0.115], offset: [0, 0.020] },
    { t: 0.14, scale: [0.105, 0.111], offset: [0, 0.016] },
    { t: 0.26, scale: [0.088, 0.094] },
  ])),
  part('KneeBoss.L', 'LowerLeg.L', 'Trim', limb(leg.knee, leg.ankle, DOME, [
    { t: -0.08, scale: 0.040, offset: [0, 0.108] },
    { t: 0.03, scale: 0.046, offset: [0, 0.120] },
    { t: 0.12, scale: 0.032, offset: [0, 0.110] },
  ])),
  part('PistonSleeve.L', 'LowerLeg.L', 'Metal', limb(leg.knee, leg.ankle, ROD, [
    { t: -0.10, scale: 0.028, offset: [OUT * 0.046, -0.098] },
    { t: 0.30, scale: 0.026, offset: [OUT * 0.046, -0.092] },
  ])),
  part('GreaveTrim.L', 'LowerLeg.L', 'Trim', limb(leg.knee, leg.ankle, PLATE, [
    { t: 0.70, scale: [0.088, 0.094] },
    { t: 0.80, scale: [0.086, 0.092] },
  ])),
];

/**
 * The boot. Authored in world axes rather than along the bone, because the foot bone runs FORWARD rather
 * than down and its local frame reads backwards in a table.
 *
 * `Sole` is the one solid that touches y = 0, and that is not cosmetic: standing height is measured off it
 * and the driver seats it on the deck from the solver's ankle, so daylight authored under the sole is
 * daylight under the rider. The ankle joint sits 11.5 cm up, which lands the sole on the binding rather
 * than through the deck.
 */
const BOOT_PARTS: FigurePart[] = [
  part('Sole.L', 'Foot.L', 'Suit', extrude(PLATE, [
    { y: 0.000, scale: [0.102, 0.162], offset: [0.112, 0.050] },
    { y: 0.046, scale: [0.105, 0.166], offset: [0.112, 0.050] },
  ])),
  part('Sabaton.L', 'Foot.L', 'Plate', extrude(PLATE, [
    { y: 0.032, scale: [0.103, 0.163], offset: [0.112, 0.050] },
    { y: 0.132, scale: [0.108, 0.170], offset: [0.112, 0.046] },
    { y: 0.234, scale: [0.100, 0.132], offset: [0.112, 0.006] },
  ])),
  part('ToeCap.L', 'Foot.L', 'Metal', hexahedron([
    [0.018, 0.028, 0.140], [0.018, 0.028, 0.216], [0.206, 0.028, 0.216], [0.206, 0.028, 0.140],
    [0.028, 0.130, 0.140], [0.028, 0.130, 0.196], [0.196, 0.130, 0.196], [0.196, 0.130, 0.140],
  ])),
  part('BootTrim.L', 'Foot.L', 'Trim', extrude(PLATE, [
    { y: 0.156, scale: [0.107, 0.152], offset: [0.112, 0.030] },
    { y: 0.182, scale: [0.106, 0.147], offset: [0.112, 0.026] },
  ])),
  part('AnkleGuard.L', 'Foot.L', 'Plate', extrude(PLATE, [
    { y: 0.204, scale: [0.094, 0.102], offset: [0.112, 0.008] },
    { y: 0.298, scale: [0.089, 0.097], offset: [0.112, 0.010] },
  ])),
  // A marker light on the outside of each boot. Low down and outboard is where it is still visible when the
  // rider is laid over in a carve and the torso lights have rotated away from the camera.
  part('MarkerLight.L', 'Foot.L', 'Lamp', box([0.212, 0.096, 0.010], [0.230, 0.132, 0.086]), LIGHT_CELL.dot),
];

/**
 * One armoured plate per finger bone, built FROM the bones rather than beside them.
 *
 * Every other part of this figure is a table of numbers that has to agree with the skeleton; thirty finger
 * segments would be thirty chances to disagree. Reading `head`/`tail` off the bone instead makes that class
 * of mistake impossible, and it is also why these are not mirrored: both hands' bones already exist, so each
 * plate is built in place and the handedness takes care of itself.
 */
const FINGER_NAME = /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)(\d)$/;

function digitPlates(): FigurePart[] {
  const plates: FigurePart[] = [];
  for (const bone of BONES) {
    const match = FINGER_NAME.exec(bone.name);
    if (!match) continue;
    const [, side, digit, index] = match;
    const segment = Number(index);
    const tip = !BONES.some(other => other.name === `${side}Hand${digit}${segment + 1}`);
    // Fingers narrow toward the tip; the thumb is the thick one and the pinky the thin one.
    const taper = 1 - 0.12 * (segment - 1);
    const wide = (digit === 'Thumb' ? 0.018 : digit === 'Pinky' ? 0.0135 : 0.016) * taper;
    const deep = (digit === 'Thumb' ? 0.019 : 0.017) * taper;
    plates.push(part(`${bone.name}Plate`, bone.name, tip ? 'Metal' : 'Plate',
      limb(bone.head, bone.tail, FINGER, [
        { t: -0.14, scale: [deep * 0.94, wide * 0.94] },
        { t: 0.50, scale: [deep, wide] },
        { t: 1.08, scale: [deep * 0.84, wide * 0.86] },
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

export const ALPINE_EXO: FigureSpec = {
  name: 'AlpineExo',
  meshName: 'AlpineExoMesh',
  rigProfile: 'slopesmith-character-armoured-v1',
  generatedBy: 'Slopesmith/tools/character-models/alpine-exo.ts',
  bones: BONES,
  palette: PALETTE,
  parts: PARTS,
  textures: [lightAtlas(), conduitStrip()],
};

/** The three.js figure, for previews and posed renders. The emissive masks live in the exported bytes
 *  rather than on these materials, so a direct render of this group shows the flat colours only. */
export function buildAlpineExo(): Group {
  return buildFigure(ALPINE_EXO);
}

export async function exportAlpineExoGlb(): Promise<Uint8Array> {
  return exportCharacterGlb(ALPINE_EXO);
}

/** The bind pose the parts table was authored against, so a check can measure the same thing. */
export const BIND = { armSpread: ARM_SPREAD, arm, leg, footLength: FOOT_LENGTH, handLength: HAND_LENGTH };

const DEFAULT_OUTPUT = fileURLToPath(new URL('../../public/characters/alpine-exo-rigged.glb', import.meta.url));

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCharacterBuild(DEFAULT_OUTPUT, exportAlpineExoGlb)
    .catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}

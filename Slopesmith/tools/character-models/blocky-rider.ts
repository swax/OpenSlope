#!/usr/bin/env -S npx tsx
/**
 * The blocky rider: a built-in character built out of boxes, from numbers rather than from a .blend.
 *
 * A blocky, voxel-styled avatar does not need Blender: it is twenty axis-aligned boxes, each rigidly bound
 * to one bone with a single weight of 1. That makes the model's real source a table of corners, which
 * reviews as a diff, regenerates with
 * `npx tsx`, and can be re-proportioned by editing one number.
 *
 *   npx tsx tools/character-models/blocky-rider.ts [OUT.glb]
 *
 * writes `public/characters/blocky-rider-rigged.glb` (part of the client build) and refuses to write a file
 * that would fail `check.ts`.
 *
 * ## Why it is shaped the way it is
 *
 * The skeleton, the solid builders and the export live in `figure.ts`, which explains the constraint the
 * joint layout answers to. In short: the driver only rotates an imported skeleton, so segment lengths are
 * the procedural rider's and are not ours to choose. Bind pose is that same rider standing — feet flat at
 * y = 0, arms hanging straight, facing +Z.
 *
 * What IS free is everything the driver never measures — box thickness, head size, boots, mitts. That is
 * where the blocky look comes from: a head almost as wide as the shoulders, limbs a third thicker than the
 * bones inside them, and a hat, so the figure reads as a toy while still riding like the rider it replaces.
 *
 * One bone per box is what makes the silhouette read as blocks rather than as low-poly, and it leaves a
 * joint no smooth deformation to fall back on. Every limb box instead OVERLAPS the joint at both of its
 * ends (see `PARTS`), so a bend buries the seam inside the neighbouring block instead of opening a gap —
 * which is why nothing here needs more than one influence per vertex.
 */

import { Group } from 'three';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  CLAVICLE_Y, ELBOW_Y, HELMET_Y, HEAD_BONE_Y, HIP_SOCKET_Y, KNEE_Y, SHOULDER_Y, UPPER_BACK_Y, V3, WRIST_Y,
  ANKLE_Y, box, buildFigure, exportFigureGlb, riderBones, runCharacterBuild,
} from './figure';

/** Segment lengths are the procedural rider's, so a boot solved onto the deck arrives on the deck. */
export const BONES = riderBones({ footLength: 0.16, handLength: 0.12 });

/* ── Materials ─────────────────────────────────────────────────────────────────────────────────────────
 * Flat colours, no textures and no images, so the GLB stays self-contained and a re-colour is one hex
 * digit rather than a repaint. Named for what they clothe, because these names are what a person sees
 * after opening the file in Blender.
 */
const PALETTE = [
  { name: 'Jacket', color: 0xe0563f },
  { name: 'Pants', color: 0x33415c },
  { name: 'Gear', color: 0x1d2430 },   // boots, mitts, goggle frame
  { name: 'Skin', color: 0xd99a6c },
  { name: 'Beanie', color: 0xf0a23a },
  { name: 'Lens', color: 0x6fd3e8 },
] as const;

type MaterialName = (typeof PALETTE)[number]['name'];

interface PartSpec {
  name: string;
  bone: string;
  material: MaterialName;
  /** Bind world corners, low and high on every axis. Boxes are given as corners rather than as a centre
   *  and a size because what has to be legible here is where a block STOPS relative to the joint it
   *  crosses — the overlaps below are load-bearing, and a centre hides them. */
  min: V3;
  max: V3;
}

/** Mirror a left-side entry onto the right: negating x swaps which corner is the low one. */
function mirror(part: PartSpec): PartSpec {
  return {
    name: part.name.replace(/\.L$/, '.R'),
    bone: part.bone.replace(/\.L$/, '.R'),
    material: part.material,
    min: [-part.max[0], part.min[1], part.min[2]],
    max: [-part.min[0], part.max[1], part.max[2]],
  };
}

/**
 * The left arm and leg.
 *
 * Two things here are deliberate. Every limb block runs PAST its joint at both ends, so a bend buries the
 * seam in the neighbouring block instead of opening a gap — that is the price of one influence per vertex.
 * And the arm blocks sit outboard of their sockets: an anatomical shoulder is only 16.5 cm off the spine,
 * so a sleeve centred on the bone disappears inside a parka this size. Hanging the block outside the
 * socket puts the pivot at its inner-top corner, which is where a blocky avatar's arm turns anyway.
 */
const LEFT_PARTS: PartSpec[] = [
  { name: 'UpperArm.L', bone: 'UpperArm.L', material: 'Jacket', min: [0.13, ELBOW_Y - 0.035, -0.11], max: [0.32, SHOULDER_Y + 0.06, 0.11] },
  { name: 'LowerArm.L', bone: 'LowerArm.L', material: 'Jacket', min: [0.1375, WRIST_Y - 0.02, -0.1025], max: [0.3125, ELBOW_Y + 0.035, 0.1025] },
  { name: 'Mitt.L', bone: 'Hand.L', material: 'Gear', min: [0.1325, WRIST_Y - 0.16, -0.095], max: [0.3175, WRIST_Y + 0.02, 0.115] },
  // Snow pants do not taper, so the two leg blocks are one column with the knee buried in it.
  { name: 'UpperLeg.L', bone: 'UpperLeg.L', material: 'Pants', min: [0.0225, KNEE_Y - 0.04, -0.105], max: [0.2125, HIP_SOCKET_Y + 0.05, 0.115] },
  { name: 'LowerLeg.L', bone: 'LowerLeg.L', material: 'Pants', min: [0.0225, ANKLE_Y - 0.025, -0.10], max: [0.2125, KNEE_Y + 0.04, 0.11] },
  // The boot's sole IS y = 0. Standing height is measured off it and the driver seats it on the deck from
  // the solver's ankle, so daylight authored under the sole would be daylight under the rider.
  { name: 'Boot.L', bone: 'Foot.L', material: 'Gear', min: [0.010, 0, -0.11], max: [0.220, 0.235, 0.20] },
];

/**
 * Everything is written against the landmarks above rather than as absolute heights, so re-proportioning
 * the rider carries the geometry with the skeleton instead of leaving the head where it used to be.
 *
 * `HELMET_Y` — the head bone's own tail, and the centre of the procedural rider's helmet — is what the
 * whole head assembly hangs off. That block is where the toy proportions live: the driver never measures
 * it, so it can be four and a bit heads tall the way a minifig is, while every joint below stays exactly
 * where a 1.70 m rider's joint is.
 */
export const PARTS: readonly PartSpec[] = [
  { name: 'Pelvis', bone: 'Hips', material: 'Pants', min: [-0.18, HIP_SOCKET_Y - 0.04, -0.145], max: [0.18, UPPER_BACK_Y - 0.02, 0.145] },
  { name: 'Jacket', bone: 'Chest', material: 'Jacket', min: [-0.19, UPPER_BACK_Y - 0.103, -0.16], max: [0.19, CLAVICLE_Y + 0.055, 0.16] },
  { name: 'Collar', bone: 'Neck', material: 'Jacket', min: [-0.10, CLAVICLE_Y - 0.02, -0.10], max: [0.10, HEAD_BONE_Y + 0.005, 0.10] },
  { name: 'Head', bone: 'Head', material: 'Skin', min: [-0.20, HELMET_Y - 0.17, -0.17], max: [0.20, HELMET_Y + 0.11, 0.19] },
  { name: 'Beanie', bone: 'Head', material: 'Beanie', min: [-0.21, HELMET_Y + 0.08, -0.18], max: [0.21, HELMET_Y + 0.28, 0.20] },
  // One band right around the skull rather than a patch on the face: from the side and from a chase camera
  // that reads as goggles on a strap, and it leaves the tan face exactly where a face belongs.
  { name: 'Goggles', bone: 'Head', material: 'Gear', min: [-0.205, HELMET_Y - 0.04, -0.185], max: [0.205, HELMET_Y + 0.07, 0.205] },
  { name: 'Lens', bone: 'Head', material: 'Lens', min: [-0.145, HELMET_Y - 0.023, 0.20], max: [0.145, HELMET_Y + 0.052, 0.222] },
  { name: 'Mouth', bone: 'Head', material: 'Gear', min: [-0.0575, HELMET_Y - 0.125, 0.183], max: [0.0575, HELMET_Y - 0.103, 0.197] },
  ...LEFT_PARTS,
  ...LEFT_PARTS.map(mirror),
];

export function buildBlockyRider(): Group {
  return buildFigure({
    name: 'BlockyRider',
    meshName: 'BlockyRiderMesh',
    rigProfile: 'slopesmith-character-blocky-v1',
    generatedBy: 'Slopesmith/tools/character-models/blocky-rider.ts',
    bones: BONES,
    palette: PALETTE,
    parts: PARTS.map(part => ({
      name: part.name, bone: part.bone, material: part.material, shape: box(part.min, part.max),
    })),
  });
}

export async function exportBlockyRiderGlb(): Promise<Uint8Array> {
  return exportFigureGlb(buildBlockyRider());
}

const DEFAULT_OUTPUT = fileURLToPath(new URL('../../public/characters/blocky-rider-rigged.glb', import.meta.url));

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCharacterBuild(DEFAULT_OUTPUT, exportBlockyRiderGlb)
    .catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}

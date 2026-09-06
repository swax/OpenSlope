#!/usr/bin/env -S npx tsx
/**
 * The stick figure: a generated full-body tracking diagnostic, not a Blender artifact.
 *
 *   npx tsx tools/character-models/stick-figure.ts [OUT.glb]
 *
 * The old built-in was a hand-exported 22-bone GLB with no reproducible source and a 2.19 m standing
 * height. This replacement uses the same canonical skeleton and deterministic exporter as the other built-in
 * characters. Its geometry is deliberately an instrument rather than a costume:
 *
 * - left and right chains have different colours;
 * - cyan and magenta rails mark the front and rear of every long body segment;
 * - bright beads expose the actual joint pivots;
 * - palms have distinct palm/back plates and feet have toe/heel markers;
 * - all five digits are articulated, colour coded, and end in visible fingertip targets.
 *
 * Those cues make a swapped limb, 180-degree bone roll, inverted palm, bad foot frame, missing joint, or
 * incorrect finger curl readable from a headset capture without needing the mesh itself to look human.
 */

import { Group } from 'three';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  HELMET_Y, HIP_HALF, UPPER_BACK_Y,
  BoneSpec, Digit, DigitSpec, FigurePart, FigureSpec, ShapeMesh, V3,
  armChain, box, buildFigure, chamferProfile, exportCharacterGlb, extrude, legChain, limb,
  riderBones, roundProfile, runCharacterBuild,
} from './figure';

/** A slight A-pose keeps both hands clear of the hips in an unposed asset preview. */
const ARM_SPREAD = 18;
const FOOT_LENGTH = 0.18, HAND_LENGTH = 0.084;

/**
 * A complete hand in the hand bone's frame: +X faces out of the palm, +Y runs toward the knuckles, and +Z
 * crosses toward the thumb. The proportions are the driver's known-good open/fist diagnostic proportions:
 * two thumb segments and three per finger against its fixed curl angles.
 */
export const DIGITS: readonly DigitSpec[] = [
  { digit: 'thumb', base: [0.002, 0.036, 0.054], direction: [0.30, 0.56, 0.77], segments: [0.034, 0.027] },
  { digit: 'index', base: [0.004, 0.078, 0.050], direction: [0.02, 1, 0.05], segments: [0.031, 0.024, 0.019] },
  { digit: 'middle', base: [0.004, 0.083, 0.017], direction: [0.02, 1, 0.00], segments: [0.034, 0.026, 0.020] },
  { digit: 'ring', base: [0.004, 0.078, -0.017], direction: [0.02, 1, -0.03], segments: [0.031, 0.024, 0.019] },
  { digit: 'pinky', base: [0.004, 0.068, -0.050], direction: [0.02, 1, -0.07], segments: [0.027, 0.020, 0.017] },
];

export const BONES = riderBones({
  footLength: FOOT_LENGTH, handLength: HAND_LENGTH, armSpread: ARM_SPREAD, digits: DIGITS,
});

export const PALETTE = [
  { name: 'Axial', color: 0xe7edf2, metalness: 0.02, roughness: 0.72 },
  { name: 'Joint', color: 0xffffff, metalness: 0.05, roughness: 0.38 },
  { name: 'Left', color: 0x86f02f, metalness: 0, roughness: 0.62 },
  { name: 'Right', color: 0xff9d24, metalness: 0, roughness: 0.62 },
  { name: 'FrontPalm', color: 0x00d9ff, metalness: 0, roughness: 0.48 },
  { name: 'RearBack', color: 0xff3fae, metalness: 0, roughness: 0.48 },
  { name: 'Thumb', color: 0xffdc3f, metalness: 0, roughness: 0.56 },
  { name: 'Index', color: 0x61f58c, metalness: 0, roughness: 0.56 },
  { name: 'Middle', color: 0x44a8ff, metalness: 0, roughness: 0.56 },
  { name: 'Ring', color: 0xb87aff, metalness: 0, roughness: 0.56 },
  { name: 'Pinky', color: 0xff6c62, metalness: 0, roughness: 0.56 },
] as const;

type MaterialName = (typeof PALETTE)[number]['name'];

const ROD = roundProfile(8, 22.5);
const TRACE = roundProfile(6);
const BEAD = roundProfile(8, 22.5);
const PALM = chamferProfile(0.22);

const part = (name: string, bone: string, material: MaterialName, shape: ShapeMesh): FigurePart =>
  ({ name, bone, material, shape });

const bone = (name: string): BoneSpec => {
  const found = BONES.find(entry => entry.name === name);
  if (!found) throw new Error(`stick figure names unknown bone ${name}`);
  return found;
};

/** A faceted bead centred on a world-space tracking landmark. It is bound to the child bone whose head owns
 * the pivot, so the bead stays on the joint as that child rotates. */
function bead(at: V3, radius: number): ShapeMesh {
  return extrude(BEAD, [
    { y: at[1] - radius, scale: [radius * 0.38, radius * 0.38], offset: [at[0], at[2]] },
    { y: at[1], scale: radius, offset: [at[0], at[2]] },
    { y: at[1] + radius, scale: [radius * 0.38, radius * 0.38], offset: [at[0], at[2]] },
  ]);
}

function sideMaterial(name: string): MaterialName {
  if (name.endsWith('.L')) return 'Left';
  if (name.endsWith('.R')) return 'Right';
  return 'Axial';
}

function radiusFor(name: string): number {
  if (name === 'Hips' || name === 'Spine' || name === 'Chest') return 0.026;
  if (name === 'Neck' || name === 'Head') return 0.018;
  if (name.startsWith('Clavicle') || name.startsWith('Pelvis.')) return 0.014;
  if (name.startsWith('UpperLeg')) return 0.024;
  if (name.startsWith('LowerLeg')) return 0.021;
  if (name.startsWith('UpperArm')) return 0.021;
  if (name.startsWith('LowerArm')) return 0.018;
  if (name.startsWith('Foot')) return 0.019;
  return 0.016;
}

function stickShape(spec: BoneSpec, radius: number): ShapeMesh {
  return limb(spec.head, spec.tail, ROD, [
    { t: -0.055, scale: radius * 0.92 },
    { t: 0.50, scale: radius },
    { t: 1.055, scale: radius * 0.92 },
  ], spec.roll);
}

/** Bones whose roll is body-forward. Feet and hands have more useful explicit orientation markers below. */
const TRACED = /^(Hips|Spine|Chest|Neck|Head|UpperArm\.[LR]|LowerArm\.[LR]|UpperLeg\.[LR]|LowerLeg\.[LR])$/;

function tracedBoneParts(spec: BoneSpec): FigurePart[] {
  const radius = radiusFor(spec.name);
  const result = [part(`${spec.name}.Stick`, spec.name, sideMaterial(spec.name), stickShape(spec, radius))];
  if (!TRACED.test(spec.name)) return result;
  for (const [label, material, direction] of [
    ['Front', 'FrontPalm', 1], ['Rear', 'RearBack', -1],
  ] as const) {
    result.push(part(`${spec.name}.${label}Rail`, spec.name, material,
      limb(spec.head, spec.tail, TRACE, [
        { t: 0.08, scale: 0.0042, offset: [0, direction * radius * 1.04] },
        { t: 0.92, scale: 0.0042, offset: [0, direction * radius * 1.04] },
      ], spec.roll)));
  }
  return result;
}

const DIGIT_BONE = /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)(\d)$/;
const digitMaterial: Record<Digit, MaterialName> = {
  thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Pinky',
};

function digitParts(): FigurePart[] {
  const result: FigurePart[] = [];
  for (const spec of BONES) {
    const match = DIGIT_BONE.exec(spec.name);
    if (!match) continue;
    const digit = match[2].toLowerCase() as Digit;
    const segment = Number(match[3]);
    const radius = digit === 'thumb' ? 0.0070 : digit === 'pinky' ? 0.0050 : 0.0058;
    result.push(part(`${spec.name}.Stick`, spec.name, digitMaterial[digit],
      limb(spec.head, spec.tail, TRACE, [
        { t: -0.10, scale: radius }, { t: 1.07, scale: radius * 0.82 },
      ], spec.roll)));
    result.push(part(`${spec.name}.Joint`, spec.name, digitMaterial[digit], bead(spec.head, radius * 1.42)));
    const next = BONES.some(other => other.name === `${match[1]}Hand${match[2]}${segment + 1}`);
    if (!next) result.push(part(`${spec.name}.Tip`, spec.name, 'Joint', bead(spec.tail, radius * 1.62)));
  }
  return result;
}

/** Major pivot markers. Connector heads that coincide at the centreline are deliberately omitted: one white
 * root bead is clearer than two perfectly overlapping side-colour beads. */
const JOINT_BONES = new Set([
  'Hips', 'Spine', 'Chest', 'Neck', 'Head',
  'UpperArm.L', 'LowerArm.L', 'Hand.L', 'UpperArm.R', 'LowerArm.R', 'Hand.R',
  'UpperLeg.L', 'LowerLeg.L', 'Foot.L', 'UpperLeg.R', 'LowerLeg.R', 'Foot.R',
]);

function bodyParts(): FigurePart[] {
  const result: FigurePart[] = [];
  for (const spec of BONES) {
    if (DIGIT_BONE.test(spec.name)) continue;
    result.push(...tracedBoneParts(spec));
    if (JOINT_BONES.has(spec.name)) {
      const small = spec.name === 'Neck' || spec.name === 'Head';
      result.push(part(`${spec.name}.Joint`, spec.name, 'Joint', bead(spec.head, small ? 0.022 : 0.027)));
    }
  }
  return result;
}

function palmParts(side: 'L' | 'R'): FigurePart[] {
  const spec = bone(`Hand.${side}`);
  const material = side === 'L' ? 'Left' : 'Right';
  const plate = (name: string, face: number, colour: 'FrontPalm' | 'RearBack') => part(
    `Hand.${side}.${name}`, spec.name, colour,
    limb(spec.head, spec.tail, PALM, [
      { t: 0.04, scale: [0.0042, 0.049], offset: [face * 0.022, 0] },
      { t: 0.91, scale: [0.0042, 0.054], offset: [face * 0.022, 0] },
    ], spec.roll),
  );
  return [
    part(`Hand.${side}.PalmFrame`, spec.name, material, limb(spec.head, spec.tail, PALM, [
      { t: -0.03, scale: [0.019, 0.052] }, { t: 0.96, scale: [0.019, 0.058] },
    ], spec.roll)),
    plate('PalmFace', 1, 'FrontPalm'),
    plate('HandBack', -1, 'RearBack'),
  ];
}

function footParts(side: 'L' | 'R'): FigurePart[] {
  const sign = side === 'L' ? 1 : -1;
  const x = sign * HIP_HALF;
  const material = side === 'L' ? 'Left' : 'Right';
  return [
    part(`Foot.${side}.Sole`, `Foot.${side}`, material,
      box([x - 0.046, 0, -0.048], [x + 0.046, 0.036, FOOT_LENGTH + 0.034])),
    part(`Foot.${side}.Toe`, `Foot.${side}`, 'FrontPalm',
      box([x - 0.032, 0.042, FOOT_LENGTH + 0.010], [x + 0.032, 0.092, FOOT_LENGTH + 0.050])),
    part(`Foot.${side}.Heel`, `Foot.${side}`, 'RearBack',
      box([x - 0.032, 0.042, -0.064], [x + 0.032, 0.092, -0.032])),
  ];
}

/** The head is a neutral cage with unmistakable face, rear, and crown targets. The face/rear pair repeats the
 * same cyan/magenta convention as the segment rails; the yellow crown makes head roll readable. */
const HEAD_PARTS: FigurePart[] = [
  part('Head.Cage', 'Head', 'Axial', extrude(roundProfile(12, 15), [
    { y: HELMET_Y - 0.105, scale: [0.060, 0.066] },
    { y: HELMET_Y - 0.060, scale: [0.094, 0.102] },
    { y: HELMET_Y + 0.045, scale: [0.098, 0.106] },
    { y: HELMET_Y + 0.108, scale: [0.054, 0.060] },
  ])),
  part('Head.Face', 'Head', 'FrontPalm',
    box([-0.046, HELMET_Y - 0.034, 0.096], [0.046, HELMET_Y + 0.043, 0.124])),
  part('Head.Rear', 'Head', 'RearBack',
    box([-0.040, HELMET_Y - 0.027, -0.122], [0.040, HELMET_Y + 0.036, -0.098])),
  part('Head.Crown', 'Head', 'Thumb',
    box([-0.026, HELMET_Y + 0.098, -0.026], [0.026, HELMET_Y + 0.142, 0.026])),
];

/** Larger torso targets remain readable when the thin rails are reduced to a few headset pixels. */
const TORSO_TARGETS: FigurePart[] = [
  part('Chest.FrontTarget', 'Chest', 'FrontPalm',
    box([-0.034, UPPER_BACK_Y + 0.075, 0.028], [0.034, UPPER_BACK_Y + 0.145, 0.052])),
  part('Chest.RearTarget', 'Chest', 'RearBack',
    box([-0.029, UPPER_BACK_Y + 0.080, -0.050], [0.029, UPPER_BACK_Y + 0.140, -0.028])),
];

export const PARTS: readonly FigurePart[] = [
  ...bodyParts(),
  ...palmParts('L'), ...palmParts('R'),
  ...footParts('L'), ...footParts('R'),
  ...digitParts(),
  ...HEAD_PARTS,
  ...TORSO_TARGETS,
];

export const STICK_FIGURE: FigureSpec = {
  name: 'TrackingStickFigure',
  meshName: 'TrackingStickFigureMesh',
  rigProfile: 'slopesmith-character-tracking-diagnostic-v2',
  generatedBy: 'Slopesmith/tools/character-models/stick-figure.ts',
  bones: BONES,
  palette: PALETTE,
  parts: PARTS,
};

export function buildStickFigure(): Group {
  return buildFigure(STICK_FIGURE);
}

export async function exportStickFigureGlb(): Promise<Uint8Array> {
  return exportCharacterGlb(STICK_FIGURE);
}

export const BIND = {
  armSpread: ARM_SPREAD,
  arm: armChain('L', ARM_SPREAD, HAND_LENGTH),
  leg: legChain('L', FOOT_LENGTH),
  footLength: FOOT_LENGTH,
  handLength: HAND_LENGTH,
};

const DEFAULT_OUTPUT = fileURLToPath(new URL('../../public/characters/stick-figure-rigged.glb', import.meta.url));

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCharacterBuild(DEFAULT_OUTPUT, exportStickFigureGlb)
    .catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}

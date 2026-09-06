// tier: fast

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Image } from '@napi-rs/canvas';
import { Quaternion, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { retargetFootWorldRotation } from '../src/app/ride/character-rig';
import { convertMixamoFbx, mixamoBoneKey } from '../src/server/routes/mixamo-character';
import { must } from './check';

must(mixamoBoneKey('mixamorig:Hips') === 'Hips', 'ordinary Mixamo namespace');
must(mixamoBoneKey('mixamorig6:LeftForeArm') === 'LeftForeArm', 'numbered Mixamo namespace');

/** A tiny ASCII FBX which reaches texture loading, then fails the later visible-weight validation. */
function externalTextureFbx(imagePath: string): Buffer {
  const bones = [
    'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'HeadTopEnd',
    'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'LeftHandMiddle1',
    'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand', 'RightHandMiddle1',
    'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
    'RightUpLeg', 'RightLeg', 'UnsupportedRightFoot', 'RightToeBase',
  ];
  const objects = bones.map((name, index) => `
    Model: ${100 + index}, "Model::mixamorig:${name}", "LimbNode" {
      Version: 232
      Properties70:  {
        P: "Lcl Translation", "Lcl Translation", "", "A",${index * 3},${20 + index * 4},${index % 2}
      }
    }
    Deformer: ${200 + index}, "SubDeformer::${name}", "Cluster" {
      Version: 100
      Indexes: *3 {
        a: 0,1,2
      }
      Weights: *3 {
        a: ${index === 0 ? '1,1,1' : '0,0,0'}
      }
      TransformLink: *16 {
        a: 1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1
      }
    }`).join('');
  const connections = bones.map((_name, index) => `
    C: "OO",${100 + index},0
    C: "OO",${100 + index},${200 + index}
    C: "OO",${200 + index},6`).join('');
  const path = imagePath.replace(/\\/g, '/');
  const ascii = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
  FBXHeaderVersion: 1003
  FBXVersion: 7400
}
Objects:  {
  Video: 1, "Video::external", "Clip" {
    Type: "Clip"
    Filename: "${path}"
    RelativeFilename: "${path}"
  }
  Texture: 2, "Texture::external", "" {
    Type: "TextureVideoClip"
    Version: 202
    TextureName: "Texture::external"
    FileName: "${path}"
  }${objects}
  Geometry: 4, "Geometry::Triangle", "Mesh" {
    Vertices: *9 {
      a: 0,0,0,100,0,0,0,100,0
    }
    PolygonVertexIndex: *3 {
      a: 0,1,-3
    }
    LayerElementUV: 0 {
      MappingInformationType: "ByPolygonVertex"
      ReferenceInformationType: "Direct"
      UV: *6 {
        a: 0,0,1,0,0,1
      }
    }
  }
  Model: 5, "Model::Mesh", "Mesh" {
    Version: 232
  }
  Deformer: 6, "Deformer::Skin", "Skin" {
    Version: 101
  }
  Material: 7, "Material::External", "" {
    Version: 102
    ShadingModel: "phong"
    Properties70:  {
      P: "DiffuseColor", "Color", "", "A",1,1,1
    }
  }
  Model: 3, "Model::Root", "Null" {
    Version: 232
  }
}
Connections:  {
  C: "OO",1,2
  C: "OO",3,0
  C: "OO",4,5
  C: "OO",5,0
  C: "OO",6,4
  C: "OO",7,5
  C: "OP",2,7,"DiffuseColor"${connections}
}`;
  // FBXLoader's ASCII parser treats leading tabs as structural depth; spaces are presentation only.
  return Buffer.from(ascii.replace(/^( +)/gm, spaces => '\t'.repeat(spaces.length / 2)));
}

// @napi-rs/canvas interprets a string assigned to Image.src as a server pathname. Spy immediately beneath
// Slopesmith's bridge: the external source must be rejected without ever reaching that native setter, even
// though parsing continues and the deliberately unweighted model subsequently fails its own validation.
const nativeSource = Object.getOwnPropertyDescriptor(Image.prototype, 'src');
if (!nativeSource?.set) throw new Error('test image decoder has no source setter');
const nativeAssignments: unknown[] = [];
Object.defineProperty(Image.prototype, 'src', {
  configurable: true,
  get: nativeSource.get,
  set(this: Image, value: unknown) {
    nativeAssignments.push(value);
    nativeSource.set!.call(this, value);
  },
});
let rejectedAfterParse = '';
try {
  const readableServerPng = resolve(import.meta.dirname, '..', 'public', 'icon-192.png');
  await convertMixamoFbx(externalTextureFbx(readableServerPng), 'external-texture.fbx');
} catch (error) { rejectedAfterParse = error instanceof Error ? error.message : String(error); }
must(/supported Mixamo humanoid.*Foot\.R/i.test(rejectedAfterParse),
  'the external-texture fixture reaches the model validation after texture parsing');
must(nativeAssignments.length === 0,
  'external FBX texture paths never reach the native image source setter');
nativeAssignments.length = 0;
const embeddedPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
try {
  await convertMixamoFbx(externalTextureFbx(`data:image/png;base64,${embeddedPng}`), 'embedded-texture.fbx');
} catch { /* the same deliberately unsupported skeleton is expected after its embedded image decodes */ }
must(nativeAssignments.length === 1 && Buffer.isBuffer(nativeAssignments[0]),
  'embedded image data is size-checked and handed to the native decoder as bytes, never as a source string');

// The importer owns character sizing as one uniform standing-bounds fit. Runtime posing must not apply a
// second, per-bone proportion fit: Mixamo HeadTop_End locations vary wildly between otherwise valid avatars.
const rigRuntime = readFileSync(resolve(import.meta.dirname, '..', 'src', 'app', 'ride', 'character-rig.ts'), 'utf8');
must(rigRuntime.includes('_world.compose(_boneHead, rotation, state.restWorldScale)'),
  'runtime preserves the uniformly fitted imported bone scale');
must(!rigRuntime.includes('length / state.sourceLength') && !rigRuntime.includes('BODY_WIDTH_SCALE'),
  'runtime does not stretch or narrow individual imported body parts');
// The one sanctioned departure from that scale, and it has to STAY one: the first-person head (docs/048), which
// is hidden by collapsing its bone because a skinned character has no head object to hide. Anything else
// reaching for a scale here would be the per-bone proportion fit the two checks above exist to forbid.
must((rigRuntime.match(/_world\.compose\(/g) ?? []).length === 2
  && rigRuntime.includes("this.firstPerson && name === 'Head'")
  && rigRuntime.includes('multiplyScalar(HEAD_HIDE_SCALE)'),
  'the only bone drawn at anything but its imported scale is the first-person head');
must(rigRuntime.includes('restLocalPosition: object.position.clone()')
  && rigRuntime.includes('state.restLocalPosition).applyMatrix4(parent.matrixWorld)'),
  'runtime preserves imported descendant joint offsets instead of pinching them onto procedural landmarks');
must(rigRuntime.includes("this.sideSwap = _sideL.sub(_sideR).dot(p.along) < 0"),
  'runtime derives front/rear chain assignment from imported joint placement');
must(rigRuntime.includes("this.orientFoot('Foot.L', _footDirection, p.soleUp)")
  && rigRuntime.includes("this.orientFoot('Foot.R', _footDirection, p.soleUp)"),
  'swapped foot directions originate at their matching swapped ankles');
must(rigRuntime.includes('boardFootAxes(p, _boardToe, _boardAlong)')
  && rigRuntime.includes('retargetFootWorldRotation(state.restWorldRotation, this.restUp, up, forward, _rotation)'),
  'imported feet follow the banked board sole plane instead of the upright body axis');
must(!rigRuntime.includes('_footRoll') && rigRuntime.includes('.multiply(restWorldRotation)'),
  'foot posing retains each asset bind rotation instead of assuming a mirrored local X sole axis');
const poseRuntime = readFileSync(resolve(import.meta.dirname, '..', 'src', 'app', 'ride', 'pose.ts'), 'utf8');
must(poseRuntime.includes('soleUp.copy(WORLD_UP).applyQuaternion(q)'),
  'foot sole normal comes from the exact quaternion used to render the board');

// A rotation-only retarget cannot point an inclined ankle-to-toe bone horizontally and keep its sole flat.
// Moving the complete bind frame instead maps the authored sole normal exactly and preserves that inclination.
const restUp = new Vector3(0, 1, 0);
const targetUp = new Vector3(0.31, 0.94, -0.14).normalize();
const targetForward = new Vector3(0.2, 0, 1).addScaledVector(targetUp, -new Vector3(0.2, 0, 1).dot(targetUp)).normalize();
for (const [label, restRotation] of [
  ['inclined Mixamo foot', new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 132 * Math.PI / 180)],
  ['mirrored authored foot', new Quaternion().setFromAxisAngle(new Vector3(0.3, 0.8, 0.5).normalize(), Math.PI)],
] as const) {
  const soleLocal = restUp.clone().applyQuaternion(restRotation.clone().invert());
  const restBoneY = new Vector3(0, 1, 0).applyQuaternion(restRotation);
  const posedRotation = retargetFootWorldRotation(restRotation, restUp, targetUp, targetForward);
  const posedSole = soleLocal.applyQuaternion(posedRotation);
  const posedBoneY = new Vector3(0, 1, 0).applyQuaternion(posedRotation);
  must(posedSole.angleTo(targetUp) < 1e-6, `${label} sole maps exactly onto the board`);
  must(Math.abs(restBoneY.dot(restUp) - posedBoneY.dot(targetUp)) < 1e-6,
    `${label} preserves its authored ankle-to-toe inclination`);
}

// An optional local FBX fixture exercises the real binary parser/exporter when available; the deterministic
// name-profile checks above still run in clean CI.
const sample = resolve(import.meta.dirname, '..', '..', 'ice-cream-social', 'models', 'Y Bot.fbx');
if (!existsSync(sample)) {
  console.log('skip Mixamo FBX round trip (optional local fixture is unavailable)');
  process.exit(0);
}

const converted = await convertMixamoFbx(readFileSync(sample), 'Y Bot.fbx');
const bytes = converted.glb;
must(bytes.toString('ascii', 0, 4) === 'glTF', 'server conversion returns a binary glTF');
must(converted.report.file === 'Y-Bot-rigged.glb', 'catalog-safe rigged filename');
must(converted.report.meshes === 2, 'all Y Bot skinned mesh parts survive');
must(converted.report.unweightedVertices === 0, 'all exported vertices remain weighted');
must(converted.report.heightMetres > 1.7 && converted.report.heightMetres < 1.9, 'Mixamo centimetres become metres');

const jsonLength = bytes.readUInt32LE(12);
const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim()) as {
  nodes: { name?: string; children?: number[]; extras?: Record<string, unknown> }[];
  skins?: { joints: number[] }[];
};
const parents = new Map<number, number>();
gltf.nodes.forEach((node, parent) => node.children?.forEach(child => parents.set(child, parent)));
const nodeIndex = (name: string) => gltf.nodes.findIndex(node => node.name === name);
const parentName = (name: string) => gltf.nodes[parents.get(nodeIndex(name))!]?.name;
must(parentName('Spine') === 'Hips', 'spine hierarchy is preserved');
must(parentName('Chest') === 'Spine', 'chest hierarchy is preserved');
must(parentName('UpperArm.L') === 'Clavicle.L', 'arm hierarchy is preserved');
must(parentName('LowerLeg.R') === 'UpperLeg.R', 'leg hierarchy is preserved');
must(Number(gltf.nodes[nodeIndex('UpperArm.L')].extras?.slopesmith_length_m) > 0,
  'authored bone length is exported in glTF extras');
must((gltf.skins?.length ?? 0) === converted.report.meshes, 'each mesh exports a canonical skin');

const roundTrip = await new GLTFLoader().parseAsync(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '');
let roundTripSkin: SkinnedMesh | undefined;
roundTrip.scene.traverse(object => { if (!roundTripSkin && object instanceof SkinnedMesh) roundTripSkin = object; });
must(!!roundTripSkin, 'converted GLB loads back as a skinned mesh');
const bindScale = new Vector3();
roundTripSkin!.bindMatrixInverse.decompose(new Vector3(), new Quaternion(), bindScale);
must(bindScale.distanceTo(new Vector3(1, 1, 1)) < 1e-5,
  'metre scale is baked instead of hidden in the skin bind matrix');
must(roundTrip.scene.getWorldScale(new Vector3()).distanceTo(new Vector3(1, 1, 1)) < 1e-5,
  'round-trip scene root stays unit scale');

console.log(`MIXAMO IMPORT: ${converted.report.vertices.toLocaleString()} vertices, `
  + `${converted.report.triangles.toLocaleString()} triangles, ${converted.report.outputBytes.toLocaleString()} bytes`);

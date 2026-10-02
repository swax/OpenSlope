// tier: fast

import * as THREE from 'three';
import { fadeMaterial, fadeObject } from '../src/app/viewport/shared/fade';
import { check, failures } from './check';

/**
 * The viewport's fade (viewport/shared/fade): what Course ▸ reset course does to the run it is replacing. The
 * layers it touches rebuild while it is on — a knot drag, a new checkpoint label — so applying it again must not
 * compound, and putting it back must return each material exactly as it was authored.
 */
{
  const opaque = new THREE.MeshBasicMaterial({ color: 0x71e858 });
  const glassy = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45 });
  fadeMaterial(opaque, 0.25);
  fadeMaterial(opaque, 0.25);
  check(opaque.opacity === 0.25 && opaque.transparent, 'fading twice is fading once');
  fadeMaterial(opaque, 1);
  check(opaque.opacity === 1 && !opaque.transparent, 'and 1 puts an opaque material back opaque');
  fadeMaterial(glassy, 0.25);
  check(Math.abs(glassy.opacity - 0.1125) < 1e-12, 'a translucent material fades from its own opacity');
  fadeMaterial(glassy, 1);
  check(glassy.opacity === 0.45 && glassy.transparent, 'and restores to it, still translucent');
}

{
  const root = new THREE.Group();
  const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial());
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()]);
  root.add(line, sprite, mesh);
  const all = [line.material, sprite.material, ...(mesh.material as THREE.Material[])];
  const authored = all.map(m => m.transparent); // a SpriteMaterial is born transparent; the others are not
  fadeObject(root, 0.5);
  check(all.every(m => m.opacity === 0.5 && m.transparent), 'fadeObject reaches lines, sprites and multi-material meshes');
  fadeObject(root, 1);
  check(all.every((m, i) => m.opacity === 1 && m.transparent === authored[i]),
    'and restores every one of them as it was authored');
}

if (failures) process.exitCode = 1;

import * as THREE from 'three';

type Unfaded = { opacity: number; transparent: boolean };

/**
 * Fade a material to `factor` of its own opacity (1 restores it). What the material was authored with is kept on
 * it the first time it is faded, so fading again never compounds and a restore is exact. A shared material fades
 * everywhere it is drawn — callers fade materials their own layer owns.
 */
export function fadeMaterial(material: THREE.Material, factor: number): void {
  const own = (material.userData.unfaded ??= { opacity: material.opacity, transparent: material.transparent }) as Unfaded;
  const transparent = own.transparent || factor < 1;
  if (material.transparent !== transparent) material.needsUpdate = true; // the blend state is part of the program
  material.transparent = transparent;
  material.opacity = own.opacity * factor;
}

/** fadeMaterial over every mesh / line / sprite material under `root`. */
export function fadeObject(root: THREE.Object3D, factor: number): void {
  root.traverse(node => {
    const material = (node as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!material) return;
    for (const m of Array.isArray(material) ? material : [material]) fadeMaterial(m, factor);
  });
}

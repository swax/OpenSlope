import * as THREE from 'three';
import type { Rgba } from '../../../core/paint/ground-textures';
import { AUTHORING_SKY_GEOMETRY, skyBackdrop, type SkyMeshData, type SkyRing } from '../../../core/sky/ring';
import { deriveTopColor } from '../../../core/sky/slice';
import type { Stage } from '../stage';

/**
 * The backdrop: SSX's sky, drawn the way the game draws it — an open-topped cylinder centred on the CAMERA,
 * so it never parallaxes and reads as infinitely far away no matter where you fly.
 *
 * Three surfaces, and one of them is not SSX's:
 *   wall    the horizon panorama, wrapped round the cylinder (core/sky/ring maps it continuously)
 *   ground  the disc below the rim — a level's own aerial view of the terrain under its horizon
 *   top     the engine's flat per-course fill above the ring's measured top edge. The game draws it as a full-screen sprite;
 *           the editor uses a camera-centred disc as its visual equivalent. Default colour is the mean of
 *           the panorama's own top row, which meets the rim without a seam.
 *
 * Drawn first (renderOrder well below everything) with depth test and write both off, so it lays down colour
 * that every real object then paints over — the standard backdrop pass, and the reason its radius is a free
 * choice rather than something that has to clear the terrain.
 */

/** World radius of the backdrop. Depth is off, so this only has to sit inside the camera's near/far planes. */
const SKY_RADIUS = 1200;

const geom = (m: SkyMeshData) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(m.uvs, 2));
  g.setIndex(m.indices);
  return g;
};

export interface SkyView {
  /** The horizon panorama (the stitched wall). */
  panorama: string;
  /** The ground disc below the rim. */
  ground: string;
  /** Fill for the open top, hex; absent => derived from the panorama's top row. */
  topColor?: string;
  /** Measured profile of the extracted ring this panorama was composed against. */
  ring?: SkyRing;
}

/** Convert between authored sRGB bytes/hex and Three's linear working colour exactly once. */
export function skyColorFromHex(hex: string): THREE.Color {
  return new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);
}

export function skyColorFromBytes(r: number, g: number, b: number): THREE.Color {
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
}

export function skyColorToHex(color: THREE.Color): string {
  return '#' + color.getHexString(THREE.SRGBColorSpace);
}

export function createSky(stage: Stage, onHorizonColorChange: () => void = () => {}) {
  const group = new THREE.Group();
  group.visible = false;
  group.renderOrder = -1000;

  const base = { depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false } as const;
  const wallMat = new THREE.MeshBasicMaterial({ ...base, color: 0xffffff });
  const groundMat = new THREE.MeshBasicMaterial({ ...base, color: 0x1b2430 });
  const topMat = new THREE.MeshBasicMaterial({ ...base, color: 0x35507a });

  const initial = skyBackdrop(SKY_RADIUS, AUTHORING_SKY_GEOMETRY);
  const meshes: THREE.Mesh[] = [];
  for (const [data, mat] of [[initial.wall, wallMat], [initial.ground, groundMat], [initial.top, topMat]] as const) {
    const mesh = new THREE.Mesh(geom(data), mat);
    mesh.renderOrder = -1000;
    mesh.frustumCulled = false; // it is always around the camera; culling it against its own centre is moot
    group.add(mesh);
    meshes.push(mesh);
  }
  stage.scene.add(group); // NOT worldRoot: core/sky/ring already emits three-world coords (the chirality flip is folded in)

  const loader = new THREE.TextureLoader();
  let token = 0; // a later setSky must win, however slowly an earlier one's image decodes
  // Visibility is a request, not just the group's current state: a panorama may still be decoding when the
  // caller hides it (for example, when leaving Info). The load callback must honour that later request rather
  // than making the sky pop back on when the image finally arrives.
  let visible = false;

  const syncVisibility = () => { group.visible = visible && !!wallMat.map; };

  const dispose = (m: THREE.MeshBasicMaterial) => { m.map?.dispose(); m.map = null; };

  /** The mean of the panorama's top row — the sky exactly where it runs out of geometry. */
  function topColorFrom(img: HTMLImageElement): THREE.Color {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = 1;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, img.naturalWidth, 1, 0, 0, img.naturalWidth, 1);
    const row = ctx.getImageData(0, 0, c.width, 1);
    const rgba: Rgba = { w: row.width, h: 1, data: new Uint8Array(row.data.buffer.slice(0)) };
    const [r, g, b] = deriveTopColor(rgba);
    return skyColorFromBytes(r, g, b);
  }

  /**
   * The mean of the panorama's BOTTOM row — the sky where distant geometry meets it, which is the colour a
   * range gate's haze has to fade into (`topColorFrom` samples the other end, for the ring's open top).
   * Null until a panorama is loaded; the caller then picks its own neutral.
   */
  function horizonColor(): THREE.Color | null {
    // A decoded but hidden panorama is not the active backdrop. Without this guard, riding a world with no
    // sky inherits whichever world's panorama happened to be previewed most recently.
    if (!group.visible) return null;
    const img = wallMat.map?.image as HTMLImageElement | undefined;
    if (!img?.naturalWidth || !img.naturalHeight) return null;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = 1;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, img.naturalHeight - 1, img.naturalWidth, 1, 0, 0, img.naturalWidth, 1);
    const row = ctx.getImageData(0, 0, c.width, 1);
    const rgba: Rgba = { w: row.width, h: 1, data: new Uint8Array(row.data.buffer.slice(0)) };
    // deriveTopColor means row v=0 of whatever it is handed, so the single row above IS its subject.
    const [r, g, b] = deriveTopColor(rgba);
    return skyColorFromBytes(r, g, b);
  }

  /**
   * Hang a sky. When `view.topColor` is absent the fill is DERIVED from the panorama's top row and handed
   * back through `onTopDerived` — the panel writes it onto the document, so the open-top colour is always a
   * real, editable value rather than a hidden default that silently changes with the picture.
   */
  function setSky(view: SkyView | null, onTopDerived?: (hex: string) => void) {
    const mine = ++token;
    if (!view) {
      group.visible = false;
      dispose(wallMat);
      dispose(groundMat);
      onHorizonColorChange();
      return;
    }

    const measured = skyBackdrop(SKY_RADIUS, view.ring ?? AUTHORING_SKY_GEOMETRY);
    [measured.wall, measured.ground, measured.top].forEach((data, index) => {
      meshes[index].geometry.dispose();
      meshes[index].geometry = geom(data);
    });

    loader.load(view.panorama, tex => {
      if (mine !== token) { tex.dispose(); return; }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;      // the panorama is a 360° loop: its two edges are neighbours
      tex.wrapT = THREE.ClampToEdgeWrapping; // but its top is open sky and its bottom is ground — never wrap those together
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      dispose(wallMat);
      wallMat.map = tex;
      wallMat.needsUpdate = true;
      if (view.topColor) {
        topMat.color = skyColorFromHex(view.topColor);
      } else {
        const derived = topColorFrom(tex.image as HTMLImageElement);
        topMat.color = derived;
        onTopDerived?.(skyColorToHex(derived));
      }
      syncVisibility();
      // A range may already be armed with the prior world's tint. Re-read this panorama now rather than
      // waiting for the rider to change draw-distance tier or leave and restart the run.
      onHorizonColorChange();
    });

    dispose(groundMat);
    groundMat.color = new THREE.Color(0xffffff);
    loader.load(view.ground, tex => {
      if (mine !== token) { tex.dispose(); return; }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; // a radial projection: wrapping it smears the rim
      groundMat.map = tex;
      groundMat.needsUpdate = true;
    });
  }

  /** Re-colour the open-top fill without reloading the sky (the panel's colour picker drags through here). */
  function setTopColor(hex: string | null) {
    if (hex) topMat.color = skyColorFromHex(hex);
    else if (wallMat.map?.image) topMat.color = topColorFrom(wallMat.map.image as HTMLImageElement);
  }

  function setVisible(on: boolean) {
    const wasVisible = group.visible;
    visible = on;
    syncVisibility();
    if (group.visible !== wasVisible) onHorizonColorChange();
  }

  /** Centre the backdrop on the EYE — this is what makes it infinitely far away. Called every frame.
   *  World, not local: in a VR ride the camera hangs off the headset rig and its own position is head-relative. */
  function follow(eye: THREE.Vector3) {
    group.position.copy(eye);
  }

  return { setSky, setTopColor, setVisible, follow, horizonColor, get loaded() { return !!wallMat.map; } };
}

export type SkyLayer = ReturnType<typeof createSky>;

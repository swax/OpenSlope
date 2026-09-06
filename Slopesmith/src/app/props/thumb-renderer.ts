import * as THREE from 'three';
import type { PropMaterial, PropModel, LevelProps } from '../../core/reference/props';
import type { V3 } from '../../core/doc/types';
import { CUSTOM_TEX_LEVEL, makeTexRef, resolvePropTex } from '../../core/paint/textures';
import { textureUrl } from '../net/asset-paths';
import {
  analyzeTextureImage, applyTextureAlphaMode, resolvePropAlphaMode, type TextureAlphaAnalysis,
} from './texture-alpha';

/** One model of an assembly view: the model plus its group-local pose (editor metres / degrees, the
 *  GroupPropDef fields — zero for mined members, whose offsets are baked into the geometry). */
export interface ThumbEntry { model: PropModel; relPos?: V3; relYaw?: number }

/**
 * Renders framed views of prop models. Two uses share one class: the Prop Library snapshots each model to a PNG
 * data URL (render), and the Prop Tools preview mounts the live canvas and orbits the camera around the model in
 * real time (prepare + view). One WebGLRenderer + scene per instance (each build swaps in the model's submeshes
 * and frames its bounding sphere), so a viewer costs a single WebGL context. Model geometry is model-local cm and
 * Z-up (game space); the group is tilted so up reads up. Props render TEXTURED — each submesh gets its material's
 * tile (from the same Textures/ as the paint palette, its own loader here so the context stays independent),
 * loaded before the (synchronous) render so the frame isn't blank; a submesh with no texture falls back to clay.
 */

/** The canonical 3/4 view — a touch above and off one corner. Library thumbnails render here; the orbit starts here. */
export const THUMB_DEFAULT_AZIMUTH = Math.PI / 4;              // 45° around vertical
export const THUMB_DEFAULT_ELEVATION = Math.atan2(0.7, Math.SQRT2); // ≈ 26° above the horizon (matches dir 1,0.7,1)

export class ThumbRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private group = new THREE.Group();       // tilts model-local Z-up into viewer Y-up; holds the model's meshes
  private neutral = new THREE.MeshLambertMaterial({ color: 0xb8b2a4, emissive: 0x0d0f12, side: THREE.DoubleSide });
  private box = new THREE.Box3();
  private sphere = new THREE.Sphere();
  private center = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private loader = new THREE.TextureLoader();
  private texCache = new Map<string, THREE.Texture | null>(); // `${level}:${file}` → texture (null = failed)
  private alphaCache = new Map<string, TextureAlphaAnalysis>();
  private matCache = new Map<string, THREE.MeshLambertMaterial>();
  private projectGeneration = 0;

  constructor(private size = 96) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setSize(size, size);
    this.renderer.setClearColor(0x000000, 0); // transparent bg so it sits on the panel
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1e6);
    // the same texture-true rig as the viewport scene (see Viewport's hemi/sun comment): physical lighting
    // divides by π, so these sizes put a well-lit face at ≈ 1.0× its texture — previews match the world
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(0.6, 1, 0.8);
    const fill = new THREE.HemisphereLight(0xe8f1ff, 0x666e78, 2.6);
    this.group.rotation.x = -Math.PI / 2; // model-local Z-up → viewer Y-up
    this.scene.add(key, fill, this.group);
  }

  /** The backing canvas — mount this to show live orbit views (the Prop Tools preview does). */
  get canvas(): HTMLCanvasElement { return this.renderer.domElement; }

  /** Load a tile texture once (cached; null on failure). */
  private load(level: string, file: string): Promise<THREE.Texture | null> {
    const k = makeTexRef(level, file);
    const have = this.texCache.get(k);
    if (have !== undefined) return Promise.resolve(have);
    const generation = this.projectGeneration;
    return new Promise(resolve => {
      this.loader.load(
        textureUrl(level, file),
        tex => {
          if (generation !== this.projectGeneration && level.toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase()) {
            tex.dispose(); resolve(null); return;
          }
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.colorSpace = THREE.SRGBColorSpace;
          try { this.alphaCache.set(k, analyzeTextureImage(tex.image)); }
          catch { this.alphaCache.set(k, { kind: 'unknown', glow: false }); }
          this.texCache.set(k, tex);
          resolve(tex);
        },
        undefined,
        () => {
          this.alphaCache.set(k, { kind: 'unknown', glow: false });
          this.texCache.set(k, null);
          resolve(null);
        },
      );
    });
  }

  invalidateProjectAssets(): void {
    this.projectGeneration++;
    const prefix = `${CUSTOM_TEX_LEVEL}/`.toLowerCase();
    for (const [key, texture] of this.texCache) if (key.toLowerCase().startsWith(prefix)) {
      texture?.dispose(); this.texCache.delete(key);
      this.alphaCache.delete(key);
    }
    for (const [key, material] of this.matCache) if (key.toLowerCase().startsWith(prefix)) {
      if (material !== this.neutral) material.dispose();
      this.matCache.delete(key);
    }
  }

  private material(level: string, file: string | null, source?: PropMaterial): THREE.MeshLambertMaterial {
    if (!file) return this.neutral;
    const texKey = makeTexRef(level, file);
    const frames = source?.frames ?? [];
    const mode = resolvePropAlphaMode(
      [...new Set([file, ...frames])].map(name => this.alphaCache.get(makeTexRef(level, name))),
      { mode: source?.alphaMode, alphaPass: source?.blend, priority: source?.prio,
        pixelAlpha: source?.pixelAlpha });
    const k = `${texKey}:${mode}`;
    let m = this.matCache.get(k);
    if (!m) {
      const tex = this.texCache.get(texKey) ?? null;
      m = tex ? new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide }) : this.neutral;
      if (m !== this.neutral) applyTextureAlphaMode(m, mode);
      this.matCache.set(k, m);
    }
    return m;
  }

  /** Load `model`'s tiles and build its meshes into the scene, ready for view() / render(). Leaves the camera
   *  where it is so an in-progress orbit angle survives swapping models. */
  prepare(model: PropModel, level: string, materials: LevelProps['materials']): Promise<void> {
    return this.prepareSet([{ model }], level, materials);
  }

  /** Load and build a whole ASSEMBLY (a group's members) into the scene — each entry's meshes at its
   *  group-local pose, so the framed view shows the set as it places (docs/015). The scene is model-local
   *  raw cm / Z-up, so an entry's editor-space pose maps in: editor (x,y,z) → raw (−100x, −100z, 100y), and
   *  an editor yaw about +Y is a raw turn of −yaw about +Z. Mined members carry zero for both. */
  async prepareSet(entries: ThumbEntry[], level: string, materials: LevelProps['materials']): Promise<void> {
    // a tile ref may name its own bank ("Custom/lamp.png" — authored-model tiles, imported-prop art);
    // resolving through the same helper the viewport materials use keeps thumbnails and world in step
    const files = new Map<string, { level: string; name: string }>();
    for (const e of entries) for (const s of e.model.subs) {
      const material = materials.get(s.mat);
      const tile = resolvePropTex(level, material?.tex);
      if (tile.name) files.set(`${tile.level}/${tile.name}`, { level: tile.level, name: tile.name });
      for (const frame of material?.frames ?? [])
        files.set(`${tile.level}/${frame}`, { level: tile.level, name: frame });
    }
    await Promise.all([...files.values()].map(f => this.load(f.level, f.name)));

    for (const c of this.group.children) c.traverse(o => (o as THREE.Mesh).geometry?.dispose());
    this.group.clear();
    for (const e of entries) {
      const holder = new THREE.Group();
      const rel = e.relPos ?? [0, 0, 0];
      holder.position.set(-100 * rel[0], -100 * rel[2], 100 * rel[1]);
      holder.rotation.z = (-(e.relYaw ?? 0) * Math.PI) / 180;
      for (const s of e.model.subs) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(s.positions, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(s.uvs, 2));
        g.setIndex(new THREE.BufferAttribute(s.indices, 1));
        if (s.normals?.length === s.positions.length)
          g.setAttribute('normal', new THREE.BufferAttribute(s.normals, 3));
        else g.computeVertexNormals();
        const material = materials.get(s.mat);
        const tile = resolvePropTex(level, material?.tex);
        holder.add(new THREE.Mesh(g, this.material(tile.level, tile.name, material)));
      }
      this.group.add(holder);
    }
    this.group.updateMatrixWorld(true);
  }

  /** Frame the prepared model and render it from a camera orbit (azimuth around vertical, elevation above the
   *  horizon, both radians). Cheap enough to call every pointer-move for a smooth drag-orbit. */
  view(azimuth: number, elevation: number): void {
    this.box.setFromObject(this.group);
    if (this.box.isEmpty()) { this.renderer.render(this.scene, this.camera); return; }
    this.box.getBoundingSphere(this.sphere);
    const r = Math.max(this.sphere.radius, 1e-3);
    this.center.copy(this.sphere.center);
    const dist = r / Math.sin((this.camera.fov * Math.PI) / 180 / 2) * 1.15; // 15% margin
    const ch = Math.cos(elevation);
    this.dir.set(ch * Math.sin(azimuth), Math.sin(elevation), ch * Math.cos(azimuth));
    this.camera.position.copy(this.center).addScaledVector(this.dir, dist);
    this.camera.near = Math.max(0.1, dist - r * 3);
    this.camera.far = dist + r * 3;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.center);
    this.renderer.render(this.scene, this.camera);
  }

  /** Render `model` textured in the canonical 3/4 view to a PNG data URL (the Prop Library's swatches). */
  async render(model: PropModel, level: string, materials: LevelProps['materials']): Promise<string> {
    return this.renderSet([{ model }], level, materials);
  }

  /** Render an ASSEMBLY in the canonical 3/4 view to a PNG data URL (the Groups grid's swatches). */
  async renderSet(entries: ThumbEntry[], level: string, materials: LevelProps['materials']): Promise<string> {
    await this.prepareSet(entries, level, materials);
    this.view(THUMB_DEFAULT_AZIMUTH, THUMB_DEFAULT_ELEVATION);
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose() {
    for (const c of this.group.children) c.traverse(o => (o as THREE.Mesh).geometry?.dispose());
    this.neutral.dispose();
    this.renderer.dispose();
  }
}

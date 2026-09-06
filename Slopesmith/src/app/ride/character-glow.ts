import * as THREE from 'three';
import { CHARACTER_UV_SCROLL_KEY } from '../../core/characters/contract';

/**
 * Scrolling emissive masks on rider models (docs/030).
 *
 * A character can declare that one of its materials' emissive maps moves, by carrying a `[u, v]` rate in
 * texture-units per second under `slopesmith_uv_scroll` in the material's glTF `extras`. Nothing here knows
 * Alpine Exo's material names: a hand-authored GLB that declares the same key animates the same way,
 * which is the difference between a feature and a special case.
 *
 * ONE step per frame, not one per rider. Rider models are loaded once and cloned — and `SkeletonUtils.clone`
 * shares materials, so every player, AI rider and remote avatar wearing a given character is looking at the
 * same Texture object. Advancing it here rather than inside `pose()` keeps a field of twenty riders at the
 * same cost as one, and keeps them in phase with each other, which is what "the same suit" should look like.
 */

interface ScrollingMap {
  texture: THREE.Texture;
  u: number;
  v: number;
}

/** Keyed by texture, so two materials sharing one mask scroll it once rather than twice as fast. */
const scrolling = new Map<THREE.Texture, ScrollingMap>();

function declaredRate(material: THREE.Material): [number, number] | null {
  const rate = (material.userData as Record<string, unknown> | undefined)?.[CHARACTER_UV_SCROLL_KEY];
  if (!Array.isArray(rate) || rate.length < 2) return null;
  const [u, v] = rate;
  if (typeof u !== 'number' || typeof v !== 'number' || !Number.isFinite(u) || !Number.isFinite(v)) return null;
  return u === 0 && v === 0 ? null : [u, v];
}

/**
 * Pick up any scrolling masks in a freshly loaded character template. Safe to call again on the same model:
 * a texture already registered keeps its phase rather than restarting.
 */
export function registerCharacterGlow(root: THREE.Object3D): void {
  root.traverse(object => {
    const held = (object as Partial<THREE.Mesh>).material;
    if (!held) return;
    for (const material of Array.isArray(held) ? held : [held]) {
      const rate = declaredRate(material);
      if (!rate) continue;
      const map = (material as THREE.MeshStandardMaterial).emissiveMap;
      if (!map || scrolling.has(map)) continue;
      // Only the axes that actually move. Forcing both would silently un-clamp an atlas that a second
      // material samples by cell, and pull a neighbouring cell's light across the seam.
      if (rate[0] !== 0) map.wrapS = THREE.RepeatWrapping;
      if (rate[1] !== 0) map.wrapT = THREE.RepeatWrapping;
      scrolling.set(map, { texture: map, u: rate[0], v: rate[1] });
    }
  });
}

/** Advance every registered mask. Called once per frame from the viewport's material-animation phase. */
export function stepCharacterGlow(dt: number): void {
  if (!(dt > 0) || !scrolling.size) return;
  for (const entry of scrolling.values()) {
    // Wrapped back into [0, 1) every frame rather than left to accumulate. The offset reaches the shader as
    // a float, and after an hour of riding an unwrapped one is in the thousands — at which point the
    // fractional part it is actually made of has lost the precision the pattern is drawn from, and a smooth
    // scroll turns into a visible stutter. The texture repeats, so wrapping changes nothing on screen.
    entry.texture.offset.set(
      wrapUnit(entry.texture.offset.x + entry.u * dt),
      wrapUnit(entry.texture.offset.y + entry.v * dt),
    );
  }
}

/** @internal Exposed so a check can reset between cases; the app itself never unregisters. */
export function resetCharacterGlow(): void {
  scrolling.clear();
}

function wrapUnit(value: number): number {
  const wrapped = value % 1;
  return wrapped < 0 ? wrapped + 1 : wrapped;
}

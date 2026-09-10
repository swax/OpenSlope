import * as THREE from 'three';
import { renderLoadingManager } from '../render-assets';
import { CUSTOM_TEX_LEVEL, parseTexRef, type TexRef } from '../../../core/paint/textures';
import { textureRefUrl } from '../../net/asset-paths';
import { SURFACE_POLY_OFFSET } from '../constants';
import { tintBackfaces } from './backface-tint';
import {
  asTextureArrayImage, buildTextureArrayBank, canPackTextureArrays, planTextureArrayBank, useTextureArray,
  type TextureArrayBank, type TextureArraySlot,
} from './texture-array';
import {
  analyzeTextureImage, applyTextureAlphaMode, invalidateTextureAlphaLevel, terrainAlphaMode,
  type TextureAlphaAnalysis, type TextureAlphaMode,
} from '../../props/texture-alpha';

/**
 * The terrain tile texture + material cache, keyed by TexRef ("<level>/<name>"): downloads each painted tile
 * once (from the same `/api/texture` the paint palette reads) and hands back the two material flavours the
 * surfaces draw with — a lit `MeshLambertMaterial` (the default look) and an unlit `MeshBasicMaterial` that
 * multiplies the baked per-vertex lighting into the texture (texture × lightmap) while a lighting view is on.
 * Shared by the authored terrain, the reference terrain and the paint ghost — a tile a placement paints, the
 * reference world reuses, and the brush previews can all be the same texture — so it's one injected holder.
 * A tile that finishes downloading fires `onLoaded` so the caller re-folds it into whatever it's drawing.
 */
export function createTileMaterials(onLoaded: () => void) {
  const texLoader = new THREE.TextureLoader(renderLoadingManager);
  const texCache = new Map<string, THREE.Texture>();
  const alphaCache = new Map<string, TextureAlphaAnalysis>();
  const texPending = new Set<string>();
  const texMissing = new Set<string>();
  const texMats = new Map<string, THREE.MeshLambertMaterial>();
  const texMatsLit = new Map<string, THREE.MeshBasicMaterial>();
  let projectGeneration = 0;

  /** Get a loaded tile texture, or kick off its download (returns null until ready, then fires onLoaded). */
  function ensure(ref: TexRef): THREE.Texture | null {
    const cached = texCache.get(ref);
    if (cached) return cached;
    if (texMissing.has(ref)) return null;
    if (!texPending.has(ref)) {
      const generation = projectGeneration;
      texPending.add(ref);
      texLoader.load(
        textureRefUrl(ref),
        tex => {
          if (generation !== projectGeneration && parseTexRef(ref).level.toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase()) {
            tex.dispose(); return;
          }
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          // The stored UVs are glTF top-left; snowknife's Unity loader samples them as (u, 1-v). Three's
          // TextureLoader defaults flipY=true (image flipped), which would instead sample 1-v -> every
          // tile lands V-flipped vs the bake. flipY=false makes the editor match the Unity import 1:1.
          tex.flipY = false;
          tex.needsUpdate = true;
          try { alphaCache.set(ref, analyzeTextureImage(tex.image)); }
          catch { alphaCache.set(ref, { kind: 'unknown', glow: false }); }
          texCache.set(ref, tex);
          texPending.delete(ref);
          onLoaded(); // fold the now-loaded tile into whatever the caller is drawing (terrain / reference / ghost)
        },
        undefined,
        () => {
          if (generation !== projectGeneration && parseTexRef(ref).level.toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase()) return;
          texPending.delete(ref);
          // A reference rebuild runs after every successful sibling tile. Remember this failure for the
          // session so nine absent pages do not turn into hundreds of identical 404s. Reloading retries.
          texMissing.add(ref);
          alphaCache.set(ref, { kind: 'unknown', glow: false });
          // A failure settles this page as surely as a success does, and the array bank below only builds
          // once NOTHING is outstanding. Without this notification a bank whose last page 404s would wait
          // for a completion that is never coming.
          onLoaded();
        },
      );
    }
    return null;
  }

  /** The lit tile material (the default terrain look). Back faces tint magenta — the non-ridable side of a
   *  one-sided patch (backface-tint.ts); on the reference this honestly shows the shipped parameterization. */
  function material(ref: TexRef, tex: THREE.Texture): THREE.MeshLambertMaterial {
    let m = texMats.get(ref);
    if (!m) {
      m = tintBackfaces(new THREE.MeshLambertMaterial({
        map: tex, side: THREE.DoubleSide,
        ...SURFACE_POLY_OFFSET, // sit behind the cage wires
      }));
      applyTextureAlphaMode(m, terrainAlphaMode(alphaCache.get(ref)));
      texMats.set(ref, m);
    }
    return m;
  }

  /** Unlit tile material that multiplies the per-vertex colour (the baked lighting) into the texture -
   *  texture x lightmap, the SSX terrain look - used while a lighting view is active. */
  function materialLit(ref: TexRef, tex: THREE.Texture): THREE.MeshBasicMaterial {
    let m = texMatsLit.get(ref);
    if (!m) {
      m = tintBackfaces(new THREE.MeshBasicMaterial({
        map: tex, vertexColors: true, side: THREE.DoubleSide,
        ...SURFACE_POLY_OFFSET,
      }));
      applyTextureAlphaMode(m, terrainAlphaMode(alphaCache.get(ref)));
      texMatsLit.set(ref, m);
    }
    return m;
  }

  /**
   * The ARRAY-TEXTURE flavour of the two materials above: one `sampler2DArray` holding every tile of a bank,
   * so a terrain cell submits one draw whatever mix of pages it contains (see mesh/texture-array.ts).
   *
   * Built once per bank, and only when every page has settled — a bank is a single upload sized to the whole
   * set, so there is nothing useful to do with a half-loaded one. Until then callers keep the per-page
   * materials, which is exactly the progressive behaviour they already had.
   */
  let bankKey: string | null = null;
  let bank: TileArrayBank | null = null;

  function ensureBank(key: string, refs: readonly TexRef[]): TileArrayBank | null {
    if (bankKey === key) return bank;
    if (!canPackTextureArrays()) return null;
    let settled = true;
    for (const ref of refs) if (!ensure(ref) && !texMissing.has(ref)) settled = false;
    if (!settled) return null;
    bankKey = key; // claim the key even on a null result, so a bank that cannot build is not retried per frame
    bank = null;
    if (!refs.length) return null;
    const plan = planTextureArrayBank(refs.map(ref => {
      const image = asTextureArrayImage(texCache.get(ref)?.image);
      return { key: ref, width: image?.width ?? 0, height: image?.height ?? 0 };
    }));
    const built = buildTextureArrayBank(plan, ref => asTextureArrayImage(texCache.get(ref)?.image),
      { flipY: false, dilateAlpha: true, anisotropy: 4 }); // terrain tiles ship flipY=false to match snowknife's (u, 1-v) sampling
    if (!built) return null;
    const modes: TextureAlphaMode[] = ['opaque', 'cutout'];
    const key3d = (index: number, mode: TextureAlphaMode) => `terrain:${key}:${index}:${mode}`;
    bank = {
      bank: built,
      materials: built.textures.flatMap((texture, index) => modes.map(mode => {
        const material = tintBackfaces(
          new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, ...SURFACE_POLY_OFFSET }));
        applyTextureAlphaMode(material, mode);
        return useTextureArray(material, texture, key3d(index, mode));
      })),
      materialsLit: built.textures.flatMap((texture, index) => modes.map(mode => {
        const material = tintBackfaces(
          new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, ...SURFACE_POLY_OFFSET }));
        applyTextureAlphaMode(material, mode);
        return useTextureArray(material, texture, key3d(index, mode));
      })),
      slot: (ref: TexRef) => built.plan.slots.get(ref),
      materialIndex: (ref: TexRef) => {
        const slot = built.plan.slots.get(ref);
        if (!slot) return undefined;
        return slot.array * modes.length + (terrainAlphaMode(alphaCache.get(ref)) === 'cutout' ? 1 : 0);
      },
    };
    console.info(`[tile-array] ${key}: ${built.plan.slots.size}/${refs.length} pages in `
      + `${built.textures.length} array(s) at ${built.plan.width}x${built.plan.height}`
      + (built.plan.excluded.length ? `, ${built.plan.excluded.length} kept separate` : ''));
    return bank;
  }

  function disposeBank(): void {
    if (bank) {
      bank.bank.dispose();
      for (const material of [...bank.materials, ...bank.materialsLit]) material.dispose();
    }
    bank = null;
    bankKey = null;
  }

  /** A different project may use the same compact `Custom/foo.png` ref for different bytes. Dispose only
   * authored entries; reference-level textures remain valid across mountain switches. */
  function invalidateProjectAssets(): void {
    projectGeneration++;
    invalidateTextureAlphaLevel(CUSTOM_TEX_LEVEL);
    disposeBank(); // packed copies of the old project's pages; the next reference build repacks
    const authored = (ref: string) => parseTexRef(ref).level.toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase();
    for (const [ref, texture] of texCache) if (authored(ref)) { texture.dispose(); texCache.delete(ref); }
    for (const ref of [...alphaCache.keys()]) if (authored(ref)) alphaCache.delete(ref);
    for (const ref of [...texPending]) if (authored(ref)) texPending.delete(ref);
    // A failure is not immutable asset state. In particular, a recovery document can ask for retail pages
    // before a fresh tab has chosen its project; those requests used to receive 409 and poison the reference
    // bank until a full page refresh. A project rebind is the retry boundary, while successfully decoded
    // reference pages above remain warm.
    texMissing.clear();
    for (const [ref, material] of texMats) if (authored(ref)) { material.dispose(); texMats.delete(ref); }
    for (const [ref, material] of texMatsLit) if (authored(ref)) { material.dispose(); texMatsLit.delete(ref); }
  }

  return { ensure, material, materialLit, ensureBank, disposeBank, invalidateProjectAssets };
}

/** One reference level's packed tile pages: the arrays themselves plus the two material flavours the terrain
 *  draws with, mirroring `material` / `materialLit` above. */
export interface TileArrayBank {
  bank: TextureArrayBank;
  materials: THREE.MeshLambertMaterial[];
  materialsLit: THREE.MeshBasicMaterial[];
  slot(ref: TexRef): TextureArraySlot | undefined;
  /** Flat material-table index: each texture array owns an opaque and a cutout shader variant. */
  materialIndex(ref: TexRef): number | undefined;
}

export type TileMaterials = ReturnType<typeof createTileMaterials>;

import GUI from 'lil-gui';
import type { SkyboxDoc } from '../../core/doc/types';
import { SKY_TIERS, panoramaSize, ringTopEquirectV, type SkyRing } from '../../core/sky/ring';
import type { Viewport } from '../viewport/viewport';
import type { SkyView } from '../viewport/scene/sky';
import type { Store } from '../state/store';
import { clearGui, note, skyPreview, tip } from '../ui/components/gui';
import { segmented, toggleBar } from '../ui/components/controls';
import { toast } from '../ui/components/toast';
import { fetchJson } from '../net/fetch-json';
import {
  customSkyUrl, referenceSkyUrl, registerReferenceSkyRevisions,
} from '../net/asset-paths';
import { clientFetch } from '../net/client';
import { openSkyGenDialog } from './sky-gen';
import {
  activeSkyboxWorld, activeSkyWorld, reconcileSkyPreviewTarget, toggleSkyPreviewLayer,
  type SkyPreviewLayer, type SkyPreviewLayers, type SkyPreviewTarget,
} from './preview';

/**
 * The skybox subsystem (docs/025), which owns a panel on BOTH scene tabs:
 *
 *   Skybox ▸ Reference   the loaded level's own sky, unrolled into its horizon panorama, with "⟶ use for my
 *                        map" — the same shape the lighting study's sun button has.
 *   the authored Skybox panel the sky your map ships with: what's set, a picker over every shipped sky, "load
 *                        image…" for a panorama of your own, and the fill colour for the ring's open top.
 *
 * A sky is portable. The extracted levels ship a compatible ring — byte-identical geometry, only
 * the textures differ — so adopting another level's sky is just adopting its texture bank, and an ISO repack
 * can lift it whole. That is why the Reference panel can hand its sky to the Mountain panel with one button
 * and nothing has to be converted.
 *
 * A factory over the host, like the reference subsystem: the panel state is closure state, the viewport /
 * store / the two folders / persistence are injected.
 */

export type SkyDeps = {
  store: Store;
  viewport: Viewport;
  /** Scene ▸ Skybox ▸ Preview, shared by the authored and reference panels. */
  previewFolder: GUI;
  /** Scene ▸ Skybox ▸ the open mountain. */
  skyFolder: GUI;
  /** Scene ▸ Skybox ▸ Reference (rebuilt on every reference load). */
  refSkyFolder: GUI;
  persistDoc: () => void;
  persistUi: () => void;
  log: (msg: string) => void;
  /** Whether Scene is showing either category that owns the shared sky/glare Preview card. */
  isPreviewSelected: () => boolean;
  /** Keep presentation effects coupled to whichever world owns the visible sky state. */
  onVisibleWorldChange: () => void;
  /** Repaint the top-bar Skybox button after the Scene preview changes it. */
  refreshView: () => void;
};

/** The URLs a document's sky resolves to — both panels and the viewport read the sky through these. */
export function skyUrls(sky: SkyboxDoc): { panorama: string; ground: string } {
  if (sky.source.kind === 'custom') return {
    panorama: customSkyUrl(sky.source.name, 'panorama'),
    ground: customSkyUrl(sky.source.name, 'ground', sky.ring),
  };
  return {
    panorama: referenceSkyUrl(sky.source.level, 'panorama'),
    ground: referenceSkyUrl(sky.source.level, 'ground'),
  };
}

export function skyLabel(sky: SkyboxDoc): string {
  return sky.source.kind === 'level' ? `${sky.source.level}’s sky` : `${sky.source.name} (your panorama)`;
}

/** The bare name a sky saves out under. */
function skyFileName(sky: SkyboxDoc): string {
  return sky.source.kind === 'level' ? sky.source.level : sky.source.name;
}

export function createSkybox(deps: SkyDeps) {
  const {
    store, viewport, previewFolder, skyFolder, refSkyFolder, persistDoc, persistUi, log,
    isPreviewSelected, onVisibleWorldChange, refreshView,
  } = deps;

  let shippedSkies: string[] = [];  // levels that ship a sky (ELYSIUM / GARI / MERQUER / MESA / SNOW)
  let customSkies: string[] = [];   // the panoramas the user has loaded, by name
  let rings: Record<string, SkyRing> = {};
  let cataloged = false;            // the catalogue has been fetched, so a missing sky really is missing
  const NONE = '(none)';

  /** The picker's current selection, mirrored onto the doc by applySky. */
  const pick = { sky: NONE, tier: 'standard' as 'standard' | 'high', top: '#35507a' };
  /** Shared editor-session preview choice. It is deliberately not mountain data. */
  let previewTarget: SkyPreviewTarget | null = null;
  let previewLayers: SkyPreviewLayers = { skybox: store.skyboxVisible, godRays: true };
  let refLevel: string | null = null;
  let refHasSky = false;
  let loadedSkyKey: string | null = null;

  async function initSky() {
    try {
      const body = await fetchJson<{
        levels?: string[];
        skies?: string[];
        rings?: Record<string, SkyRing>;
        versions?: Record<string, { panorama?: string; ground?: string }>;
      }>('/api/skybox');
      shippedSkies = body.levels ?? [];
      customSkies = body.skies ?? [];
      rings = body.rings ?? {};
      registerReferenceSkyRevisions(body.versions ?? {});
      cataloged = true;
    } catch { /* static build / server down — the panel still shows what the doc carries */ }
    syncSkyFromDoc(); // boot order: loadMountain() ran this once already, before the catalogue existed
    // Reference and sky catalogues load independently. If the reference won the race, rebuild its panel now
    // that we can say whether the level actually ships a sky.
    if (refLevel) setupRefSkyUi(refLevel);
  }

  /** Every sky the picker offers: none, the shipped levels', and the user's own. */
  function skyOptions(): string[] {
    return [NONE, ...shippedSkies, ...customSkies.map(customKey)];
  }
  const customKey = (name: string) => `★ ${name}`;
  const isCustomKey = (key: string) => key.startsWith('★ ');

  /** Turn a picker entry back into the doc's source record. */
  function sourceOf(key: string): SkyboxDoc['source'] | null {
    if (key === NONE) return null;
    return isCustomKey(key) ? { kind: 'custom', name: key.slice(2) } : { kind: 'level', level: key };
  }

  /** The picker entry a doc's sky shows as. */
  function keyOf(sky: SkyboxDoc | undefined): string {
    if (!sky) return NONE;
    return sky.source.kind === 'level' ? sky.source.level : customKey(sky.source.name);
  }

  const refSky = (level: string): SkyboxDoc => ({ source: { kind: 'level', level }, on: true });

  /** The ring a custom sky is cut against: the one this document already named — so changing the tier or the
   *  open-top fill never re-cuts the pages against different geometry — else the loaded reference's ring when
   *  it ships one, else the first level in the catalogue that does. Undefined only before the catalogue has
   *  loaded, and the export then picks the first shipped ring itself. */
  function customSkyRing(current: SkyboxDoc | undefined): string | undefined {
    if (current?.ring && shippedSkies.includes(current.ring)) return current.ring;
    if (refLevel && refHasSky) return refLevel;
    return shippedSkies[0];
  }

  function measuredRing(sky: SkyboxDoc): SkyRing | undefined {
    const level = sky.source.kind === 'level' ? sky.source.level : sky.ring ?? shippedSkies[0];
    return level ? rings[level] : undefined;
  }

  /** The global backdrop follows the nearest mountain, except that the dedicated Scene preview keeps its
   *  explicit comparison target and a running ride locks to the course being ridden. */
  function getActiveSkyWorld(): SkyPreviewTarget | null {
    return activeSkyboxWorld(
      store.currentMode, isPreviewSelected(), viewport.riding || viewport.xrPresenting,
      store.playTarget, previewTarget, viewport.nearestMountainWorld, store.skyboxVisible,
    );
  }

  function getActiveGodRayWorld(): SkyPreviewTarget | null {
    return activeSkyWorld(
      store.currentMode, isPreviewSelected(), viewport.riding || viewport.xrPresenting,
      store.playTarget, previewTarget, previewLayers.godRays,
    );
  }

  /** The one backdrop that should be visible for the active world. A ride can still have glare without a sky. */
  function desiredSky(): { key: string; sky: SkyboxDoc; authored: boolean } | null {
    const world = getActiveSkyWorld();
    if (world === 'reference') {
      return refLevel && refHasSky ? { key: `reference:${refLevel}`, sky: refSky(refLevel), authored: false } : null;
    }
    return world === 'authored' && store.mdoc.skybox
      ? { key: `authored:${keyOf(store.mdoc.skybox)}`, sky: store.mdoc.skybox, authored: true }
      : null;
  }

  /** Reconcile the single viewport backdrop with Info/Play state. `reload` is used when the selected authored
   *  source changed without changing its logical slot, or when its panorama must derive a fresh top colour. */
  function syncSkyVisibility(reload = false) {
    const desired = desiredSky();
    if (!desired) {
      viewport.showSky(false);
      onVisibleWorldChange();
      return;
    }

    if (reload || loadedSkyKey !== desired.key) {
      loadedSkyKey = desired.key;
      const view: SkyView = { ...skyUrls(desired.sky), topColor: desired.sky.topColor,
        ring: measuredRing(desired.sky) };
      viewport.setSky(view, desired.authored ? hex => {
        pick.top = hex;
        if (store.mdoc.skybox) store.mdoc.skybox.topColor = hex;
        persistDoc();
        skyFolder.controllers.forEach(c => c.updateDisplay());
      } : undefined);
    } else if (desired.authored) {
      viewport.setSkyTopColor(desired.sky.topColor ?? null);
    }
    viewport.showSky(true);
    onVisibleWorldChange();
  }

  /** The top-bar Skybox switch and Scene's Skybox preview layer share one persisted view preference. */
  function setSkyboxVisible(on: boolean, persist = true) {
    if (store.skyboxVisible === on && previewLayers.skybox === on) return;
    store.skyboxVisible = on;
    previewLayers = { ...previewLayers, skybox: on };
    if (persist) persistUi();
    buildPreviewPanel();
    syncSkyVisibility();
    refreshView();
  }

  function toggleSkybox() { setSkyboxVisible(!store.skyboxVisible); }

  /** Rebuild the shared world selector. Availability belongs to the world slot, not to one layer: a mountain
   *  may legitimately carry glare without a skybox, so feature-gating these buttons on sky art made that
   *  glare impossible to preview. Each layer independently decides whether the selected world has anything
   *  to draw. */
  function buildPreviewPanel() {
    clearGui(previewFolder);
    const referenceAvailable = !!refLevel;
    previewTarget = reconcileSkyPreviewTarget(previewTarget, true, referenceAvailable);
    const targets = segmented<SkyPreviewTarget>([
      { value: 'authored', label: 'My mountain', title: 'Preview my mountain’s skybox and sun glare.' },
      { value: 'reference', label: 'Reference', title: () => refLevel
        ? `Preview ${refLevel}’s skybox and sun glare.`
        : 'Load a reference mountain to preview its skybox or sun glare.' },
    ], () => previewTarget, target => {
      previewTarget = target;
      syncSkyVisibility();
    });
    targets.setEnabled('authored', true);
    targets.setEnabled('reference', referenceAvailable);
    targets.el.setAttribute('role', 'group');
    targets.el.setAttribute('aria-label', 'Mountain to preview');
    const row = document.createElement('div');
    row.className = 'sp-gui-custom sp-sky-preview-target';
    row.appendChild(targets.el);
    previewFolder.$children.appendChild(row);

    const layers = toggleBar<SkyPreviewLayer>([
      { value: 'none', label: 'None', title: 'Turn both preview layers off.' },
      { value: 'skybox', label: 'Skybox', title: 'Toggle the selected mountain’s skybox.' },
      { value: 'god-rays', label: 'God ray', title: 'Toggle the selected mountain’s sun glare.' },
    ], layer => layer === 'none'
      ? !store.skyboxVisible && !previewLayers.godRays
      : layer === 'skybox' ? store.skyboxVisible : previewLayers.godRays,
    layer => {
      previewLayers = toggleSkyPreviewLayer(previewLayers, layer);
      store.skyboxVisible = previewLayers.skybox;
      persistUi();
      syncSkyVisibility();
      refreshView();
    });
    layers.el.setAttribute('role', 'group');
    layers.el.setAttribute('aria-label', 'Preview layers');
    const layerRow = document.createElement('div');
    layerRow.className = 'sp-gui-custom sp-sky-preview-layers';
    layerRow.appendChild(layers.el);
    previewFolder.$children.appendChild(layerRow);
    note(previewFolder, 'Skybox shares the top-bar switch; outside this preview it follows the nearest mountain. '
      + 'God ray remains independent. A layer with no data for the selected mountain draws nothing; None turns both off.');
    previewFolder.open();
  }

  function buildSkyPanel() {
    clearGui(skyFolder);
    const sky = store.mdoc.skybox;

    if (sky) skyPreview(skyFolder, skyUrls(sky).panorama, skyLabel(sky));
    else note(skyFolder, 'No sky — the mountain draws on the flat background.',
      'An ISO repack then keeps the target level’s own sky.');

    tip(skyFolder.add(pick, 'sky', skyOptions()).name('skybox').onChange(applySky),
      'The backdrop your mountain ships with; ★ entries are panoramas you loaded.',
      'Compatible extracted skies can be adopted directly. Ring layout comes from each map’s generated metadata.');

    tip(skyFolder.add({ load: loadImage }, 'load').name('▲ load image…'),
      'Use your own panorama (PNG).',
      'A wide strip is taken as the horizon band; a 2:1 image is treated as a full equirectangular sky and '
      + 're-projected into it. Anything above the selected ring’s measured top edge is discarded.');

    tip(skyFolder.add({ gen: generateSky }, 'gen').name('✨ generate…'),
      'Generate a sky with fal.ai from a description.',
      'A 2:1 equirectangular panorama comes back, stored and applied exactly like a loaded image. Needs a '
      + 'fal.ai API key (Settings ▸ Integrations) and bills your own fal.ai account; nothing is billed until '
      + 'Generate is pressed.');

    if (!sky) return;

    tip(skyFolder.add({ save: () => savePanorama(skyUrls(sky).panorama, `${skyFileName(sky)}-sky.png`) }, 'save').name('⤓ save panorama…'),
      'Save this sky’s horizon panorama as a PNG.',
      'Paint over it — or generate a new one at the size on the preview — and load it straight back; the '
      + 'panorama is the authoring format, so the round trip is lossless.');

    tip(skyFolder.addColor(pick, 'top').name('open-top fill').onChange(() => {
      applySky(false);
    }), 'The flat colour above the panorama ring.',
      'Saved with the mountain and exported as Skybox/Sky.json TopColor. Default is the mean of the '
      + 'panorama’s top row, which meets the rim without a hard seam.');

    tip(skyFolder.add({ reset: resetTop }, 'reset').name('↺ fill from panorama'),
      'Take the open-top fill back to the mean of the panorama’s top row.');

    if (sky.source.kind === 'custom') {
      const ring = measuredRing(sky);
      const size = ring ? panoramaSize(SKY_TIERS[pick.tier].upper, ring) : null;
      tip(skyFolder.add(pick, 'tier', ['standard', 'high']).name('resolution').onChange(applySky),
        'Texture budget for the selected ring’s pages.',
        `standard uses ${SKY_TIERS.standard.upper}px upper panels${size ? ` and a ${size.w}×${size.h} working panorama` : ''}; `
        + 'high doubles wall resolution, but its 32-bit pages cost substantially more VRAM and upload '
        + 'bandwidth. Untested on hardware.');
    }
  }

  /** Mirror the panel onto the doc, then re-hang the sky in the viewport. `reload` false when only the
   *  open-top colour moved — the panorama is already up, and re-fetching it would flicker mid-drag. */
  function applySky(reload = true) {
    const source = sourceOf(pick.sky);
    if (!source) {
      delete store.mdoc.skybox;
      persistDoc();
      loadedSkyKey = null;
      viewport.setSky(null);
      buildSkyPanel();
      buildPreviewPanel();
      syncSkyVisibility();
      return;
    }
    const hadSky = !!store.mdoc.skybox;
    const changed = keyOf(store.mdoc.skybox) !== pick.sky;
    const sky: SkyboxDoc = { source, on: true, tier: pick.tier };
    // A custom sky records the ring it is composed against, because the export cuts its pages on that
    // ring's real azimuth spans and copies that ring's meshes into Skybox/. A level sky brings its own.
    if (source.kind === 'custom') {
      const ring = customSkyRing(store.mdoc.skybox);
      if (ring) sky.ring = ring;
    }
    // A new sky drops the old fill so the new panorama's own top row derives one; otherwise the colour on the
    // swatch IS the document's, so it ships as picked.
    if (!changed) sky.topColor = pick.top;
    store.mdoc.skybox = sky;
    persistDoc();  // the sky changes outside scheduleRebuild, so it persists itself (as the sun does)
    if (changed) loadedSkyKey = null;
    if (!hadSky) buildPreviewPanel();
    syncSkyVisibility(reload || changed);
    if (changed) buildSkyPanel(); // a different sky = a different preview (and a custom one gains a resolution row)
  }

  /** Drop the authored fill so it re-derives from the panorama's top row (and lands back on the document). */
  function resetTop() {
    if (!store.mdoc.skybox) return;
    delete store.mdoc.skybox.topColor;
    syncSkyVisibility(true);
    toast('Open-top fill taken from the panorama’s top row.', 'ok');
  }

  /**
   * Save a sky's panorama to disk — the other half of "load image…". Paint over what comes out (or generate a
   * fresh one at the size the caption shows) and load it straight back: the panorama IS the authoring format,
   * so a round trip lands every panel back where it came from.
   */
  async function savePanorama(url: string, filename: string) {
    try {
      const res = await clientFetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`Saved ${filename}.`, 'ok');
    } catch (e) {
      toast(`Save failed: ${e instanceof Error ? e.message : e}`, 'err', 5000);
    }
  }

  /** Adopt a freshly stored custom sky: add it to the picker and make it the mountain's — the shared tail of
   *  both routes in, "load image…" and "✨ generate…". `name` is the name the store answered with, which is
   *  `<name>_2` and up when the name was taken (docs/038). */
  function adoptSky(name: string) {
    if (!customSkies.includes(name)) customSkies.push(name);
    pick.sky = customKey(name);
    applySky();
  }

  /** Load an image as a sky: POST it, and the server re-projects it into the ring band before storing it, so
   *  every sky in the editor is the same kind of image from here on. */
  function loadImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const name = file.name.replace(/\.[^.]+$/, '');
      try {
        const ring = customSkyRing(store.mdoc.skybox) ?? '';
        const res = await clientFetch(`/api/skyupload?name=${encodeURIComponent(name)}&ring=${encodeURIComponent(ring)}`, {
          method: 'POST',
          headers: { 'content-type': 'image/png' },
          body: await file.arrayBuffer(),
        });
        const body = await res.json() as { name?: string; error?: string };
        if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
        adoptSky(body.name!);
        toast(`Sky “${body.name}” loaded.`, 'ok');
      } catch (e) {
        toast(`Sky load failed: ${e instanceof Error ? e.message : e}`, 'err', 5000);
      }
    };
    input.click();
  }

  /** The ✨ button: describe a sky, fal paints the panorama, and it lands through the same adopt tail as a
   *  loaded image (docs/025). */
  function generateSky() {
    const ringLevel = customSkyRing(store.mdoc.skybox);
    const ring = ringLevel ? rings[ringLevel] : undefined;
    openSkyGenDialog({
      ringLevel,
      ringTopV: ring ? ringTopEquirectV(ring) : undefined,
      onSaved: name => {
        adoptSky(name);
        toast(`Sky “${name}” generated and applied.`, 'ok');
      },
    });
  }

  /** Pull a loaded doc's saved sky back into the panel + viewport (boot, Load, undo). */
  function syncSkyFromDoc() {
    const sky = store.mdoc.skybox;
    pick.sky = keyOf(sky);
    pick.tier = sky?.tier ?? 'standard';
    if (sky?.topColor) pick.top = sky.topColor;
    // a doc can name a sky this machine doesn't have (a .slope.json from elsewhere); say so rather than
    // silently showing an empty panel
    if (cataloged && sky && !skyOptions().includes(pick.sky)) log(`this mountain's sky (${skyLabel(sky)}) isn't in Maps`);
    buildSkyPanel();
    buildPreviewPanel();
    skyFolder.controllers.forEach(c => c.updateDisplay());
    loadedSkyKey = null;
    viewport.setSky(null);
    syncSkyVisibility();
  }

  // ---- Reference half: the loaded level's own sky ----

  /** Rebuild Scene ▸ Skybox ▸ Reference for the level that just loaded. Called on every reference load
   *  (and with null on clear), mirroring the lighting study. */
  function setupRefSkyUi(level: string | null) {
    clearGui(refSkyFolder);
    refLevel = level;
    refHasSky = !!level && shippedSkies.includes(level);
    if (!level) {
      buildPreviewPanel();
      syncSkyVisibility();
      return;
    }
    if (!refHasSky) {
      note(refSkyFolder, 'This level ships no skybox.');
      buildPreviewPanel();
      syncSkyVisibility();
      return;
    }
    const panorama = referenceSkyUrl(level, 'panorama');
    skyPreview(refSkyFolder, panorama, `${level} — horizon`);
    skyPreview(refSkyFolder, referenceSkyUrl(level, 'ground'), 'ground below the horizon');
    tip(refSkyFolder.add({ use: () => useReferenceSky(level) }, 'use').name('⟶ use for my map'),
      'Ship this level’s sky with your mountain.',
      'It transfers whole — an ISO repack lifts its texture bank and ring straight out of the original disc, '
      + 'so it arrives byte-for-byte with nothing re-encoded.');
    tip(refSkyFolder.add({ save: () => savePanorama(panorama, `${level}-sky.png`) }, 'save').name('⤓ save panorama…'),
      `Save ${level}’s horizon as a PNG — the starting point for a sky of your own.`,
      `Repaint it (or build a new one at the size on the preview), then “load image…” under Skybox ▸ `
      + `${store.mdoc.name || 'Mountain'} to ship it instead.`);
    refSkyFolder.open();
    buildPreviewPanel();
    syncSkyVisibility();
  }

  function useReferenceSky(level: string) {
    pick.sky = level;
    previewTarget = 'authored';
    applySky();
    toast(`${level}’s sky is now your mountain’s.`, 'ok');
  }

  return {
    initSky, syncSkyFromDoc, setupRefSkyUi, syncSkyVisibility, getActiveSkyWorld, getActiveGodRayWorld,
    toggleSkybox, setSkyboxVisible,
  };
}

export type Skybox = ReturnType<typeof createSkybox>;

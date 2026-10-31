import type { PublicCourse } from '../../core/session/public-courses';
import { beforeAppUpdate } from '../offline';
import { defaultMountain } from '../../core/doc/mountain';
import { authoredModelLevelProps } from '../../core/doc/models';
import { decodeProps, type PropsPayload } from '../../core/reference/props';
import { decodeReferenceEffects } from '../../core/reference/effects';
import { buildReferenceMeshProgressive } from '../../core/reference/terrain';
import { Viewport } from '../viewport/viewport';
import type { ViewportCallbacks } from '../viewport/types';
import { createStore } from '../state/store';
import { createPlay } from '../ride/play';
import { rideControlHelp, type RideControlHelp } from '../ride/control-help';
import { customSkyUrl, setAssetUrlResolver } from '../net/asset-paths';
import { setClientProjectId } from '../net/client';
import type { SessionChannel } from '../net/session-channel';
import type { PeerMarks } from '../viewport/scene/peers';
import { localMapData } from './local-map-data';
import * as levels from '../../shared/map-levels';
import { readReferenceEffects } from '../../shared/map-effects';
import { buildLevelPropsUncached, nativeArtSource } from '../../shared/map-props';
import type { EditDoc } from '../../core/doc/doc-edit';
import { IMPORTED_PROP_LEVEL } from '../../core/props/imported';
import { DEFAULT_CHARACTER_MODEL_ID } from '../../core/characters/builtins';
import { lightPublicReference } from './lighting';
import { installLocalSky } from './sky';
import { cachedIsoCourses } from './iso-cache';
import { publicMountainDocument, publicPropPayload } from './course-assets';
import type { V3 } from '../../core/doc/types';
import { readLocalProject } from '../state/local-projects';
import { bundleAssets, bundleProps } from './bundle-assets';
import { installLocalAssetApi } from './local-asset-api';
import { parseAssetVersion } from '../../core/reference/asset-version';
import { toast } from '../ui/components/toast';
import { fetchJson } from '../net/fetch-json';

const yieldFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function json<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Course data could not be loaded (${response.status}).`);
  return response.json() as Promise<T>;
}

/** Public play composes the existing viewport and ride controller without starting the editor or autosave. */
export async function preparePublicPlayer(
  course: PublicCourse,
  container: HTMLElement,
  session: SessionChannel,
  ui: {
    progress: (text: string) => void;
    onPlaying: (playing: boolean) => void;
    onRideControls: (help: RideControlHelp | null) => void;
    onStartChanged: (custom: boolean) => void;
    /** The character to ride as; `setAvatar` changes it later. */
    avatar?: string;
  },
) {
  const { progress, onPlaying, onRideControls, onStartChanged } = ui;
  progress('Preparing the mountain…');
  const bundle = course.localProjectId ? await readLocalProject(course.localProjectId) : null;
  if (course.localProjectId && !bundle) throw new Error('This mountain is no longer saved on this device.');
  const privateSnapshot = course.private
    ? await json<{ document: EditDoc }>(`/api/projects/${encodeURIComponent(course.id)}`)
    : null;
  const privateLevels = course.private
    ? await json<{ maps?: { name: string; course?: string }[] }>('/api/levels')
    : null;
  const custom = bundle && bundleAssets(bundle);
  const aliases = {
    ...course.isoAliases,
    ...bundle?.isoAliases,
    ...Object.fromEntries((privateLevels?.maps ?? []).filter(map => map.course).map(map => [map.name, map.course!])),
    ...(course.kind === 'reference' && course.isoCourses[0] ? { [course.id]: course.isoCourses[0] } : {}),
  };
  const cached = await cachedIsoCourses().catch(() => [] as string[]);
  const availableCourses =
    bundle || course.private || course.kind === 'project'
      ? cached
      : course.isoCourses.filter(slot => cached.includes(slot));
  const availableLevels = [
    ...availableCourses,
    ...Object.keys(aliases).filter(level => availableCourses.includes(aliases[level])),
  ];
  const local = await localMapData(availableCourses, aliases, cached);
  installLocalAssetApi(local, availableCourses, !!course.private);
  setAssetUrlResolver(path => {
    const resolved = custom?.resolve(path) ?? path;
    return resolved !== path ? resolved : local.resolveAsset(path);
  });
  setClientProjectId(course.kind === 'project' && !bundle ? course.id : null);
  const store = createStore({ mdoc: defaultMountain(), currentMode: 'play', storedUi: {} });
  const noop = () => {};
  let updateRideControls = noop;
  let setStart: (world: V3) => void = noop;
  const callbacks: ViewportCallbacks = {
    onSelectKnot: noop,
    onMoveKnot: noop,
    onPaintCell: noop,
    onPick: noop,
    onSculpt: noop,
    onBeginSculpt: noop,
    onEndSculpt: noop,
    onBeginSculptGrab: noop,
    onSculptGrab: noop,
    onEndSculptGrab: noop,
    onStepBrushRadius: () => 1,
    isGrabBrush: () => false,
    onSelectCorner: noop,
    onMoveCorner: noop,
    onMoveHandle: noop,
    onSelectCorners: noop,
    onRideEvent: event => session.rideEvent(event),
    onRideControlContextChange: () => updateRideControls(),
    onPlayClick: world => setStart(world),
  };
  const viewport = new Viewport(container, callbacks, store);
  // Our own rider wears this; other players learn it from the pose published below.
  let avatar = ui.avatar ?? DEFAULT_CHARACTER_MODEL_ID;
  viewport.riderModel = avatar;
  updateRideControls = () =>
    onRideControls(
      viewport.riding && !viewport.xrPlaying ? rideControlHelp(viewport.rideWalking, viewport.rideFirstPerson) : null,
    );
  viewport.mode = 'play';
  viewport.setReferenceOffset([0, 0, 0]);
  viewport.shadeMode = 'textured';
  viewport.cage = false;
  viewport.showOwnBox(false);
  viewport.showRefBox(false);
  // Public play already fills the available screen; there is no editor chrome to expand past.
  viewport.setRideFullscreenControl(false);
  // The editor's optional Effects view starts off; public riding always presents the live course.
  store.worldEffectsVisible = true;
  viewport.showWorldEffects(true);
  store.playAiMax = 0;
  store.playCountdownOn = false;
  viewport.setRideSnow(0.25);
  const target = course.kind === 'reference' ? 'reference' : 'authored';
  let localSky: Awaited<ReturnType<typeof installLocalSky>>;
  if (course.kind === 'reference') {
    const level = course.id;
    if (course.retailData) {
      const patches = await levels.readLevelPatches(local.source, level);
      const [mesh, path, splines, aiPaths, laps, seconds] = await Promise.all([
        buildReferenceMeshProgressive(patches.patches, { yieldControl: yieldFrame }),
        levels.readLevelCourse(local.source, level),
        levels.readLevelSplines(local.source, level),
        levels.readLevelAiPaths(local.source, level),
        levels.readLevelLaps(local.source, level),
        levels.readLevelShowoffSeconds(local.source, level),
      ]);
      await lightPublicReference(mesh, patches.patches, id =>
        local.fileUrl(`${level}/Lightmaps/${String(id).padStart(4, '0')}.png`),
      );
      viewport.setReference(mesh, level);
      if (mesh.lightColor) viewport.setReferenceLighting(mesh.lightColor);
      viewport.setReferenceCourse(path?.points ?? null, path);
      viewport.setReferenceSplines(splines);
      viewport.setReferenceAiPaths(aiPaths);
      viewport.setReferenceLaps(laps);
      viewport.setReferenceShowoffSeconds(seconds);
      progress('Preparing scenery and collision…');
      const props = decodeProps(await buildLevelPropsUncached(local.source, level));
      viewport.registerPropModels(props);
      await viewport.setReferencePropsProgressive(props, yieldFrame);
      const effects = await readReferenceEffects(local.source, level).catch(() => null);
      if (effects) viewport.setReferenceEffects(decodeReferenceEffects(effects));
      localSky = await installLocalSky(viewport, local.source, level, local.fileUrl);
    } else {
      const data = await json<
        Awaited<ReturnType<typeof levels.readLevelPatches>> & {
          course: Awaited<ReturnType<typeof levels.readLevelCourse>>;
          splines: Awaited<ReturnType<typeof levels.readLevelSplines>>;
          aiPaths: Awaited<ReturnType<typeof levels.readLevelAiPaths>>;
          laps: number;
          showoffSeconds: number;
        }
      >(`/api/level?name=${encodeURIComponent(level)}`);
      const mesh = await buildReferenceMeshProgressive(data.patches, { yieldControl: yieldFrame });
      await lightPublicReference(mesh, data.patches, id => `/api/lightmap?level=${encodeURIComponent(level)}&id=${id}`);
      viewport.setReference(mesh, level);
      if (mesh.lightColor) viewport.setReferenceLighting(mesh.lightColor);
      viewport.setReferenceCourse(data.course?.points ?? null, data.course);
      viewport.setReferenceSplines(data.splines);
      viewport.setReferenceAiPaths(data.aiPaths);
      viewport.setReferenceLaps(data.laps);
      viewport.setReferenceShowoffSeconds(data.showoffSeconds);
      const props = decodeProps(await json<PropsPayload>(`/api/props?level=${encodeURIComponent(level)}`));
      viewport.registerPropModels(props);
      viewport.setReferenceProps(props);
    }
    viewport.showReferenceProps(true);
    viewport.showReferenceTricks(true);
    session.reference(level);
  } else {
    const snapshot =
      bundle ??
      privateSnapshot ??
      (await json<{ document: EditDoc }>(`/api/public/project?id=${encodeURIComponent(course.id)}`));
    const document = publicMountainDocument(snapshot.document, availableLevels);
    store.mdoc = document;
    await viewport.setMountainProgressive(document, null, [], noop, yieldFrame);
    viewport.syncLiveModels(authoredModelLevelProps(document));
    const donors = new Set(
      (document.props ?? [])
        .map(prop => prop.level)
        .filter(
          level =>
            !!parseAssetVersion(level) ||
            (!level.startsWith('@') &&
              availableLevels.some(available => available.toLowerCase() === level.toLowerCase())),
        ),
    );
    const installed = new Set<string>();
    const installDonor = async (level: string) => {
      if (installed.has(level)) return;
      const payload = parseAssetVersion(level)
        ? await fetchJson<PropsPayload>(`/api/props?level=${encodeURIComponent(level)}`)
        : await buildLevelPropsUncached(local.source, level);
      payload.level = level;
      viewport.registerPropModels(decodeProps(payload));
      installed.add(level);
    };
    const missing = new Set<string>();
    for (const level of donors) {
      try {
        await installDonor(level);
      } catch (error) {
        if (!parseAssetVersion(level)) throw error;
        missing.add(level);
      }
    }
    if (missing.size) {
      document.props = document.props?.filter(prop => !missing.has(prop.level));
      toast('Some prop versions are unavailable. Load the matching game assets to see those props.', 'warn', 8000);
    }
    if (document.props?.some(prop => prop.level === IMPORTED_PROP_LEVEL)) {
      const props = bundle
        ? bundleProps(bundle)
        : await json<PropsPayload>(`/api/custom-props?project=${encodeURIComponent(course.id)}`);
      viewport.syncLiveModels(decodeProps(publicPropPayload(props, availableLevels)));
    }
    if (availableCourses.length) {
      const art = await nativeArtSource(local.source);
      for (const donor of new Set([art.gemLevel].filter(Boolean))) {
        await installDonor(donor);
      }
      viewport.setRailSkins(art.railSkins);
      viewport.setGemModels(new Map(art.gemTiers.map(tier => [tier.tier, { level: art.gemLevel, model: tier.model }])));
    }
    viewport.setPlacedProps(document.props ?? [], null, [], document.effects);
    viewport.setRails(document.rails ?? [], null, null);
    viewport.setGems(document.gems ?? [], null);
    viewport.setFreeLights(document.lights ?? [], null);
    viewport.setParticleVolumes(document.particleVolumes ?? []);
    viewport.setScreens(document.screens ?? [], document.props, null);
    if (document.skybox?.source.kind === 'level') {
      localSky = await installLocalSky(viewport, local.source, document.skybox.source.level, local.fileUrl);
    } else if (document.skybox?.source.kind === 'custom') {
      const name = document.skybox.source.name;
      viewport.setSky({
        panorama: customSkyUrl(name, 'panorama'),
        ground: customSkyUrl(name, 'ground'),
        topColor: document.skybox.topColor,
      });
    }
    viewport.focusMountain(document);
  }
  const play = createPlay({
    store,
    viewport,
    persistUi: noop,
    rebuildTools: noop,
    updateCmdSheet: noop,
    syncSkyVisibility: () => {
      const playing = viewport.riding || viewport.xrPlaying;
      viewport.showSky(playing);
      localSky?.setVisible(playing);
    },
    ensureReferenceEffects: async () => {},
    onPlayingChanged: playing => {
      session.setPlaying(playing);
      onPlaying(!!playing);
      updateRideControls();
    },
  });
  play.enterPlaySetup(target);
  setStart = world => {
    if (viewport.riding || viewport.xrPlaying) return;
    play.setPlaySpawn(world);
    onStartChanged(true);
  };
  const publish = window.setInterval(() => {
    if (session.isOpen())
      session.aware({
        player: viewport.playerPose(avatar, session.serverNow()),
        vertices: [],
        quads: [],
        dragging: [],
      });
  }, 100);
  const stopUpdateGuard = beforeAppUpdate(() => {
    if (viewport.riding || viewport.xrPlaying) throw new Error('Exit play before reloading to update.');
  });
  return {
    play: () => play.startPlay(),
    vr: () => play.startVr(),
    stop: () => {
      if (viewport.xrPlaying) play.stopVr();
      else play.exitRide();
    },
    resetStart() {
      const spawn = play.defaultPlaySpawn();
      if (!spawn) return;
      play.setPlaySpawn(spawn.pos);
      onStartChanged(false);
    },
    /** Swap our rider's character, mid-run included. */
    setAvatar(id: string) {
      avatar = id;
      viewport.riderModel = id;
    },
    peers(peers: PeerMarks[]) {
      viewport.setPeers(peers, session.serverNow());
    },
    canGoToPlayer(userId: string) {
      return !viewport.xrPlaying && viewport.activeMapPlayers().some(player => player.userId === userId);
    },
    goToPlayer(userId: string) {
      const player = viewport.activeMapPlayers().find(player => player.userId === userId);
      return !!player && viewport.goToMapPlayer(player.sessionId);
    },
    rideEvent: viewport.applyRideEvent.bind(viewport),
    dispose() {
      stopUpdateGuard();
      clearInterval(publish);
      local.dispose();
      custom?.dispose();
    },
  };
}
export type PublicPlayer = Awaited<ReturnType<typeof preparePublicPlayer>>;

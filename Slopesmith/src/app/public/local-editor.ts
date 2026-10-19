import type { Account } from '../net/account';
import { configureWorkspace } from '../net/workspace';
import { setAssetUrlResolver } from '../net/asset-paths';
import { mapNameAtPath, mapPath } from '../navigation';
import { blankMountain, migrateMountain } from '../../core/doc/mountain';
import { computePreflight } from '../../core/export/preflight';
import { decodeProps, type PropsPayload } from '../../core/reference/props';
import { recordFromReferenceProp } from '../../core/props/adopt';
import type { EditDoc } from '../../core/doc/doc-edit';
import type { ProjectBundle, BundleAssetKind } from '../../core/project/transfer';
import type { PublicCourse } from '../../core/session/public-courses';
import { openLocalProjects } from '../state/local-projects';
import { cachedIsoCourses } from './iso-cache';
import { localMapData } from './local-map-data';
import * as levels from '../../shared/map-levels';
import { buildLevelPropsUncached, nativeArtSource, readMaterialTables } from '../../shared/map-props';
import { readReferenceEffects } from '../../shared/map-effects';
import { bundleAssets, bundleProps } from './bundle-assets';

const packed = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** Copy only the published document and its original assets. All subsequent editor requests stay local. */
async function publicBundle(course: PublicCourse): Promise<ProjectBundle> {
  const response = await fetch(`/api/public/project?id=${encodeURIComponent(course.id)}`);
  if (!response.ok) throw new Error('This public mountain is no longer available.');
  const { document } = (await response.json()) as { document: EditDoc };
  const bundle: ProjectBundle = {
    kind: 'slopesmith-project',
    schema: 1,
    name: document.name,
    revision: 0,
    takenAt: new Date().toISOString(),
    document: migrateMountain(document),
    assets: [],
    blobs: {},
    missing: [],
  };
  const wanted = new Map<string, { kind: BundleAssetKind; name: string; url: string }>();
  const add = (kind: BundleAssetKind, name: string, path: string, params: Record<string, string>) => {
    const url = new URL(path, location.origin);
    for (const [key, value] of Object.entries({ ...params, project: course.id })) url.searchParams.set(key, value);
    wanted.set(`${kind}:${name}`, { kind, name, url: url.href });
  };
  function collect(value: unknown): void {
    if (typeof value === 'string' && /^Custom\//i.test(value)) {
      const name = value.slice(value.indexOf('/') + 1);
      add('texture', name, '/api/texture', { level: 'Custom', name });
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === 'string' && ['collisionSoundFile', 'ambientSoundFile', 'soundFile'].includes(key))
          add('sound', child, '/api/custom-sound', { name: child });
        collect(child);
      }
  }
  async function attach(kind: BundleAssetKind, name: string, bytes: Uint8Array, model?: number) {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    bundle.assets.push({ kind, name, hash, size: bytes.length, ...(model === undefined ? {} : { model }) });
    bundle.blobs![hash] = packed(bytes);
  }
  if (
    document.props?.some(prop => prop.level === '@import') ||
    document.propLines?.some(line => line.template.level === '@import')
  ) {
    const response = await fetch(`/api/custom-props?project=${encodeURIComponent(course.id)}`);
    if (!response.ok) throw new Error('The public mountain’s custom models could not be loaded.');
    const props = decodeProps((await response.json()) as PropsPayload);
    for (const model of props.models) {
      const record = { ...recordFromReferenceProp(props, model, model.name).record, id: model.id };
      collect(record);
      await attach('prop', record.name, new TextEncoder().encode(JSON.stringify(record)), record.id);
    }
  }
  collect(document);
  if (document.raceMusic) add('music', document.raceMusic, '/api/custom-music-file', { name: document.raceMusic });
  if (document.skybox?.source.kind === 'custom') {
    const name = document.skybox.source.name;
    add('sky', name, '/api/skypano', { sky: name });
  }
  for (const asset of wanted.values()) {
    const response = await fetch(asset.url);
    if (response.ok) await attach(asset.kind, asset.name, new Uint8Array(await response.arrayBuffer()));
    else bundle.missing!.push(`${asset.kind}:${asset.name}`);
  }
  return bundle;
}

/** ISO inspection and browser projects read reference data from this device's ISO cache. */
export async function prepareEditorWorkspace(account: Account): Promise<void> {
  const url = new URL(location.href),
    reference = url.searchParams.get('reference'),
    localRequest = url.searchParams.get('local');
  const offline = account.accounts === 'open' && account.offline;
  const localOnly = !!localRequest || offline || (account.accounts === 'required' && !('user' in account));
  if (!localOnly && !reference) return;
  const cached = await cachedIsoCourses();
  const projects = localOnly ? await openLocalProjects() : null;
  if (projects) {
    const name = mapNameAtPath(url.pathname, 'editor');
    if (localRequest === 'new') await projects.createNew();
    else if (localRequest) {
      if (!projects.open(localRequest)) throw new Error('This local mountain is no longer saved on this device.');
    } else if (name) {
      if (offline) {
        if (!projects.openNamed(name)) throw new Error('This mountain is not saved on this device. Open Maps to choose a local mountain.');
      } else {
        const response = await fetch('/api/public/courses');
        if (!response.ok) throw new Error('The public map catalogue could not be loaded.');
        const { courses } = (await response.json()) as { courses: PublicCourse[] };
        const course = courses.find(
          course => course.kind === 'project' && course.name.toLowerCase() === name.toLowerCase(),
        );
        if (course) {
          const bundle = await publicBundle(course);
          await projects.copyPublic(bundle, course.id, course.isoAliases);
        } else if (!projects.openNamed(name)) throw new Error('This mountain is private or no longer available.');
      }
    } else if (reference) await projects.seed(blankMountain(), undefined, `reference:${reference}`);
    // A project id in an authenticated/capture URL must never bind the guest workspace to a server project.
    url.searchParams.delete('project');
    const active = projects.activeProject();
    if (active) {
      url.pathname = mapPath('editor', active.name);
      url.searchParams.set('local', active.id);
    }
    history.replaceState(history.state, '', url);
  }
  let aliases = projects?.isoAliases() ?? {};
  let local = await localMapData(cached, aliases);
  let aliasKey = JSON.stringify(aliases);
  async function refreshAliases() {
    const next = projects?.isoAliases() ?? {};
    if (JSON.stringify(next) === aliasKey) return;
    const source = await localMapData(cached, next);
    local.dispose();
    local = source;
    aliases = next;
    aliasKey = JSON.stringify(next);
  }
  const custom = bundleAssets(() => projects?.current());
  window.addEventListener('pagehide', event => { if (!event.persisted) custom.dispose(); });
  const resolve = (path: string): string => {
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return path;
    if (localOnly) {
      const resolved = custom.resolve(path);
      if (resolved !== path) return resolved;
    }
    const resolved = local.resolveAsset(path);
    if (resolved !== path) return resolved;
    const bytes = [
      '/api/texture',
      '/api/lightmap',
      '/api/particle-texture',
      '/api/effect-sound',
      '/api/board-sound',
      '/api/environment-sound',
      '/api/announcer-sound',
      '/api/skypano',
      '/api/skyground',
      '/api/skybox/page',
    ];
    return localOnly && bytes.includes(url.pathname) ? 'data:application/octet-stream;base64,' : path;
  };
  setAssetUrlResolver(resolve);
  const knownLevel = (level: string) =>
    cached.some(name => name.toLowerCase() === level.toLowerCase()) ||
    Object.entries(aliases).some(
      ([alias, slot]) => alias.toLowerCase() === level.toLowerCase() && cached.includes(slot),
    );
  configureWorkspace(localOnly, async (url, init) => {
    const path = url.pathname,
      q = url.searchParams,
      level = q.get('level') ?? q.get('name') ?? '';
    const json = Response.json;
    // Choosing a local mountain changes where map edits go, not who is signed in. Account controls
    // remain usable for members; project/library writes still go through the local-only adapter below.
    if (
      localOnly && 'user' in account &&
      (path.startsWith('/api/auth/') ||
        ((init?.method ?? 'GET').toUpperCase() === 'GET' &&
          (path === '/api/members' || path.startsWith('/api/members/'))))
    ) return fetch(url, init);
    if (projects) {
      const response = await projects.request(url, init);
      if (response) {
        await refreshAliases();
        return response;
      }
    }
    if ((init?.method ?? 'GET').toUpperCase() !== 'GET') {
      if (localOnly && path === '/api/preflight')
        return json(computePreflight((JSON.parse(String(init?.body)) as { doc: EditDoc }).doc));
      return null;
    }
    if (path === '/api/levels') {
      const maps = (await levels.listLevelOrigins(local.source)).map(map => ({
        ...map,
        name: cached.find(name => name.toLowerCase() === map.name.toLowerCase()) ?? map.name,
      }));
      if (localOnly) return json({ levels: cached, maps });
      const response = await fetch(url, init);
      if (!response.ok) return response;
      const server = (await response.json()) as { levels: string[]; maps: typeof maps };
      return json({
        levels: [...new Set([...server.levels, ...cached])],
        maps: [...server.maps.filter(map => !knownLevel(map.name)), ...maps],
      });
    }
    if (path === '/api/level' && knownLevel(level)) {
      const [patches, course, light, splines, aiPaths, laps, showoffSeconds, world, billboards] = await Promise.all([
        levels.readLevelPatches(local.source, level),
        levels.readLevelCourse(local.source, level),
        levels.readLevelLights(local.source, level),
        levels.readLevelSplines(local.source, level),
        levels.readLevelAiPaths(local.source, level),
        levels.readLevelLaps(local.source, level),
        levels.readLevelShowoffSeconds(local.source, level),
        levels.readLevelWorld(local.source, level),
        levels.readLevelBillboards(local.source, level),
      ]);
      return json({ ...patches, course, light, splines, aiPaths, laps, showoffSeconds, world, billboards });
    }
    if (path === '/api/props' && knownLevel(level)) return json(await buildLevelPropsUncached(local.source, level));
    if (path === '/api/effects' && knownLevel(level)) return json(await readReferenceEffects(local.source, level));
    if (path === '/api/lightrig' && knownLevel(level)) return json(await levels.readLevelLightRig(local.source, level));
    if (path === '/api/textures' && (localOnly || knownLevel(level))) {
      const names =
        level.toLowerCase() === 'custom'
          ? (projects
              ?.current()
              ?.assets.filter(asset => asset.kind === 'texture')
              .map(asset => asset.name) ?? [])
          : await local.source.listDir(`${level}/Textures`);
      return json(
        level
          ? { level, tiles: names.filter(name => /\.png$/i.test(name)).map(name => ({ name, count: 0 })) }
          : { levels: cached },
      );
    }
    if (localOnly && path === '/api/props/native-art') return json(await nativeArtSource(local.source));
    if (localOnly && path === '/api/props/materials')
      return json({ tables: Object.fromEntries(await readMaterialTables(local.source)) });
    if (localOnly && path === '/api/props') return json({ levels: cached });
    if (localOnly && path === '/api/custom-props') {
      const bundle = projects?.current();
      return json(bundle ? bundleProps(bundle) : { level: '@import', models: [], materials: [], instances: [] });
    }
    if (localOnly && path === '/api/custom-sounds')
      return json({
        sounds:
          projects
            ?.current()
            ?.assets.filter(asset => asset.kind === 'sound')
            .map(asset => asset.name) ?? [],
      });
    if (localOnly && path === '/api/characters') return json({ characters: [] });
    if (localOnly && path === '/api/skybox')
      return json({
        levels: [],
        skies:
          projects
            ?.current()
            ?.assets.filter(asset => asset.kind === 'sky')
            .map(asset => asset.name) ?? [],
      });
    if (localOnly && path === '/api/groups') return json({ groups: [] });
    const resolved = resolve(url.href);
    return (resolved !== url.href && resolved.startsWith('blob:')) || resolved.startsWith('data:application/json')
      ? fetch(resolved)
      : null;
  });
}

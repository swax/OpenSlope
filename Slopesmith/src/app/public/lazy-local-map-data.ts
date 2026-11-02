import type { MapDataSource } from '../../shared/map-data';
import { mapLimit, READ_CONCURRENCY } from '../../shared/map-data';
import { findMapChoice, legacyTrickyMapName, mapSourceId, splitMapSource } from '../../core/reference/map-source';
import { BOARD_BANK, BOOST_BANK } from '../../core/audio/board-sound';
import type { CollisionSoundIndex } from '../../core/effects/collision-sound';
import { compareBoardAudioSources } from '../../core/audio/board-sources';
import { normalizeMapGame } from '../../core/reference/map-game';
import { referenceParticleTexturePaths } from '../../core/effects/particle-textures';
import { mapSourceRequest } from '../net/map-source';
import { cachedCourseHasFiles, cachedCoursePaths, readCachedCourseFile } from './iso-cache';
import { localMapData } from './local-map-data';

const AUDIO_ROUTES = new Set([
  '/api/board-audio',
  '/api/board-sound',
  '/api/environment-sound',
  '/api/effect-sound',
  '/api/reference-music',
  '/api/reference-music-sample',
  '/api/reference-intro-music',
]);

/** A catalogue holds identities; opening it does not read every course's files or music graphs. */
export async function lazyLocalMapData(
  courses: string[],
  aliases: Record<string, string> = {},
  audioDonors: string[] = [],
) {
  const available = new Map(courses.map(course => [course.toLowerCase(), course]));
  const pool = new Map([...courses, ...audioDonors].map(course => [course.toLowerCase(), course]));
  const names = [...available.keys()];
  for (const [alias, target] of Object.entries(aliases)) {
    const match = findMapChoice(
      [...available.values()].map(name => ({ name })),
      target,
    );
    if (match && !available.has(alias.toLowerCase())) {
      available.set(alias.toLowerCase(), match.name);
      names.push(alias.toLowerCase());
    }
  }
  const courseFor = (name: string) => {
    const key = splitMapSource(name).name.toLowerCase();
    return available.get(key) ?? available.get(legacyTrickyMapName(key)?.toLowerCase() ?? '');
  };
  const hasLevel = (name: string) => !!courseFor(name);
  let disposed = false;
  const scope = crypto.randomUUID();
  const blobs = new Map<string, Promise<Blob | null>>();
  const readyBlobs = new Map<string, Blob>();
  const urls = new Map<string, string>();
  const paths = new Map<string, Promise<Set<string>>>();
  const audio = new Map<string, Promise<Awaited<ReturnType<typeof localMapData>>>>();
  const readyAudio = new Map<string, Awaited<ReturnType<typeof localMapData>>>();
  const split = (path: string) => {
    const [name, ...rest] = path.replace(/\\/g, '/').split('/').filter(Boolean);
    return { course: courseFor(name ?? ''), path: rest.join('/').toLowerCase() };
  };
  const fileKey = (course: string, path: string) => `${course}/${path.toLowerCase()}`;
  async function readFile(path: string): Promise<Blob | null> {
    const selected = split(path);
    if (!selected.course || !selected.path) return null;
    const key = fileKey(selected.course, selected.path);
    let value = blobs.get(key);
    if (!value) {
      value = readCachedCourseFile(selected.course, selected.path).then(blob => {
        if (disposed) throw new Error('This local asset workspace is closed.');
        if (blob) readyBlobs.set(key, blob);
        return blob;
      });
      blobs.set(key, value);
      void value.catch(() => {
        if (blobs.get(key) === value) blobs.delete(key);
      });
    }
    return value;
  }
  function coursePaths(course: string): Promise<Set<string>> {
    let pending = paths.get(course);
    if (!pending) {
      pending = cachedCoursePaths(course).then(names => new Set(names));
      paths.set(course, pending);
      void pending.catch(() => {
        if (paths.get(course) === pending) paths.delete(course);
      });
    }
    return pending;
  }
  async function list(path: string): Promise<string[]> {
    if (!path) return names;
    const selected = split(path);
    if (!selected.course) return [];
    const prefix = selected.path ? `${selected.path}/` : '';
    return [
      ...new Set(
        [...(await coursePaths(selected.course))]
          .filter(name => name.startsWith(prefix))
          .map(name => name.slice(prefix.length).split('/')[0]),
      ),
    ];
  }
  const source: MapDataSource = {
    root: '',
    async readJsonOr<T>(path: string, fallback: T) {
      const file = await readFile(path);
      return file ? (JSON.parse(await file.text()) as T) : fallback;
    },
    async readTextOrNull(path) {
      return (await (await readFile(path))?.text()) ?? null;
    },
    async readBytesOrNull(path) {
      const file = await readFile(path);
      return file ? new Uint8Array(await file.arrayBuffer()) : null;
    },
    async listDir(path) {
      return list(path);
    },
    async listEntries(path) {
      const selected = split(path);
      const files = selected.course ? await coursePaths(selected.course) : new Set<string>();
      const prefix = selected.path ? `${selected.path}/` : '';
      return (await list(path)).map(name => ({ name, isDirectory: !path || !files.has(prefix + name) }));
    },
    async pathExists(path) {
      const selected = split(path);
      if (!selected.course) return false;
      return !selected.path || !!(await readFile(path)) || cachedCourseHasFiles(selected.course, `${selected.path}/`);
    },
  };
  function fileUrl(path: string): string {
    const selected = split(path);
    if (!selected.course) return 'data:application/octet-stream;base64,';
    const key = fileKey(selected.course, selected.path);
    const file = readyBlobs.get(key);
    if (!file)
      return `/api/local-map-file?level=${encodeURIComponent(mapSourceId('local', selected.course))}&path=${encodeURIComponent(selected.path)}&localAssets=${scope}`;
    let url = urls.get(key);
    if (!url) {
      url = URL.createObjectURL(file);
      urls.set(key, url);
    }
    return url;
  }
  async function jsonFile<T>(course: string, path: string, fallback: T): Promise<T> {
    const file = await readCachedCourseFile(course, path);
    return file ? (JSON.parse(await file.text()) as T) : fallback;
  }
  let choices: Promise<{ name: string; game?: string; index: Partial<CollisionSoundIndex> }[]> | undefined;
  function audioChoices() {
    return (choices ??= mapLimit([...pool.values()], READ_CONCURRENCY, async name => {
      const index = await jsonFile<Partial<CollisionSoundIndex>>(name, 'Audio/SoundIndex.json', { Banks: {} });
      let game: string | undefined;
      for (const path of ['Audio/RidingImport.json', 'Origin.json', 'Import.json']) {
        game = normalizeMapGame((await jsonFile<{ Game?: unknown }>(name, path, {})).Game);
        if (game) break;
      }
      return { name, game, index };
    }));
  }
  const preferred = new Map<string, Promise<string | undefined>>();
  function preferredAudio(bank: string, donors = false): Promise<string | undefined> {
    const key = `${bank}:${donors}`;
    let pending = preferred.get(key);
    if (!pending) {
      pending = findPreferredAudio(bank, donors);
      preferred.set(key, pending);
      void pending.catch(() => {
        if (preferred.get(key) === pending) preferred.delete(key);
      });
    }
    return pending;
  }
  async function findPreferredAudio(bank: string, donors: boolean): Promise<string | undefined> {
    const candidates = (await audioChoices())
      .filter(choice => donors || available.has(choice.name.toLowerCase()))
      .map(choice => ({ ...choice, bank: choice.index.Banks?.[bank === BOARD_BANK ? '1' : '0'] ?? bank }))
      .sort(compareBoardAudioSources);
    for (const candidate of candidates)
      if (
        (await cachedCoursePaths(candidate.name, `audio/sfx/${candidate.bank.toLowerCase()}/`)).some(path =>
          path.endsWith('.wav'),
        )
      )
        return candidate.name;
  }
  async function loadAudio(selected: string[], music: boolean) {
    const key = `${music}:${[...new Set(selected)].sort().join('|')}`;
    let pending = audio.get(key);
    if (!pending) {
      pending = (async () => {
        const fallback = (
          await Promise.all(
            selected.map(course =>
              jsonFile<Partial<CollisionSoundIndex>>(course, 'Audio/SoundIndex.json', { Banks: {} }),
            ),
          )
        ).some(index => index.RidingFallback === 'ssx-tricky');
        const donor = fallback ? await preferredAudio(BOARD_BANK, true) : undefined;
        const value = await localMapData(selected, aliases, donor ? [donor] : [], music ? 'audio' : 'riding');
        if (disposed) {
          value.dispose();
          throw new Error('This local asset workspace is closed.');
        }
        readyAudio.set(key, value);
        return value;
      })();
      audio.set(key, pending);
      void pending.catch(() => {
        if (audio.get(key) === pending) audio.delete(key);
      });
    }
    return pending;
  }
  function resolveAsset(path: string): string {
    const selected = mapSourceRequest(path);
    if (selected.source === 'server' || selected.version) return path;
    const { url } = selected,
      q = url.searchParams;
    const level = q.get('level') ?? '';
    if (AUDIO_ROUTES.has(url.pathname)) {
      if (level ? hasLevel(level) : courses.length) {
        url.searchParams.set('mapSource', 'local');
        url.searchParams.set('localAssets', scope);
        return url.href;
      }
      return path;
    }
    if (q.has('project') || level.toLowerCase() === 'custom') return path;
    if (url.pathname === '/api/texture' && hasLevel(level)) return fileUrl(`${level}/Textures/${q.get('name')}`);
    if (url.pathname === '/api/lightmap' && hasLevel(level))
      return fileUrl(`${level}/Lightmaps/${(q.get('id') ?? '0').padStart(4, '0')}.png`);
    if (url.pathname === '/api/particle-texture' && (level ? hasLevel(level) : courses.length > 0)) {
      url.searchParams.set('mapSource', 'local');
      url.searchParams.set('localAssets', scope);
      return url.href;
    }
    // Other local byte routes are resolved asynchronously by the workspace transport.
    return path;
  }
  async function resolveRequest(path: string): Promise<string> {
    const selected = mapSourceRequest(path);
    if (selected.source === 'server') return path;
    const { url } = selected,
      q = url.searchParams,
      level = q.get('level') ?? '';
    if (url.pathname === '/api/local-map-file') {
      const full = `${level}/${q.get('path') ?? ''}`;
      return (await readFile(full)) ? fileUrl(full) : 'data:application/octet-stream;base64,';
    }
    if (url.pathname === '/api/announcer-audio') return 'data:application/json,%7B%7D';
    if (url.pathname === '/api/announcer-sound') return 'data:audio/wav;base64,';
    if (AUDIO_ROUTES.has(url.pathname)) {
      const course = courseFor(level);
      let selectedCourses = course ? [course] : [];
      if (!level) {
        if (url.pathname === '/api/environment-sound') {
          const bank = q.get('bank') ?? '',
            slot = (q.get('slot') ?? '0').padStart(3, '0');
          for (const candidate of courses) {
            if (
              (await readCachedCourseFile(candidate, `Audio/SFX/${bank}/${slot}.wav`)) ||
              (await readCachedCourseFile(candidate, `Audio/SFX/${bank}/${slot}.loop.wav`))
            ) {
              selectedCourses = [candidate];
              break;
            }
          }
        } else
          selectedCourses = [
            ...new Set(
              (await Promise.all([preferredAudio(BOARD_BANK), preferredAudio(BOOST_BANK)])).filter(
                (value): value is string => !!value,
              ),
            ),
          ];
      }
      return (await loadAudio(selectedCourses, url.pathname.startsWith('/api/reference-'))).resolveAsset(
        selected.url.href,
      );
    }
    if (url.pathname === '/api/particle-texture' && (level ? hasLevel(level) : courses.length > 0)) {
      const name = q.get('name') ?? 'fog0.png';
      for (const course of level ? [level] : courses) {
        const riding = await source.readJsonOr<unknown>(`${course}/RidingEffects.json`, {});
        for (const sprite of referenceParticleTexturePaths(name, riding)) {
          const full = `${course}/Textures/${sprite}`;
          if (await readFile(full)) return fileUrl(full);
        }
      }
      return 'data:image/png;base64,';
    }
    const resolved = resolveAsset(path);
    return resolved !== path && mapSourceRequest(resolved).url.pathname === '/api/local-map-file'
      ? resolveRequest(resolved)
      : resolved;
  }
  return {
    source,
    fileUrl,
    resolveAsset,
    resolveRequest,
    hasLevel,
    dispose() {
      disposed = true;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      for (const data of readyAudio.values()) data.dispose();
      urls.clear();
      readyAudio.clear();
      readyBlobs.clear();
      blobs.clear();
      paths.clear();
    },
  };
}

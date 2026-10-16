import type { MapDataSource } from '../../shared/map-data';
import { readCachedCourse } from './iso-cache';
import type { CollisionSoundIndex } from '../../core/effects/collision-sound';
import type { ReferenceMusicGraph, ReferenceMusicIndex, ReferenceMusicSummary } from '../../core/reference/music';

/** Read the same portable map files as the server, with browser-local Blobs replacing filesystem reads. */
export async function localMapData(courses: string[], aliases: Record<string, string> = {}) {
  const all = new Map<string, Map<string, Blob>>();
  for (const course of courses) all.set(course.toLowerCase(), await readCachedCourse(course));
  for (const [alias, course] of Object.entries(aliases)) {
    const files = all.get(course.toLowerCase());
    if (files) all.set(alias.toLowerCase(), files);
  }
  const urls = new Map<string, string>();
  const soundIndexes = new Map<string, CollisionSoundIndex>();
  const musicIndexes = new Map<string, ReferenceMusicIndex>();
  const musicGraphs = new Map<string, ReferenceMusicGraph>();
  for (const [level, files] of all) {
    const index = files.get('audio/soundindex.json');
    if (index) soundIndexes.set(level, JSON.parse(await index.text()) as CollisionSoundIndex);
    const playlist = files.get('audio/music/playlist.json');
    const songs: ReferenceMusicSummary[] = [];
    for (const id of playlist ? JSON.parse(await playlist.text()) as string[] : []) {
      const graphFile = files.get(`audio/music/${id.toLowerCase()}/graph.json`);
      if (!graphFile) continue;
      const graph = JSON.parse(await graphFile.text()) as ReferenceMusicGraph;
      musicGraphs.set(`${level}/${id.toLowerCase()}`, graph);
      const totalSeconds = graph.Samples.reduce((sum, sample) => sum + (sample.Seconds ?? sample.Meta / 1000), 0);
      songs.push({ id, title: graph.Song, short: graph.Short ?? id, bpm: graph.Bpm, tracks: graph.Tracks,
        sections: graph.Sections, events: graph.Events, routers: graph.Routers.length, nodes: graph.Nodes.length,
        samples: graph.Samples.length, totalSeconds, averageChunkSeconds: totalSeconds / Math.max(1, graph.Samples.length) });
    }
    musicIndexes.set(level, { level, songs, intro: null, environment: null });
  }
  const fallbackSprite = document.createElement('canvas'); fallbackSprite.width = fallbackSprite.height = 32;
  const context = fallbackSprite.getContext('2d')!;
  const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, '#ffffff'); gradient.addColorStop(1, '#ffffff00');
  context.fillStyle = gradient; context.fillRect(0, 0, 32, 32);
  const fallbackUrl = fallbackSprite.toDataURL();
  const parts = (path: string) => path.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
  const blob = (path: string): Blob | undefined => {
    const [level, ...rest] = parts(path);
    return all.get(level)?.get(rest.join('/'));
  };
  const list = (path: string) => {
    const [level, ...rest] = parts(path);
    if (!level) return [...all.keys()];
    const prefix = rest.length ? `${rest.join('/')}/` : '';
    return [...new Set([...(all.get(level)?.keys() ?? [])].filter(key => key.startsWith(prefix))
      .map(key => key.slice(prefix.length).split('/')[0]))];
  };
  const source: MapDataSource = {
    root: '',
    async readJsonOr<T>(path: string, fallback: T) { const file = blob(path); return file ? JSON.parse(await file.text()) as T : fallback; },
    async readTextOrNull(path) { return await blob(path)?.text() ?? null; },
    async readBytesOrNull(path) { const file = blob(path); return file ? new Uint8Array(await file.arrayBuffer()) : null; },
    async listDir(path) { return list(path); },
    async listEntries(path) { return list(path).map(name => ({ name, isDirectory: !blob(`${path}/${name}`) })); },
    async pathExists(path) { return !!blob(path) || !!list(path).length; },
  };
  function fileUrl(path: string): string {
    const key = path.toLowerCase();
    const found = urls.get(key);
    if (found) return found;
    const file = blob(path);
    if (!file) return /\.png$/i.test(path) ? fallbackUrl : 'data:application/octet-stream;base64,';
    const url = URL.createObjectURL(file);
    urls.set(key, url);
    return url;
  }
  function resolveAsset(path: string): string {
    const url = new URL(path, location.origin), q = url.searchParams;
    const level = q.get('level') || courses[0] || '';
    const data = (value: unknown) => `data:application/json,${encodeURIComponent(JSON.stringify(value))}`;
    if (url.pathname === '/api/board-audio') return data({ board: courses[0] ?? null, boost: courses[0] ?? null, surfaceGroups: null });
    if (url.pathname === '/api/announcer-audio') return data({});
    if (url.pathname === '/api/reference-music') {
      const song = q.get('song');
      return data(song ? musicGraphs.get(`${level.toLowerCase()}/${song.toLowerCase()}`) ?? {}
        : musicIndexes.get(level.toLowerCase()) ?? { level, songs: [], intro: null, environment: null });
    }
    if (url.pathname === '/api/reference-music-sample') {
      const song = q.get('song') ?? '', sample = Number(q.get('sample')) - 1;
      const name = musicGraphs.get(`${level.toLowerCase()}/${song.toLowerCase()}`)?.Samples[sample]?.Wav;
      return name ? fileUrl(`${level}/Audio/Music/${song}/${name}`) : 'data:audio/wav;base64,';
    }
    if (level.toLowerCase() === 'custom' || q.has('project')) return path;
    if (url.pathname === '/api/texture') return fileUrl(`${level}/Textures/${q.get('name')}`);
    if (url.pathname === '/api/lightmap') return fileUrl(`${level}/Lightmaps/${(q.get('id') ?? '0').padStart(4, '0')}.png`);
    if (url.pathname === '/api/particle-texture') return fileUrl(`${level}/Textures/${q.get('name')}`);
    if (url.pathname === '/api/effect-sound') {
      const bank = q.get('bank') || 'course';
      const files = all.get(level.toLowerCase());
      const actualBank = bank === 'course' ? soundIndexes.get(level.toLowerCase())?.Banks['2']
        : bank === 'crowd' ? soundIndexes.get(level.toLowerCase())?.Banks['3'] : bank;
      const suffix = `/${(q.get('slot') ?? '0').padStart(3, '0')}.wav`;
      const sound = [...(files?.keys() ?? [])].find(path => path.startsWith('audio/sfx/') && path.endsWith(suffix)
        && path.split('/')[2] === actualBank?.toLowerCase());
      return sound ? fileUrl(`${level}/${sound}`) : 'data:audio/wav;base64,';
    }
    // Missing optional disc channels remain local too; a guest never falls back to server retail bytes.
    if (url.pathname === '/api/board-sound' || url.pathname === '/api/environment-sound') {
      const bank = q.get('bank')?.toLowerCase(), slot = (q.get('slot') ?? '0').padStart(3, '0');
      for (const course of courses) {
        const path = `${course}/Audio/SFX/${bank}/${slot}.wav`;
        if (blob(path)) return fileUrl(path);
      }
      return 'data:audio/wav;base64,';
    }
    if (url.pathname === '/api/announcer-sound') return 'data:audio/wav;base64,';
    return path;
  }
  return { source, fileUrl, resolveAsset, dispose() { for (const url of urls.values()) URL.revokeObjectURL(url); } };
}

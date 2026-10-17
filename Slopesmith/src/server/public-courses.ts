import { join } from 'node:path';
import { ensureWorkspace } from './workspace-config';
import { readJsonOr, writeJsonAtomic } from './fs-async';
import { serialize } from './serialize';
import { listProjects, openProject, requireProjectManager, type ProjectActor } from './projects';
import { listLevelOrigins } from './routes/levels';
import { classifyExportProvenance } from '../core/export/manifest';
import { referenceInRoom, type PublicCourse, type PublicCourseKind } from '../core/session/public-courses';
import type { EditDoc } from '../core/doc/doc-edit';
import { behaviourRecords } from '../core/props/defaults';
import { isDiscCourse } from '../core/reference/disc-courses';
import { IMPORTED_PROP_LEVEL } from '../core/props/imported';
import { withProjectAssets } from './project-assets';
import { listImportedProps } from './routes/imported-props';

interface Publication {
  kind: PublicCourseKind;
  id: string;
}
const file = async () => join((await ensureWorkspace()).workspaceRoot, 'public-courses.json');
const key = (kind: string, id: string) => `${kind}:${id}`;
let knownPublic = new Set<string>();
const changeListeners = new Set<() => void>();
export function onPublicCoursesChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}
export function publicRoomKnown(room: string): boolean {
  const level = referenceInRoom(room);
  if (level && isDiscCourse(level)) return true;
  return knownPublic.has(key(level === null ? 'project' : 'reference', level ?? room).toLowerCase());
}
async function publications(): Promise<Publication[]> {
  const rows = await readJsonOr<Publication[]>(await file(), []);
  const valid = Array.isArray(rows)
    ? rows.filter(row => row && (row.kind === 'project' || row.kind === 'reference') && typeof row.id === 'string')
    : [];
  knownPublic = new Set(valid.map(row => key(row.kind, row.id).toLowerCase()));
  return valid;
}

/** Asset levels are explicit refs; internal/generated and mountain-local banks never need a disc. */
export function projectIsoCourses(doc: EditDoc, assetTextures: readonly string[] = []): string[] {
  const levels = new Set<string>();
  const level = (value: string | undefined) => {
    if (value && !value.startsWith('@') && value.toLowerCase() !== 'custom') levels.add(value.toUpperCase());
  };
  const texture = (value: string | undefined | null) => {
    if (value?.includes('/')) level(value.split('/')[0]);
  };
  for (const ref of Object.values(doc.quadTex ?? {})) texture(ref);
  for (const ref of assetTextures) texture(ref);
  for (const model of doc.models ?? []) {
    texture(model.texture);
    for (const frame of model.frames ?? []) texture(frame);
  }
  for (const prop of doc.props ?? []) {
    level(prop.level);
    for (const record of behaviourRecords(prop)) level(record.nativeCollision?.physicsSource?.level);
  }
  for (const volume of doc.particleVolumes ?? []) texture(volume.texture);
  if (doc.skybox?.source.kind === 'level') level(doc.skybox.source.level);
  const textures = Object.fromEntries(
    Object.entries(doc.quadTex ?? {}).map(([id, ref]) => [
      id,
      { level: ref.split('/')[0], name: ref.split('/').slice(1).join('/') },
    ]),
  );
  // Rails/gems, shared sound banks and custom sky rings need one donor even without an explicit level ref.
  const provenance = classifyExportProvenance(doc, textures);
  if (provenance.retailDerived && !levels.size) levels.add('GARI');
  return [...levels].sort();
}

export async function publicCourses(): Promise<PublicCourse[]> {
  const [published, projects, maps] = await Promise.all([publications(), listProjects(), listLevelOrigins()]);
  const wanted = new Set(published.map(row => key(row.kind, row.id)));
  const result: PublicCourse[] = maps
    .filter(map => wanted.has(key('reference', map.name)))
    .map(map => ({
      kind: 'reference',
      id: map.name,
      name: map.name,
      retailData: map.retailData,
      isoCourses: map.retailData ? [map.course ?? map.name] : [],
    }));
  for (const project of projects) {
    if (!wanted.has(key('project', project.id))) continue;
    const snapshot = await openProject(project.id);
    const imported = new Set(
      snapshot.document.props?.filter(prop => prop.level === IMPORTED_PROP_LEVEL).map(prop => prop.model),
    );
    const assetTextures = imported.size
      ? (await withProjectAssets(snapshot, listImportedProps))
          .filter(entry => imported.has(entry.record.id))
          .flatMap(entry =>
            (entry.record.materials ?? []).flatMap(material => [material.tex, ...(material.frames ?? [])]),
          )
          .filter((ref): ref is string => !!ref)
      : [];
    const isoAliases: Record<string, string> = Object.fromEntries(
      projectIsoCourses(snapshot.document, assetTextures).map(name => {
        const origin = maps.find(map => map.name.toUpperCase() === name);
        return [name, origin?.course ?? name] as const;
      }),
    );
    const isoCourses = [...new Set(Object.values(isoAliases))].sort();
    result.push({
      kind: 'project',
      id: project.id,
      name: project.name,
      retailData: !!isoCourses.length,
      isoCourses,
      isoAliases,
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function isPublished(kind: PublicCourseKind, id: string): Promise<boolean> {
  return (await publications()).some(row => row.kind === kind && row.id.toLowerCase() === id.toLowerCase());
}

export async function publicRoomAllowed(room: string): Promise<boolean> {
  const level = referenceInRoom(room);
  if (level && isDiscCourse(level)) return true;
  return isPublished(level === null ? 'project' : 'reference', level ?? room);
}

export async function setPublished(
  kind: PublicCourseKind,
  id: string,
  published: boolean,
  actor: ProjectActor,
): Promise<void> {
  if (kind === 'project') {
    await requireProjectManager(id, actor);
  } else {
    if (actor.role !== 'admin' && actor.role !== 'moderator')
      throw new Error('Only moderators can publish reference maps.');
    const map = (await listLevelOrigins()).find(map => map.name.toLowerCase() === id.toLowerCase());
    if (!map) throw new Error('Reference map not found.');
    id = map.name;
    if (published && map.retailData && map.origin !== 'retail') {
      throw new Error(
        'This exported map mixes authored and retail files. Publish its editable mountain instead so retail assets resolve from each visitor’s ISO.',
      );
    }
    if (published && map.retailData && !map.course)
      throw new Error('Re-import this reference to record its ISO course slot before publishing it.');
  }
  await serialize('public-courses', async () => {
    const rows = (await publications()).filter(row => key(row.kind, row.id) !== key(kind, id));
    if (published) rows.push({ kind, id });
    await writeJsonAtomic(await file(), rows);
    knownPublic = new Set(rows.map(row => key(row.kind, row.id).toLowerCase()));
    for (const listener of changeListeners) listener();
  });
}

const LEVEL_READS = new Set([
  '/api/level',
  '/api/props',
  '/api/effects',
  '/api/lightrig',
  '/api/lightmap',
  '/api/texture',
  '/api/skypano',
  '/api/skyground',
]);
const PROJECT_READS = new Set([
  '/api/texture',
  '/api/custom-props',
  '/api/custom-sound',
  '/api/custom-music-file',
  '/api/skypano',
  '/api/skyground',
]);

/** Only original assets of an explicitly published course pass anonymously. Never grants a retail route. */
export async function publicAssetRequest(mount: string, mounted: string, method: string): Promise<boolean> {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const url = new URL(mounted, 'http://localhost');
  // Byte-route exceptions apply only to the leaf route, never its catalogues or future sub-routes.
  if (url.pathname !== '/') return false;
  const query = url.searchParams;
  const project = query.get('project');
  const level = query.get('level');
  const custom =
    mount === '/api/texture'
      ? level?.toLowerCase() === 'custom'
      : mount === '/api/skypano' || mount === '/api/skyground'
        ? !level && !!query.get('sky')
        : !level;
  if (project && PROJECT_READS.has(mount) && custom) {
    return isPublished('project', project);
  }
  const name = mount === '/api/level' ? query.get('name') : level;
  if (!name || !LEVEL_READS.has(mount) || !(await isPublished('reference', name))) return false;
  // Reference texture reads can fall back to the bank named inside a qualified texture ref. The public
  // exception must cover that donor too, otherwise an original reference becomes a proxy for retail art.
  if (mount === '/api/texture') {
    const ref = (query.get('name') ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    const slash = ref.indexOf('/');
    if (slash >= 0 && ref.slice(0, slash).toLowerCase() !== name.toLowerCase()) return false;
  }
  const map = (await listLevelOrigins()).find(map => map.name.toLowerCase() === name.toLowerCase());
  return !!map && !map.retailData;
}

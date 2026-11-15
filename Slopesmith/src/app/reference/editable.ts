import type { ProjectBundle } from '../../core/project/transfer';
import { mapGame, mapGameLabel, type MapSourceChoice } from '../../core/reference/map-game';
import type { MapSource } from '../../core/reference/map-source';
import type { PlacedProp, V3 } from '../../core/doc/types';
import { AUTHORED_MODEL_LEVEL, authoredModelLevelProps } from '../../core/doc/models';
import { courseCenters, startFrame, finishFrame } from '../../core/doc/course';
import { authoredAiDisplayPaths } from '../../core/doc/ai-paths';
import { decodeProps, type LevelProps, type PropsPayload } from '../../core/reference/props';
import { expandGroupProps, type GroupsPayload } from '../../core/reference/groups';
import { IMPORTED_PROP_LEVEL } from '../../core/props/imported';
import { isEffectTriggerProp } from '../../core/effects/trigger-volume';
import { createEmptyEffectsDocument } from '../../core/effects/authoring';
import { makeTexRef, parseTexRef, resolvePropTex } from '../../core/paint/textures';
import { generateTexture } from '../../core/paint/ground-textures';
import { toRaw } from '../../core/export/level';
import { rawInstanceQuat } from '../../core/export/props';
import { railHasTube, railBezierSegments, nativeSplineFields, railTubeTexture } from '../../core/rails/rails';
import { sweepRail, railSupportPosts } from '../../core/rails/rail-mesh';
import { currentAccount } from '../net/account';
import type { ReferenceMapSource } from '../net/reference-source';
import { listLocalProjects, readLocalProject } from '../state/local-projects';
import type { ClientProject } from '../state/project-sync';
import { projectAssetSource } from '../net/project-assets';
import { hexToRgb } from '../../core/math/color';
import { authoredPatches } from './authored';
import { encodePng } from '../export/png';

export interface EditableReferenceChoice extends MapSourceChoice {
  projectId: string;
  source: MapSource;
}

/** Reference groups distinguish saved editable mountains from unclassified map folders. */
export const referenceMapGames = {
  id(map: MapSourceChoice): string {
    if (/^(local|server):@project:/.test(map.name)) return 'slopesmith';
    const game = mapGame(map);
    return game === 'unknown' || game === 'slopesmith' ? 'custom-ref' : game;
  },
  label(game: string): string {
    return game === 'slopesmith' ? 'Slopesmith' : game === 'custom-ref' ? 'Custom Ref' : mapGameLabel(game);
  },
};

export function editableReferenceChoice(project: ClientProject, source: MapSource): EditableReferenceChoice {
  return {
    name: `${source}:@project:${encodeURIComponent(project.id)}`,
    projectId: project.id,
    source,
    origin: 'slopesmith',
    label: project.name,
    displayName: project.name,
  };
}

/** A new saved revision still names the same reference when restoring this mountain's view. */
export function findEditableReference(choices: readonly EditableReferenceChoice[], name: string) {
  const match = /^(local|server):@project:([^:]+)(?::|$)/.exec(name);
  return (
    match && choices.find(choice => choice.source === match[1] && encodeURIComponent(choice.projectId) === match[2])
  );
}

export async function listEditableReferences(): Promise<EditableReferenceChoice[]> {
  const server = async (): Promise<ClientProject[]> => {
    const account = await currentAccount();
    if (!('user' in account) && (account.accounts !== 'open' || account.offline)) return [];
    const response = await fetch('/api/projects');
    if (!response.ok) throw new Error('Could not list server mountains.');
    return ((await response.json()) as { projects: ClientProject[] }).projects;
  };
  const results = await Promise.allSettled([listLocalProjects(), server()]);
  return results.flatMap((result, i) => {
    if (result.status === 'rejected') {
      console.warn('Could not list editable reference maps:', result.reason);
      return [];
    }
    return result.value.map(project => editableReferenceChoice(project, i === 0 ? 'local' : 'server'));
  });
}

export async function openEditableReference(choice: EditableReferenceChoice): Promise<ReferenceMapSource> {
  let bundle: ProjectBundle | null;
  if (choice.source === 'local') bundle = await readLocalProject(choice.projectId);
  else {
    const snapshot = await json<{ project: ClientProject; document: ProjectBundle['document'] }>(
      await fetch(`/api/projects/${encodeURIComponent(choice.projectId)}`),
    );
    bundle = {
      kind: 'slopesmith-project',
      schema: 1,
      name: snapshot.project.name,
      revision: snapshot.project.revision,
      takenAt: snapshot.project.updatedAt,
      document: snapshot.document,
      assets: [],
    };
  }
  if (!bundle) throw new Error('This mountain is no longer saved on this device.');
  // This reader supplies project-owned and borrowed bytes independently of the active editor. No export runs.
  const assets = await projectAssetSource(
    bundle,
    bundle.isoAliases,
    choice.source === 'server' ? choice.projectId : undefined,
  );
  try {
    const importedProps = bundle.document.props?.some(prop => prop.level === IMPORTED_PROP_LEVEL)
      ? await json<PropsPayload>(await assets.request('/api/custom-props'))
      : null;
    // Match only this snapshot: the editor's active document and runtime substitutions stay independent.
    const matched = await assets.matchImported({ document: bundle.document, importedProps });
    return documentReferenceSource(
      `${choice.name}:snapshot:${crypto.randomUUID()}`,
      { ...bundle, document: matched.document.document },
      {
        request: path =>
          path === '/api/custom-props' && matched.document.importedProps
            ? Promise.resolve(Response.json(matched.document.importedProps))
            : assets.request(path),
        dispose: () => assets.dispose(),
      },
    );
  } catch (error) {
    assets.dispose();
    throw error;
  }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error((await response.text()) || 'Could not read this reference map.');
  return response.json() as Promise<T>;
}

const packed = (array: Float32Array | Uint32Array) => {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** Project an immutable editable snapshot into the existing reference protocol, without producing map files. */
export function documentReferenceSource(
  id: string,
  bundle: ProjectBundle,
  assets: { request(path: string): Promise<Response>; dispose(): void },
): ReferenceMapSource {
  const doc = structuredClone(bundle.document);
  const textures = new Map<string, string>();
  const names = new Map<string, string>();
  const texture = (ref: string): string => {
    let name = names.get(ref);
    if (!name) {
      name = `tile-${names.size}.png`;
      names.set(ref, name);
      textures.set(name, ref);
    }
    return name;
  };
  const patches = authoredPatches(doc, texture);
  const banks = new Map<string, Promise<LevelProps>>();
  const bank = (level: string): Promise<LevelProps> => {
    let pending = banks.get(level);
    if (!pending) {
      pending =
        level === AUTHORED_MODEL_LEVEL
          ? Promise.resolve(authoredModelLevelProps(doc))
          : assets
              .request(
                level === IMPORTED_PROP_LEVEL ? '/api/custom-props' : `/api/props?level=${encodeURIComponent(level)}`,
              )
              .then(response => json<PropsPayload>(response))
              .then(decodeProps);
      banks.set(level, pending);
    }
    return pending;
  };
  let props: Promise<PropsPayload> | undefined;
  async function readProps(): Promise<PropsPayload> {
    const payload: PropsPayload = { level: id, models: [], materials: [], instances: [] };
    const placements: PlacedProp[] = [];
    const groups = new Map<string, Promise<GroupsPayload>>();
    for (const prop of doc.props ?? []) {
      if (isEffectTriggerProp(prop)) continue;
      let definition = prop.groupDefinition;
      if (prop.group && !definition) {
        let pending = groups.get(prop.level);
        if (!pending) {
          pending = assets
            .request(`/api/groups?level=${encodeURIComponent(prop.level)}`)
            .then(response => json<GroupsPayload>(response));
          groups.set(prop.level, pending);
        }
        definition = (await pending).groups.find(group => group.id === prop.group);
        if (!definition) throw new Error(`The reference is missing prop group ${prop.group}.`);
      }
      placements.push(...(definition ? expandGroupProps(prop, definition) : [prop]));
    }
    await Promise.all([...new Set(placements.map(prop => prop.level))].map(bank));
    const models = new Map<string, number>();
    const materials = new Map<string, number>();
    for (const prop of placements) {
      const source = await bank(prop.level);
      const key = `${prop.level}:${prop.model}`;
      let modelId = models.get(key);
      if (modelId === undefined) {
        const model = source.models.find(model => model.id === prop.model);
        if (!model) throw new Error(`The reference is missing model ${prop.name || key}.`);
        modelId = payload.models.length;
        models.set(key, modelId);
        payload.models.push({
          id: modelId,
          name: model.name,
          ...(model.pickup ? { pickup: true } : {}),
          ...(model.animation ? { animation: model.animation } : {}),
          ...(model.rotation ? { rotation: model.rotation } : {}),
          ...(model.collision
            ? { collision: { pos: packed(model.collision.positions), idx: packed(model.collision.indices) } }
            : {}),
          subs: model.subs.map(sub => {
            const matKey = `${prop.level}:${sub.mat}`;
            let mat = materials.get(matKey);
            if (mat === undefined) {
              const original = source.materials.get(sub.mat);
              mat = original ? payload.materials.length : -1;
              materials.set(matKey, mat);
              if (original) {
                const page = resolvePropTex(prop.level, original.tex);
                payload.materials.push({
                  ...original,
                  id: mat,
                  tex: page.name ? texture(makeTexRef(page.level, page.name)) : null,
                  frames: original.frames.map(frame => texture(makeTexRef(page.level, frame))),
                });
              }
            }
            return {
              mat,
              pos: packed(sub.positions),
              uv: packed(sub.uvs),
              idx: packed(sub.indices),
              ...(sub.normals ? { nor: packed(sub.normals) } : {}),
              ...(sub.object !== undefined ? { object: sub.object } : {}),
              ...(sub.piece !== undefined ? { piece: sub.piece, piecePivot: sub.piecePivot } : {}),
            };
          }),
        });
      }
      payload.instances.push({
        i: payload.instances.length,
        m: modelId,
        p: toRaw(prop.pos),
        q: rawInstanceQuat(prop),
        s: [prop.scale, prop.scale, prop.scale],
        n: prop.name || prop.id || `Prop ${payload.instances.length + 1}`,
        pc: prop.solid !== false,
        pb: prop.solid !== false,
        c: prop.solid === false ? 0 : 2,
      });
    }
    for (const rail of doc.rails ?? []) {
      if (!railHasTube(rail)) continue;
      const skin = railTubeTexture(rail, {});
      const mat = skin ? payload.materials.length : -1;
      if (skin) payload.materials.push({ id: mat, tex: texture(skin) });
      for (const geometry of [sweepRail(rail), railSupportPosts(rail)]) {
        if (!geometry) continue;
        const positions = geometry.positions.flatMap((_, i) =>
          i % 3 === 0 ? toRaw(geometry.positions.slice(i, i + 3) as V3) : [],
        );
        const modelId = payload.models.length;
        payload.models.push({
          id: modelId,
          name: `Rail_${rail.name || rail.id || modelId}`,
          subs: [
            {
              mat,
              pos: packed(new Float32Array(positions)),
              uv: packed(new Float32Array(geometry.uvs)),
              idx: packed(new Uint32Array(geometry.indices)),
            },
          ],
        });
        payload.instances.push({
          i: payload.instances.length,
          m: modelId,
          p: [0, 0, 0],
          q: [0, 0, 0, 1],
          s: [1, 1, 1],
          n: `Rail_${modelId}`,
          c: 0,
        });
      }
    }
    return payload;
  }
  let disposed = false;
  return {
    id,
    async read(url) {
      if (disposed) return Response.json({ error: 'This editable reference is no longer loaded.' }, { status: 404 });
      const q = url.searchParams;
      if (url.pathname === '/api/level') {
        const points = doc.course.knots.length >= 2 ? courseCenters(doc.course) : [];
        const start = points.length ? startFrame(doc.course) : null;
        const finish = points.length ? finishFrame(doc.course) : null;
        return Response.json({
          name: id,
          patches,
          course: points.length
            ? {
                source: 'Editable map',
                points,
                start: start!.pos,
                finish: finish!.pos,
                finishFwd: finish!.fwd,
                podium: null,
                length: points.reduce(
                  (sum, point, i) => sum + (i ? Math.hypot(...point.map((n, axis) => n - points[i - 1][axis])) : 0),
                  0,
                ),
                drop: points[0][1] - points.at(-1)![1],
              }
            : null,
          splines: (doc.rails ?? []).map((rail, originalIndex) => ({
            originalIndex,
            name: rail.name || `Rail_${originalIndex}`,
            style: nativeSplineFields(rail).style,
            segments: railBezierSegments(rail.nodes, rail.handles).map(segment => segment.map(toRaw)),
          })),
          aiPaths: authoredAiDisplayPaths(doc.course, doc.aiSeed ?? 1, doc.aiPaths, doc.autoAiPaths !== false).map(
            (path, originalIndex) => ({
              ...path,
              originalIndex,
              start: originalIndex < 6,
              startSlots: originalIndex < 6 ? [originalIndex] : [],
              markers: [],
            }),
          ),
          laps: doc.laps,
          showoffSeconds: doc.showoffSeconds,
          world: doc.glare,
          light: doc.sun ? { ...doc.sun } : null,
        });
      }
      if (url.pathname === '/api/props') return Response.json(await (props ??= readProps()));
      if (url.pathname === '/api/texture') {
        const ref = textures.get(q.get('name') ?? '');
        if (!ref) return Response.json({ error: 'Unknown reference texture.' }, { status: 404 });
        const page = parseTexRef(ref);
        if (page.level === '@surface') {
          const bytes = await encodePng(generateTexture(page.name));
          return new Response(bytes as BodyInit, { headers: { 'content-type': 'image/png' } });
        }
        return assets.request(`/api/texture?${new URLSearchParams({ level: page.level, name: page.name })}`);
      }
      if (url.pathname === '/api/textures')
        return Response.json({ level: id, tiles: [...textures.keys()].map(name => ({ name, count: 0 })) });
      if (url.pathname === '/api/lightrig')
        return Response.json({
          level: id,
          lights: (doc.lights ?? []).map(light => {
            const pos = toRaw(light.pos);
            const radius = (light.reach * 100) / Math.sqrt(3);
            return {
              name: light.name || light.id || 'Light',
              type: light.kind === 'point' ? 2 : 1,
              colour: hexToRgb(light.color).map(c => c * light.intensity),
              dir: toRaw(light.dir ?? [0, -1, 0]).map(n => n / 100),
              pos,
              lo: pos.map(n => n - radius),
              hi: pos.map(n => n + radius),
              cone: light.kind === 'spot' ? Math.cos(((light.cone ?? 35) * Math.PI) / 180) : 1,
              coneSource: 'preview',
              spriteRes: light.glint ?? 0,
            };
          }),
        });
      if (url.pathname === '/api/effects')
        return Response.json({ level: id, document: createEmptyEffectsDocument(doc.name), instances: [] });
      if (url.pathname === '/api/reference-music')
        return Response.json({ level: id, songs: [], intro: null, environment: null });
      return Response.json({ error: 'This reference has no resource at this path.' }, { status: 404 });
    },
    dispose() {
      if (!disposed) assets.dispose();
      disposed = true;
    },
  };
}

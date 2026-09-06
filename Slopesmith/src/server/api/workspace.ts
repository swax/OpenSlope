import type { ServerResponse } from 'node:http';
import type { ApiRequest } from './request';
import type { Identity } from '../accounts/guard';
import type { ProjectActor } from '../projects';
import type { EditDoc } from '../../core/doc/doc-edit';
import type { LabelDefinition, V3 } from '../../core/doc/types';
import { changeSummary, describeChanges } from '../../core/doc/compare';
import { migrateMountain } from '../../core/doc/mountain';
import {
  documentRegisters, objectRegister, quadRegister, readRegister,
  type ObjectFamily, type QuadField, type RegisterKey, type RegisterValue,
} from '../../core/doc/registers';
import { validateEffectsDocument } from '../../core/effects/document';
import { surfaceHeightSampler } from '../../core/mesh/retopology/integrate-surface-fit';
import * as projects from '../projects';
import {
  asBundle, downloadDocument, downloadProject, duplicateProject, missingAssets, uploadProject, type BundleAsset,
} from '../project-transfer';
import { migrateLegacyProjectAssets, withProjectAssets } from '../project-assets';
import { systemEvent } from '../session/chat';
import { trimPlayerSeats } from '../session/capacity';
import { presenceFor, sessionsOn } from '../session/presence';
import {
  assign, joinRoom, onWire, planRevert, roomFor, roomWriters, takeSnapshot, type RevertRequest,
} from '../session/room';
import { prepareWebSocketText } from '../session/socket';
import { saveWorkspaceConfig, workspaceConfig } from '../workspace-config';
import { jsonResponse, readJsonBody, type ApiHandler } from './common';
import {
  gate, link, type ApiAction, type ApiActionTemplate, type ApiLink, type HateoasEnvelope,
} from './hateoas';
import { courseRuler, expandIntents } from './intents';

/** An uploaded map carries its custom assets inline, base64 by content hash, so the cap is a whole map's
 *  worth of art rather than a document's. Only the hashes the receiving server said it lacked are ever sent. */
const TRANSFER_BODY_LIMIT = 256 * 1024 * 1024;

/** A write refused by the optimistic check answers 409 carrying the snapshot the client is behind, which is
 *  what the conflict dialog resolves from — it needs the current revision to rebase onto and the current
 *  document to adopt. Shared by the two writes that can lose that race: a save and a restore.
 *
 *  The success answers with the project's own envelope, like create does: a document PUT is where an agent
 *  replaces topology, and the actions it wants next — assign registers, seat props on the new ground, upload
 *  the tiles that paint it — all hang off this resource. Without them the one write registers cannot make
 *  was also the one write that dead-ended the walk. The 409 stays bare: what a loser of that race needs is
 *  the snapshot to rebase onto, and its links would describe a state the caller does not yet hold. */
async function saveOrConflict(
  res: ServerResponse, identity: Identity | undefined, write: () => Promise<projects.ProjectSnapshot>,
): Promise<void> {
  try {
    const snapshot = await write();
    jsonResponse(res, 200, { ...snapshot, ...projectEnvelope(snapshot.project, identity) });
  } catch (error) {
    if (error instanceof projects.ProjectConflictError) {
      jsonResponse(res, 409, { error: error.message, ...error.snapshot });
    } else throw error;
  }
}

/** Who the server will credit a checkpoint to, and whose work it holds. Taken from the identity the guard
 *  already established and the people actually on the map — never from the request body, so a checkpoint's
 *  attribution is a fact rather than something a client claimed. */
function attribution(identity: Identity | undefined, projectId: string): { by: string; members: string[] } {
  const by = identity && (identity.kind === 'owner' || identity.kind === 'member') ? identity.user.username : '';
  const members = [...new Set(presenceFor(projectId).map(entry => entry.username))].sort();
  return { by, members: members.length ? members : by ? [by] : [] };
}

/** Who did something, as the room names them. Read off the identity the guard established, never off the
 *  request — which is what makes the events below facts rather than something a client claimed. */
const actor = (identity: Identity | undefined): string =>
  identity && (identity.kind === 'owner' || identity.kind === 'member') ? identity.user.username : 'Somebody';

/** The stable account facts project ownership is based on. The route guard has already excluded anonymous and
 *  unenrolled identities; access keys retain their account's authoring identity. */
function projectActor(identity: Identity | undefined): ProjectActor {
  if (identity && 'user' in identity) return { id: identity.user.id, role: identity.user.role };
  throw new projects.ProjectPermissionError('Sign in to change a map.');
}

/** The moment a checkpoint was taken, off the file name that encodes it — the half of "restored the
 *  checkpoint from 14:02" that makes the sentence worth reading. */
function checkpointClock(file: string): string {
  const stamp = /T(\d\d)-(\d\d)/.exec(decodeURIComponent(file));
  return stamp ? `${stamp[1]}:${stamp[2]}` : 'earlier';
}

/** The map as it stands right now: the room's copy when one is open, since that — not the file — is the
 *  authoritative document while people are editing (docs/039), and the file otherwise. */
async function liveDocument(id: string): Promise<EditDoc> {
  return roomFor(id)?.doc ?? (await projects.openProject(id)).document;
}

/** A list of ids off a request body, which is what a selection-bounded revert arrives as. */
const names = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 100_000) : [];

/** How far a revert reached, in the words the room hears it in. */
function revertPhrase(request: RevertRequest): string {
  const bounded = (request.vertices?.length ?? 0) + (request.quads?.length ?? 0) > 0;
  return `everything ${request.by ? `${request.by} changed` : 'that changed'}${bounded ? ' in a selection' : ''}`;
}

// ---- the HATEOAS surface of a map (docs/052) --------------------------------------------------------------

/** Whether this identity may edit / manage this map, for gating actions the way the write routes will
 *  actually answer. Read-only when the caller has no account at all. */
function projectGates(project: projects.ProjectManifest, identity: Identity | undefined) {
  const actor = identity && 'user' in identity
    ? { id: identity.user.id, role: identity.user.role } : undefined;
  const edit = gate(identity, 'editor');
  const restricted = actor && !('disabled' in edit) && !projects.canEditProject(project, actor)
    ? { disabled: true as const,
      disabledReason: 'This map is restricted to editors selected by its owner.' }
    : edit;
  const manage = actor && projects.canManageProject(project, actor)
    ? {} : { disabled: true as const,
      disabledReason: 'Only this map\'s owner or a moderator can do that.' };
  return { edit: restricted, manage };
}

/**
 * Everything one map offers, computed against who is asking (docs/052). This response is never shared
 * through the response cache, so identity-dependent disabling is safe here — an action the caller cannot
 * invoke is emitted disabled with the reason the route would refuse with, which is an agent's recourse.
 *
 * The asset library actions carry `?project=` so a session-less caller (an agent with a bearer key has no
 * browser tab) is bound to this mountain explicitly rather than to whatever happens to be open.
 */
function projectEnvelope(project: projects.ProjectManifest, identity: Identity | undefined): HateoasEnvelope {
  const id = encodeURIComponent(project.id);
  const base = `/api/projects/${id}`;
  const { edit, manage } = projectGates(project, identity);
  const links: ApiLink[] = [
    link('self', base, 'This map: manifest, revision, and its whole document'),
    link('collection', '/api/projects'),
    link('root', '/api'),
    link('registers', `${base}/registers`, 'The map\'s authoring state as registers; POST edits here'),
    link('ground', `${base}/ground`, 'POST { points: [[x,z],…] } — the surface height under each; the '
      + '`seat` action is what moves placements onto it'),
    link('course', `${base}/course`, 'The run as a ruler: its length, each knot\'s station, and a station table '
      + '(?every=25, or ?at=120,340) with heading, floor width and ground — the frame pos: {station, lateral} '
      + 'places in; ?near=x,z;x,z answers where points already on the map stand in it'),
    link('labels', `${base}/labels`, 'The map\'s semantic edit groups, and which quads and props each holds'),
    link('checkpoints', `${base}/checkpoints`, 'The map\'s history ring'),
    link('download', `${base}/download?assets=bytes`, 'The whole map as one portable bundle'),
    link('textures', `/api/textures?level=Custom&project=${id}`, 'This map\'s own uploaded tiles'),
    link('props', `/api/custom-props?project=${id}`, 'This map\'s own imported models'),
    link('sounds', `/api/custom-sounds?project=${id}`, 'This map\'s own hit/ambient sounds'),
    link('music', `/api/custom-music?project=${id}`, 'This map\'s own race-music tracks'),
    link('skies', `/api/skybox?project=${id}`, 'Every sky source: shipped level skies and this map\'s uploads'),
    link('reference', '/api/reference', 'The extracted levels everything can be borrowed from'),
    link('guide', '/api/guide', 'How to author through this API'),
  ];
  const actions: ApiAction[] = [
    {
      rel: 'assignRegisters', href: `${base}/registers`, method: 'POST',
      title: 'Edit the map: absolute last-writer-wins register assignments, plus `rules` that paint, texture '
        + 'and re-label whole labelled sections in one call, and intents on a change — a position in run terms '
        + '{station, lateral, above}, `repeat` for a row, `from` for a variant, `shape` for a model',
      schema: '/api/schemas/AssignRegisters',
      body: { changes: [{ key: 'g/name', value: '' }] }, ...edit,
    },
    {
      rel: 'queryGround', href: `${base}/ground`, method: 'POST',
      title: 'Where the ground is: top-surface heights on the current document under [x, z] points',
      schema: '/api/schemas/GroundQuery', body: { points: [[0, 0]] },
    },
    {
      rel: 'seat', href: `${base}/seat`, method: 'POST',
      title: 'Put placements on the ground: props by label, and anything named by id, onto the surface '
        + 'under them (a rail node by node)',
      schema: '/api/schemas/SeatPlacements',
      body: { where: { labels: [] }, ids: [], offset: 0 }, ...edit,
    },
    {
      rel: 'preflight', href: `/api/preflight?project=${id}`, method: 'POST',
      title: 'What an export of a document would ship: its tiles, cells, imported models and sky',
      schema: '/api/schemas/Preflight', body: { doc: {} },
    },
    {
      rel: 'saveDocument', href: `${base}/document`, method: 'PUT',
      title: 'Replace the whole document optimistically — the only topology write',
      schema: '/api/schemas/SaveDocument',
      body: { baseRevision: project.revision, document: {} }, ...edit,
    },
    {
      rel: 'checkpoint', href: `${base}/checkpoints`, method: 'POST',
      title: 'Keep this moment in the map\'s history',
      schema: '/api/schemas/TakeCheckpoint', body: { note: '' }, ...edit,
    },
    {
      rel: 'setPermissions', href: `${base}/permissions`, method: 'PUT',
      title: 'Restrict who may edit this map',
      schema: '/api/schemas/SetMapPermissions', body: { editorIds: null }, ...manage,
    },
    {
      rel: 'delete', href: base, method: 'DELETE',
      title: 'Delete this map — its name retires for good', ...manage,
    },
  ];
  const templates: ApiActionTemplate[] = [
    {
      rel: 'duplicate', hrefTemplate: `${base}/duplicate?name={name}`, method: 'POST',
      title: 'Fork this map under a new name',
    },
    {
      rel: 'uploadTexture', hrefTemplate: `/api/texture-upload?project=${id}&name={stem}`, method: 'POST',
      title: 'Add a tile to this map\'s library; paint it as "Custom/<name>.png"',
      alternateEncoding: {
        contentType: 'image/png',
        description: 'Raw image bytes as the body; re-encoded RGBA and shrunk to a 512 px edge. The '
          + 'response\'s `name` is the stored stem — a taken name becomes name_2 and up.',
      },
    },
    {
      // The recourse for a tile already in the library: an agent that re-runs its build, or redraws one
      // sheet, would otherwise upload beside its own work and paint from `name_2` while the original stayed
      // behind. Replace lands the new art under a free name, repoints the records that referenced the old
      // one, and removes it — so the caller repaints from the answer's `name`, as it does after any upload.
      rel: 'replaceTexture', hrefTemplate: `/api/texture-replace?project=${id}&name={stem}`, method: 'POST',
      title: 'Give a tile already in this map\'s library new art; answers {replaced, name}',
      alternateEncoding: {
        contentType: 'image/png',
        description: 'Raw image bytes as the body, as for an upload. The old tile is removed and the '
          + 'response\'s `name` is the stem to paint from — it is NOT the stem you replaced.',
      },
    },
    {
      rel: 'uploadSound', hrefTemplate: `/api/sound-upload?project=${id}&name={stem}`, method: 'POST',
      title: 'Add a hit/ambient WAV (normalised to PCM16 mono, 10 s cap)',
      alternateEncoding: { contentType: 'audio/wav', description: 'Raw WAV bytes as the body.' },
    },
    {
      rel: 'uploadMusic', hrefTemplate: `/api/custom-music?project=${id}&name={file}`, method: 'POST',
      title: 'Add a full-length race track (wav/mp3/flac/ogg/m4a/aac); select it with g/raceMusic',
      alternateEncoding: { contentType: 'application/octet-stream', description: 'Raw audio bytes, stored verbatim.' },
    },
    {
      rel: 'uploadSky', hrefTemplate: `/api/skyupload?project=${id}&name={stem}&fit=auto`, method: 'POST',
      // The stem alone: a sky resolves through the data-name sanitiser, which deletes the dot, so a name
      // carrying its extension addresses a file nobody wrote. A tile is the other way round — hence the
      // contrast being spelled out on both templates rather than left to be discovered.
      title: 'Add a horizon panorama; select it with g/skybox {source:{kind:"custom",name:"<stem>"}} — no extension',
      alternateEncoding: { contentType: 'image/png', description: 'Raw panorama PNG bytes as the body.' },
    },
    {
      rel: 'importProp', hrefTemplate: `/api/custom-prop-import?project=${id}&name={stem}`, method: 'POST',
      title: 'Import a decoded model into this map\'s prop library; place it at level "@import"',
      schema: '/api/schemas/ImportedPropRecord',
    },
  ];
  return { _links: links, _actions: actions, _actionTemplates: templates };
}

/** What one label holds, in the ids a register names — the row `GET …/labels/{id}` answers with. */
interface LabelMembers { quadIds: string[]; propIds: string[] }

/**
 * Which quads and props each label holds (docs/052).
 *
 * Membership lives on the labelled thing — a face's `quadLabels` row, a placement's own `labels` — so there
 * is no index to keep in step with the document: it is walked once, here, on the way out. The quad channels
 * key by INDEX in memory (docs/039) and a register names a quad by its stable id, so the crossing happens
 * here too; a placement that predates prop identity has no id to hand back and is counted nowhere.
 */
function labelMembership(document: EditDoc): Map<string, LabelMembers> {
  const held = new Map<string, LabelMembers>();
  const members = (label: string): LabelMembers => {
    let found = held.get(label);
    if (!found) held.set(label, found = { quadIds: [], propIds: [] });
    return found;
  };
  for (const [index, labels] of Object.entries(document.quadLabels ?? {})) {
    const quadId = document.quadIds[Number(index)];
    if (quadId === undefined) continue;
    for (const label of labels) members(label).quadIds.push(quadId);
  }
  for (const prop of document.props ?? []) {
    if (!prop.id) continue;
    for (const label of prop.labels ?? []) members(label).propIds.push(prop.id);
  }
  return held;
}

/** Enough faults to see the shape of what is wrong. A document whose mesh is inconsistent produces one per
 *  quad otherwise, which is an answer nobody reads. */
const PROBLEM_LIMIT = 50;

/** Whether one of a quad's four corners names a vertex the buffer actually holds. */
const namesCorner = (value: unknown, vertices: number): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < vertices;

/**
 * What a hand-authored document is, read exactly as creating a map would read it — and nothing written
 * (docs/052).
 *
 * The migrator IS the check: `POST /api/projects` runs the same call, so a document that survives it is one
 * this server would accept, and what it throws is the message the create would have failed with. It throws
 * one message, though, and two faults are worth answering as a list of paths instead — so both are looked
 * for on the raw fields, before it runs. A quad naming a corner the vertex buffer has not got, it does not
 * police at all: it assumes the corners exist and dies inside itself on an undefined property. An effects
 * graph whose cross-table references do not resolve, it does police — through the very validator called here.
 */
function documentReport(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return { ok: false, counts: null, problems: [{ path: '$', message: 'Project document must be a JSON object' }] };
  }
  const problems: { path: string; message: string }[] = [];
  const raw = value as { vertices?: unknown; quads?: unknown; effects?: unknown };
  // Only the document form has a mesh to check; an older save arrives as a grid the migrator promotes.
  if (Array.isArray(raw.vertices) && Array.isArray(raw.quads)) {
    const held = raw.vertices.length / 3;
    for (const [index, quad] of (raw.quads as unknown[]).entries()) {
      if (problems.length >= PROBLEM_LIMIT) break;
      if (Array.isArray(quad) && quad.length === 4 && quad.every(corner => namesCorner(corner, held))) continue;
      problems.push({ path: `$.quads[${index}]`, message: 'must name four corners of the vertex buffer' });
    }
  }
  for (const issue of raw.effects === undefined ? [] : validateEffectsDocument(raw.effects)) {
    if (problems.length >= PROBLEM_LIMIT) break;
    problems.push({ path: `$.effects${issue.path.slice(1)}`, message: issue.message });
  }
  if (problems.length) return { ok: false, counts: null, problems };
  let document: EditDoc;
  try { document = migrateMountain(value); }
  catch (error) {
    return { ok: false, counts: null,
      problems: [{ path: '$', message: String(error instanceof Error ? error.message : error) }] };
  }
  return {
    ok: true,
    counts: {
      vertices: document.vertices.length / 3, quads: document.quads.length,
      courseKnots: document.course.knots.length,
      props: document.props?.length ?? 0, lights: document.lights?.length ?? 0,
      rails: document.rails?.length ?? 0, gems: document.gems?.length ?? 0,
      models: document.models?.length ?? 0, screens: document.screens?.length ?? 0,
      particleVolumes: document.particleVolumes?.length ?? 0, labels: document.labels?.length ?? 0,
    },
    problems,
  };
}

/** One register change off the wire: `{key, value}` assigns, `{key}` or `{key, remove:true}` clears. Absent
 *  when the write is a selector alone (`rules`), but a body carrying neither meant something and sent
 *  nothing, which is worth saying rather than answering as a batch that did nothing. */
function registerChanges(value: unknown): [RegisterKey, RegisterValue][] {
  const body = value && typeof value === 'object' ? value as { changes?: unknown; rules?: unknown } : null;
  if (!body || (body.changes === undefined && body.rules === undefined)
    || (body.changes !== undefined && !Array.isArray(body.changes))) {
    throw new Error('Send { changes: [{ key, value }, …] }, { rules: [{ where, set }, …] }, or both — see '
      + '/api/schemas/AssignRegisters.');
  }
  const entries = Array.isArray(body.changes) ? body.changes : [];
  if (entries.length > 100_000) throw new Error('That is over 100000 changes in one request.');
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Each change is an object { key, value?, remove? }.');
    }
    const { key, value: held, remove } = entry as { key?: unknown; value?: unknown; remove?: unknown };
    if (typeof key !== 'string' || !key) throw new Error('Each change names a register key.');
    const clearing = remove === true || !('value' in entry);
    return [key, clearing ? undefined : normalizedObjectValue(key, held)];
  });
}

/**
 * The id a whole-object register key names, for the families whose value carries its own `id` field.
 *
 * The check this feeds exists because a mismatch corrupts quietly: `byIdentity` inserts the value as it
 * stands, so an object pushed under key `o/gem/gem:0001` while carrying `id: "gem:0002"` answers to
 * NEITHER register correctly — the key finds nothing on the next read, and the object re-emits under an id
 * nobody assigned. An absent id is filled in from the key instead, which is what an agent means anyway.
 */
function objectIdFromKey(key: RegisterKey): string | null {
  if (!key.startsWith('o/')) return null;
  const cut = key.indexOf('/', 2);
  if (cut < 0) return null;
  const family = key.slice(2, cut);
  const rest = key.slice(cut + 1);
  if (family === 'effect') {
    const tableCut = rest.indexOf('/');
    return tableCut < 0 ? null : rest.slice(tableCut + 1);
  }
  if (family === 'effect-node') {
    // o/effect-node/<table>/<rowId>/<nodeId> — and a node's id is itself "<rowId>/node:NNNN", so the id is
    // everything past the second segment, slashes and all.
    const tableCut = rest.indexOf('/');
    const afterTable = tableCut < 0 ? '' : rest.slice(tableCut + 1);
    const ownerCut = afterTable.indexOf('/');
    return ownerCut < 0 ? null : afterTable.slice(ownerCut + 1);
  }
  return rest;
}

function normalizedObjectValue(key: RegisterKey, value: RegisterValue): RegisterValue {
  const id = objectIdFromKey(key);
  if (id === null || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const held = (value as { id?: unknown }).id;
  if (held === undefined) return { ...(value as Record<string, unknown>), id };
  if (held !== id) {
    throw new Error(`The object assigned to ${key} carries id ${JSON.stringify(held)} — a register holds `
      + 'the object its key names, so leave `id` out or make them match.');
  }
  return value;
}

// ---- selector writes: one intent instead of a thousand keys (docs/052) ------------------------------------

/**
 * Why a selector exists at all: building a real mountain over HTTP, ~1478 of ~1500 register writes were two
 * intents a client had expanded itself — "texture every quad in this section" and "drop these props onto the
 * surface". The read side has scoped with `?prefix=`/`?keys=` from the start; the write side took only an
 * explicit list, so every caller re-implemented the same two loops. Both are one call now.
 *
 * A rule expands HERE into ordinary register assignments and lands through the same `assign` an explicit
 * change does, so the register model is untouched: still absolute, still last-writer-wins, still relayed to
 * everyone on the map key by key. What arrives is an intent; what lands is registers.
 */

/** One selector rule, resolved against the map it will run on. */
interface SelectorRule {
  /** Label ids a quad must carry ALL of. The intersection is the point: "the trail quads inside this one
   *  section" is two labels, and no list of quad ids at all. */
  labels: string[];
  /** The quad channels to assign, already in register terms — `undefined` where the caller sent `null`, which
   *  clears the channel. */
  channels: [QuadField, RegisterValue][];
  /** Label ids to add to / remove from each matched face's own `labels` register. */
  addLabel?: string;
  removeLabel?: string;
}

/** How one rule turned out — how many faces it named and how many keys that came to. Reported per rule, in
 *  request order, because a rule that matched nothing looks exactly like a rule that worked otherwise. */
interface RuleOutcome { matched: number; keys: number }

/**
 * The label a name or an id addresses.
 *
 * Both work, because an agent that has just assigned `o/label/label:0003 {name:"trail"}` should not have to
 * read it back to use it. An id wins over a name, so a label called `label:0007` cannot shadow the register
 * addressing, and a name two labels share is refused rather than guessed at.
 *
 * A label this map has not got is refused by name, before anything lands. A rule is a query, and a query that
 * silently matches nothing reads as a successful edit that never happened — the one outcome an author cannot
 * detect from the response.
 */
function labelResolver(document: EditDoc): (named: string) => string {
  const byId = new Set((document.labels ?? []).map(label => label.id));
  const byName = new Map<string, string[]>();
  for (const label of document.labels ?? []) {
    byName.set(label.name, [...(byName.get(label.name) ?? []), label.id]);
  }
  return named => {
    if (byId.has(named)) return named;
    const found = byName.get(named) ?? [];
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new Error(`This map has ${found.length} labels named ${JSON.stringify(named)} — name the one you `
        + `mean by id (${found.join(', ')}).`);
    }
    throw new Error(`This map has no label ${JSON.stringify(named)} — GET …/labels lists the ones it has.`);
  };
}

/** The label ids a `where` clause names: `labels` for the intersection, `label` as sugar for a single one. */
function whereLabels(where: unknown, resolve: (named: string) => string): string[] {
  if (!where || typeof where !== 'object' || Array.isArray(where)) {
    throw new Error('`where` selects by label: { "labels": ["<name or id>", …] } (or "label" for one).');
  }
  const { label, labels } = where as { label?: unknown; labels?: unknown };
  const named = [...(label === undefined ? [] : [label]), ...(Array.isArray(labels) ? labels : [])];
  if (!named.length || named.some(one => typeof one !== 'string' || !one)) {
    throw new Error('`where` names at least one label, by name or by id — a selector naming none would reach '
      + 'the whole mountain.');
  }
  return [...new Set(named.map(one => resolve(one as string)))];
}

/**
 * One channel of a rule's `set`, in register terms.
 *
 * `null` clears the channel, because an unpainted, untextured or unlocked face is one whose channel holds
 * nothing at all — the same `undefined` a `{ key }` change assigns. `labels` is deliberately not settable
 * whole: a rule adds or removes ONE label, so two rules over overlapping sections compose instead of the
 * second discarding the first's work.
 */
function ruleChannel(field: string, value: unknown): [QuadField, RegisterValue] {
  const clearing = value === null || (field === 'lock' && value === false);
  const held = (ok: boolean, wants: string): RegisterValue => {
    if (!clearing && !ok) throw new Error(`A rule's \`${field}\` is ${wants}.`);
    return clearing ? undefined : value;
  };
  switch (field) {
    case 'paint':
      return ['paint', held(Number.isInteger(value),
        'a SurfaceType integer (1 snow, 3 powder, 5 ice), or null to reset')];
    case 'tex':
      return ['tex', held(typeof value === 'string' && value.length > 0,
        'a tile ref "<LEVEL>/<file>.png" or "Custom/<file>.png", or null to clear')];
    case 'orient':
      return ['orient', held(!!value && typeof value === 'object' && !Array.isArray(value),
        '{ rot: 0-3, mirror: boolean }, or null to clear')];
    case 'lock':
      return ['lock', clearing ? undefined : held(value === true, 'true, or false/null to unlock')];
    case 'twist':
      return ['twist', held(Array.isArray(value), 'the face\'s four corner offsets, or null to clear')];
    default:
      throw new Error(`A rule cannot set ${JSON.stringify(field)}. It names quad channels only — paint, tex, `
        + 'orient, lock, twist, addLabel, removeLabel. A prop is a whole-object register with no per-field '
        + 'patch below it (docs/039): assign it whole as o/prop/<id>, or move it with POST …/seat.');
  }
}

/** The `rules` half of a register write, resolved against the map it will run on. */
function selectorRules(body: unknown, document: EditDoc): SelectorRule[] {
  const held = (body as { rules?: unknown } | null)?.rules;
  if (held === undefined) return [];
  if (!Array.isArray(held)) {
    throw new Error('`rules` is an array of { where, set } — see /api/schemas/AssignRegisters.');
  }
  if (held.length > 1_000) throw new Error('That is over 1000 rules in one request.');
  const resolve = labelResolver(document);
  return held.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Each rule is an object { where: { labels: […] }, set: { … } }.');
    }
    const { where, set } = entry as { where?: unknown; set?: unknown };
    if (!set || typeof set !== 'object' || Array.isArray(set) || !Object.keys(set).length) {
      throw new Error('Each rule sets something: paint, tex, orient, lock, twist, addLabel or removeLabel.');
    }
    const fields = set as Record<string, unknown>;
    const rule: SelectorRule = { labels: whereLabels(where, resolve), channels: [] };
    for (const [field, value] of Object.entries(fields)) {
      if (field === 'addLabel' || field === 'removeLabel') {
        if (typeof value !== 'string' || !value) throw new Error(`\`${field}\` is one label's name or id.`);
        rule[field] = resolve(value);
        continue;
      }
      rule.channels.push(ruleChannel(field, value));
    }
    return rule;
  });
}

/**
 * Rules expanded into the assignments they stand for — the same keys the caller could have listed itself,
 * produced from the membership the map already carries.
 *
 * Order is the whole contract: a later rule wins over an earlier one that touched the same key, and the
 * caller's explicit `changes` are appended after all of them, so an explicit key always wins over a rule.
 * Nothing here decides anything — `assign` resolves it exactly as it resolves two people typing.
 */
function expandRules(document: EditDoc, rules: SelectorRule[]):
  { changes: [RegisterKey, RegisterValue][]; outcomes: RuleOutcome[] } {
  const changes: [RegisterKey, RegisterValue][] = [];
  const outcomes: RuleOutcome[] = [];
  // Membership lives on the labelled face (docs/052), keyed by quad INDEX in memory, so the crossing into the
  // stable ids a register names happens here, once per rule.
  const membership = Object.entries(document.quadLabels ?? {});
  for (const rule of rules) {
    const before = changes.length;
    let matched = 0;
    for (const [index, carried] of membership) {
      if (!rule.labels.every(id => carried.includes(id))) continue;
      const quad = document.quadIds[Number(index)];
      if (quad === undefined) continue;
      matched++;
      for (const [field, value] of rule.channels) changes.push([quadRegister(quad, field), value]);
      if (rule.addLabel === undefined && rule.removeLabel === undefined) continue;
      const held = new Set(carried);
      if (rule.addLabel !== undefined) held.add(rule.addLabel);
      if (rule.removeLabel !== undefined) held.delete(rule.removeLabel);
      // Sorted, because that is the stored form of a membership row (`normalizeLabels` dedupes and sorts it,
      // and the editor's own toggle writes it that way). A document whose stored hash disagrees with its
      // manifest is reconciled on the next read as an edit from outside — costing a revision and making the
      // room drop its next snapshot — so a register value that does not round-trip is a lost write later.
      // A face left carrying nothing clears the register rather than holding an empty list, so it reads
      // exactly like one that was never labelled.
      changes.push([quadRegister(quad, 'labels'), held.size ? [...held].sort() : undefined]);
    }
    outcomes.push({ matched, keys: changes.length - before });
  }
  if (changes.length > 100_000) {
    throw new Error(`Those rules expand to ${changes.length} register assignments, which is over the 100000 `
      + 'a single request may carry. Narrow the selection.');
  }
  return { changes, outcomes };
}

// ---- seating placements on the ground (docs/052) -----------------------------------------------------------

/** Millimetre rounding for the numbers a ruler answers with — a station table is read by a person. */
const mm = (value: number): number => Math.round(value * 1000) / 1000;

/** The top-surface sampler `POST …/ground` answers with, shared with the seat write so both read the same
 *  height off the same bicubic quilt. The sampler answers the surface nearest `nearY`; asked from far above
 *  everything, that is the uppermost one — the one a placed object stands on. */
function topSurface(document: EditDoc): (x: number, z: number) => number | null {
  let ceiling = 0;
  for (let at = 1; at < document.vertices.length; at += 3) {
    ceiling = Math.max(ceiling, document.vertices[at]);
  }
  const sample = surfaceHeightSampler(document, 4);
  const sky = ceiling + 1000;
  return (x, z) => sample(x, z, sky);
}

/** The placement families a seat request can move: the ones whose register holds its own world position. A
 *  screen is not one — an attached screen's `pos` is in its prop's frame — and neither is a model, whose
 *  vertices are geometry rather than a placement. */
const SEATABLE: ReadonlySet<string> = new Set<ObjectFamily>(['prop', 'light', 'gem', 'rail']);

/** The register an id names, whether it arrived bare (`prop:kiln-a`) or whole (`o/prop/prop:kiln-a`). */
function placementRegister(named: string): RegisterKey {
  const cut = named.startsWith('o/') ? named.indexOf('/', 2) : -1;
  const family = cut > 0 ? named.slice(2, cut) : named.slice(0, named.indexOf(':'));
  if (!SEATABLE.has(family) || (cut > 0 && cut === named.length - 1)) {
    throw new Error(`${JSON.stringify(named)} names nothing that can be seated — send prop:… / light:… / `
      + 'gem:… / rail:… , or the whole register key o/<family>/<id>.');
  }
  return cut > 0 ? named : objectRegister(family as ObjectFamily, named);
}

const isPoint = (value: unknown): value is V3 =>
  Array.isArray(value) && value.length === 3 && value.every(part => typeof part === 'number');

/** Where a placement stands, in the order its own value holds the points. A rail is the reason this is a
 *  LIST: it follows the ground along its whole length rather than pivoting about its first node. */
function standsOn(value: RegisterValue): V3[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const held = value as { pos?: unknown; nodes?: unknown };
  if (Array.isArray(held.nodes)) return held.nodes.every(isPoint) ? held.nodes : null;
  return isPoint(held.pos) ? [held.pos] : null;
}

/** The placement with its points put back on the ground — a copy, since the value read out of a register is
 *  the document's own object and the room compares the two to decide whether anything moved. */
function reseated(value: RegisterValue, points: V3[]): RegisterValue {
  const held = value as Record<string, unknown>;
  return Array.isArray(held.nodes) ? { ...held, nodes: points } : { ...held, pos: points[0] };
}

/** The register scope a read asked for: comma-separated prefixes, exact keys, or `all`. The default is the
 *  authoring state an agent works with — objects, the course, the globals — because the terrain channels
 *  are big enough on a real mountain that fetching them should be a choice. */
function registerScope(url: URL): (key: RegisterKey) => boolean {
  const keys = url.searchParams.get('keys');
  if (keys) {
    const wanted = new Set(keys.split(',').map(part => part.trim()).filter(Boolean));
    return key => wanted.has(key);
  }
  const raw = url.searchParams.get('prefix')?.trim();
  if (raw === 'all') return () => true;
  const prefixes = (raw ? raw.split(',') : ['o/', 'g/', 'course']).map(part => part.trim()).filter(Boolean);
  return key => prefixes.some(prefix => key.startsWith(prefix));
}

/** Machine-local roots plus revisioned project persistence, and the map transfer that moves one project
 *  between servers (docs/038). The local server owns these paths; the browser only sends documents, bundles
 *  and settings through this API, so no absolute path ever leaves the machine.
 *
 *  What happens to a map is announced into the room as it happens (docs/038): created, uploaded, restored and
 *  deleted are the events people ask each other about, and they are generated here — where the server knows
 *  both that it happened and who asked for it. */
export const workspaceRoutes: Record<string, ApiHandler> = {
  '/api/config': async (req, res) => {
    try {
      if (req.method === 'GET') {
        jsonResponse(res, 200, { config: workspaceConfig() });
        return;
      }
      if (req.method === 'PUT') {
        const body = await readJsonBody(req) as { workspaceRoot?: string; mapsRoot?: string; maxPlayers?: number };
        const saved = await saveWorkspaceConfig(body);
        // Unlike path changes, capacity is live. Lowering it removes lower-role accounts immediately in the
        // same order as admission (viewer, editor, moderator) while unbounded admins remain connected.
        trimPlayerSeats(saved.config.maxPlayers);
        jsonResponse(res, 200, saved);
        return;
      }
      res.statusCode = 405; res.end('GET or PUT only');
    } catch (error) {
      jsonResponse(res, 400, { error: String(error instanceof Error ? error.message : error) });
    }
  },

  '/api/projects': async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    const parts = path ? path.split('/') : [];
    // Which browser tab is asking. Two tabs are two independent editors, so each keeps its own active
    // project rather than the last one to open silently reassigning the other's — and it is also how a
    // revision push tells this tab's own write from somebody else's.
    const rawClient = req.headers['x-slopesmith-client'];
    const clientId = (Array.isArray(rawClient) ? rawClient[0] : rawClient)?.slice(0, 64);
    const identity = (req as ApiRequest).identity;
    try {
      if (req.method === 'GET' && !parts.length) {
        jsonResponse(res, 200, {
          projects: await projects.listProjects(),
          _links: [link('self', '/api/projects'), link('root', '/api'), link('guide', '/api/guide')],
          _linkTemplates: [{ rel: 'item', hrefTemplate: '/api/projects/{id}',
            title: 'One map: manifest, document, and everything that can be done to it' }],
          _actions: [{
            rel: 'create', href: '/api/projects', method: 'POST',
            title: 'Create a map — an empty body starts from the default rideable mountain; `name` names it at birth',
            schema: '/api/schemas/CreateMap', body: { name: '' }, ...gate(identity, 'editor'),
          }, {
            rel: 'validate', href: '/api/projects/validate', method: 'POST',
            title: 'Read a document the way creating a map would, and say what it is — nothing is written',
            schema: '/api/schemas/ValidateDocument', body: { document: {} }, ...gate(identity, 'editor'),
          }] satisfies ApiAction[],
        });
        return;
      }
      if (req.method === 'GET' && parts[0] === 'current') {
        const current = await projects.currentProject(clientId);
        if (!current) { res.statusCode = 204; res.end(); return; }
        jsonResponse(res, 200, current); return;
      }
      if (req.method === 'POST' && !parts.length) {
        const body = await readJsonBody(req) as { document?: unknown; name?: unknown };
        // No document means the default starter mountain. The browser always sends one; an API caller that
        // wants "a mountain to start editing" should not have to compose a whole document to ask for it —
        // nor rename in a second request when it already knows what the map is called.
        const created = await projects.createProject(body.document ?? {}, clientId, true,
          projectActor(identity).id, typeof body.name === 'string' ? body.name : undefined);
        systemEvent(`${actor(identity)} created ${created.project.name}`);
        jsonResponse(res, 201, { ...created, ...projectEnvelope(created.project, identity) }); return;
      }
      // The same read a create does, without the map (docs/052). A caller composing a document by hand — the
      // one case the register grammar cannot cover, since topology is not addressable — can find out what it
      // has before spending a map name on it.
      if (parts.length === 1 && parts[0] === 'validate' && req.method === 'POST') {
        const body = await readJsonBody(req) as { document?: unknown };
        jsonResponse(res, 200, {
          ...documentReport(body.document),
          _links: [link('self', '/api/projects/validate'), link('collection', '/api/projects')],
        });
        return;
      }

      // ---- moving a mountain between servers (docs/038) ----
      // The manifest round trip is the whole negotiation: the uploader sends what its mountain wears, this server
      // names the hashes it lacks, and only those bytes are sent with the upload that follows.
      if (parts.length === 2 && parts[0] === 'transfer' && parts[1] === 'manifest' && req.method === 'POST') {
        const body = await readJsonBody(req) as { assets?: BundleAsset[] };
        jsonResponse(res, 200, await missingAssets(Array.isArray(body.assets) ? body.assets : []));
        return;
      }
      if (parts.length === 1 && parts[0] === 'transfer' && req.method === 'POST') {
        const body = await readJsonBody(req, TRANSFER_BODY_LIMIT);
        const transfer = body as { bundle?: unknown; name?: unknown };
        const bundle = asBundle(body) ?? asBundle(transfer?.bundle);
        if (!bundle) throw new Error('that is not a Slopesmith mountain bundle');
        const name = typeof transfer?.name === 'string' ? transfer.name : undefined;
        const uploaded = await uploadProject(bundle, clientId, name, projectActor(identity).id);
        systemEvent(`${actor(identity)} imported ${uploaded.snapshot.project.name}`);
        jsonResponse(res, 201, {
          ...uploaded.snapshot, stored: uploaded.stored, absent: uploaded.absent,
        });
        return;
      }

      if (parts.length === 1 && req.method === 'GET') {
        const snapshot = await projects.openProject(parts[0]);
        jsonResponse(res, 200, { ...snapshot, ...projectEnvelope(snapshot.project, identity) }); return;
      }

      // ---- the map as registers (docs/039, docs/052): the agent-facing read and the ordinary write ----
      // Reads come off the live room when one is open, since that is the authoritative document while
      // people are editing; writes go through the same room `assign` every socket edit lands through, so a
      // program's changes stream to everyone on the map and theirs are never overwritten wholesale.
      if (parts.length === 2 && parts[1] === 'registers' && req.method === 'GET') {
        const wanted = registerScope(url);
        const registers: [RegisterKey, RegisterValue][] = [];
        for (const [key, value] of documentRegisters(await liveDocument(parts[0]))) {
          if (wanted(key)) registers.push([key, value]);
        }
        jsonResponse(res, 200, {
          projectId: parts[0], count: registers.length, registers,
          _links: [
            link('self', `/api/projects/${encodeURIComponent(parts[0])}/registers`),
            link('project', `/api/projects/${encodeURIComponent(parts[0])}`),
          ],
        });
        return;
      }
      if (parts.length === 2 && parts[1] === 'registers' && req.method === 'POST') {
        const principal = projectActor(identity);
        const project = await projects.requireProjectEdit(parts[0], principal);
        const body = await readJsonBody(req);
        const by = actor(identity);
        const room = await joinRoom(parts[0]);
        // Intents first (intents.ts): a position said in the run's own terms, a row said as one change, a
        // variant said as a copy of another register, a model said as a shape — each expanded against the
        // room's own document into the plain changes below, so what lands is exactly what an explicit list
        // would have landed, and the register model never learns a batch arrived as an intent.
        const intents = expandIntents(room.doc, body, () => topSurface(room.doc));
        const changes = registerChanges(intents.body);
        // Restoring content is an editor action; the map's NAME is still a rename, exactly as the
        // document save and the checkpoint revert treat it. Rules cannot reach g/name at all — they name
        // quad channels — so the bar is asked of the explicit changes alone.
        if (changes.some(([key]) => key === 'g/name') && !projects.canManageProject(project, principal)) {
          throw new projects.ProjectPermissionError('Only this map\'s owner or a moderator can rename it.');
        }
        // Selectors are resolved against the room's own copy — the authoritative document while people are
        // editing — so a rule paints the section as it stands right now, placements and all.
        const rules = expandRules(room.doc, selectorRules(body, room.doc));
        // Rules first, `changes` after: assignments land in order and the last writer wins, so an explicit
        // key always overrides a rule that happened to touch it, and a later rule overrides an earlier one.
        const written = assign(room, [...rules.changes, ...changes], by);
        // A room joined over HTTP has no socket participant whose leaving would flush it, so nothing may be
        // left only in memory: the snapshot is taken before answering, and the answer carries the revision
        // it produced.
        await takeSnapshot(room);
        if (written.landed.length) {
          const frame = prepareWebSocketText(JSON.stringify({
            t: 'sync', projectId: parts[0], at: written.at, changes: onWire(written.landed), by,
          }));
          for (const session of sessionsOn(parts[0])) session.sendPrepared(frame);
        }
        const manifest = await projects.projectManifest(parts[0]);
        jsonResponse(res, 200, {
          projectId: parts[0], revision: manifest.revision,
          landed: written.landed.length, retired: written.retired.length,
          refused: written.refused.length,
          refusedKeys: written.refused,
          // What each rule reached, in request order. `keys` is what it produced, not what landed: a rule
          // that repaints a section already that colour is honest work with nothing to report as a change.
          rules: rules.outcomes,
          // What the intents expanded to — positions resolved, clones made, copies taken, shapes built — so
          // a `repeat` that made twelve lamps reads as twelve in the answer and not as one change.
          intents: intents.outcomes,
          _links: [
            link('self', `/api/projects/${encodeURIComponent(parts[0])}/registers`),
            link('project', `/api/projects/${encodeURIComponent(parts[0])}`),
          ],
        });
        return;
      }
      // The run as a ruler (docs/052): its length, each knot's arc station, and a station table with the
      // line's position, heading, floor width and the ground height there — the frame a placement's
      // `pos: { station, lateral }` resolves in (intents.ts), answered so an author can see it before
      // placing by it. A read off the live document, like `registers`.
      if (parts.length === 2 && parts[1] === 'course' && req.method === 'GET') {
        const document = await liveDocument(parts[0]);
        const ruler = courseRuler(document.course);
        const ground = topSurface(document);
        const asked = url.searchParams.get('at');
        const spacing = url.searchParams.get('every');
        // `?near=x,z;x,z` asks the other direction — where a point already on the map stands in run terms —
        // which is how a placement made by hand is checked against a setback rule. Alone, it answers without
        // the station table; with `at`/`every` it answers beside one.
        const nearAsked = url.searchParams.get('near');
        const nearPoints: [number, number][] = (nearAsked ?? '').split(';').filter(Boolean).map(pair => {
          const parts = pair.split(',').map(part => Number(part.trim()));
          if (parts.length !== 2 || parts.some(part => !Number.isFinite(part))) {
            throw new Error('?near= lists points as x,z pairs separated by semicolons: near=812.5,1240;790,1301');
          }
          return [parts[0], parts[1]];
        });
        if (nearPoints.length > 2000) throw new Error('?near= takes at most 2000 points.');
        let stations: number[];
        if (asked) {
          stations = asked.split(',').map(part => Number(part.trim()));
          // A millimetre of slack past the end, because the `length` this route answers with is itself
          // rounded to one and is the first thing a caller asks for again.
          if (stations.length > 2000 || stations.some(s => !Number.isFinite(s) || s < 0 || s > ruler.length + 0.0015)) {
            throw new Error(`?at= lists stations in metres from 0 to ${mm(ruler.length)}, at most 2000 of them.`);
          }
        } else if (nearAsked !== null && spacing === null) {
          stations = [];
        } else {
          const every = Number(spacing ?? 25);
          if (!Number.isFinite(every) || every < 1) throw new Error('?every= is a spacing in metres, 1 or more.');
          if (ruler.length / every > 2000) {
            throw new Error(`?every=${every} would list over 2000 stations on a ${mm(ruler.length)} m run — take a coarser step.`);
          }
          stations = [];
          for (let s = 0; s < ruler.length; s += every) stations.push(s);
          stations.push(ruler.length);
        }
        const height = ground;
        const near = nearPoints.map(([x, z]) => {
          const station = ruler.nearest(x, z);
          const frame = ruler.at(station);
          const lateral = (x - frame.pos[0]) * frame.side[0] + (z - frame.pos[2]) * frame.side[2];
          const under = height(x, z);
          return {
            x, z, station: mm(station), lateral: mm(lateral), heading: mm(frame.heading), width: mm(frame.width),
            ground: under === null ? null : mm(under),
          };
        });
        jsonResponse(res, 200, {
          projectId: parts[0], revision: (await projects.projectManifest(parts[0])).revision,
          length: mm(ruler.length),
          frame: 'station: metres along the line from knot 0. lateral: metres to the rider\'s RIGHT looking '
            + 'downhill (negative = left). heading: the yaw that faces downhill here; a prop\'s yaw "course+90" '
            + 'faces the rider\'s left.',
          knots: document.course.knots.map((knot, index) => ({
            index, station: mm(ruler.knotStations[index]), pos: knot.pos, width: knot.width,
          })),
          stations: stations.map(station => {
            const frame = ruler.at(station);
            const under = height(frame.pos[0], frame.pos[2]);
            return {
              station: mm(station), pos: frame.pos.map(mm), heading: mm(frame.heading), width: mm(frame.width),
              ground: under === null ? null : mm(under),
            };
          }),
          ...(nearAsked === null ? {} : { near }),
          _links: [
            link('self', `/api/projects/${encodeURIComponent(parts[0])}/course`),
            link('registers', `/api/projects/${encodeURIComponent(parts[0])}/registers?keys=course`,
              'The course register itself — the knots this ruler is laid along'),
            link('project', `/api/projects/${encodeURIComponent(parts[0])}`),
          ],
        });
        return;
      }
      // Where the ground is (docs/052): batch top-surface heights on the CURRENT document, live room
      // included. This is what a placement agent seats props, lights and buildings with — sampled from the
      // actual bicubic quilt, so nobody re-derives terrain math client-side against a document that may
      // already be behind the room. A read that arrives as POST only because its input is a batch of points.
      if (parts.length === 2 && parts[1] === 'ground' && req.method === 'POST') {
        const body = await readJsonBody(req) as { points?: unknown };
        if (!Array.isArray(body.points) || body.points.length > 4096) {
          throw new Error('Send { points: [[x, z], …] } — at most 4096 points per request.');
        }
        const points = body.points.map(entry => {
          if (!Array.isArray(entry) || entry.length !== 2
            || !Number.isFinite(entry[0]) || !Number.isFinite(entry[1])) {
            throw new Error('Each point is [x, z] in editor metres.');
          }
          return entry as [number, number];
        });
        const sample = topSurface(await liveDocument(parts[0]));
        jsonResponse(res, 200, {
          projectId: parts[0], revision: (await projects.projectManifest(parts[0])).revision,
          heights: points.map(([x, z]) => sample(x, z)),
          _links: [
            link('self', `/api/projects/${encodeURIComponent(parts[0])}/ground`),
            link('project', `/api/projects/${encodeURIComponent(parts[0])}`),
          ],
        });
        return;
      }
      // Put placements on the ground (docs/052) — the second intent every placement agent expanded itself:
      // ask `ground` where the surface is, then send one register per prop. The whole selection is one call
      // here, sampled from the same quilt `ground` answers from, so a section of props follows the terrain it
      // was sculpted onto.
      //
      // A GEOMETRIC operation, not a field patch: it reads each placement's whole register, moves the points
      // it stands on, and assigns the whole object back through the same `assign` as everything else. The
      // no-per-field-patch rule that keeps concurrent editing honest (docs/039) is untouched — there is still
      // no way to say "set `pos` on everything in this section", only "put this selection on the ground".
      //
      // And it WRITES, so it is an editor action — unlike `ground`, which asks the same question of the same
      // sampler and changes nothing (`projectAccess` in app.ts names that exception, and only that one).
      if (parts.length === 2 && parts[1] === 'seat' && req.method === 'POST') {
        await projects.requireProjectEdit(parts[0], projectActor(identity));
        const body = await readJsonBody(req) as { where?: unknown; ids?: unknown; offset?: unknown };
        if (body.where === undefined && body.ids === undefined) {
          throw new Error('Send `where` (every placement carrying these labels), `ids` (placements by id), '
            + 'or both — see /api/schemas/SeatPlacements.');
        }
        const offset = body.offset ?? 0;
        if (typeof offset !== 'number' || !Number.isFinite(offset)) {
          throw new Error('`offset` is how far above the surface to seat, in metres.');
        }
        const by = actor(identity);
        const room = await joinRoom(parts[0]);
        // The union of the two: a labelled section, plus whatever was named by hand. Labels live on
        // placements rather than on the families with no `labels` field, so `where` selects props and `ids`
        // is how a rail, a gem or a light joins them.
        const wanted = new Set<RegisterKey>();
        if (body.where !== undefined) {
          const labels = whereLabels(body.where, labelResolver(room.doc));
          for (const prop of room.doc.props ?? []) {
            if (prop.id && labels.every(id => (prop.labels ?? []).includes(id))) {
              wanted.add(objectRegister('prop', prop.id));
            }
          }
        }
        for (const named of names(body.ids)) wanted.add(placementRegister(named));
        const sample = topSurface(room.doc);
        const changes: [RegisterKey, RegisterValue][] = [];
        let skipped = 0;
        for (const key of wanted) {
          const value = readRegister(room.doc, key);
          const points = standsOn(value);
          if (!points) throw new Error(`${key} names no placement this map holds.`);
          let found = false;
          const moved = points.map(point => {
            const height = sample(point[0], point[2]);
            // Nothing under it: left exactly where it stands and counted, because dropping a point to zero
            // is the one outcome nobody asked for.
            if (height === null) { skipped++; return point; }
            found = true;
            return [point[0], height + offset, point[2]] as V3;
          });
          if (found) changes.push([key, reseated(value, moved)]);
        }
        const written = assign(room, changes, by);
        await takeSnapshot(room);
        if (written.landed.length) {
          const frame = prepareWebSocketText(JSON.stringify({
            t: 'sync', projectId: parts[0], at: written.at, changes: onWire(written.landed), by,
          }));
          for (const session of sessionsOn(parts[0])) session.sendPrepared(frame);
        }
        const manifest = await projects.projectManifest(parts[0]);
        jsonResponse(res, 200, {
          projectId: parts[0], revision: manifest.revision,
          // Placements that moved, and placements already sitting where the ground put them. These registers
          // came out of the document itself, so none of them can be refused or retired. `skipped` counts
          // POINTS rather than placements: a prop is one, a rail one per node.
          seated: written.landed.length, skipped,
          unchanged: changes.length - written.landed.length,
          _links: [
            link('self', `/api/projects/${encodeURIComponent(parts[0])}/seat`),
            link('project', `/api/projects/${encodeURIComponent(parts[0])}`),
          ],
        });
        return;
      }
      // Which quads and props carry a label (docs/052). A label is how a mountain is divided into sections
      // an author reasons about — "the village", "the lower berms" — and the only way to ask what one holds
      // was to read the whole document and join it yourself. Off the live room like every other read here,
      // so an in-progress session's placements are counted.
      if (parts.length >= 2 && parts.length <= 3 && parts[1] === 'labels' && req.method === 'GET') {
        const base = `/api/projects/${encodeURIComponent(parts[0])}`;
        const document = await liveDocument(parts[0]);
        const membership = labelMembership(document);
        const row = (label: LabelDefinition) => ({
          id: label.id, name: label.name, ...(label.color ? { color: label.color } : {}),
          quadCount: membership.get(label.id)?.quadIds.length ?? 0,
          propCount: membership.get(label.id)?.propIds.length ?? 0,
        });
        const revision = (await projects.projectManifest(parts[0])).revision;
        if (parts.length === 2) {
          jsonResponse(res, 200, {
            projectId: parts[0], revision, labels: (document.labels ?? []).map(row),
            _links: [link('self', `${base}/labels`), link('project', base)],
            _linkTemplates: [{ rel: 'item', hrefTemplate: `${base}/labels/{labelId}`,
              title: 'One label with the quad and prop ids it holds, ready to address as registers' }],
          });
          return;
        }
        const label = (document.labels ?? []).find(held => held.id === decodeURIComponent(parts[2]));
        if (!label) {
          jsonResponse(res, 404, {
            error: `This map has no label ${decodeURIComponent(parts[2])}.`,
            _links: [link('collection', `${base}/labels`, 'Every label this map defines')],
          });
          return;
        }
        jsonResponse(res, 200, {
          projectId: parts[0], revision, ...row(label),
          quadIds: membership.get(label.id)?.quadIds ?? [], propIds: membership.get(label.id)?.propIds ?? [],
          _links: [
            link('self', `${base}/labels/${encodeURIComponent(label.id)}`),
            link('collection', `${base}/labels`),
            link('project', base),
          ],
        });
        return;
      }
      if (parts.length === 1 && req.method === 'DELETE') {
        await projects.requireProjectManager(parts[0], projectActor(identity));
        const deleted = await projects.deleteProject(parts[0]);
        systemEvent(`${actor(identity)} deleted ${deleted.name}`);
        jsonResponse(res, 200, { deleted: { id: deleted.id, name: deleted.name } }); return;
      }
      if (parts.length === 2 && parts[1] === 'download' && req.method === 'GET') {
        // `assets=bytes` is the self-contained form an exported mountain ZIP needs; the default is the
        // lightweight manifest form retained for API compatibility.
        jsonResponse(res, 200, await downloadProject(parts[0], url.searchParams.get('assets') === 'bytes'));
        return;
      }
      if (parts.length === 2 && parts[1] === 'duplicate' && req.method === 'POST') {
        const duplicated = await duplicateProject(parts[0], clientId, url.searchParams.get('name') ?? undefined,
          projectActor(identity).id);
        systemEvent(`${actor(identity)} duplicated ${duplicated.snapshot.project.name}`);
        jsonResponse(res, 201, {
          ...duplicated.snapshot, stored: duplicated.stored, absent: duplicated.absent,
        });
        return;
      }
      if (parts.length === 2 && parts[1] === 'activate' && req.method === 'POST') {
        jsonResponse(res, 200, await projects.activateProject(parts[0], clientId)); return;
      }
      if (parts.length === 2 && parts[1] === 'permissions' && req.method === 'PUT') {
        const principal = projectActor(identity);
        await projects.requireProjectManager(parts[0], principal);
        const body = await readJsonBody(req) as { editorIds?: unknown };
        if (body.editorIds !== null && (!Array.isArray(body.editorIds)
          || body.editorIds.length > 1_000 || body.editorIds.some(id => typeof id !== 'string'))) {
          throw new Error('editorIds must be null or an array of at most 1000 user ids');
        }
        const project = await projects.setProjectEditors(parts[0], body.editorIds as string[] | null);
        systemEvent(`${actor(identity)} ${project.editorIds === undefined ? 'opened' : 'restricted'} editing on ${project.name}`);
        jsonResponse(res, 200, { project });
        return;
      }
      // A whole document, optimistically. This is what replaces a mountain rather than assigning to it — a
      // fresh import, a resolved conflict, and the autosave of a tab whose session channel is not up. Ordinary
      // concurrent editing does not come through here at all: it is register assignments over the session
      // channel, which cannot collide (docs/039). A live register room adopts whatever lands here, so the two
      // paths cannot drift apart.
      if (parts.length === 2 && parts[1] === 'document' && req.method === 'PUT') {
        const body = await readJsonBody(req) as { baseRevision?: number; document?: unknown };
        if (!Number.isInteger(body.baseRevision)) throw new Error('baseRevision must be an integer');
        const principal = projectActor(identity);
        const project = await projects.requireProjectEdit(parts[0], principal);
        const requestedName = body.document && typeof body.document === 'object'
          ? (body.document as { name?: unknown }).name : undefined;
        if (!projects.canManageProject(project, principal)
          && typeof requestedName === 'string' && requestedName !== project.name) {
          throw new projects.ProjectPermissionError('Only this map\'s owner or a moderator can rename it.');
        }
        await saveOrConflict(res, identity,
          () => projects.saveProject(parts[0], body.baseRevision!, body.document, clientId,
            projects.canManageProject(project, principal)));
        return;
      }
      // History (docs/040): the checkpoints under the project's autosaves/ ring — list them with what the ring
      // costs, take one of the project as it stands, read one whole document back for a preview or a fork,
      // name one so it is kept, and restore one as the next revision.
      if (parts.length === 2 && parts[1] === 'checkpoints' && req.method === 'GET') {
        jsonResponse(res, 200, await projects.listCheckpoints(parts[0])); return;
      }
      if (parts.length === 2 && parts[1] === 'checkpoints' && req.method === 'POST') {
        await projects.requireProjectEdit(parts[0], projectActor(identity));
        const body = await readJsonBody(req) as { note?: string; reason?: string };
        // Only the two an editor asks for: a checkpoint someone named, and the forced one before a bulk
        // destructive edit. The timer's own reason is not a client's to claim.
        const reason = body.reason === 'bulk' ? 'bulk' : 'named';
        if (reason === 'named' && !body.note?.trim()) throw new Error('A named checkpoint needs a note');
        jsonResponse(res, 201, {
          checkpoint: await projects.checkpointNow(parts[0],
            { reason, note: body.note?.trim(), ...attribution(identity, parts[0]) }),
        });
        return;
      }
      if (parts.length === 3 && parts[1] === 'checkpoints' && req.method === 'GET') {
        jsonResponse(res, 200, await projects.readCheckpoint(parts[0], decodeURIComponent(parts[2]))); return;
      }
      // A checkpoint exported as the same self-contained mountain ZIP source the current revision uses. The
      // checkpoint file itself is only a compressed document; its assets are resolved here from the owning
      // project's local catalogue, so the browser receives the same portable shape as a live revision.
      if (parts.length === 4 && parts[1] === 'checkpoints' && parts[3] === 'download' && req.method === 'GET') {
        const { checkpoint, document } = await projects.readCheckpoint(parts[0], decodeURIComponent(parts[2]));
        const current = await projects.openProject(parts[0]);
        await migrateLegacyProjectAssets(current);
        jsonResponse(res, 200, await withProjectAssets(current, () => downloadDocument(document, {
          name: current.project.name, revision: checkpoint.revision, takenAt: checkpoint.takenAt,
        }, url.searchParams.get('assets') === 'bytes')));
        return;
      }
      // What changed since a checkpoint, in words rather than as a diff to read (docs/040). The registers a
      // document decomposes into are what makes this cheap: how many corners moved, which faces were
      // repainted or retextured, which objects appeared or vanished, which globals differ. `writers` is who
      // the room currently credits registers to, which is who a scoped revert may be aimed at.
      if (parts.length === 4 && parts[1] === 'checkpoints' && parts[3] === 'changes' && req.method === 'GET') {
        const { checkpoint, document } = await projects.readCheckpoint(parts[0], decodeURIComponent(parts[2]));
        const summary = changeSummary(document, await liveDocument(parts[0]));
        const room = roomFor(parts[0]);
        jsonResponse(res, 200, {
          checkpoint, summary, described: describeChanges(summary), writers: room ? roomWriters(room) : [],
        });
        return;
      }
      // A scoped revert (docs/040): "put back everything Bob changed since this checkpoint", or "put this
      // selection back to it". Both are ordinary register assignments — the checkpoint's values, assigned —
      // so they land through the same path any edit lands through and need no storage of their own. Editor
      // role, like every other write to a map (`ROUTE_ACCESS`), and the document being replaced is set aside
      // as a pinned checkpoint first, so a revert nobody wanted is undone exactly as a bad restore is.
      if (parts.length === 4 && parts[1] === 'checkpoints' && parts[3] === 'revert' && req.method === 'POST') {
        const principal = projectActor(identity);
        const project = await projects.requireProjectEdit(parts[0], principal);
        const body = await readJsonBody(req) as { by?: string; vertices?: unknown; quads?: unknown };
        const file = decodeURIComponent(parts[2]);
        const request: RevertRequest = {
          ...(body.by?.trim() ? { by: body.by.trim() } : {}),
          vertices: names(body.vertices), quads: names(body.quads),
        };
        const { checkpoint, document: was } = await projects.readCheckpoint(parts[0], file);
        const room = await joinRoom(parts[0]);
        // The room, not the file, is the authoritative document while it is open, so it is written out before
        // the checkpoint that holds what the revert is about to replace.
        await takeSnapshot(room);
        const planned = planRevert(room, was, request);
        // Restoring content is an editor action; restoring the old map name is still a rename.
        const changes = projects.canManageProject(project, principal)
          ? planned : planned.filter(([key]) => key !== 'g/name');
        if (!changes.length) {
          jsonResponse(res, 200, {
            ...await projects.openProject(parts[0]), reverted: 0, unchanged: true,
            checkpoint: null, described: [],
          });
          return;
        }
        const held = await projects.checkpointNow(parts[0],
          { reason: 'revert', note: `replaced by a revert to the checkpoint from ${checkpoint.takenAt}`,
            ...attribution(identity, parts[0]) });
        const by = actor(identity);
        const written = assign(room, changes, by);
        await takeSnapshot(room);
        // What the revert actually put back. A key naming geometry deleted since the checkpoint retires
        // quietly rather than travelling on as an edit nobody can apply, and a whole-map revert can carry a
        // great many of those.
        const applied = written.landed;
        // Relayed to everybody on the map, the requester included: these are somebody else's registers as far
        // as every replica is concerned, including the one whose author asked for them.
        if (applied.length) {
          const frame = prepareWebSocketText(JSON.stringify({
            t: 'sync', projectId: parts[0], at: written.at, changes: onWire(applied), by,
          }));
          for (const session of sessionsOn(parts[0])) {
            session.sendPrepared(frame);
          }
        }
        const snapshot = await projects.openProject(parts[0]);
        systemEvent(`${by} reverted ${revertPhrase(request)} on ${snapshot.project.name} to the checkpoint `
          + `from ${checkpointClock(file)} — ${applied.length} register${applied.length === 1 ? '' : 's'}`);
        // The summary is what STILL differs from the checkpoint now the revert has landed, which for a scoped
        // one is everybody else's work — the whole reason it was scoped.
        const summary = changeSummary(was, snapshot.document);
        jsonResponse(res, 200, {
          ...snapshot, reverted: applied.length, unchanged: applied.length === 0, checkpoint: held,
          retired: written.retired.length, summary, described: describeChanges(summary),
        });
        return;
      }
      if (parts.length === 4 && parts[1] === 'checkpoints' && parts[3] === 'name' && req.method === 'POST') {
        await projects.requireProjectEdit(parts[0], projectActor(identity));
        const body = await readJsonBody(req) as { note?: string };
        jsonResponse(res, 200, {
          checkpoint: await projects.nameCheckpoint(parts[0], decodeURIComponent(parts[2]), body.note ?? '',
            attribution(identity, parts[0]).by),
        });
        return;
      }
      if (parts.length === 4 && parts[1] === 'checkpoints' && parts[3] === 'restore' && req.method === 'POST') {
        const principal = projectActor(identity);
        const project = await projects.requireProjectEdit(parts[0], principal);
        const body = await readJsonBody(req) as { baseRevision?: number };
        if (!Number.isInteger(body.baseRevision)) throw new Error('baseRevision must be an integer');
        await saveOrConflict(res, identity, async () => {
          const restored = await projects.restoreCheckpoint(parts[0], body.baseRevision!,
            decodeURIComponent(parts[2]), clientId, projects.canManageProject(project, principal));
          if (!restored.unchanged) {
            systemEvent(`${actor(identity)} restored ${restored.project.name} to the checkpoint from `
              + checkpointClock(parts[2]));
          }
          return restored;
        });
        return;
      }
      res.statusCode = 404; res.end('Unknown project route');
    } catch (error) {
      // A checkpoint that has been thinned since the listing was taken is gone, not malformed: 410 tells the
      // panel its list is stale, which is a different repair from 400's "that was never a checkpoint".
      if (error instanceof projects.CheckpointGoneError) {
        jsonResponse(res, 410, { error: error.message }); return;
      }
      if (error instanceof projects.ProjectPermissionError) {
        jsonResponse(res, error.statusCode, { error: error.message }); return;
      }
      jsonResponse(res, 400, { error: String(error instanceof Error ? error.message : error) });
    }
  },
};

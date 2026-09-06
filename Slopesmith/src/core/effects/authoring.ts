import type { PlacedProp, Rail, V3 } from '../doc/types';
import { isTilted, rotateByPlacement, unrotateByPlacement, type PropRotation } from '../props/pose';
import { ensureRailIds, isMotionPath, nativeSplineFields, railStartsOff } from '../rails/rails';
import {
  cloneEffectsDocument,
  compatibleEffectSemanticTypes,
  parseEffectsDocument,
  validateEffectsDocument,
  type EffectFunction,
  type EffectGraph,
  type EffectNode,
  type EffectSlot,
  type EffectsDocument,
  type JsonObject,
  type JsonValue,
} from './document';
import {
  crackedMaterialControlFromGraph,
  isTextureFlipPulse,
  materialControlFromGraph,
  materialWorldEffectsFromGraph,
  textureFlipFromGraph,
  type MaterialControl,
  type MaterialWorldEffects,
  type TextureFlipEffect,
  type UvScrollEffect,
} from './world-effects';
import {
  EFFECT_LATCH_CIRCUMSTANCES,
  effectCircumstanceLabel,
  effectSlotCanSelfEnd,
  effectSlotHoldsAtEnd,
  effectSlotLatchIsEmptyGraph,
  type AuthoredEffectCircumstance,
  type EffectCircumstance,
  type EffectLatchCircumstance,
  type EffectOwnerKind,
  type EffectSelection,
} from './authoring-contract';
import {
  EFFECT_TEMPLATES,
  EFFECT_TYPES,
  type EffectAttachment,
  type EffectAuthoringIssue,
  type EffectNodeTemplateId,
  type EffectTemplate,
  type EffectTemplateId,
} from './authoring-catalogue';

export * from './authoring-contract';
export * from './authoring-catalogue';

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const collectionIds = (document: EffectsDocument): Set<string> => new Set([
  ...document.slots.map(x => x.id), ...document.graphs.map(x => x.id), ...document.functions.map(x => x.id),
  ...document.objectProperties.map(x => x.id), ...document.instances.map(x => x.id),
  ...document.physics.map(x => x.id), ...document.collisionModels.map(x => x.id), ...document.splines.map(x => x.id),
  ...document.graphs.flatMap(x => x.nodes.map(n => n.id)), ...document.functions.flatMap(x => x.nodes.map(n => n.id)),
]);

/** Deterministic stable id allocation makes authored diffs and tests readable. */
export function nextEffectId(document: EffectsDocument, prefix: string): string {
  const used = collectionIds(document);
  for (let i = 0; ; i++) {
    const id = `${prefix}:${i.toString().padStart(4, '0')}`;
    if (!used.has(id)) return id;
  }
}

export function nextPlacedPropId(props: readonly PlacedProp[], prefix = 'prop'): string {
  const used = new Set(props.map(p => p.id).filter((id): id is string => !!id));
  for (let i = 0; ; i++) {
    const id = `${prefix}:${i.toString().padStart(4, '0')}`;
    if (!used.has(id)) return id;
  }
}

/** Upgrade old slope documents in place: attachments need identity that survives array reorder/delete. */
export function ensurePlacedPropIds(props: PlacedProp[] | undefined): void {
  if (!props) return;
  const used = new Set<string>(), needsId: PlacedProp[] = [];
  for (const prop of props) {
    if (typeof prop.id === 'string' && prop.id && !used.has(prop.id)) used.add(prop.id);
    else needsId.push(prop);
  }
  for (const prop of needsId) {
    prop.id = nextPlacedPropId([...used].map(id => ({ id } as PlacedProp)));
    used.add(prop.id);
  }
}

export function createEmptyEffectsDocument(level: string): EffectsDocument {
  return {
    $schema: 'openslope-effects-v1.schema.json', kind: 'openslope-effects', version: 1,
    target: { game: 'ssx-tricky', platform: 'ps2', region: 'pal', level: level || 'UNTITLED' },
    header: { U1: 1966592, U2: 1053952, U3: 0.006 },
    slots: [], graphs: [], functions: [], objectProperties: [], instances: [], physics: [], collisionModels: [], splines: [],
    extensions: {},
  };
}

const AUTHORED_MOTION_PATH_PREFIX = 'spline:path:';
const AUTHORED_RAIL_PREFIX = 'spline:rail:';
const isAuthoredMotionPathResource = (id: string): boolean => id.startsWith(AUTHORED_MOTION_PATH_PREFIX);
const isAuthoredSplineResource = (id: string): boolean =>
  isAuthoredMotionPathResource(id) || id.startsWith(AUTHORED_RAIL_PREFIX);

/** Portable effect-resource id for any course spline Slopesmith manages — a motion path or a grind rail.
 *  The rail's own id prefix (`path:` / `rail:`) is what keeps the two kinds apart in the resource table. */
export const authoredSplineId = (rail: Rail): string | null => rail.id ? `spline:${rail.id}` : null;

/** Portable effect-resource id for an authored motion path, and null for a grind rail. Callers that mean
 *  "a route a mover can follow" want this; callers that mean "any spline" want `authoredSplineId`. */
export const authoredMotionPathSplineId = (path: Rail): string | null =>
  isMotionPath(path) ? authoredSplineId(path) : null;

/** Recover the mountain motion-path id from a Slopesmith-managed spline resource. */
export const authoredMotionPathIdFromSpline = (splineId: string | null | undefined): string | null =>
  splineId?.startsWith(AUTHORED_MOTION_PATH_PREFIX) ? splineId.slice('spline:'.length) : null;

/** Recover the mountain spline id — a grind rail's or a motion path's — from a managed spline resource. */
export const authoredRailIdFromSpline = (splineId: string | null | undefined): string | null =>
  splineId && isAuthoredSplineResource(splineId) ? splineId.slice('spline:'.length) : null;

/**
 * Mirror every complete course spline into Effects.json's native spline-resource table, so a node can name
 * one by reference and the writer can resolve it to a native index.
 *
 * Both kinds are mirrored because both are in the native table: `buildSplinesJson` writes grind rails and
 * motion paths together, in document order, filtered to those with at least two nodes — which is exactly the
 * `complete` list below, so `originalIndex` IS the native `SplineIndex` for either kind.
 *
 * What differs is which node may point at which. A mover follows a route, so `spline.animation` is held to
 * motion paths; a rail toggle switches candidacy, and retail aims it at both grind rails and the off-by-
 * default splines of a breakable, so it is held to neither.
 */
export function syncAuthoredSplineEffectResources(document: EffectsDocument, rails: Rail[] | undefined): void {
  ensureRailIds(rails);
  const complete = (rails ?? []).filter(rail => rail.nodes.length >= 2);
  const managed = complete.map((path, originalIndex) => {
    const native = nativeSplineFields(path);
    return {
      id: authoredSplineId(path)!,
      originalIndex,
      name: path.name || `${isMotionPath(path) ? 'Motion path' : 'Rail'} ${originalIndex + 1}`,
      data: { U1: native.u0, U2: native.u1, SplineStyle: native.style },
      extensions: { slopesmith: { path: path.id! } },
    };
  });
  const live = new Set(managed.map(resource => resource.id));
  const stale = new Set(document.splines
    .filter(resource => isAuthoredSplineResource(resource.id) && !live.has(resource.id))
    .map(resource => resource.id));
  document.splines = [
    ...document.splines.filter(resource => !isAuthoredSplineResource(resource.id)),
    ...managed,
  ];
  for (const owner of [...document.graphs, ...document.functions])
    for (const node of owner.nodes) {
      const spline = node.references?.spline;
      if (spline && (stale.has(spline)
        || (node.semanticType === 'spline.animation' && !isAuthoredMotionPathResource(spline))))
        node.references!.spline = null;
    }
}

/** Kept as the name the mover path has always called. The sync is one operation over all course splines. */
export const syncAuthoredMotionPathEffectResources = syncAuthoredSplineEffectResources;

/** Bind a newly added spline-mover node to a preferred complete motion path, falling back to the first path. */
export function bindEffectSplineToMotionPath(document: EffectsDocument, selection: EffectSelection,
  rails: Rail[] | undefined, preferredPathId?: string | null): boolean {
  syncAuthoredSplineEffectResources(document, rails);
  const node = effectNode(document, selection);
  if (node?.semanticType !== 'spline.animation') return false;
  const routes = document.splines.filter(resource => isAuthoredMotionPathResource(resource.id));
  const preferred = preferredPathId
    ? routes.find(resource => authoredMotionPathIdFromSpline(resource.id) === preferredPathId) : null;
  const target = preferred ?? routes[0];
  (node.references ??= {}).spline = target?.id ?? null;
  return !!target;
}

/**
 * Bind a newly added rail toggle to a preferred rail, falling back to the first GRIND rail on the mountain.
 *
 * The fallback is deliberately a grind rail rather than the first spline of any kind: a toggle aimed at a
 * motion path would switch a mover's route in and out of the rail network, which is legal and is never what
 * an author reaching for "rail on / off" meant.
 */
export function bindEffectSplineToRail(document: EffectsDocument, selection: EffectSelection,
  rails: Rail[] | undefined, preferredRailId?: string | null): boolean {
  syncAuthoredSplineEffectResources(document, rails);
  const node = effectNode(document, selection);
  if (node?.semanticType !== 'spline.toggle') return false;
  const grindIds = new Set((rails ?? [])
    .filter(rail => !isMotionPath(rail) && rail.id).map(rail => `spline:${rail.id}`));
  const grinds = document.splines.filter(resource => grindIds.has(resource.id));
  const preferred = preferredRailId
    ? grinds.find(resource => resource.id === `spline:${preferredRailId}`) : null;
  const target = preferred ?? grinds[0];
  (node.references ??= {}).spline = target?.id ?? null;
  return !!target;
}

/** One node that names a course spline, found by walking the document the other way round. */
export interface SplineEffectUse {
  ownerKind: EffectOwnerKind;
  ownerId: string;
  nodeId: string;
  semanticType: string;
  /** `spline.toggle` only: whether this node switches the rail INTO the rail query (`Effect ≠ 0`) or out of
   *  it. The two directions want opposite things of the rail, so the panels and the validator both need it. */
  switchesOn?: boolean;
}

/** Whether a rail toggle puts its spline into the rail query or takes it out [Trailmap: 140-rail-toggle]. */
function splineToggleSwitchesOn(node: EffectNode): boolean {
  const spline = node.payload.Spline;
  // The template ships `Effect: 1`, so a payload missing the word reads as the on direction it was born with.
  if (!object(spline) || typeof spline.Effect !== 'number') return true;
  return spline.Effect !== 0;
}

/**
 * Every node that names `splineId`, across graphs and shared functions.
 *
 * The document only ever runs prop → slot → graph → node → spline, so a rail has no way of knowing what
 * points at it. That is exactly what an author selecting a rail wants to know — which effect switches this,
 * and does it switch it on or off — and it is what makes a rail readable in Effects mode rather than an
 * inert tube the mode has no opinion about.
 */
export function splineEffectUses(document: EffectsDocument, splineId: string | null | undefined): SplineEffectUse[] {
  if (!splineId) return [];
  const out: SplineEffectUse[] = [];
  const scan = (ownerKind: EffectOwnerKind, owners: readonly { id: string; nodes: EffectNode[] }[]) => {
    for (const owner of owners)
      for (const node of owner.nodes) {
        if (node.references?.spline !== splineId) continue;
        out.push({
          ownerKind, ownerId: owner.id, nodeId: node.id, semanticType: node.semanticType ?? `MainType ${node.mainType}`,
          ...(node.semanticType === 'spline.toggle' ? { switchesOn: splineToggleSwitchesOn(node) } : {}),
        });
      }
  };
  scan('graph', document.graphs);
  scan('function', document.functions);
  return out;
}

/** One placement a spline is paired with, plus the node naming the spline that led here. */
export interface SplinePairedProp {
  prop: PlacedProp;
  /** The spline node whose own effect also aims at this prop — so a panel can open the effect, not just jump. */
  use: SplineEffectUse;
}

/**
 * The props a spline is PAIRED with: the placements that the very graphs naming this spline also act on.
 *
 * There is no spline→prop field to read. The curve and the model along it are unrelated records on disc —
 * separate `.pbd` rows, no reference either way (docs/014) — so this is the one join the data actually
 * contains, and it is the join retail itself relies on. `HideShowOff` retires a rail with TWO nodes in one
 * graph: a `MainType 25` naming the spline and a `MainType 7` naming the instance. One graph, both ends. An
 * author who wired those together said, in the only way the format allows, that this curve and that model
 * are the same rail.
 *
 * So it answers nothing for a curve no effect touches, and that is correct rather than a gap: nothing in the
 * level claims those two objects belong together, and pairing them by proximity would be the editor
 * inventing a fact and presenting it in the same button as a real one.
 */
export function splinePairedProps(document: EffectsDocument, props: readonly PlacedProp[],
  splineId: string | null | undefined): SplinePairedProp[] {
  const out: SplinePairedProp[] = [];
  const seen = new Set<string>();
  for (const use of splineEffectUses(document, splineId)) {
    const owner = effectOwner(document, { ownerKind: use.ownerKind, ownerId: use.ownerId });
    for (const node of owner?.nodes ?? []) {
      const target = authoredInstanceEffectCall(document, props, node)?.target;
      if (!target?.id || seen.has(target.id)) continue;
      seen.add(target.id);
      out.push({ prop: target, use });
    }
  }
  return out;
}

/**
 * Point a newly added vertical lift at an altitude above the placement carrying it.
 *
 * The node's target is an absolute world Z, so a shipped default is meaningless — this is what makes the
 * template authorable at all rather than a trap. `LIFT_DEFAULT_HEIGHT_M` above the prop is a lift the author
 * can see working immediately and then tune; the field does not track the prop afterwards, and the
 * template's own description says so.
 */
export const LIFT_DEFAULT_HEIGHT_M = 30;

/** The altitude a lift added to this graph should carry riders to, or null when the graph is not on a prop
 *  yet. Resolved through the same slot walk the editor uses everywhere else, so a node added to a latch
 *  column or a bare graph reports honestly rather than defaulting to the origin. */
export function zBoostTargetForOwner(document: EffectsDocument, props: readonly PlacedProp[],
  ownerId: string): number | null {
  const binding = authoredEffectBindings(document, props).find(item => item.graph.id === ownerId);
  return binding ? binding.prop.pos[1] : null;
}

export function bindZBoostToPlacement(document: EffectsDocument, selection: EffectSelection,
  placementY: number): boolean {
  const node = effectNode(document, selection);
  if (node?.semanticType !== 'property.z-boost') return false;
  const sub = (node.payload as { type0?: { type0Sub18?: Record<string, number> } })?.type0?.type0Sub18;
  if (!sub) return false;
  // The payload holds RAW altitude, the same centimetre Z the exporter writes (`toRaw`'s third component is
  // `100 * y`). Written out rather than imported to keep core/effects free of a dependency on core/export.
  sub.U5 = 100 * (placementY + LIFT_DEFAULT_HEIGHT_M);
  return true;
}

/**
 * Give a newly added call node a function to call, making an empty one when the document has none.
 *
 * Every other bind helper points at something that already exists — a rail, a placement, a route. A call has
 * nothing of the sort to fall back on: an authored mountain starts with an empty function table, so "bind to
 * the first one" would leave the node unbound on the only documents that matter, and an unbound call is a
 * slot the repack compiler refuses whole. Creating the body is therefore part of adding the node, and the
 * author gets an empty function in the tree to fill in rather than a reference to hunt for.
 *
 * Returns the id of the function the node now names.
 */
export function bindEffectFunctionCall(document: EffectsDocument, selection: EffectSelection,
  preferredFunctionId?: string | null): string | null {
  const node = effectNode(document, selection);
  if (node?.semanticType !== 'function.call') return null;
  const preferred = preferredFunctionId
    ? document.functions.find(fn => fn.id === preferredFunctionId) : null;
  let target = preferred ?? null;
  if (!target) {
    const id = nextEffectId(document, 'function');
    target = { id, name: 'Shared effect', nodes: [] };
    document.functions.push(target);
  }
  (node.references ??= {}).function = target.id;
  return target.id;
}

export function effectOwner(document: EffectsDocument, selection: EffectSelection): EffectGraph | EffectFunction | null {
  return selection.ownerKind === 'graph'
    ? document.graphs.find(x => x.id === selection.ownerId) ?? null
    : document.functions.find(x => x.id === selection.ownerId) ?? null;
}

export function effectNode(document: EffectsDocument, selection: EffectSelection): EffectNode | null {
  const owner = effectOwner(document, selection);
  return owner && selection.nodeId ? owner.nodes.find(x => x.id === selection.nodeId) ?? null : null;
}

const emptyEffectCircumstances = (): EffectSlot['circumstances'] => ({
  persistent: null, collision: null, slot3: null, slot4: null, trigger: null, slot6: null, slot7: null,
});

/** Populate a template's latch columns on the host slot, each as a fresh empty sentinel graph. */
function applyTemplateLatches(document: EffectsDocument, slot: EffectSlot, template: EffectTemplate): void {
  for (const circumstance of template.latches ?? []) {
    if (slot.circumstances[circumstance]) continue;
    const latchId = nextEffectId(document, 'graph');
    document.graphs.push({ id: latchId, name: `${effectCircumstanceLabel(circumstance)} latch`, nodes: [] });
    slot.circumstances[circumstance] = latchId;
  }
}

/** Create an empty graph and slot for one user-facing native effect circumstance. */
export function addEmptyEffect(document: EffectsDocument,
  circumstance: AuthoredEffectCircumstance): EffectSelection {
  const type = EFFECT_TYPES.find(item => item.circumstance === circumstance) ?? EFFECT_TYPES[0];
  const graphId = nextEffectId(document, 'graph');
  document.graphs.push({ id: graphId, name: type.label, nodes: [] });
  const slotId = nextEffectId(document, 'slot');
  const circumstances = emptyEffectCircumstances();
  circumstances[type.circumstance] = graphId;
  document.slots.push({ id: slotId, name: `${type.label} slot`, circumstances });
  return { ownerKind: 'graph', ownerId: graphId };
}

/**
 * Materialise everything an imported MODEL declared for itself — emitters and scrolling surfaces — into
 * one persistent graph attached to a placement of it (docs/032).
 *
 * The declaration lives in the GLB, so the author never re-authors the same snow plume against every gun
 * they stamp down. But what PLAYS it is the ordinary effects runtime, reached the ordinary way, through
 * real nodes in a real graph: nothing here renders anything, and the moment it is attached the graph is an
 * ordinary one the Effects editor can open, retune or delete. A scroll that bypassed the graph would work
 * on screen and then be invisible in the editor, unexportable, and a second mechanism to maintain.
 *
 * Returns false when the prop already carries an attachment, which is what makes this safe to call on every
 * placement: a prop somebody has since edited is left exactly as they left it.
 */
export function attachModelEffectsToProp(document: EffectsDocument, propId: string,
  declared: {
    emitters?: readonly { fields: Record<string, number> }[];
    scrolls?: readonly { mat: number; effect: UvScrollEffect }[];
    /** The model carries an object-hierarchy clip (an imported GLB that declared a spin). */
    clip?: boolean;
  }): boolean {
  const emitters = declared.emitters ?? [];
  const scrolls = declared.scrolls ?? [];
  if (!emitters.length && !scrolls.length && !declared.clip) return false;
  if (effectAttachments(document).some(item => item.target.id === propId)) return false;
  const graphId = nextEffectId(document, 'graph');
  const nodes: EffectNode[] = [];
  /** A node built the way the editor's own templates build one. The semantic type is DERIVED from the
   *  payload rather than written out, so these read identically to a hand-added node — the inspector's
   *  label comes straight off it, and a node without one shows as the bare "Main type 2". */
  const push = (mainType: number, payload: JsonObject, extensions?: JsonObject) => {
    const semanticType = compatibleEffectSemanticTypes({ mainType, payload })?.[0];
    nodes.push({
      id: `${graphId}/node:${nodes.length.toString().padStart(4, '0')}`,
      mainType,
      ...(semanticType ? { semanticType } : {}),
      payload,
      references: {},
      ...(extensions ? { extensions } : {}),
    });
  };
  if (declared.clip) {
    // The looping Model clip template verbatim, so a declared spin and a hand-added one are the same node:
    // the geometry is already in the document, and this is only the player that runs it. U1/U2 are the clip
    // WINDOW in frames and negative means "the whole clip" — the value 40 of retail's 43 anim nodes carry.
    push(0, { type0: { SubType: 256,
      type0Sub256: { U0: 1, U1: -1, U2: -1, U3: 30, U4: 0, U5: 1, U6: 0, U7: 3 } } });
  }
  for (const emitter of emitters) {
    push(2, { type2: { SubType: 0, type2Sub0: { ...emitter.fields } } });
  }
  for (const scroll of scrolls) {
    // An ordinary retail-shaped UVScroll node, so it decodes with the existing reader and exports as a
    // native one. Which material it drives is a Slopesmith concern and rides in `extensions`, leaving the
    // payload byte-shaped like the record it came from.
    push(0, { type0: { SubType: 10, UVScroll: {
      U0: scroll.effect.mode, U1: scroll.effect.uPerTick, U2: scroll.effect.vPerTick,
      U3: scroll.effect.activeDuration, U4: scroll.effect.pauseDuration, U5: scroll.effect.lifetime,
    } } }, { slopesmith: { material: scroll.mat } });
  }
  document.graphs.push({ id: graphId, name: 'Model effects', nodes });
  const slotId = nextEffectId(document, 'slot');
  const circumstances = emptyEffectCircumstances();
  circumstances.persistent = graphId;
  document.slots.push({ id: slotId, name: 'Model effects slot', circumstances });
  attachEffectToProp(document, propId, slotId, 'persistent');
  return true;
}

/** A template's chain as concrete nodes in a fresh graph. Ids number from zero because the graph is new. */
function templateNodes(template: EffectTemplate, graphId: string): EffectNode[] {
  return (template.nodes ?? []).map((node, index) =>
    ({ ...structuredClone(node), id: `${graphId}/node:${index.toString().padStart(4, '0')}` }));
}

export function addEffectTemplate(document: EffectsDocument, templateId: EffectTemplateId): EffectSelection {
  const template = EFFECT_TEMPLATES.find(x => x.id === templateId) ?? EFFECT_TEMPLATES[0];
  const graphId = nextEffectId(document, 'graph');
  const nodes = templateNodes(template, graphId);
  const graph: EffectGraph = { id: graphId, name: template.label, nodes };
  document.graphs.push(graph);
  const slotId = nextEffectId(document, 'slot');
  const circumstances = emptyEffectCircumstances();
  circumstances[template.circumstance] = graphId;
  const slot: EffectSlot = { id: slotId, name: `${template.label} slot`, circumstances };
  document.slots.push(slot);
  applyTemplateLatches(document, slot, template);
  return { ownerKind: 'graph', ownerId: graphId, ...(nodes[0] ? { nodeId: nodes[0].id } : {}) };
}

export function addEffectFunction(document: EffectsDocument): EffectSelection {
  const id = nextEffectId(document, 'function');
  document.functions.push({ id, name: 'New function', nodes: [] });
  return { ownerKind: 'function', ownerId: id };
}

function nextNodeId(document: EffectsDocument, owner: EffectGraph | EffectFunction): string {
  const used = new Set(owner.nodes.map(x => x.id));
  for (let i = 0; ; i++) {
    const id = `${owner.id}/node:${i.toString().padStart(4, '0')}`;
    if (!used.has(id) && !collectionIds(document).has(id)) return id;
  }
}

export function addEffectNodeTemplate(document: EffectsDocument, selection: EffectSelection,
  templateId: EffectNodeTemplateId): EffectSelection | null {
  const owner = effectOwner(document, selection);
  const template = EFFECT_TEMPLATES.find(x => x.id === templateId);
  if (!owner || !template?.nodes?.length) return null;
  // Appended one at a time so each id is allocated against the chain as it grows — a recipe extends the
  // existing chain rather than replacing it, which is how native trigger chains are built up.
  const added = template.nodes.map(source => {
    const node: EffectNode = { ...structuredClone(source), id: nextNodeId(document, owner) };
    owner.nodes.push(node);
    return node;
  });
  if (template.latches && selection.ownerKind === 'graph')
    for (const binding of graphSlots(document, selection.ownerId))
      applyTemplateLatches(document, binding.slot, template);
  return { ownerKind: selection.ownerKind, ownerId: selection.ownerId, nodeId: added[0].id };
}

export function moveEffectOwner(document: EffectsDocument, selection: EffectSelection, delta: -1 | 1): boolean {
  const list = selection.ownerKind === 'graph' ? document.graphs : document.functions;
  const at = list.findIndex(x => x.id === selection.ownerId), to = at + delta;
  if (at < 0 || to < 0 || to >= list.length) return false;
  const mutable = list as (EffectGraph | EffectFunction)[];
  [mutable[at], mutable[to]] = [mutable[to], mutable[at]];
  return true;
}

export function duplicateEffectOwner(document: EffectsDocument, selection: EffectSelection): EffectSelection | null {
  const source = effectOwner(document, selection);
  if (!source) return null;
  const isGraph = selection.ownerKind === 'graph';
  const id = nextEffectId(document, isGraph ? 'graph' : 'function');
  const copy = structuredClone(source) as EffectGraph | EffectFunction;
  copy.id = id;
  copy.name = `${source.name ?? source.id} copy`;
  copy.nodes = copy.nodes.map((node, i) => ({ ...node, id: `${id}/node:${i.toString().padStart(4, '0')}` }));
  const list = isGraph ? document.graphs : document.functions;
  const at = list.findIndex(x => x.id === source.id);
  (list as (EffectGraph | EffectFunction)[]).splice(at + 1, 0, copy);
  return { ownerKind: selection.ownerKind, ownerId: id, ...(copy.nodes.length ? { nodeId: copy.nodes[0].id } : {}) };
}

/** Delete an owner without leaving dangling native references. */
export function deleteEffectOwner(document: EffectsDocument, selection: EffectSelection): boolean {
  const list = selection.ownerKind === 'graph' ? document.graphs : document.functions;
  const at = list.findIndex(x => x.id === selection.ownerId);
  if (at < 0) return false;
  list.splice(at, 1);
  if (selection.ownerKind === 'graph') {
    for (const slot of document.slots)
      for (const key of Object.keys(slot.circumstances) as EffectCircumstance[])
        if (slot.circumstances[key] === selection.ownerId) slot.circumstances[key] = null;
    for (const owner of [...document.graphs, ...document.functions])
      for (const node of owner.nodes)
        if (node.references?.effectGraph === selection.ownerId) node.references.effectGraph = null;
  } else {
    for (const owner of [...document.graphs, ...document.functions])
      for (const node of owner.nodes)
        if (node.references?.function === selection.ownerId) node.references.function = null;
  }
  return true;
}

export function duplicateEffectNode(document: EffectsDocument, selection: EffectSelection): EffectSelection | null {
  const owner = effectOwner(document, selection), source = effectNode(document, selection);
  if (!owner || !source) return null;
  const copy = structuredClone(source);
  copy.id = nextNodeId(document, owner);
  const at = owner.nodes.indexOf(source);
  owner.nodes.splice(at + 1, 0, copy);
  return { ...selection, nodeId: copy.id };
}

export function deleteEffectNode(document: EffectsDocument, selection: EffectSelection): EffectSelection | null {
  const owner = effectOwner(document, selection), node = effectNode(document, selection);
  if (!owner || !node) return null;
  const at = owner.nodes.indexOf(node);
  owner.nodes.splice(at, 1);
  const next = owner.nodes[Math.min(at, owner.nodes.length - 1)];
  return { ownerKind: selection.ownerKind, ownerId: selection.ownerId, ...(next ? { nodeId: next.id } : {}) };
}

export function moveEffectNode(document: EffectsDocument, selection: EffectSelection, delta: -1 | 1): boolean {
  const owner = effectOwner(document, selection), node = effectNode(document, selection);
  if (!owner || !node) return false;
  const at = owner.nodes.indexOf(node), to = at + delta;
  if (to < 0 || to >= owner.nodes.length) return false;
  [owner.nodes[at], owner.nodes[to]] = [owner.nodes[to], owner.nodes[at]];
  return true;
}

/** Replace the selected node from its exact portable JSON, proving the whole document still validates first. */
export function replaceEffectNodeRaw(document: EffectsDocument, selection: EffectSelection, json: string): EffectNode {
  const owner = effectOwner(document, selection), current = effectNode(document, selection);
  if (!owner || !current) throw new Error('Select a node first.');
  let value: unknown;
  try { value = JSON.parse(json); } catch (error) { throw new Error(`Invalid node JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  if (!object(value)) throw new Error('Node JSON must be an object.');
  const replacement = value as unknown as EffectNode;
  if (!replacement.id) replacement.id = current.id;
  const draft = cloneEffectsDocument(document);
  const draftOwner = effectOwner(draft, selection)!;
  draftOwner.nodes[draftOwner.nodes.findIndex(x => x.id === current.id)] = replacement;
  parseEffectsDocument(draft);
  owner.nodes[owner.nodes.indexOf(current)] = replacement;
  return replacement;
}

function slopesmithExtension(document: EffectsDocument, create: boolean): Record<string, JsonValue> | null {
  if (!document.extensions && create) document.extensions = {};
  const ext = document.extensions;
  if (!ext) return null;
  const existing = ext.slopesmith;
  if (object(existing)) return existing as Record<string, JsonValue>;
  if (!create) return null;
  const made: JsonObject = {};
  ext.slopesmith = made;
  return made;
}

const isCircumstance = (value: unknown): value is EffectCircumstance =>
  typeof value === 'string' && ['persistent', 'collision', 'slot3', 'slot4', 'trigger', 'slot6', 'slot7'].includes(value);

export function effectAttachments(document: EffectsDocument): EffectAttachment[] {
  const raw = slopesmithExtension(document, false)?.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.filter(item => object(item)
    && typeof item.id === 'string' && object(item.target) && item.target.kind === 'prop'
    && typeof item.target.id === 'string' && typeof item.slot === 'string' && isCircumstance(item.circumstance))
    .map(item => item as unknown as EffectAttachment);
}

export interface AuthoredEffectBinding {
  prop: PlacedProp;
  slot: EffectSlot;
  circumstance: EffectCircumstance;
  graph: EffectGraph;
}

/** Resolve every graph carried by an authored prop's slot. `attachment.circumstance` is only the editor's
 * preferred graph/focus; the native instance owns the whole slot and therefore every populated circumstance. */
export function authoredEffectBindings(document: EffectsDocument,
  props: readonly PlacedProp[]): AuthoredEffectBinding[] {
  const propById = new Map(props.filter(prop => !!prop.id).map(prop => [prop.id!, prop]));
  const graphById = new Map(document.graphs.map(graph => [graph.id, graph]));
  const out: AuthoredEffectBinding[] = [];
  for (const attachment of effectAttachments(document)) {
    if (!attachment.enabled) continue;
    const prop = propById.get(attachment.target.id);
    const slot = document.slots.find(item => item.id === attachment.slot);
    if (!prop || !slot) continue;
    for (const circumstance of Object.keys(slot.circumstances) as EffectCircumstance[]) {
      const graphId = slot.circumstances[circumstance];
      const graph = graphId ? graphById.get(graphId) : null;
      if (graph) out.push({ prop, slot, circumstance, graph });
    }
  }
  return out;
}

/** Whether a prop's enabled attachment resolves a real graph in the requested native slot circumstance. */
export function authoredPropHasEffectCircumstance(document: EffectsDocument | null | undefined,
  propId: string | null | undefined, circumstance: EffectCircumstance): boolean {
  if (!document || !propId) return false;
  const attachment = effectAttachments(document).find(item => item.enabled && item.target.id === propId);
  const slot = attachment ? document.slots.find(item => item.id === attachment.slot) : null;
  const graphId = slot?.circumstances[circumstance];
  return !!graphId && document.graphs.some(graph => graph.id === graphId);
}

/** Resolve always-on material effects attached to an authored prop through the editor's stable-ID slot join. */
export function authoredPropMaterialEffects(document: EffectsDocument | null | undefined,
  propId: string | null | undefined, mat?: number): MaterialWorldEffects | null {
  if (!document || !propId) return null;
  const attachment = effectAttachments(document).find(item => item.enabled && item.target.id === propId);
  if (!attachment) return null;
  const slot = document.slots.find(item => item.id === attachment.slot);
  const graphId = slot?.circumstances.persistent;
  const effect = materialWorldEffectsFromGraph(graphId ? document.graphs.find(item => item.id === graphId) : null, mat);
  if (!effect?.textureFlip?.dwell) return effect;
  let seed = 0x811c9dc5;
  for (let i = 0; i < propId.length; i++) seed = Math.imul(seed ^ propId.charCodeAt(i), 0x01000193);
  return { ...effect, textureFlip: { ...effect.textureFlip, seed: seed >>> 0 } };
}

/** Every circumstance an attached slot can run a graph from, in the order the renderer resolves them. */
const MATERIAL_CIRCUMSTANCE_ORDER: readonly EffectCircumstance[] =
  ['persistent', 'collision', 'slot3', 'slot4', 'trigger', 'slot6', 'slot7'];

/**
 * The material property an authored prop's graphs install, whichever circumstance installs it.
 *
 * This is deliberately wider than `authoredPropMaterialEffects`, which answers "what animates on its own" and
 * so reads the persistent slot alone. A receiver can be installed by any circumstance — a ride-over button
 * installs its flip on contact — and the renderer needs to know before the first control message arrives, so
 * the prop can be given a material of its own to pulse.
 */
export function authoredPropMaterialControl(document: EffectsDocument | null | undefined,
  propId: string | null | undefined): MaterialControl | null {
  if (!document || !propId) return null;
  const attachment = effectAttachments(document).find(item => item.enabled && item.target.id === propId);
  const slot = attachment ? document.slots.find(item => item.id === attachment.slot) : null;
  if (!slot) return null;
  let crackedControl: MaterialControl | null = null;
  for (const circumstance of MATERIAL_CIRCUMSTANCE_ORDER) {
    const graphId = slot.circumstances[circumstance];
    const graph = graphId ? document.graphs.find(item => item.id === graphId) : null;
    const control = materialControlFromGraph(graph);
    // A receiver only earns a material of its own when its graph also carries the bound-node op that writes
    // one. Authored graphs send that op directly; the reference path additionally follows shared functions,
    // which authoring has no way to build.
    if (control && graph!.nodes.some(node => node.mainType === 3 || node.mainType === 9)) return control;
    // Crack's intact -> cracked texture selection is implicit in the native handler, not a TextureFlip node in
    // the graph. Remember it as the fallback receiver so this placement gets a private two-frame material.
    if (circumstance === 'collision') crackedControl = crackedMaterialControlFromGraph(graph);
  }
  return crackedControl;
}

/** Compatibility helper for callers interested only in the recovered UV scroll. */
export function authoredPropUvScroll(document: EffectsDocument | null | undefined,
  propId: string | null | undefined): UvScrollEffect | null {
  return authoredPropMaterialEffects(document, propId)?.uvScroll ?? null;
}

/**
 * The FREE-RUNNING flipbook an authored prop installs: a persistent texture flip whose `length` — the node's
 * lifetime — is zero, so it lives as long as its slot and the material cycles forever. This is the set a
 * level publishes as `Flip.json`, and the lifetime is the whole discriminator: a `length > 0` flip is a
 * collision-fired one-shot that pulses a second state and dies (the ride-over button), so a consumer that
 * free-ran it would strobe a material whose frames are STATES rather than an animation.
 *
 * Read off the graph's own node rather than through `authoredPropMaterialEffects`, which also synthesizes a
 * flip for a crowd box — the crowd plays the shared cd bank on the per-cell CrowdBox schedule, not this rate.
 */
export function authoredPropTextureFlip(document: EffectsDocument | null | undefined,
  propId: string | null | undefined): TextureFlipEffect | null {
  if (!document || !propId) return null;
  const attachment = effectAttachments(document).find(item => item.enabled && item.target.id === propId);
  const slot = attachment ? document.slots.find(item => item.id === attachment.slot) : null;
  const graphId = slot?.circumstances.persistent;
  const flip = textureFlipFromGraph(graphId ? document.graphs.find(item => item.id === graphId) : null);
  return flip && !isTextureFlipPulse(flip) && flip.speed > 0 ? flip : null;
}

/** The Effect-end latch test for an authored prop's attached slot: a finished play-once clip holds its last
 * frame instead of reverting to the rest pose [Trailmap: 150-logic §slot-columns]. */
export function authoredPropHoldsAtEnd(document: EffectsDocument | null | undefined,
  propId: string | null | undefined): boolean {
  if (!document || !propId) return false;
  const attachment = effectAttachments(document).find(item => item.enabled && item.target.id === propId);
  return effectSlotHoldsAtEnd(attachment ? document.slots.find(item => item.id === attachment.slot) : null);
}

/** Graphs outside every attached slot, plus functions because functions are shared call targets rather than
 * level-object attachments. This is the prop-centric editor's lossless catch-all. */
export function unassignedEffectOwnerIds(document: EffectsDocument, attachedSlotIds: Iterable<string>): Set<string> {
  const attached = new Set(attachedSlotIds);
  const assignedGraphs = new Set<string>();
  for (const slot of document.slots) {
    if (!attached.has(slot.id)) continue;
    for (const graphId of Object.values(slot.circumstances)) if (graphId) assignedGraphs.add(graphId);
  }
  return new Set([
    ...document.graphs.filter(graph => !assignedGraphs.has(graph.id)).map(graph => graph.id),
    ...document.functions.map(fn => fn.id),
  ]);
}

/** Resolve the effect graph attached to one authored prop. Viewport picking uses the same stable-ID join as
 * the attachment panel, preferring the particle node itself when the graph contains a timer emitter. */
export function effectSelectionForProp(document: EffectsDocument, propId: string): EffectSelection | null {
  const attachment = effectAttachments(document).find(item => item.enabled && item.target.id === propId);
  if (!attachment) return null;
  const slot = document.slots.find(item => item.id === attachment.slot);
  const graphId = slot?.circumstances[attachment.circumstance];
  const graph = graphId ? document.graphs.find(item => item.id === graphId) : null;
  if (!graph) return null;
  const node = graph.nodes.find(item => !!particleEmitterFields(item)) ?? graph.nodes[0];
  return { ownerKind: 'graph', ownerId: graph.id, ...(node ? { nodeId: node.id } : {}) };
}

export function attachEffectToProp(document: EffectsDocument, propId: string, slot: string,
  circumstance: EffectCircumstance): EffectAttachment {
  const ext = slopesmithExtension(document, true)!;
  const attachments = effectAttachments(document);
  const prior = attachments.find(x => x.target.id === propId);
  const attachment: EffectAttachment = prior ?? {
    id: nextAttachmentId(attachments), target: { kind: 'prop', id: propId }, slot, circumstance, enabled: true,
  };
  attachment.slot = slot;
  attachment.circumstance = circumstance;
  attachment.enabled = true;
  if (!prior) {
    const raw = Array.isArray(ext.attachments) ? ext.attachments : (ext.attachments = []);
    raw.push(attachment as unknown as JsonValue);
  }
  return attachment;
}

function nextAttachmentId(attachments: readonly EffectAttachment[]): string {
  const used = new Set(attachments.map(x => x.id));
  for (let i = 0; ; i++) {
    const id = `attachment:${i.toString().padStart(4, '0')}`;
    if (!used.has(id)) return id;
  }
}

export function detachEffectFromProp(document: EffectsDocument, propId: string): boolean {
  const ext = slopesmithExtension(document, false);
  if (!ext || !Array.isArray(ext.attachments)) return false;
  const before = ext.attachments.length;
  ext.attachments = ext.attachments.filter(item => !(object(item) && object(item.target) && item.target.id === propId));
  return ext.attachments.length !== before;
}

/** Add an empty effect to a prop's native slot, creating and attaching the slot when necessary. */
export function addEmptyEffectToProp(document: EffectsDocument, propId: string,
  circumstance: AuthoredEffectCircumstance): EffectSelection {
  const type = EFFECT_TYPES.find(item => item.circumstance === circumstance) ?? EFFECT_TYPES[0];
  const attachment = effectAttachments(document).find(item => item.enabled && item.target.id === propId);
  const slot = attachment ? document.slots.find(item => item.id === attachment.slot) : undefined;
  if (!attachment || !slot) {
    const selection = addEmptyEffect(document, type.circumstance);
    const binding = graphSlots(document, selection.ownerId)[0];
    if (binding) attachEffectToProp(document, propId, binding.slot.id, binding.circumstance);
    return selection;
  }
  const existingGraphId = slot.circumstances[type.circumstance];
  const existingGraph = existingGraphId ? document.graphs.find(item => item.id === existingGraphId) : null;
  if (existingGraph) return { ownerKind: 'graph', ownerId: existingGraph.id,
    ...(existingGraph.nodes[0] ? { nodeId: existingGraph.nodes[0].id } : {}) };
  const graphId = nextEffectId(document, 'graph');
  document.graphs.push({ id: graphId, name: type.label, nodes: [] });
  slot.circumstances[type.circumstance] = graphId;
  return { ownerKind: 'graph', ownerId: graphId };
}

/**
 * Toggle a latch circumstance on a prop's slot [Trailmap: 150-logic §slot-columns]. Checking authors the
 * retail shape — a reference to a fresh ZERO-NODE graph, because the engine only tests populated-ness and an
 * empty chain is the cheapest legal "yes". Unchecking clears the reference and garbage-collects the latch
 * graph when it stayed empty and nothing else references it. A prop with no slot yet gets a bare slot whose
 * only populated column is the latch — exactly the Elysium door's authored form.
 */
export function setPropEffectLatch(document: EffectsDocument, propId: string,
  circumstance: EffectLatchCircumstance, enabled: boolean): boolean {
  const attachment = effectAttachments(document).find(item => item.enabled && item.target.id === propId);
  let slot = attachment ? document.slots.find(item => item.id === attachment.slot) : undefined;
  if (!enabled) {
    const graphId = slot?.circumstances[circumstance];
    if (!slot || !graphId) return false;
    slot.circumstances[circumstance] = null;
    const graph = document.graphs.find(item => item.id === graphId);
    const referenced = document.slots.some(item => Object.values(item.circumstances).includes(graphId))
      || [...document.graphs, ...document.functions].some(owner =>
        owner.nodes.some(node => node.references?.effectGraph === graphId));
    if (graph && graph.nodes.length === 0 && !referenced)
      document.graphs.splice(document.graphs.indexOf(graph), 1);
    return true;
  }
  if (slot?.circumstances[circumstance]) return false;
  if (!slot) {
    const slotId = nextEffectId(document, 'slot');
    slot = { id: slotId, name: 'Effect slot', circumstances: emptyEffectCircumstances() };
    document.slots.push(slot);
    attachEffectToProp(document, propId, slotId, circumstance);
  }
  const graphId = nextEffectId(document, 'graph');
  document.graphs.push({ id: graphId, name: `${effectCircumstanceLabel(circumstance)} latch`, nodes: [] });
  slot.circumstances[circumstance] = graphId;
  return true;
}

/**
 * Prop-first authoring: add a template DIRECTLY to a level prop, so a graph is never created unattached.
 * No attachment yet → the template's graph + slot are created and the prop attached in one step. Already
 * attached with the template's circumstance free → a fresh graph wires into that circumstance of the prop's
 * own slot — the native multi-circumstance shape [Trailmap: 150-logic] (the extracted river authors persistent flow + collision reset
 * on ONE slot). Circumstance already running a graph → the template node appends to that graph, extending
 * its execution chain the way native trigger chains grow.
 */
export function addEffectTemplateToProp(document: EffectsDocument, propId: string,
  templateId: EffectTemplateId): EffectSelection {
  const template = EFFECT_TEMPLATES.find(x => x.id === templateId) ?? EFFECT_TEMPLATES[0];
  const attachment = effectAttachments(document).find(item => item.enabled && item.target.id === propId);
  const slot = attachment ? document.slots.find(item => item.id === attachment.slot) : undefined;
  if (!attachment || !slot) {
    const selection = addEffectTemplate(document, templateId);
    const binding = graphSlots(document, selection.ownerId)[0];
    if (binding) attachEffectToProp(document, propId, binding.slot.id, binding.circumstance);
    return selection;
  }
  const existingGraphId = slot.circumstances[template.circumstance];
  const existingGraph = existingGraphId ? document.graphs.find(item => item.id === existingGraphId) : null;
  if (existingGraph) {
    const selection: EffectSelection = { ownerKind: 'graph', ownerId: existingGraph.id };
    if (template.id === 'empty' || !template.nodes?.length)
      return { ...selection, ...(existingGraph.nodes[0] ? { nodeId: existingGraph.nodes[0].id } : {}) };
    return addEffectNodeTemplate(document, selection, template.id as EffectNodeTemplateId) ?? selection;
  }
  const graphId = nextEffectId(document, 'graph');
  const nodes = templateNodes(template, graphId);
  document.graphs.push({ id: graphId, name: template.label, nodes });
  slot.circumstances[template.circumstance] = graphId;
  applyTemplateLatches(document, slot, template);
  return { ownerKind: 'graph', ownerId: graphId, ...(nodes[0] ? { nodeId: nodes[0].id } : {}) };
}

/**
 * Point an `act-on-instance` node at the placement it should run on, and the graph it should run there.
 *
 * The document names a PLACEMENT, not an instance index. The packed index does not exist until the props are
 * appended during the repack, so the compiler resolves this chain — instance row → placement → baked group →
 * packed row — and back-patches the number afterwards. Recording the placement instead of a number is also
 * what keeps the reference stable while the author moves props around.
 *
 * The instance row is shared: two hops at the same target reuse one row, which is the shape the native table
 * has anyway (one row per instance, however many nodes name it).
 */
export function bindInstanceHop(document: EffectsDocument, node: EffectNode,
  placementId: string, targetGraphId: string): void {
  if (node.mainType !== 7) throw new Error(`bindInstanceHop expects a MainType-7 node, got ${node.mainType}`);
  const existing = document.instances.find(item =>
    (item.extensions?.slopesmith as { placement?: string } | undefined)?.placement === placementId);
  const binding = existing ?? {
    id: nextEffectId(document, 'instance'),
    property: null,
    extensions: { slopesmith: { placement: placementId } },
  };
  if (!existing) document.instances.push(binding);
  node.references = { ...node.references, instance: binding.id, effectGraph: targetGraphId };
}

/** Resolve both authored ends of a MainType-7 remote call. The node names an Effects instance row rather
 * than a placed prop directly; Slopesmith's stable placement id lives in that row's extension until export
 * turns it into a packed native instance index. Keeping this join beside `bindInstanceHop` gives every
 * authored inspector the same answer about which prop receives which graph. */
export interface AuthoredInstanceEffectCall {
  target: PlacedProp | null;
  graph: EffectGraph | null;
  targetLabel: string;
  graphLabel: string;
}

export function authoredInstanceEffectCall(document: EffectsDocument, props: readonly PlacedProp[],
  node: EffectNode): AuthoredInstanceEffectCall | null {
  if (node.mainType !== 7 || (!node.references?.instance && !node.references?.effectGraph)) return null;
  const instance = node.references?.instance
    ? document.instances.find(item => item.id === node.references!.instance) ?? null : null;
  const slopesmith = object(instance?.extensions?.slopesmith) ? instance.extensions.slopesmith : null;
  const placementId = slopesmith && typeof slopesmith.placement === 'string' ? slopesmith.placement : null;
  const target = placementId ? props.find(prop => prop.id === placementId) ?? null : null;
  const graph = node.references?.effectGraph
    ? document.graphs.find(item => item.id === node.references!.effectGraph) ?? null : null;
  return {
    target,
    graph,
    targetLabel: target ? `${target.name} · ${target.id}` : placementId ?? node.references?.instance ?? '(none)',
    graphLabel: graph ? `${graph.name ?? graph.id} · ${graph.id}` : node.references?.effectGraph ?? '(none)',
  };
}

/**
 * Point a `rider-teleport` node at the placement the rider should land beside.
 *
 * The same placement → packed-index chain `bindInstanceHop` relies on, and it shares the instance rows: a
 * teleport and a hop aimed at one prop reuse the row, which is the shape the native table has anyway.
 *
 * The rider does NOT arrive on the placement. The runtime steps ~3 m off it before setting the position, so
 * the destination is a marker for a landing spot rather than the spot itself — put it somewhere with clear
 * ground on every side rather than tight against geometry.
 */
export function bindRiderTeleport(document: EffectsDocument, node: EffectNode, placementId: string): void {
  if (node.mainType !== 24) throw new Error(`bindRiderTeleport expects a MainType-24 node, got ${node.mainType}`);
  const existing = document.instances.find(item =>
    (item.extensions?.slopesmith as { placement?: string } | undefined)?.placement === placementId);
  const binding = existing ?? {
    id: nextEffectId(document, 'instance'),
    property: null,
    extensions: { slopesmith: { placement: placementId } },
  };
  if (!existing) document.instances.push(binding);
  node.references = { ...node.references, instance: binding.id };
}

export function graphSlots(document: EffectsDocument, graphId: string): { slot: EffectSlot; circumstance: EffectCircumstance }[] {
  const out: { slot: EffectSlot; circumstance: EffectCircumstance }[] = [];
  for (const slot of document.slots)
    for (const circumstance of Object.keys(slot.circumstances) as EffectCircumstance[])
      if (slot.circumstances[circumstance] === graphId) out.push({ slot, circumstance });
  return out;
}

export function timerEmitterFields(node: EffectNode): Record<string, JsonValue> | null {
  if (node.mainType !== 2 || !object(node.payload.type2)) return null;
  const type2 = node.payload.type2;
  return type2.SubType === 0 && object(type2.type2Sub0) ? type2.type2Sub0 as Record<string, JsonValue> : null;
}

const EMITTER_WORD = new DataView(new ArrayBuffer(4));

const floatFromRawEmitterWord = (value: number): number => {
  EMITTER_WORD.setInt32(0, Math.trunc(value));
  return EMITTER_WORD.getFloat32(0);
};

const rawEmitterWordFromFloat = (value: number): number => {
  EMITTER_WORD.setFloat32(0, Math.fround(value));
  return EMITTER_WORD.getInt32(0);
};

/** Decode the dedicated contact-emitter payload without changing its lossless document representation.
 * Snowknife historically described SubType 2 as 51 integers, but the retail reader sends U2..U48 through the
 * same P6 particle path as a timer emitter and reads those words as IEEE-754 floats. U0/U1 and U49/U50 remain
 * integer count/trail and sprite/blend selectors. */
export function collisionEmitterFields(node: EffectNode): Record<string, JsonValue> | null {
  if (node.mainType !== 2 || !object(node.payload.type2)) return null;
  const type2 = node.payload.type2;
  if (type2.SubType !== 2 || !object(type2.type2Sub2)) return null;
  const raw = type2.type2Sub2 as Record<string, JsonValue>;
  const decoded: Record<string, JsonValue> = {};
  for (let index = 0; index <= 50; index++) {
    const key = `U${index}`;
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (index < 2 || index > 48) decoded[key] = value;
    else decoded[key] = floatFromRawEmitterWord(value);
  }
  return decoded;
}

/** Renderer-facing particle law for both native Type-2 emitter constructors. */
export function particleEmitterFields(node: EffectNode): Record<string, JsonValue> | null {
  return timerEmitterFields(node) ?? collisionEmitterFields(node);
}

/** Write one renderer-facing particle value back through the storage convention of its native subtype. */
export function setParticleEmitterField(node: EffectNode, key: string, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const timer = timerEmitterFields(node);
  if (timer) {
    if (typeof timer[key] !== 'number') return false;
    timer[key] = value;
    return true;
  }
  if (node.mainType !== 2 || !object(node.payload.type2)) return false;
  const type2 = node.payload.type2;
  if (type2.SubType !== 2 || !object(type2.type2Sub2)) return false;
  const match = /^U(\d+)$/.exec(key);
  const index = match ? Number(match[1]) : -1;
  if (index < 0 || index > 50 || typeof type2.type2Sub2[key] !== 'number') return false;
  type2.type2Sub2[key] = index < 2 || index > 48
    ? Math.trunc(value) : rawEmitterWordFromFloat(value);
  return true;
}

/** True when a graph can reach a timer emitter through the graph's mapped function / instance-graph calls.
 * The editor uses this conservative structural check to keep the ambient Effects runtime focused on actual
 * particle graphs: persistent material and AnimObject graphs continue through their dedicated renderers, and
 * cyclic or unusually deep call graphs fail closed instead of growing the frame scheduler without bound. */
export function effectGraphHasTimerEmitter(document: EffectsDocument, graph: EffectGraph,
  maxDepth = 6): boolean {
  const owners = new Map<string, { id: string; nodes: EffectNode[] }>([
    ...document.graphs.map(owner => [owner.id, owner] as const),
    ...document.functions.map(owner => [owner.id, owner] as const),
  ]);
  const visit = (owner: { id: string; nodes: EffectNode[] }, depth: number, path: ReadonlySet<string>): boolean => {
    if (depth > maxDepth || path.has(owner.id)) return false;
    if (owner.nodes.some(node => !!timerEmitterFields(node))) return true;
    const nextPath = new Set(path).add(owner.id);
    for (const node of owner.nodes) {
      const targetId = node.references?.function ?? node.references?.effectGraph;
      const target = targetId ? owners.get(targetId) : null;
      if (target && visit(target, depth + 1, nextPath)) return true;
    }
    return false;
  };
  return visit(graph, 0, new Set());
}

/** SSF raw local centimetres (X/Y/Z-up) ↔ Slopesmith local metres (X/Y-up/Z), including X chirality. */
export const rawEmitterToEditor = (raw: V3): V3 => [-raw[0] / 100, raw[2] / 100, -raw[1] / 100];
export const editorEmitterToRaw = (editor: V3): V3 => [-editor[0] * 100, -editor[2] * 100, editor[1] * 100];

export function emitterLocalRaw(node: EffectNode): V3 | null {
  // A collision emitter's U9-U11 words survive in the file, but the native SubType-2 constructor replaces
  // them with the live contact point. Treating that stored seed as an editable spatial handle is misleading.
  if (node.semanticType === 'particle.collision') return null;
  const fields = particleEmitterFields(node);
  if (!fields) return null;
  const values = [fields.U9, fields.U10, fields.U11];
  return values.every(x => typeof x === 'number' && Number.isFinite(x)) ? values as V3 : null;
}

export function setEmitterLocalRaw(node: EffectNode, raw: V3): boolean {
  if (node.semanticType === 'particle.collision') return false;
  return setParticleEmitterField(node, 'U9', raw[0])
    && setParticleEmitterField(node, 'U10', raw[1])
    && setParticleEmitterField(node, 'U11', raw[2]);
}

export function emitterWorldPosition(node: EffectNode, prop?: PlacedProp): V3 | null {
  const raw = emitterLocalRaw(node);
  if (!raw) return null;
  let local = rawEmitterToEditor(raw);
  if (!prop) return local;
  local = rotateByPlacement([local[0] * prop.scale, local[1] * prop.scale, local[2] * prop.scale], prop);
  return [prop.pos[0] + local[0], prop.pos[1] + local[1], prop.pos[2] + local[2]];
}

/**
 * Rebase support (docs/028): a model absorbed a placement's rotation/scale into its stored frame
 * (`rebaseModelToPlacement`), so every attached timer-emitter's model-local offset takes the same
 * rotation + scale — one pass per graph keeps each emitter seated on the same model feature for every
 * placement at once (their poses all composed with the same inverse).
 */
export function transformModelEmitterFrames(document: EffectsDocument, propIds: Iterable<string>,
  rotation: PropRotation, scale: number): void {
  if (rotation.yaw === 0 && !isTilted(rotation) && scale === 1) return;
  const ids = new Set(propIds);
  const done = new Set<string>();
  for (const attachment of effectAttachments(document)) {
    if (!ids.has(attachment.target.id)) continue;
    const slot = document.slots.find(item => item.id === attachment.slot);
    for (const graphId of slot ? Object.values(slot.circumstances) : []) {
      if (!graphId || done.has(graphId)) continue;
      done.add(graphId);
      const graph = document.graphs.find(item => item.id === graphId);
      for (const node of graph?.nodes ?? []) {
        const raw = emitterLocalRaw(node);
        if (!raw) continue;
        const local = rawEmitterToEditor(raw);
        const framed = rotateByPlacement([scale * local[0], scale * local[1], scale * local[2]], rotation);
        setEmitterLocalRaw(node, editorEmitterToRaw(framed));
      }
    }
  }
}

export function setEmitterWorldPosition(node: EffectNode, world: V3, prop?: PlacedProp): boolean {
  let local: V3 = prop
    ? [world[0] - prop.pos[0], world[1] - prop.pos[1], world[2] - prop.pos[2]]
    : [...world];
  if (prop) {
    local = unrotateByPlacement(local, prop);
    const scale = Math.abs(prop.scale) > 1e-9 ? prop.scale : 1;
    local = [local[0] / scale, local[1] / scale, local[2] / scale];
  }
  return setEmitterLocalRaw(node, editorEmitterToRaw(local));
}

/** The three nodes that end whatever the bound prop is running. Grouped because their placement rules are
 *  identical and one of those rules is a measured console freeze. */
const LIFETIME_COMMAND_TYPES = new Set(['property.node-destroy', 'property.node-pause',
  'property.node-tombstone']);

/**
 * Nodes that lay down without the one thing they point at, and what happens if they ship that way.
 *
 * Each of these is picked rather than defaulted — there is no sensible default destination for a teleport —
 * so the template creates them empty and the author fills them in. The failure is silent in the editor and
 * loud nowhere: an unbound reference either drops the whole effect at export or does nothing on hardware. It
 * is a validator rather than a line of prose in the template for exactly that reason: the warning has to
 * arrive on the prop that has the problem, at the moment it has it.
 */
const REQUIRED_NODE_REFERENCES: readonly {
  semanticType: string; key: string; message: string;
}[] = [
  { semanticType: 'instance.state', key: 'instance',
    message: 'Run on another prop has no target prop, so it does nothing. Choose one under Target prop' },
  { semanticType: 'instance.state', key: 'effectGraph',
    message: 'Run on another prop has no effect to run, so it does nothing. Choose one under Effect to run' },
  { semanticType: 'rider.teleport', key: 'instance',
    message: 'Teleport rider has no destination. The level will not export until one is chosen, because a '
      + 'teleport with a guessed destination would drop the rider anywhere on the mountain' },
  { semanticType: 'spline.toggle', key: 'spline',
    message: 'Rail on / off has no rail. The level will not export until one is chosen' },
  { semanticType: 'function.call', key: 'function',
    message: 'Call shared effect has no shared effect to call. The level will not export until one is chosen' },
];

export function validateEffectsAuthoring(document: EffectsDocument, props: readonly PlacedProp[] = [],
  rails: readonly Rail[] = []): EffectAuthoringIssue[] {
  const out: EffectAuthoringIssue[] = validateEffectsDocument(document)
    .map(issue => ({ ...issue, severity: 'error' as const }));
  const propIds = new Set(props.map(p => p.id).filter((id): id is string => !!id));
  for (const [i, attachment] of effectAttachments(document).entries()) {
    if (!propIds.has(attachment.target.id)) out.push({ severity: 'error', path: `$.extensions.slopesmith.attachments[${i}].target.id`,
      message: `references missing level prop '${attachment.target.id}'` });
    if (!document.slots.some(x => x.id === attachment.slot)) out.push({ severity: 'error', path: `$.extensions.slopesmith.attachments[${i}].slot`,
      message: `references missing slot '${attachment.slot}'` });
  }
  for (const binding of authoredEffectBindings(document, props)) {
    if (binding.circumstance !== 'collision') continue;
    const path = `$level.props[${binding.prop.id ?? '?'}]`;
    const native = binding.prop.nativeCollision;
    if (native) {
      const unavailable = !native.playerCollision
        ? 'PlayerCollision is off'
        : native.mode === 0 ? 'collision mode 0 has no contact shape'
          : native.mode === 3 && !native.physicsSource ? 'collision mode 3 has no sphere-tree donor'
            : null;
      if (unavailable) out.push({ severity: 'warning', path: `${path}.nativeCollision`,
        message: `collision effect cannot fire under the specified collision state: ${unavailable}` });
    }
    // Measured: on a Garibaldi-slot course the node builds and holds the slot in every pass while the rider
    // is never lifted, and the run reads `laps_remaining` 0 throughout — the counter is seeded from the
    // course table, not from anything an author can set (Trailmap/tools/autotest, cell `lap-boost`). A
    // directional boost in an identical box with identical tuning launched the rider every pass, so this is
    // the gate and not a broken node.
    if (binding.graph.nodes.some(node => node.semanticType === 'property.lap-boost'))
      out.push({ severity: 'warning', path: `${path}.effects`,
        message: 'Lap-gated lift only lifts riders who still have a lap to go, and the lap count comes from the course rather than from this node — only the Megaplex course slot has one. Anywhere else it builds normally and lifts nobody. Use a Directional boost unless this level packs into that slot' });
    const roller = binding.graph.nodes.some(node => node.semanticType === 'property.roller');
    if (roller && !native?.physicsSource) out.push({ severity: 'warning', path: `${path}.effects`,
      // Measured, not assumed: on PS2 the node builds and its constructor rewrites the instance's body bits,
      // and the instance's translation then holds one value for the entire run. A built roller and a working
      // one are indistinguishable from the effect slot, which is why this warns rather than trusting that the
      // node appeared (Trailmap/tools/autotest, cell `prop-roller`).
      message: 'This Roller moves in preview and in Unity, but the prop has no physics body for the PS2 build, so in game it will not budge. Give it a collision profile with a physics source' });
  }
  // The latch columns and the dead columns [Trailmap: 150-logic §slot-columns]: slot3/slot4 populated-ness
  // suppresses the engine's default state revert (a non-empty chain then runs INSTEAD of the revert — no
  // retail level authors one), slot4 is only consulted when something on the slot can self-end, and the
  // finished node it keeps alive permanently blocks the slot's own no-live-node gates. Slot6/slot7 have no
  // engine reader at all.
  document.slots.forEach((slot, i) => {
    const path = `$.slots[${i}].circumstances`;
    const graphById = new Map(document.graphs.map(graph => [graph.id, graph]));
    for (const circumstance of EFFECT_LATCH_CIRCUMSTANCES)
      if (slot.circumstances[circumstance] && !effectSlotLatchIsEmptyGraph(document, slot, circumstance))
        out.push({ severity: 'warning', path: `${path}.${circumstance}`,
          message: `nodes in ${effectCircumstanceLabel(circumstance)} run INSTEAD of the prop resetting itself. The original game always leaves this one empty, so anything here is untested ground` });
    if (slot.circumstances.slot4) {
      if (!effectSlotCanSelfEnd(document, slot)) out.push({ severity: 'warning', path: `${path}.slot4`,
        message: 'nothing on this prop can finish on its own — loops never end, and a budgeted clip never reaches its end — so the Effect end setting is never used' });
      const noLiveNodeGate = Object.values(slot.circumstances).some(graphId => {
        const graph = graphId ? graphById.get(graphId) : null;
        return !!graph?.nodes.some(node => node.semanticType === 'condition.no-live-node'
          || (node.mainType === 5 && object(node.payload.type5) && node.payload.type5.U0 === 3));
      });
      if (noLiveNodeGate) out.push({ severity: 'warning', path: `${path}.slot4`,
        message: 'Effect end keeps the finished node alive, so this prop\'s Only if: prop is idle test can never pass again' });
    }
    // The two-stage break is TWO chains on one slot and either half alone is inert
    // [Trailmap: 150-logic §deferred-trigger]. A Cracked surface breaks nothing itself: when its strength
    // runs out it resolves this slot's trigger column and runs whatever is there. With the column empty it
    // resolves -1, the node retires, and the prop is left cracked and standing — which looks from the editor
    // exactly like a breakable that was authored correctly, because every node in it IS correct.
    //
    // Only this direction is checkable. The complement — a trigger column with no installer — cannot be
    // decided from the slot, because a Counter can be installed on the instance by a hop from somebody
    // else's chain, and warning on that would fire on the one shape retail actually ships.
    if (Object.values(slot.circumstances).some(graphId => {
      const graph = graphId ? graphById.get(graphId) : null;
      return !!graph?.nodes.some(node => node.semanticType === 'property.cracked');
    }) && !slot.circumstances.trigger) out.push({ severity: 'warning', path: `${path}.trigger`,
      message: 'a Cracked surface does not break anything itself — it runs this prop\'s Trigger effect when '
        + 'its strength runs out, and the break belongs there. With no Trigger effect the prop cracks and '
        + 'then stands there for the rest of the level' });
    // What may go in a Trigger effect depends on which of its two possible senders fires it, and the two
    // pull in opposite directions [Trailmap: 150-logic §deferred-trigger]. A COUNTER fires its column from
    // inside its own update and is still live while that column runs, so a node that installs on this same
    // instance takes the counter out from under itself — measured on PS2 as a reproducible hang, not a
    // misfire. A CRACKED SURFACE fires its column and then touches nothing, which is why the whole break
    // (sound, kill, reveals) belongs there.
    //
    // So the check is conditioned on the sender rather than on the column: a crack-fired trigger full of
    // property nodes is the shape retail ships, and warning on it would be wrong.
    const triggerGraph = slot.circumstances.trigger ? graphById.get(slot.circumstances.trigger) : null;
    if (triggerGraph) {
      const onSlot = (semanticType: string): boolean => Object.values(slot.circumstances).some(graphId => {
        const graph = graphId ? graphById.get(graphId) : null;
        return !!graph?.nodes.some(node => node.semanticType === semanticType);
      });
      const counterFired = onSlot('property.counter');
      const crackFired = onSlot('property.cracked');
      if (counterFired && !crackFired) {
        const suicidal = triggerGraph.nodes.some(node => LIFETIME_COMMAND_TYPES.has(node.semanticType ?? ''));
        if (suicidal) out.push({ severity: 'error', path: `${path}.trigger`,
          message: 'this Trigger effect is fired by a Counter on the same prop, and it stops whatever that '
            + 'prop is running — which at that moment is the Counter itself, mid-update. Measured on PS2 as a '
            + 'console freeze. Move the stop onto another prop and reach it with Run on another prop' });
        const installs = triggerGraph.nodes.filter(node => node.mainType === 0
          && !LIFETIME_COMMAND_TYPES.has(node.semanticType ?? ''));
        if (installs.length) out.push({ severity: 'warning', path: `${path}.trigger`,
          message: 'a Counter fires this Trigger effect while it is still running, so a node that installs on '
            + 'this same prop displaces it mid-update. Behind a Counter, use Run on another prop and let the '
            + 'other prop\'s effect do the work' });
      }
    }
    for (const circumstance of ['slot6', 'slot7'] as const)
      if (slot.circumstances[circumstance]) out.push({ severity: 'warning', path: `${path}.${circumstance}`,
        message: `nothing in the game ever reads ${effectCircumstanceLabel(circumstance)}, so this effect can never run` });
  });
  for (const [ownerKind, owners] of [['graphs', document.graphs], ['functions', document.functions]] as const) {
    owners.forEach((owner, oi) => owner.nodes.forEach((node, ni) => {
      const path = `$.${ownerKind}[${oi}].nodes[${ni}]`;
      if (node.semanticType === 'property.roller') {
        const type0 = node.payload.type0;
        const roller = typeof type0 === 'object' && type0 !== null && !Array.isArray(type0)
          ? (type0 as Record<string, unknown>).type0Sub0 : null;
        const mass = typeof roller === 'object' && roller !== null && !Array.isArray(roller)
          ? (roller as Record<string, unknown>).U0 : null;
        if (typeof mass !== 'number' || !Number.isFinite(mass) || mass <= 0) out.push({
          severity: 'warning', path: `${path}.payload.type0.type0Sub0.U0`,
          message: 'Roller mass must be a number greater than zero. As it stands, preview and the exported bundle both skip this Roller',
        });
      }
      for (const required of REQUIRED_NODE_REFERENCES) {
        if (node.semanticType !== required.semanticType) continue;
        if (node.references?.[required.key as keyof typeof node.references] == null)
          out.push({ severity: 'error', path: `${path}.references.${required.key}`, message: required.message });
      }
      // Ridden on hardware in Showoff, alone, at half a metre: the effect dispatches and the rider's
      // multiplier never leaves 1.0, while boost pads on the same course in the same passes write their
      // fields normally (Trailmap/tools/autotest, cell `gem-multiplier`). Authoring it is not an error — the
      // record may yet be completed — but shipping a scoring pickup that has never been seen to score is
      // something an author should be told once, on the prop, rather than discovering in a play test.
      if (node.semanticType === 'score.multiplier') out.push({ severity: 'warning', path,
        message: 'Score multiplier has not yet been seen to work on hardware: the effect runs and the rider\'s '
          + 'multiplier never moves. It also only scores in Showoff modes — in Race or Freeride it does '
          + 'nothing at all. Do not build a scoring route around it yet' });
      const emitter = particleEmitterFields(node);
      if (emitter) {
        const emitterPayload = node.semanticType === 'particle.collision' ? 'type2Sub2' : 'type2Sub0';
        const numeric = (key: string) => typeof emitter[key] === 'number' ? emitter[key] as number : NaN;
        if (numeric('U0') < 0) out.push({ severity: 'warning', path: `${path}.payload.type2.${emitterPayload}.U0`, message: 'particle count is negative' });
        if (numeric('U1') < 0 || numeric('U1') > 10) out.push({ severity: 'warning', path: `${path}.payload.type2.${emitterPayload}.U1`, message: 'trail-copy count is outside the usual 0–10 range' });
        if (numeric('U49') < 0) out.push({ severity: 'warning', path: `${path}.payload.type2.${emitterPayload}.U49`, message: 'sprite index is negative' });
      }
    }));
  }
  // A rail toggle and the rail it names are authored in two different toolboxes, and the pairing between them
  // is silent in both directions: the node ships and dispatches either way, and the rail looks identical on
  // the mountain. Only the document knows whether the two agree, which is what puts the rule here rather than
  // in the template's prose [Trailmap: 140-rail-toggle].
  for (const rail of rails) {
    if (isMotionPath(rail)) continue;
    const splineId = authoredSplineId(rail);
    if (!splineId) continue;
    const path = `$level.rails[${rail.id}]`;
    const name = rail.name?.trim() || rail.id;
    const toggles = splineEffectUses(document, splineId).filter(use => use.semanticType === 'spline.toggle');
    if (railStartsOff(rail) && !toggles.some(use => use.switchesOn)) out.push({ severity: 'warning', path,
      message: `rail '${name}' is set to start off, so it ships outside the rail network, and no effect ever `
        + 'switches it on — nobody can grind it. Add a Rail on / off node set to on, or untick "starts off"' });
    if (!railStartsOff(rail) && toggles.some(use => use.switchesOn)) out.push({ severity: 'warning', path,
      message: `a Rail on / off node switches rail '${name}' ON, but it is already grindable from the moment `
        + 'the level loads, so the node changes nothing. Tick "starts off" on the rail to make the switch mean '
        + 'something' });
  }
  return out;
}

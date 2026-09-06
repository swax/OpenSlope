/**
 * Versioned, engine-neutral effects interchange contract. Snowknife owns the SSF adapter; Slopesmith
 * authors this document; Unity consumes the same file. Stable string IDs are identity. Array order is
 * only the requested order when Snowknife compacts the tables back into an SSF.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export type EffectRef = string | null;

export interface EffectsTarget {
  game: string;
  platform: string;
  region: string;
  executable?: string;
  level: string;
}

export interface EffectsSource {
  fileName?: string;
  byteLength?: number;
  sha256?: string;
}

export interface EffectNode {
  id: string;
  originalIndex?: number;
  mainType: number;
  semanticType?: string;
  payload: JsonObject;
  references?: Record<string, EffectRef>;
  extensions?: JsonObject;
}

export interface EffectGraph {
  id: string;
  originalIndex?: number;
  name?: string;
  nodes: EffectNode[];
  extensions?: JsonObject;
}

export interface EffectFunction {
  id: string;
  originalIndex?: number;
  name: string;
  nodes: EffectNode[];
  extensions?: JsonObject;
}

export interface EffectSlot {
  id: string;
  originalIndex?: number;
  name?: string;
  circumstances: {
    persistent: EffectRef;
    collision: EffectRef;
    slot3: EffectRef;
    slot4: EffectRef;
    trigger: EffectRef;
    slot6: EffectRef;
    slot7: EffectRef;
  };
  extensions?: JsonObject;
}

export interface EffectObjectProperty {
  id: string;
  originalIndex?: number;
  data: JsonObject;
  references: {
    effectSlot: EffectRef;
    physics: EffectRef;
    collisionModel: EffectRef;
  };
  extensions?: JsonObject;
}

export interface EffectInstanceBinding {
  id: string;
  originalIndex?: number;
  property: EffectRef;
  extensions?: JsonObject;
}

export interface EffectResource {
  id: string;
  originalIndex?: number;
  name?: string;
  data: JsonObject;
  extensions?: JsonObject;
}

/** The `kind` every Effects document written today carries. */
export const EFFECTS_KIND = 'openslope-effects';
/** The schema id written alongside {@link EFFECTS_KIND}. */
export const EFFECTS_SCHEMA_ID = 'openslope-effects-v1.schema.json';
/**
 * Pre-rename spelling of {@link EFFECTS_KIND}. The v1 contract did not change when the project was
 * renamed to OpenSlope — only the name did — so `Effects.json` extracted before the rename is still a
 * valid document. Reads accept it and normalize; writes only ever emit the current spelling.
 */
const LEGACY_EFFECTS_KIND = 'swx-effects';
const LEGACY_EFFECTS_SCHEMA_ID = 'swx-effects-v1.schema.json';

export interface EffectsDocument {
  $schema?: string;
  kind: 'openslope-effects';
  version: 1;
  target: EffectsTarget;
  source?: EffectsSource;
  header: { U1: number; U2: number; U3: number };
  slots: EffectSlot[];
  graphs: EffectGraph[];
  functions: EffectFunction[];
  objectProperties: EffectObjectProperty[];
  instances: EffectInstanceBinding[];
  physics: EffectResource[];
  collisionModels: EffectResource[];
  splines: EffectResource[];
  extensions?: JsonObject;
}

export interface EffectsValidationIssue {
  path: string;
  message: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isRef = (value: unknown): value is EffectRef => value === null || typeof value === 'string';

/** The vocabulary itself. Exported so the effect-node picker can present ALL of it — what the editor can lay
 *  down, and what it cannot with the reason — rather than only the subset that happens to have a template. */
export const CANONICAL_SEMANTIC_TYPES = new Set([
  'animation.combo-trigger', 'animation.delta-grant', 'audio.play', 'camera.operation',
  'condition.gate', 'condition.human-rider', 'condition.no-live-node', 'condition.random', 'condition.speed',
  'counter.decrement', 'counter.mark', 'function.call', 'function.call-detached', 'hud.message',
  'instance.flag-0x800.clear', 'instance.flag-0x800.set', 'instance.state',
  'material.texture-frame', 'material.uv-offset-v', 'particle.collision', 'particle.timer',
  'property.anim-combo', 'property.anim-delta', 'property.anim-object', 'property.anim-texture-flip',
  'property.boost', 'property.breakable-kill', 'property.counter', 'property.cracked', 'property.crowd-box',
  'property.dead-node', 'property.debounce', 'property.fence', 'property.flag', 'property.lap-boost',
  'property.mesh-animation', 'property.movie', 'property.node-destroy', 'property.node-pause',
  'property.node-tombstone', 'property.node-tombstone-flagged', 'property.particle', 'property.rail',
  'property.random-boost', 'property.roller', 'property.texture-flip', 'property.timer',
  'property.trick-trigger', 'property.tube-end-boost', 'property.uv-scroll',
  'property.uv-scroll-texture-flip', 'property.z-boost', 'rider.boost', 'rider.reset', 'rider.teleport',
  'score.multiplier', 'spline.animation', 'spline.toggle', 'time.bonus', 'trick.boost', 'wait',
]);

const EXTENSION_SEMANTIC_TYPE = /^x-[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const NUMERIC_SEMANTIC_TYPE = /^(?:property|emitter|main)\.-?\d+$|^node\.control\.command--?\d+$/;

/** True for vocabulary defined by openslope-effects-v1, including lossless numeric fallbacks. */
export function isCanonicalEffectSemanticType(value: string): boolean {
  return CANONICAL_SEMANTIC_TYPES.has(value) || NUMERIC_SEMANTIC_TYPE.test(value);
}

const propertySemanticType = (subType: number, deadNodeMode: unknown): string => {
  if (subType === 5) {
    if (deadNodeMode === 0) return 'property.node-destroy';
    if (deadNodeMode === 1) return 'property.node-pause';
    if (deadNodeMode === 2) return 'property.node-tombstone';
    if (deadNodeMode === 3) return 'property.node-tombstone-flagged';
    if (deadNodeMode === 4) return 'property.breakable-kill';
    return 'property.dead-node';
  }
  return new Map<number, string>([
    [0, 'property.roller'], [2, 'property.debounce'], [6, 'property.counter'], [7, 'property.boost'],
    [8, 'property.timer'], [9, 'property.rail'], [10, 'property.uv-scroll'], [11, 'property.texture-flip'],
    [12, 'property.fence'], [13, 'property.flag'], [14, 'property.cracked'], [15, 'property.lap-boost'],
    [16, 'property.random-boost'], [17, 'property.crowd-box'], [18, 'property.z-boost'],
    [19, 'property.uv-scroll-texture-flip'], [20, 'property.mesh-animation'], [21, 'property.trick-trigger'],
    [22, 'property.particle'], [23, 'property.movie'], [24, 'property.tube-end-boost'],
    [256, 'property.anim-object'], [257, 'property.anim-delta'], [258, 'property.anim-combo'],
    [259, 'property.anim-texture-flip'],
  ]).get(subType) ?? `property.${subType}`;
};

/** Canonical meanings compatible with one native node. Context may refine control-message nodes. */
export function compatibleEffectSemanticTypes(node: Pick<EffectNode, 'mainType' | 'payload'>): readonly string[] | null {
  const payload = node.payload;
  if (node.mainType === 0) {
    const type0 = isObject(payload.type0) ? payload.type0 : null;
    return Number.isInteger(type0?.SubType)
      ? [propertySemanticType(type0!.SubType as number, type0!.DeadNodeMode)] : null;
  }
  if (node.mainType === 2) {
    const type2 = isObject(payload.type2) ? payload.type2 : null;
    if (!Number.isInteger(type2?.SubType)) return null;
    const subType = type2!.SubType as number;
    return [subType === 0 ? 'particle.timer' : subType === 1 ? 'spline.animation'
      : subType === 2 ? 'particle.collision' : `emitter.${subType}`];
  }
  if (node.mainType === 3 || node.mainType === 9) {
    const key = node.mainType === 3 ? 'type3' : 'type9';
    const control = isObject(payload[key]) ? payload[key] : null;
    if (!Number.isInteger(control?.U0)) return null;
    const command = control!.U0 as number;
    const meanings = [`node.control.command-${command}`];
    if (command === 1) meanings.push('counter.mark');
    if (command === 2) meanings.push('animation.delta-grant', 'material.texture-frame');
    if (command === 3) meanings.push('animation.combo-trigger', 'counter.decrement');
    if (command === 6) meanings.push('material.uv-offset-v');
    if (command === 7) meanings.push('instance.flag-0x800.clear');
    if (command === 8) meanings.push('instance.flag-0x800.set');
    return meanings;
  }
  if (node.mainType === 5) {
    const type5 = isObject(payload.type5) ? payload.type5 : null;
    if (!Number.isInteger(type5?.U0)) return null;
    return [new Map<number, string>([
      [0, 'condition.speed'], [1, 'condition.random'], [2, 'condition.human-rider'], [3, 'condition.no-live-node'],
    ]).get(type5!.U0 as number) ?? 'condition.gate'];
  }
  return [new Map<number, string>([
    [4, 'wait'], [7, 'instance.state'], [8, 'audio.play'], [12, 'hud.message'], [13, 'rider.reset'],
    [14, 'score.multiplier'], [16, 'time.bonus'], [17, 'rider.boost'], [18, 'trick.boost'],
    [21, 'function.call'], [23, 'camera.operation'], [24, 'rider.teleport'], [25, 'spline.toggle'],
    [26, 'function.call-detached'],
  ]).get(node.mainType) ?? `main.${node.mainType}`];
}

/** Validate structure, unique identities, and every stable cross-table reference. */
export function validateEffectsDocument(value: unknown): EffectsValidationIssue[] {
  const issues: EffectsValidationIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ path, message });
  if (!isObject(value)) return [{ path: '$', message: 'document root must be an object' }];
  if (value.kind !== EFFECTS_KIND && value.kind !== LEGACY_EFFECTS_KIND)
    issue('$.kind', `must be '${EFFECTS_KIND}'`);
  if (value.version !== 1) issue('$.version', 'must be 1');
  if (!isObject(value.target)) issue('$.target', 'must be an object');
  else {
    for (const key of ['game', 'platform', 'region', 'level'])
      if (typeof value.target[key] !== 'string' || value.target[key] === '') issue(`$.target.${key}`, 'must be a non-empty string');
  }
  if (!isObject(value.header)) issue('$.header', 'must be an object');
  else {
    if (!Number.isInteger(value.header.U1)) issue('$.header.U1', 'must be an integer');
    if (!Number.isInteger(value.header.U2)) issue('$.header.U2', 'must be an integer');
    if (typeof value.header.U3 !== 'number' || !Number.isFinite(value.header.U3)) issue('$.header.U3', 'must be a finite number');
  }

  const arrayNames = ['slots', 'graphs', 'functions', 'objectProperties', 'instances', 'physics', 'collisionModels', 'splines'] as const;
  for (const name of arrayNames) if (!Array.isArray(value[name])) issue(`$.${name}`, 'must be an array');
  if (issues.length) return issues;

  const arrays = Object.fromEntries(arrayNames.map(name => [name, value[name] as unknown[]])) as Record<typeof arrayNames[number], unknown[]>;
  const ids: Partial<Record<typeof arrayNames[number], Set<string>>> = {};
  const collect = (name: typeof arrayNames[number]) => {
    const seen = new Set<string>(); ids[name] = seen;
    arrays[name].forEach((item, i) => {
      const path = `$.${name}[${i}]`;
      if (!isObject(item)) { issue(path, 'must be an object'); return; }
      if (typeof item.id !== 'string' || item.id === '') issue(`${path}.id`, 'must be a non-empty string');
      else if (seen.has(item.id)) issue(`${path}.id`, `duplicate id '${item.id}'`);
      else seen.add(item.id);
    });
  };
  for (const name of arrayNames) collect(name);

  const ref = (path: string, raw: unknown, target: typeof arrayNames[number]) => {
    if (!isRef(raw)) { issue(path, 'must be a string ID or null'); return; }
    if (typeof raw === 'string' && !ids[target]!.has(raw)) issue(path, `references missing ${target} id '${raw}'`);
  };

  arrays.slots.forEach((raw, i) => {
    if (!isObject(raw)) return;
    const path = `$.slots[${i}].circumstances`;
    if (!isObject(raw.circumstances)) { issue(path, 'must be an object'); return; }
    for (const key of ['persistent', 'collision', 'slot3', 'slot4', 'trigger', 'slot6', 'slot7'])
      ref(`${path}.${key}`, raw.circumstances[key], 'graphs');
  });

  arrays.objectProperties.forEach((raw, i) => {
    if (!isObject(raw)) return;
    const path = `$.objectProperties[${i}]`;
    if (!isObject(raw.data)) issue(`${path}.data`, 'must be an object');
    if (!isObject(raw.references)) { issue(`${path}.references`, 'must be an object'); return; }
    ref(`${path}.references.effectSlot`, raw.references.effectSlot, 'slots');
    ref(`${path}.references.physics`, raw.references.physics, 'physics');
    ref(`${path}.references.collisionModel`, raw.references.collisionModel, 'collisionModels');
  });

  arrays.instances.forEach((raw, i) => {
    if (isObject(raw)) ref(`$.instances[${i}].property`, raw.property, 'objectProperties');
  });

  const validateOwner = (raw: unknown, path: string, functionOwner: boolean) => {
    if (!isObject(raw)) return;
    if (functionOwner && typeof raw.name !== 'string') issue(`${path}.name`, 'must be a string');
    if (!Array.isArray(raw.nodes)) { issue(`${path}.nodes`, 'must be an array'); return; }
    const nodeIds = new Set<string>();
    raw.nodes.forEach((nodeRaw, ni) => {
      const np = `${path}.nodes[${ni}]`;
      if (!isObject(nodeRaw)) { issue(np, 'must be an object'); return; }
      if (typeof nodeRaw.id !== 'string' || nodeRaw.id === '') issue(`${np}.id`, 'must be a non-empty string');
      else if (nodeIds.has(nodeRaw.id)) issue(`${np}.id`, `duplicate node id '${nodeRaw.id}'`);
      else nodeIds.add(nodeRaw.id);
      if (!Number.isInteger(nodeRaw.mainType)) issue(`${np}.mainType`, 'must be an integer');
      if (!isObject(nodeRaw.payload)) issue(`${np}.payload`, 'must be an object');
      if (nodeRaw.semanticType !== undefined) {
        if (typeof nodeRaw.semanticType !== 'string' || nodeRaw.semanticType === '')
          issue(`${np}.semanticType`, 'must be a non-empty string');
        else if (!isCanonicalEffectSemanticType(nodeRaw.semanticType)
          && !EXTENSION_SEMANTIC_TYPE.test(nodeRaw.semanticType))
          issue(`${np}.semanticType`, `unknown semantic type '${nodeRaw.semanticType}'; use a canonical name or an x- namespace`);
        else if (!EXTENSION_SEMANTIC_TYPE.test(nodeRaw.semanticType)
          && Number.isInteger(nodeRaw.mainType) && isObject(nodeRaw.payload)) {
          const compatible = compatibleEffectSemanticTypes(nodeRaw as unknown as EffectNode);
          if (compatible && !compatible.includes(nodeRaw.semanticType))
            issue(`${np}.semanticType`, `'${nodeRaw.semanticType}' is incompatible with native mainType/payload; expected ${compatible.join(' or ')}`);
        }
      }
      if (nodeRaw.references !== undefined && !isObject(nodeRaw.references)) issue(`${np}.references`, 'must be an object');
      const refs = isObject(nodeRaw.references) ? nodeRaw.references : {};
      const main = nodeRaw.mainType;
      if (main === 7) {
        ref(`${np}.references.instance`, refs.instance, 'instances');
        ref(`${np}.references.effectGraph`, refs.effectGraph, 'graphs');
      } else if (main === 21) ref(`${np}.references.function`, refs.function, 'functions');
      else if (main === 24) ref(`${np}.references.instance`, refs.instance, 'instances');
      else if (main === 25) ref(`${np}.references.spline`, refs.spline, 'splines');
      if (main === 2 && isObject(nodeRaw.payload) && isObject(nodeRaw.payload.type2)
          && nodeRaw.payload.type2.SubType === 1)
        ref(`${np}.references.spline`, refs.spline, 'splines');
    });
  };
  arrays.graphs.forEach((owner, i) => validateOwner(owner, `$.graphs[${i}]`, false));
  arrays.functions.forEach((owner, i) => validateOwner(owner, `$.functions[${i}]`, true));

  for (const name of ['physics', 'collisionModels', 'splines'] as const)
    arrays[name].forEach((raw, i) => { if (isObject(raw) && !isObject(raw.data)) issue(`$.${name}[${i}].data`, 'must be an object'); });
  return issues;
}

/** Parse a file/string or validate an already parsed value. Throws one readable aggregate error. */
export function parseEffectsDocument(input: string | unknown): EffectsDocument {
  let value: unknown;
  try { value = typeof input === 'string' ? JSON.parse(input) : input; }
  catch (error) { throw new Error(`Invalid Effects JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  const issues = validateEffectsDocument(value);
  if (issues.length) throw new Error(`Invalid Effects document:\n${issues.map(i => `  ${i.path}: ${i.message}`).join('\n')}`);
  // Normalize a pre-rename document so callers only ever see the current spelling.
  const document = value as EffectsDocument;
  const kind: string = document.kind;
  if (kind === LEGACY_EFFECTS_KIND) {
    (document as { kind: string }).kind = EFFECTS_KIND;
    if (document.$schema === LEGACY_EFFECTS_SCHEMA_ID) document.$schema = EFFECTS_SCHEMA_ID;
  }
  return document;
}

/** Stable human-readable save form used by Slopesmith downloads and level export. */
export function serializeEffectsDocument(document: EffectsDocument): string {
  parseEffectsDocument(document);
  return JSON.stringify(document, null, 2) + '\n';
}

export function cloneEffectsDocument(document: EffectsDocument): EffectsDocument {
  return parseEffectsDocument(JSON.parse(JSON.stringify(document)));
}

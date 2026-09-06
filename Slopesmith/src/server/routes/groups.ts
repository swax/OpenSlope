import { join } from 'node:path';
import { mapsRoot } from '../workspace-config';
import { mapLimit, readJsonOr, READ_CONCURRENCY } from '../fs-async';
import { mineGroups, type GroupDef, type GroupsPayload, type GroupSourceInstance, type GroupSourceModel } from '../../core/reference/groups';
import { readLevelLightRig } from './levels';
import { modelLocalBox } from './props';
import { safeDataName } from './safe-name';

/**
 * Serve a level's mined GROUP defs (docs/015): assemblies recovered from its own Instances.json (models
 * co-placed at identical origins — hydrant base + lid, sign + stand) and Lights.json (lights at a consistent
 * fixture-local offset — the street lamp's halo spot). The mining itself is pure (core/groups.mineGroups);
 * this reads the files, runs it once per level (the extracted data is static, so the result is cached for
 * the dev-server's lifetime), and orders each def's members leader-first by bounding-box volume so the
 * placement stores / previews the visually dominant model.
 */

/** Keyed by level, holding the in-flight mining rather than its result, so several clients asking for the
 *  same level at once share one pass over Instances.json instead of each running their own. */
const cache = new Map<string, Promise<GroupsPayload>>();

export function readLevelGroups(level: string): Promise<GroupsPayload> {
  const lvl = safeDataName(level);
  let pending = cache.get(lvl);
  if (!pending) {
    pending = mineLevelGroups(lvl);
    cache.set(lvl, pending);
    // A failed read must not be cached as the permanent answer for this level.
    void pending.catch(() => { if (cache.get(lvl) === pending) cache.delete(lvl); });
  }
  return pending;
}

async function mineLevelGroups(lvl: string): Promise<GroupsPayload> {
  const dir = join(mapsRoot(), lvl);
  const [modelsJson, instJson] = await Promise.all([
    readJsonOr<{ Models: { ModelName: string }[] } | null>(join(dir, 'Models.json'), null),
    readJsonOr<{
      Instances: { ModelID: number; Location: number[]; Rotation: number[]; Scale: number[]; Visable?: boolean }[];
    } | null>(join(dir, 'Instances.json'), null),
  ]);
  if (!modelsJson || !instJson) return { level: lvl, groups: [] };

  const models: GroupSourceModel[] = modelsJson.Models.map((m, id) => ({ id, name: m.ModelName }));
  const instances: GroupSourceInstance[] = instJson.Instances
    .filter(i => i.ModelID >= 0 && i.Visable !== false)
    .map(i => ({ model: i.ModelID, loc: i.Location, rot: i.Rotation, scale: i.Scale }));

  const rig = await readLevelLightRig(lvl);
  const groups = mineGroups(lvl, models, instances, rig?.lights ?? []);

  // leader-first: the largest member is the model a placement stores, previews and seats by. Volumes are
  // resolved up front for every model that needs ordering, so the comparator stays a pure synchronous sort.
  const needed = [...new Set(groups.filter(g => g.props.length > 1).flatMap(g => g.props.map(p => p.model)))];
  const volumes = new Map(await mapLimit(needed, READ_CONCURRENCY, async model => {
    const b = await modelLocalBox(lvl, model);
    const volume = b ? (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]) : 0;
    return [model, volume] as const;
  }));
  for (const g of groups) {
    if (g.props.length > 1) g.props.sort((a, b) => (volumes.get(b.model) ?? 0) - (volumes.get(a.model) ?? 0));
  }

  return { level: lvl, groups };
}

/** Resolve a set of group refs ("<level>:<id>") to their defs — the export's lookup (mining cached). */
export async function groupDefIndex(levels: Iterable<string>): Promise<Map<string, GroupDef>> {
  const idx = new Map<string, GroupDef>();
  const payloads = await Promise.all([...levels].map(level => readLevelGroups(level)));
  for (const payload of payloads) {
    for (const g of payload.groups) idx.set(`${g.level}:${g.id}`, g);
  }
  return idx;
}

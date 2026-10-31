import { joinMapPath as join, mapLimit, READ_CONCURRENCY, type MapDataSource } from './map-data';
import {
  mineGroups,
  type GroupsPayload,
  type GroupSourceInstance,
  type GroupSourceModel,
} from '../core/reference/groups';
import { readLevelLightRig } from './map-levels';
import { modelLocalBox } from './map-props';

/** Mine assemblies from the selected map's own files, for both server and browser-local libraries. */
export async function readLevelGroups(io: MapDataSource, lvl: string): Promise<GroupsPayload> {
  const dir = join(io.root, lvl);
  const [modelsJson, instJson] = await Promise.all([
    io.readJsonOr<{ Models: { ModelName: string }[] } | null>(join(dir, 'Models.json'), null),
    io.readJsonOr<{
      Instances: { ModelID: number; Location: number[]; Rotation: number[]; Scale: number[]; Visable?: boolean }[];
    } | null>(join(dir, 'Instances.json'), null),
  ]);
  if (!modelsJson || !instJson) return { level: lvl, groups: [] };

  const models: GroupSourceModel[] = modelsJson.Models.map((m, id) => ({ id, name: m.ModelName }));
  const instances: GroupSourceInstance[] = instJson.Instances.filter(i => i.ModelID >= 0 && i.Visable !== false).map(
    i => ({ model: i.ModelID, loc: i.Location, rot: i.Rotation, scale: i.Scale }),
  );

  const rig = await readLevelLightRig(io, lvl);
  const groups = mineGroups(lvl, models, instances, rig?.lights ?? []);

  // leader-first: the largest member is the model a placement stores, previews and seats by. Volumes are
  // resolved up front for every model that needs ordering, so the comparator stays a pure synchronous sort.
  const needed = [...new Set(groups.filter(g => g.props.length > 1).flatMap(g => g.props.map(p => p.model)))];
  const volumes = new Map(
    await mapLimit(needed, READ_CONCURRENCY, async model => {
      const b = await modelLocalBox(io, lvl, model);
      const volume = b ? (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]) : 0;
      return [model, volume] as const;
    }),
  );
  for (const g of groups) {
    if (g.props.length > 1) g.props.sort((a, b) => (volumes.get(b.model) ?? 0) - (volumes.get(a.model) ?? 0));
  }

  return { level: lvl, groups };
}

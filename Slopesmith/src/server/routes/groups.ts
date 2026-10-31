import { serverMapName } from '../../core/reference/map-source';
import { mapsRoot } from '../workspace-config';
import * as fs from '../fs-async';
import { readLevelGroups as mineLevelGroups } from '../../shared/map-groups';
import type { GroupDef, GroupsPayload } from '../../core/reference/groups';
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
  const lvl = safeDataName(serverMapName(level));
  let pending = cache.get(lvl);
  if (!pending) {
    pending = mineLevelGroups({ root: mapsRoot(), ...fs }, lvl);
    cache.set(lvl, pending);
    // A failed read must not be cached as the permanent answer for this level.
    void pending.catch(() => {
      if (cache.get(lvl) === pending) cache.delete(lvl);
    });
  }
  return level === lvl
    ? pending
    : pending.then(payload => ({
        ...payload,
        level,
        groups: payload.groups.map(group => ({ ...group, level })),
      }));
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

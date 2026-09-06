import type { EditDoc } from '../../core/doc/doc-edit';
import { computePreflight, type Preflight, type PreflightProps } from '../../core/export/preflight';
import { IMPORTED_PROP_LEVEL } from '../../core/props/imported';
import { AUTHORED_MODEL_LEVEL, authoredModelFrames, authoredModelLevelProps, modelNumber } from '../../core/doc/models';
import { isEffectTriggerProp } from '../../core/effects/trigger-volume';
import { expandGroupProps, type GroupDef } from '../../core/reference/groups';
import type { PlacedProp } from '../../core/doc/types';
import { listImportedProps } from './imported-props';
import { groupDefIndex } from './groups';
import { readMaterialTables, readModelGeometries } from './props';
import { readSkyRing, resolveSkyRingLevel } from './skybox';

/**
 * Summarise what a document ships (docs/011): its painted tiles, its cells, the props and imported models it
 * places, and the sky it carries. The classifier itself is pure; this route adds the parts that live on
 * disk — model geometry, the source levels' material tables, and the imported-model records.
 *
 * There is nothing target-relative here. What a disc does with these pages — which slot each one lands in,
 * what is reused, appended or encoded, and what it costs in VRAM — is `snowknife repack --dry-run`, run by
 * the thing that installs the pages rather than modelled a second time in TypeScript.
 */
export async function preflightFor(doc: EditDoc): Promise<Preflight> {
  let ring;
  if (doc.skybox?.source.kind === 'custom') {
    try { ring = await readSkyRing(await resolveSkyRingLevel(doc.skybox.ring ?? '')); }
    catch { /* export reports the missing ring; preflight keeps a zero-sized estimate */ }
  }
  return withPlacedProps(doc, await withImportedModels(doc, computePreflight(doc, ring)));
}

/**
 * Attach the imported-model summary (docs/032): two generated props are otherwise invisible in a tile list,
 * because their geometry — which bakes once per placement — is not a painted cell at all. The classifier
 * stays pure: the record store lives on disk, so the server attaches this after the fact.
 */
async function withImportedModels(doc: EditDoc, pf: Preflight): Promise<Preflight> {
  const placed = new Map<number, number>();
  for (const p of doc.props ?? []) {
    if (p.level === IMPORTED_PROP_LEVEL) placed.set(p.model, (placed.get(p.model) ?? 0) + 1);
  }
  if (!placed.size) return pf;
  const models: NonNullable<Preflight['importedModels']> = [];
  for (const { record } of await listImportedProps()) {
    const placements = placed.get(record.id);
    if (!placements) continue;
    placed.delete(record.id);
    models.push({
      name: record.name,
      placements,
      tris: record.tris,
      pages: record.materials.flatMap(m => (m.tex ? [m.tex] : [])),
    });
  }
  // a placement whose record was deleted — the bake warns rather than dropping it, and so does this
  for (const [id, placements] of placed) {
    models.push({ name: `model #${id}`, placements, tris: 0, pages: [], missing: true });
  }
  return { ...pf, importedModels: models };
}

/** One model's price, whatever it was borrowed, authored or imported from. */
interface PricedModel { name: string; tris: number; pages: string[] }

/**
 * Price every placement the doc carries: how much geometry the level has to hold, how much the Unity bundle
 * bakes, and which texture pages the props drag into the bank. Pages are the ceiling that actually runs out,
 * and a prop wearing three tiles spends three of them however many times it is placed, so this counts models
 * rather than only placements.
 *
 * It prices what the EXPORT writes, not what the doc literally lists: trigger volumes carry no geometry and a
 * group placement bakes as its member models, so both go through the same treatment `core/export/folder.ts`
 * gives them before it writes a vertex. Getting that wrong here would under-report exactly the assemblies an
 * author places most casually.
 */
async function withPlacedProps(doc: EditDoc, pf: Preflight): Promise<Preflight> {
  const placements = (doc.props ?? []).filter(p => !isEffectTriggerProp(p));
  if (!placements.length) return pf;

  const groupLevels = new Set(placements.flatMap(p => (p.group ? [p.level] : [])));
  const defs: ReadonlyMap<string, GroupDef> = groupLevels.size
    ? await groupDefIndex(groupLevels) : new Map();
  const expanded: PlacedProp[] = placements.flatMap(pp => {
    const def = pp.group ? defs.get(`${pp.level}:${pp.group}`) : undefined;
    return def ? expandGroupProps(pp, def) : [pp];
  });

  const counts = new Map<string, { level: string; model: number; count: number }>();
  for (const prop of expanded) {
    const key = `${prop.level}/${prop.model}`;
    const found = counts.get(key);
    if (found) found.count++;
    else counts.set(key, { level: prop.level, model: prop.model, count: 1 });
  }

  const priced = await priceModels(doc, counts);

  const rows: PreflightProps['rows'] = [];
  const pages = new Set<string>();
  const missing: string[] = [];
  let geomTris = 0, bakedTris = 0;
  for (const [key, { level, count }] of counts) {
    const model = priced.get(key);
    if (!model) { missing.push(`${key} × ${count}`); continue; }
    geomTris += model.tris;
    bakedTris += model.tris * count;
    for (const page of model.pages) pages.add(page);
    rows.push({ source: level, name: model.name, placements: count, tris: model.tris, pages: model.pages.length });
  }
  rows.sort((a, b) => b.tris * b.placements - a.tris * a.placements);

  return {
    ...pf,
    props: {
      placements: expanded.length,
      models: rows.length,
      geomTris,
      bakedTris,
      pages: [...pages].sort(),
      rows,
      missing,
    },
  };
}

/** Resolve each placed `<level>/<model>` to its triangles and its pages, from whichever store owns it. */
async function priceModels(doc: EditDoc, counts: Map<string, { level: string; model: number }>):
Promise<Map<string, PricedModel>> {
  const out = new Map<string, PricedModel>();

  // borrowed models: geometry off the source level's meshes, pages out of its material table
  const wanted = new Map<string, Set<number>>();
  for (const { level, model } of counts.values()) {
    if (level === IMPORTED_PROP_LEVEL || level === AUTHORED_MODEL_LEVEL) continue;
    const found = wanted.get(level) ?? new Set<number>();
    found.add(model);
    wanted.set(level, found);
  }
  if (wanted.size) {
    const materials = await readMaterialTables();
    for (const [level, ids] of wanted) {
      const geometries = await readModelGeometries(level, ids);
      const table = materials.get(level) ?? [];
      for (const [id, geom] of geometries) {
        const pages = new Set<string>();
        let tris = 0;
        for (const sub of geom.subs) {
          tris += sub.indices.length / 3;
          const material = table[sub.mat];
          if (!material) continue;
          // A flipbook indexes the bank per frame, so every frame is its own slot
          // (Snowknife/docs/repack-technical-reference.md).
          for (const page of [material.TexturePath, ...(material.TextureFlipbook ?? [])]) {
            if (page) pages.add(`${level}/${page}`);
          }
        }
        out.set(`${level}/${id}`, { name: geom.name, tris, pages: [...pages] });
      }
    }
  }

  // the author's own polygon cages: geometry and tile are both on the document
  if ([...counts.values()].some(c => c.level === AUTHORED_MODEL_LEVEL)) {
    const authored = authoredModelLevelProps(doc);
    for (const model of doc.models ?? []) {
      const id = modelNumber(model.id);
      const geom = authored.models.find(m => m.id === id);
      if (!geom) continue;
      const frames = authoredModelFrames(model);
      const pages = new Set<string>(frames.length ? frames : (model.texture ? [model.texture] : []));
      out.set(`${AUTHORED_MODEL_LEVEL}/${id}`, {
        name: model.name,
        tris: geom.subs.reduce((n, sub) => n + sub.indices.length / 3, 0),
        pages: [...pages],
      });
    }
  }

  // imported GLBs: the record already carries both
  if ([...counts.values()].some(c => c.level === IMPORTED_PROP_LEVEL)) {
    for (const { record } of await listImportedProps()) {
      out.set(`${IMPORTED_PROP_LEVEL}/${record.id}`, {
        name: record.name,
        tris: record.tris,
        pages: [...new Set(record.materials.flatMap(m => (m.tex ? [m.tex] : [])))],
      });
    }
  }

  return out;
}

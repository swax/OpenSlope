/**
 * Export a workspace project to the Maps library, headless.
 *
 *   npx tsx scripts/export-project.ts MY_PROJECT
 *   npx tsx scripts/export-project.ts MY_PROJECT --no-lighting     # skip the lightmap bake
 *
 * This is the join between the two halves of a from-scratch course's build loop. A recipe writes a workspace
 * PROJECT — the editable document, held in the workspace store — and every offline harness that answers a
 * question about how the course RIDES reads a level FOLDER out of `mapsRoot()`: `ai-course-run.ts` wants
 * Patches.json, AIP.json, Props.json, Effects.json and Splines.json, and `snowknife` wants the same folder to
 * bake an ISO from. Without this step the two never meet, and a course can be rebuilt all day without the
 * thing that races it ever seeing the change.
 *
 * The bake is the slow part and it is on by default, because the lightmap is what an authored light rig
 * actually produces — an export with `--no-lighting` is the right thing to race and the wrong thing to look at.
 */
import { exportLevel } from '../src/server/routes/export';
import { listProjects, openProject } from '../src/server/projects';
import { migrateLegacyProjectAssets, withProjectAssets } from '../src/server/project-assets';
import type { EditDoc } from '../src/core/doc/doc-edit';
import type { QuadMeshDoc } from '../src/core/doc/types';

const args = process.argv.slice(2);
const NAME = (args.find(a => !a.startsWith('--')) ?? '').toUpperCase();
const LIGHTING = !args.includes('--no-lighting');
const AI_PATHS = !args.includes('--no-ai-paths');

if (!NAME) {
  const known = (await listProjects()).map(p => p.name).sort();
  console.log('usage: npx tsx scripts/export-project.ts <PROJECT> [--no-lighting] [--no-ai-paths]');
  console.log(`  workspace projects: ${known.join(', ') || '(none)'}`);
  process.exit(1);
}

const manifest = (await listProjects()).find(project => project.name.toUpperCase() === NAME);
if (!manifest) throw new Error(`no workspace project named "${NAME}"`);

const snapshot = await openProject(manifest.id);
await migrateLegacyProjectAssets(snapshot);
const doc = snapshot.document as QuadMeshDoc;
const started = Date.now();

console.log(`${manifest.name} revision ${snapshot.project.revision}: `
  + `${doc.quads.length} patches, ${(doc.props ?? []).length} props, ${(doc.lights ?? []).length} lights, `
  + `${(doc.rails ?? []).length} rails, ${(doc.gems ?? []).length} gems`);

const { dir, log } = await withProjectAssets(snapshot,
  () => exportLevel(doc as unknown as EditDoc, { lighting: LIGHTING, aiPaths: AI_PATHS }));
console.log(log);
console.log(`\n  exported to ${dir} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(`  race it: npx tsx scripts/ai-course-run.ts ${manifest.name} 260`);

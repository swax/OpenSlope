import { textFile, type ExportFile } from './files';

/** The disc recipe written beside the map. */
export const DISC_NOTES = 'Repack.md';
export const DISC_MANIFEST = 'repack-many.json';
/** The course slot the recipe is written for. Snowknife can replace any retail slot, but menu availability
 *  still follows the player's mode and progress; naming one concretely makes the commands runnable. */
export const DISC_SLOT = 'GARI';

/** Where the recipe's commands point, as the machine that runs `snowknife` addresses them. Manifest and
 *  command lines take POSIX separators, which Windows accepts too. */
export interface DiscRecipePaths {
  /** This export folder. */
  exportDir: string;
  /** The slot's extracted level-data folder. */
  levelData: string;
  /** The same folder relative to this export — the form the manifest stores, since its paths resolve from
   *  the manifest's own directory. */
  levelDataRelative: string;
}

/** Quote only when a path needs it, so the common case pastes clean. */
const arg = (value: string) => (/\s/.test(value) ? `"${value}"` : value);

/**
 * What to run on this folder, written into it: the exact `snowknife` invocations, and a `repack-many` manifest
 * that already names this export.
 *
 * Slopesmith writes the map folder and stops. `snowknife` holds everything past that — the glTF bake Unity
 * consumes, and the target's slot table, allocator and encoder — so the folder is target-agnostic and every
 * step beyond it is a command. That makes the arguments the thing most easily lost, so they ship with the map:
 * `gltf` bakes the bundle source, `texture-plan` answers how the pages resolve with no disc at all,
 * `repack --dry-run` reports the whole allocation against a real image without writing one, and the
 * manifest is the same build in `repack-many`'s own schema — add entries to put several courses in one image.
 */
export function discRecipeFiles(name: string, paths: DiscRecipePaths): { files: ExportFile[]; log: string[] } {
  const inputIso = 'ssx-tricky.iso';
  const outputIso = `ssx-tricky-${name.toLowerCase()}.iso`;
  const manifest = JSON.stringify({
    InputIso: inputIso,
    OutputIso: outputIso,
    Levels: [{ Slot: DISC_SLOT, LevelData: paths.levelDataRelative, Export: '.' }],
    // Retail-shaped indexed pages keep a prop-heavy export under the measured GS-VRAM ceiling. Type 5 is
    // lossless but costs four times as much and corrupts later custom pages once their aggregate gets large.
    TextureType2: true,
    // The slot's own props ride along otherwise: not drawn once a prop build delists them, but still
    // sounding their emitters over the author's own and still holding their course-bank slots.
    BareSlot: true,
    // The public recipe keeps the supplied executable byte-identical. Sky colour and developer inspection
    // patches remain explicit, local choices rather than properties of every generated build.
    SkyColors: false,
  }, null, 2) + '\n';

  const here = paths.exportDir;
  const repack = ['repack', arg(inputIso), DISC_SLOT, arg(paths.levelData), arg(here), arg(outputIso)];
  const notes = [
    `# Building from ${name}`,
    '',
    '## Bake it for Unity',
    '',
    '```',
    `snowknife gltf ${arg(here)} ${name.toLowerCase()}`,
    '```',
    '',
    'Writes `gltf/` inside this folder — the terrain, props and collision meshes `snowknife unity` builds a',
    'bundle from.',
    '',
    '## Building a disc',
    '',
    'This folder is target-agnostic: every texture ships flattened and verbatim, and `Slopesmith.json` records',
    'the level each page came from. `snowknife` reads that and decides, page by page, whether to reuse the',
    "target slot's own SSH entry, install a donor level's page verbatim, or encode a custom one.",
    '',
    `Everything below rides as **${DISC_SLOT}**. Snowknife can replace any retail course slot: change the`,
    "slot name and point the level-data argument at that slot's extracted folder. Course selection still",
    "follows the retail game's mode and the current memory-card progress, so verify the chosen slot from a",
    'clean save before publishing it as the default route.',
    '',
    '## How the pages resolve — no disc needed',
    '',
    '```',
    `snowknife texture-plan ${arg(here)} ${DISC_SLOT}`,
    '```',
    '',
    '## The whole allocation plan, against a real image, writing nothing',
    '',
    '```',
    `snowknife ${repack.join(' ')} --texture-type2 --bare-slot --no-skycolor --dry-run`,
    '```',
    '',
    'Slots retained and reusable, pages installed in allocation order (reuse or append), bytes, the custom-page',
    'VRAM total, path/placement, and anything that will be dropped. `--json` emits the same plan as a record.',
    '',
    '## Build it',
    '',
    '```',
    `snowknife ${repack.join(' ')} --texture-type2 --bare-slot --no-skycolor`,
    '```',
    '',
    'This default command selects no executable feature and passes `--no-skycolor`, so Snowknife leaves the',
    'supplied boot executable byte-for-byte unchanged. The course data is replaced in the new image; the clean',
    'source image is read only.',
    '',
    'The recipe uses retail-shaped type-2 pages so a prop-heavy build stays inside the measured GS-VRAM',
    'budget. Remove `--texture-type2` (or set `TextureType2` false in the manifest) only when the dry-run',
    'shows the lossless 32-bit type-5 aggregate is inside that budget.',
    '',
    'It also passes `--bare-slot` (`BareSlot` in the manifest), because your course replaces the slot\'s',
    "terrain but inherits the retail course's whole prop population, still standing where that course left",
    'them. A prop build delists those props so they neither draw nor collide, but a placed emitter is dispatched',
    "from the level's sound data rather than the world grid — so without the flag the donor's crowd and",
    'birdsong play over your own emitters, and the bank slots those props hold stay unavailable to your clips.',
    'Drop it only when you mean to keep the retail scenery.',
    '',
    'Custom prop sounds are re-encoded at the rate the target course bank is played at, whatever rate you',
    'authored them in. That is not a size decision but a pitch one: the engine ignores a sound\'s own rate tag',
    'and plays the slot at the bank\'s, so a clip left at 48 kHz would come out slow and flat. The build says',
    'which rate it picked.',
    '',
    'It is still worth knowing what a clip costs, because the bank is uploaded whole and must not outgrow the',
    'one it replaces: cost is proportional to rate times length, and no retail course-bank sound exceeds',
    '22 kHz or reaches three seconds. `--sound-rate` (or `SoundRate` in the manifest) overrides the rate for',
    'every clip, up or down — reach for it only to buy bytes on a build that is over budget, since anything',
    "but the bank's own rate plays sharp.",
    '',
    '## Starting the course on a clean save',
    '',
    'Replacing a course does not change whether the retail menu exposes that slot. Prefer a slot already',
    'available in the mode and profile your players will use, and test it with an empty memory card.',
    '',
    'For a locked slot, the player can use the retail game\'s built-in course-access cheat, entered at the title',
    'screen; the code is widely published and is not repeated here. The setting lasts for the current run and may',
    'need to be entered again after restarting. It uses a feature already present in the game; Snowknife does not',
    'rewrite progression or provide a memory-card save.',
    '',
    '## Optional local course inspection',
    '',
    'Noclip is not required to build or select the course. For local geometry and collision inspection only,',
    'append `--patches noclip` to the build command. This explicitly modifies the output image\'s executable;',
    'keep it off normal release-candidate builds.',
    '',
    '## Several courses in one image',
    '',
    `\`${DISC_MANIFEST}\` beside this file is the same build as a manifest — add a \`Levels\` entry per course:`,
    '',
    '```',
    `snowknife repack-many ${arg(`${here}/${DISC_MANIFEST}`)} --dry-run`,
    `snowknife repack-many ${arg(`${here}/${DISC_MANIFEST}`)}`,
    '```',
    '',
    `Its paths resolve from this folder, so \`${inputIso}\` is your own SSX Tricky dump dropped in beside it (or`,
    'any path you point it at) and the built image lands here too.',
    '',
  ].join('\n');

  return {
    files: [textFile(DISC_MANIFEST, manifest), textFile(DISC_NOTES, notes)],
    log: [`wrote ${DISC_NOTES} + ${DISC_MANIFEST} (the glTF bake + the disc step, riding as ${DISC_SLOT} — edit the slot)`],
  };
}

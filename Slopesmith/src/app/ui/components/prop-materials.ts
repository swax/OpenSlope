import type GUI from 'lil-gui';
import { detail, flipbookPreview, texturePreview, tip } from './gui';
import { toast } from './toast';
import { IMPORTED_PROP_LEVEL } from '../../../core/props/imported';
import { AUTHORED_MODEL_LEVEL } from '../../../core/doc/models';
import { CUSTOM_TEX_LEVEL, makeTexRef, parseTexRef, resolvePropTex, type TexRef } from '../../../core/paint/textures';
import { propModelMaterials, type LevelProps, type PropModelMaterialUse } from '../../../core/reference/props';
import type { TextureLibrary } from '../../paint/library';
import { postJson } from '../../net/fetch-json';
import { textureUrl } from '../../net/asset-paths';

/**
 * The Materials block of the prop inspector: what each material a placement's model draws with is made of,
 * and — where the model is ours — the controls to change it.
 *
 * A material belongs to the MODEL, not the placement. The native table is level-wide and a mesh indexes into
 * it, so retexturing changes every placement of that model at once; the panel says so rather than letting an
 * author discover it by moving one prop and watching the rest follow. That is also why editing stops at
 * reference models: their materials come from an extracted level's `Materials.json`, which Slopesmith reads
 * and never authors.
 */

/** Models whose material table Slopesmith owns and may therefore rewrite. */
export function propMaterialsEditable(level: string): boolean {
  return level === IMPORTED_PROP_LEVEL || level === AUTHORED_MODEL_LEVEL;
}

const fileOf = (ref: string | null): string => (ref ? parseTexRef(ref).name || ref : '(untextured)');

/** A bank, as a person should hear it named. "Custom" is the fixed word for the open mountain's OWN tiles —
 *  it addresses that mountain's `assets/textures` and is shared with nothing — so saying it back to the
 *  author reads like a folder somebody else can reach into. Reserve the literal for banks that really are
 *  somebody else's. */
const bankName = (level: string): string =>
  level.toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase() ? 'this mountain’s own tiles' : level;

/** The look a material renders with, in the terms the texture inspector already uses. */
function appearanceOf(use: PropModelMaterialUse): string {
  const parts = [use.material?.alphaMode
    ? `${use.material.alphaMode} (explicit)`
    : use.material?.blend ? 'alpha pass' : 'opaque'];
  if (use.material?.prio) parts.push('draw priority');
  if (use.material?.scroll) parts.push('declared scroll');
  return parts.join(' · ');
}

export interface PropMaterialsHost {
  library: TextureLibrary;
  propLevels: Map<string, LevelProps>;
  /** Refetch the imported catalogue and re-render placements against it. */
  reloadImportedProps: () => Promise<unknown>;
  rebuildTools: () => void;
  /** Change an AUTHORED model's single uniform tile (`AuthoredModel.texture`). */
  setAuthoredModelTexture: (modelId: number, ref: string) => void;
  /** Change an AUTHORED model's flipbook state list (`AuthoredModel.frames`). */
  setAuthoredModelFrames: (modelId: number, frames: readonly string[]) => void;
}

/**
 * Fill a Materials section for one placement's model.
 *
 * Read-only rows for every model; the pick/flipbook controls appear only for a model whose table we own.
 * Frames are ordinary bank tiles — they are already in the Texture Library and paintable — so adding one is
 * the ordinary texture pick rather than a private browser.
 */
export function addPropMaterials(section: GUI, host: PropMaterialsHost,
  level: string, model: number, placements: number): void {
  const props = host.propLevels.get(level);
  const record = props?.models.find(entry => entry.id === model);
  if (!props || !record) {
    tip(detail(section, 'model geometry still loading', 'materials'),
      'The placement’s source level has not finished loading, so its material table is not resolved yet.');
    return;
  }
  const uses = propModelMaterials(props, record);
  if (!uses.length) {
    tip(detail(section, 'none — this model draws no textured surface', 'materials'),
      'A surfaceless model (an effect host or a collision-only proxy) indexes no material at all.');
    return;
  }
  const editable = propMaterialsEditable(level);
  if (placements > 1)
    tip(detail(section, `shared by ${placements} placements of this model`, 'scope'),
      'Editing here changes every placement of this model, not just the selected one.',
      'A material belongs to the model, exactly as it does natively — a mesh indexes a level-wide table.');

  for (const use of uses) {
    const label = uses.length > 1 ? `material ${use.mat}` : 'material';
    const tex = use.material?.tex ?? null;
    // A material's tile may be a bare file in its own level's bank or a cross-level ref; its FRAMES are
    // always bare names in whichever bank the tile resolved to, which is what the renderer assumes too.
    const tile = resolvePropTex(level, tex);
    const frames = use.material?.frames ?? [];
    const frameRef = (name: string) => makeTexRef(tile.level, name);
    const urlOf = (name: string | null) => (name ? textureUrl(tile.level, name) : null);

    // Both editable model kinds present the same controls; only where the edit LANDS differs. An imported
    // model owns a material table in the prop catalogue and is patched over HTTP; an authored one carries a
    // tile and a state list on its own document record, and goes through history like every other doc edit.
    const authored = level === AUTHORED_MODEL_LEVEL;
    const patch = async (next: { tex: string | null; frames: string[] }) => {
      if (authored) {
        host.setAuthoredModelTexture(model, next.tex ?? '');
        host.setAuthoredModelFrames(model, next.frames);
        host.rebuildTools();
        return;
      }
      try {
        await postJson(`/api/custom-prop-materials?id=${model}`,
          JSON.stringify([{ id: use.mat, tex: next.tex, frames: next.frames }]));
        await host.reloadImportedProps();
        host.rebuildTools();
      } catch (e) {
        toast(`Material change failed — ${e instanceof Error ? e.message : String(e)}`, 'err', 6000);
      }
    };

    const pickTexture = () => host.library.openPick({
      title: `Choose a texture — ${record.name}${authored ? '' : ` ${label}`}`,
      current: tex as TexRef | null,
      // Frame 0 IS the material's tile, so re-picking it re-heads the state list rather than leaving a
      // flipbook whose first frame is no longer what the surface rests on.
      onPick: ref => void patch({ tex: ref ?? null,
        frames: frames.length > 1 ? [ref ?? '', ...frames.slice(1).map(frameRef)] : [] }),
    });

    texturePreview(section, {
      label,
      src: urlOf(tile.name),
      value: fileOf(tex),
      hint: `Drawn over ${use.subs} submesh(es) / ${use.triangles} triangle(s) · ${appearanceOf(use)}.`
        + (editable ? '\nClick to choose this material’s resting tile off the art.' : ''),
      ...(editable ? { onOpen: pickTexture } : {}),
    });
    tip(detail(section, appearanceOf(use), 'appearance'),
      'Opaque or the game’s alpha pass, plus draw order and any declared UV scroll.',
      'Alpha is the source material’s bit-18 flag; draw priority is the bit-17 draw-order tiebreaker.');

    // A state list needs a tile to be headed by; an untextured material has nothing to make states of.
    const editFrames = editable && !!tex;
    const replaceFrame = (index: number) => host.library.openPick({
      title: `Replace frame ${index} — ${record.name} ${label}`,
      current: frameRef(frames[index]) as TexRef,
      onPick: ref => {
        if (!ref) return;
        // Frames resolve against the bank the material's own tile names, so one from elsewhere would
        // render as a missing texture rather than as the art that was picked.
        if (parseTexRef(ref).level !== tile.level) {
          toast(`A frame has to live in the same bank as the material’s tile (${bankName(tile.level)}).`, 'err', 6000);
          return;
        }
        const next = frames.map(frameRef);
        next[index] = ref;
        void patch({ tex, frames: next });
      },
    });

    if (frames.length > 1)
      flipbookPreview(section, {
        label: 'flipbook',
        frames: frames.map(name => ({ src: urlOf(name), value: name })),
        hint: 'One state of this material. An effect attached to the placement — not the material — plays '
          + 'the list.',
        ...(editFrames ? { onFrame: replaceFrame } : {}),
      });
    else if (editFrames)
      tip(detail(section, 'none — a single still image', 'flipbook'),
        'Add a second frame to make it switchable, then attach an effect to decide what moves it.');

    if (!editFrames) continue;
    tip(section.add({ add: () => host.library.openPick({
      title: `Add a flipbook frame — ${record.name} ${label}`,
      current: null,
      onPick: ref => {
        if (!ref) return;
        if (parseTexRef(ref).level !== tile.level) {
          toast(`A frame has to live in the same bank as the material’s tile (${bankName(tile.level)}).`, 'err', 6000);
          return;
        }
        void patch({ tex, frames: [...(frames.length > 1 ? frames.map(frameRef) : [tex!]), ref] });
      },
    }) }, 'add').name('＋ flipbook frame…'),
      'Append a state — an ordinary tile from the same bank as this material’s own.');

    if (frames.length > 1) {
      tip(section.add({ drop: () => void patch({ tex, frames: frames.slice(0, -1).map(frameRef) }) }, 'drop')
        .name(`− drop frame ${frames.length - 1}`),
        'Remove the last state; dropping to one frame makes the material a still image again.');
      tip(section.add({ clear: () => void patch({ tex, frames: [] }) }, 'clear').name('✕ clear flipbook'),
        'Back to a plain still image; the frames stay in the Texture Library.');
    }
  }
}

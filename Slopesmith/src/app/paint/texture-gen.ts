import {
  FAL_GENERATION_HEADER, FAL_INPAINT_MODELS, FAL_MODELS, GEN_SIZES, STORE_SIZES,
  createFalGenerationProvenance, estimateInpaintUsd, estimateUsd, falEndpointMayGenerate,
  falInpaintModel, falModel, usdText, type FalGenerationProvenance,
} from '../../core/paint/fal-models';
import { CUSTOM_TEX_LEVEL, parseTexRef, suggestTextureName, type TexRef } from '../../core/paint/textures';
import { makeSeamless } from '../../core/paint/seamless';
import { textureRefUrl } from '../net/asset-paths';
import { fetchJson } from '../net/fetch-json';
import { clientFetch } from '../net/client';
import { loadSettings, saveSettings } from '../state/settings';
import { openSettingsDialog } from '../ui/chrome/settings-dialog';
import { installStyles } from '../ui/components/styles';
import { modal } from '../ui/components/modal';
import { toast } from '../ui/components/toast';
import { tooltip } from '../ui/components/tooltip';
import type { TexturePick } from './texture-pick';
import { createFalRightsDisclosure, renderFalRightsDisclosure } from './fal-rights';

/**
 * Generate texture: the Custom level's ✨ tile, beside the + that loads an image from disk. Same
 * destination — a tile stored as Custom/<name>.png — reached three ways, as tabs:
 *
 *  • NEW TEXTURE — describe the material, fal invents it from nothing (text-to-image).
 *  • TRANSITION — pick two existing tiles A and C; fal INPAINTS the strip between them into a tile B
 *    that blends one material into the other. Paint columns A · B · C and the mountain walks from snow
 *    to rock without a hard seam.
 *  • DECAL — pick a source tile and describe a decal; fal inpaints it onto the material's centre,
 *    leaving the edges untouched so the result tiles exactly like its source.
 *
 * Four things about this flow are deliberate and worth stating, because each one looks like an oversight:
 *
 *  • ONE field is the source: the description. "ice cream with sprinkles" becomes both the prompt sent to
 *    fal and the name the tile is stored under (ice-cream-with-sprinkles.png), so there is nothing to keep
 *    in sync by hand. The tiling boilerplate is real and still editable, but it sits one disclosure down —
 *    it is identical every time and is not what the author came here to write. Editing it by hand takes it
 *    off the description's leash until Recompose, because silently overwriting a tuned prompt on the next
 *    keystroke would be indefensible. (The inpaint tabs carry the same disclosure-and-leash via promptRig.)
 *
 *  • Generation size and stored size are separate menus. Diffusion models are trained at 512 and up and
 *    return mush when asked for 128, so a PS2-sized tile is generated large and downscaled here — the
 *    downscale acts as a supersample, and the tile ends up SHARPER than one generated at its final size.
 *    Only the generation size is billed, which is why the price moves with the first menu and not the second.
 *
 *  • Seamless wrap blend is on by default and is not optional decoration — but it belongs to the New tab
 *    only. No text-to-image model tiles on its own; the blend is what actually makes the edges meet (see
 *    seamlessBlend). The inpaint tabs get their wrap FROM CONSTRUCTION instead: the repaint zone never
 *    touches the tile's edges, and compositeMasked puts the source art back bit-for-bit outside it — a
 *    half-offset blend there would smear A into C, or the decal into the corners.
 *
 *  • Add to library does NOT close the dialog. Generating a usable material is a numbers game, so the
 *    dialog is built to be run several times: each add rolls the suggested name forward, leaving the prompt
 *    and settings in place for the next go. Nor does clicking outside it (the modal is sticky): an unsaved
 *    generation is paid-for work, so only Close and Esc dismiss the dialog.
 *
 * See docs/033-generate-texture.md.
 */

/** The fixed half of the prompt: everything that makes the model return a MATERIAL rather than a picture. */
const TILEABLE_GUIDANCE =
  'Seamless repeating pattern, top-down orthographic flat lay, evenly lit with flat ambient light, '
  + 'no directional shadows, no cast shadows, no highlights, no vignetting, uniform scale across the whole '
  + 'frame, fills the frame edge to edge with no border, margin, frame or backdrop. No objects, no text, '
  + 'no watermark, no people. Photographic material sample for a game terrain tile.';

/** Quick subjects — the materials an SSX-shaped mountain actually wants, one click into the description. */
const PRESETS: ReadonlyArray<{ label: string; subject: string }> = [
  { label: 'Snow', subject: 'packed snow with faint ski tracks and fine ice crystals' },
  { label: 'Ice', subject: 'blue glacial ice with hairline cracks and a scuffed surface' },
  { label: 'Powder', subject: 'deep untouched powder snow with soft wind ripples' },
  { label: 'Rock', subject: 'grey granite rock face with lichen and fine grit' },
  { label: 'Gravel', subject: 'loose grey gravel and small crushed stones' },
  { label: 'Metal', subject: 'scuffed galvanised steel deck plate with a diamond tread' },
  { label: 'Wood', subject: 'weathered pine planks with visible grain and knots' },
  { label: 'Concrete', subject: 'poured concrete with hairline cracks and staining' },
];

/** The prompt actually sent: the author's one-line description wrapped in the fixed tiling guidance. With
 *  no description there is nothing to make a texture OF, so only the guidance shows and Generate stays off. */
const promptFor = (subject: string) =>
  subject ? `Seamless tileable texture of ${subject}.\n\n${TILEABLE_GUIDANCE}` : TILEABLE_GUIDANCE;

/** The Transition tab's inpaint prompt. The model only ever paints the middle strip, so everything here is
 *  about CONTINUING the two materials it can see either side of the gap. `vert` flips the geometry words
 *  for the stacked A-above-C layout. */
const transPromptFor = (desc: string, vert: boolean) =>
  `Seamless gradual transition zone between the ground material at the ${vert ? 'top' : 'left'} edge and `
  + `the ground material at the ${vert ? 'bottom' : 'right'} edge. `
  + (desc ? `The blend: ${desc}. ` : '')
  + 'Continue both materials into the gap and mix them into each other naturally, matching their scale, '
  + 'grain and colour. Top-down orthographic flat lay, evenly lit with flat ambient light, no directional '
  + 'shadows, no objects, no text, no border. Photographic ground material for a game terrain tile.';

/** The Transition tab's SECOND inpaint prompt — the wrap repair pass. By the time this is sent the image
 *  has been rolled half a tile across the blend, so the strip's wrap seam is sitting mid-frame as an
 *  ordinary join for the model to erase (and the join itself has been bridged out of the sent pixels —
 *  a conditioning model must not be shown the seam it is asked to remove). */
const healPromptFor = (desc: string, vert: boolean) =>
  `Repair the ${vert ? 'vertical' : 'horizontal'} seam running through the masked band: continue the `
  + `blended transition material from directly ${vert ? 'left and right' : 'above and below'} so the `
  + 'texture flows through without a visible join. '
  + (desc ? `The blend: ${desc}. ` : '')
  + 'Keep the mix consistent with the surrounding image, matching its scale, grain and colour. Top-down '
  + 'orthographic flat lay, flat ambient light, no shadows, no objects, no text, no border.';

/** The Decal tab's inpaint prompt: the description IS the decal; the wrapper keeps it flat and of a piece
 *  with the material it lands on. */
const decalPromptFor = (desc: string) =>
  (desc ? `${desc}, ` : '')
  + 'applied directly onto the surrounding surface as a flat decal. Keep the surrounding material visible '
  + 'around it and match its lighting and scale, so the decal reads as printed or painted on the surface. '
  + 'Top-down orthographic view, flat ambient light, no cast shadows, no border, no watermark.';

/** The Transition tab's repaint strip — the middle third, matching the A · B · C metaphor: a third of A for
 *  context, a third to invent, a third of C. Runs down the tile horizontally, across it vertically. */
const TRANS_BAND = { lo: 1 / 3, hi: 2 / 3 } as const;

/** The strip as a rect, in either orientation. */
const transBandRect = (size: number, vert: boolean): Rect => vert
  ? { x: 0, y: size * TRANS_BAND.lo, w: size, h: size * (TRANS_BAND.hi - TRANS_BAND.lo) }
  : { x: size * TRANS_BAND.lo, y: 0, w: size * (TRANS_BAND.hi - TRANS_BAND.lo), h: size };

/** The Decal tab's repaint zone — the central half in both axes. The edges are what make a tile tile, so
 *  they are simply never offered to the model. */
const DECAL_BOX = { x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 } as const;

/** compositeMasked's cross-fade radius as a fraction of the image edge — 4px at 512: enough to hide the
 *  mask boundary, two orders of magnitude short of reaching a tile edge. */
const FEATHER_DIV = 128;

type GenMode = 'new' | 'transition' | 'decal';

interface Rect { x: number; y: number; w: number; h: number }

const css = `
/* overflow-x: hidden is load-bearing — setting only overflow-y promotes overflow-x from visible to auto,
   which draws a horizontal scrollbar across the dialog with nothing actually overflowing. */
.sp-texgen { width: 470px; box-sizing: border-box; padding: 12px 14px 0; color: #d7e3f0;
  background: #0c141d; border: 1px solid #2c3e50; border-radius: 7px;
  font: 12px/1.45 system-ui, sans-serif; box-shadow: 0 12px 40px #0009;
  max-height: 92vh; overflow-y: auto; overflow-x: hidden; }
/* the dialog scrolls, so the actions ride the bottom edge rather than sitting past the fold under the
   explanatory copy — Generate must be reachable without scrolling for it */
.sp-texgen .sp-modal-actions { position: sticky; bottom: 0; margin-top: 12px; padding: 10px 0;
  background: #0c141d; border-top: 1px solid #23364a; }
.sp-texgen h3 { margin: 0 0 8px; color: #cfe3f5; font: 600 13px system-ui, sans-serif; }
.sp-texgen .hint { margin: 4px 0 0; color: #8aa0b4; font-size: 11px; line-height: 1.5; }
.sp-texgen .hint a { color: #6ee7a8; }
.sp-texgen .warn { color: #f0c9a8; }
.sp-texgen .fal-rights { margin-top: 7px; padding: 7px 8px; border-left: 2px solid #42627d;
  background: #101c27; }
.sp-texgen label.fld { display: block; margin: 9px 0 3px; color: #9fb3c8; font-size: 11px; font-weight: 600; }
.sp-texgen textarea, .sp-texgen input[type=text], .sp-texgen input[type=number], .sp-texgen select {
  width: 100%; box-sizing: border-box; background: #0e1822; color: #d7e3f0; border: 1px solid #2c3e50;
  border-radius: 4px; padding: 6px 8px; font: 12px/1.45 system-ui, sans-serif; }
.sp-texgen textarea { resize: vertical; min-height: 84px; }
.sp-texgen input:focus, .sp-texgen textarea:focus, .sp-texgen select:focus { outline: 0; border-color: #3a6ea5; }
.sp-texgen .presets { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.sp-texgen .presets .sp-btn { padding: 3px 8px; font-size: 11px; }
.sp-texgen .promptbox { margin-top: 9px; border: 1px solid #23364a; border-radius: 5px; padding: 6px 8px; }
.sp-texgen .promptbox summary { color: #9fb3c8; font-size: 11px; font-weight: 600; cursor: pointer; }
.sp-texgen .promptbox summary:hover { color: #cfe3f5; }
.sp-texgen .promptbox textarea { margin-top: 7px; }
.sp-texgen .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; }
.sp-texgen .price { float: right; color: #6ee7a8; font-weight: 600; }
.sp-texgen .chk { display: flex; align-items: flex-start; gap: 6px; margin: 10px 0 0; cursor: pointer; }
.sp-texgen .chk input { margin: 2px 0 0; cursor: pointer; }
.sp-texgen .chk span { color: #cfe3f5; font-size: 12px; }
.sp-texgen .banner { padding: 8px 10px; margin-bottom: 8px; border-radius: 4px; font-size: 11.5px; line-height: 1.45;
  color: #f0d9cf; background: #3a2a26; border-left: 3px solid #c2543a; }
.sp-texgen .banner .sp-btn { margin-top: 6px; }
/* the three ways in, as tabs — one dialog, one destination (a Custom tile), three sources */
.sp-texgen .tabs { display: flex; margin: 0 0 10px; border: 1px solid #2c3e50; border-radius: 6px; overflow: hidden; }
.sp-texgen .tabs button { flex: 1 1 0; background: #0e1822; border: 0; border-right: 1px solid #2c3e50;
  color: #9fb3c8; padding: 6px 4px; font: 12px system-ui, sans-serif; cursor: pointer; }
.sp-texgen .tabs button:last-child { border-right: 0; }
.sp-texgen .tabs button:hover { color: #eaf6ff; }
.sp-texgen .tabs button.on { background: #1c2b3a; color: #eaf6ff; font-weight: 600; }
/* the Transition tab's A · B · C row, shared with the Decal tab's source slot */
.sp-texgen .abc { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 8px; }
/* vertical stack: the boxes arrange the way the tiles will be painted — A above C, narrower so three
   stacked squares don't swallow the dialog */
.sp-texgen .abc.vert { grid-template-columns: 1fr; width: 110px; margin-left: auto; margin-right: auto; }
.sp-texgen .slot { position: relative; width: 100%; aspect-ratio: 1; padding: 0; overflow: hidden;
  border: 1px solid #2c3e50; border-radius: 6px; background: #0a121a center/cover no-repeat;
  color: #9fb3c8; font: 11px/1.35 system-ui, sans-serif; }
.sp-texgen .slot.empty { border: 2px dashed #3d5166; display: grid; place-items: center; padding: 0 6px; }
.sp-texgen button.slot { cursor: pointer; }
.sp-texgen button.slot:hover { border-color: #6ee7a8; color: #6ee7a8; }
.sp-texgen .slot .art { position: absolute; inset: 0; background: center/cover no-repeat; }
.sp-texgen .slot.b { image-rendering: pixelated; }
.sp-texgen .slot-cap { margin-top: 3px; display: flex; align-items: center; justify-content: center; gap: 6px;
  color: #8aa0b4; font-size: 10.5px; }
.sp-texgen .rot { background: #1c2b3a; border: 1px solid #34506b; color: #cfe3f5; border-radius: 4px;
  padding: 0 6px; font: 11px/1.6 system-ui, sans-serif; cursor: pointer; }
.sp-texgen .rot:hover:not(:disabled) { background: #25425c; }
.sp-texgen .rot:disabled { opacity: .4; cursor: default; }
/* the Decal tab: source slot beside its description, so the pair reads as one sentence */
.sp-texgen .decal-row { display: flex; gap: 10px; align-items: flex-start; margin-top: 8px; }
.sp-texgen .decal-row .slotwrap { flex: 0 0 96px; }
.sp-texgen .decal-row .grow { flex: 1 1 auto; min-width: 0; }
.sp-texgen .decal-row .grow label.fld { margin-top: 0; }
/* the preview repeats the tile rather than showing it once, so the seam — or its absence — is the thing you
   actually look at. 2:1 box at a quarter-width tile = exactly 4 across by 2 down. (The Transition tab
   overrides the size inline to show an A·B·C strip instead — B against itself is a seam nobody paints.) */
.sp-texgen .preview { position: relative; width: 100%; aspect-ratio: 2 / 1; margin-top: 10px; border-radius: 5px;
  border: 1px solid #2c3e50; background-color: #0a121a; background-position: 0 0;
  background-size: 25% auto; background-repeat: repeat; image-rendering: pixelated; }
.sp-texgen .preview.empty { display: grid; place-items: center; }
.sp-texgen .preview .placeholder { color: #62798f; font-size: 11.5px; text-align: center; padding: 0 16px; }
.sp-texgen .previewcap { margin-top: 4px; color: #7f97ac; font-size: 10.5px; text-align: center; }
`;

/** Install the dialog stylesheet. Exported for the Generate skybox dialog (sky/sky-gen.ts), which wears
 *  the same chrome — shell, fields, presets, prompt disclosure, preview — under the same class. */
export function ensureTexGenStyles() { installStyles('texture-gen', css); }

/** A composed-prompt disclosure that tracks its composer until hand-edited; ↺ puts it back on the leash.
 *  Hand-edits force the disclosure open so a dialog never quietly sends other than what it shows. Shared by
 *  this dialog's inpaint tabs and the Generate skybox dialog (the New tab predates it and wires the same
 *  pattern inline). */
export function promptRig(compose: () => string, onEdit: () => void) {
  const box = document.createElement('details');
  box.className = 'promptbox';
  const summary = document.createElement('summary');
  const ta = document.createElement('textarea');
  ta.rows = 5;
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Composed from the fields above. Edit it and it stops tracking them until you reset.';
  const rst = document.createElement('button');
  rst.type = 'button';
  rst.className = 'sp-btn';
  rst.textContent = '↺ Recompose';
  rst.style.marginTop = '6px';
  box.append(summary, ta, hint, rst);
  let edited = false;
  const sync = () => {
    if (!edited) ta.value = compose();
    summary.textContent = edited ? 'Full prompt sent to fal.ai — edited by hand' : 'Full prompt sent to fal.ai';
    if (edited) box.open = true;
    rst.style.display = edited ? '' : 'none';
  };
  ta.oninput = () => { edited = true; sync(); onEdit(); };
  rst.onclick = () => { edited = false; sync(); onEdit(); };
  sync();
  return { el: box, value: () => ta.value, sync, edited: () => edited };
}

export interface TextureGenDeps {
  /** Open mountain name shown for the local asset destination. */
  mountainName: string;
  /** A tile was stored — the Library reloads Custom and makes `name` the brush. */
  onSaved(name: string): void | Promise<void>;
  /** Borrow the Texture Library's pick mode (docs/005) to answer "which tile?" — the Transition tab's A / C
   *  ends and the Decal tab's source. The dialog hides itself while the pick is up, because the library
   *  panel lives under the modal backdrop. */
  pickTexture(req: TexturePick): void;
}

/** Open the Generate texture dialog. Nothing is billed until Generate is pressed, and nothing enters the
 *  library until Save is pressed, so both cancel paths are free. */
export function openTextureGenDialog(deps: TextureGenDeps): void {
  ensureTexGenStyles();
  const settings = loadSettings();
  const prefs = { ...settings.texGen };
  // sticky: a stray click outside the dialog must not throw away a paid generation or a typed prompt —
  // only the Close button and Esc dismiss it
  const { host, close: closeModal } = modal({ sticky: true });
  host.classList.add('sp-texgen');
  const back = host.parentElement as HTMLElement; // the modal backdrop — hidden while a library pick is up

  // Esc closes the dialog — EXCEPT while a library pick is up: the pick's capture-phase Esc listener
  // (library.ts) runs first and stops propagation, so Esc then cancels the pick and this never fires.
  // stopPropagation here keeps the editor's own layered Escape (shortcuts.ts) out of it in turn.
  const onEsc = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onEsc);
  const close = () => {
    document.removeEventListener('keydown', onEsc);
    closeModal();
  };

  const title = document.createElement('h3');
  title.textContent = 'Generate texture';

  // ---- tabs ----
  let mode: GenMode = 'new';
  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  const tabBtns = new Map<GenMode, HTMLButtonElement>();
  const tabDefs: ReadonlyArray<{ m: GenMode; label: string; tip: string }> = [
    { m: 'new', label: 'New texture', tip: 'Describe a material and generate a fresh tile from nothing.' },
    {
      m: 'transition', label: 'Transition',
      tip: 'Pick tiles A and C — fal.ai inpaints a tile B that blends one into the other.',
    },
    {
      m: 'decal', label: 'Decal',
      tip: 'Describe a decal — fal.ai inpaints it onto a tile’s centre, so the result tiles like its source.',
    },
  ];
  for (const t of tabDefs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t.label;
    tooltip(b, t.tip);
    b.onclick = () => setTab(t.m);
    tabBtns.set(t.m, b);
    tabs.appendChild(b);
  }

  // ---- no-key banner: the dialog still opens, so the flow explains itself before it asks for anything ----
  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.textContent = 'No fal.ai API key yet. Generation calls fal.ai with your own key and bills your '
    + 'own account — add one to switch this on.';
  const bannerBtn = document.createElement('button');
  bannerBtn.type = 'button';
  bannerBtn.className = 'sp-btn';
  bannerBtn.textContent = 'Open Settings…';
  bannerBtn.onclick = () => { close(); openSettingsDialog(); };
  banner.appendChild(bannerBtn);

  // ================= NEW TEXTURE tab =================
  const panelNew = document.createElement('div');

  // ---- subject: the one thing the author types ----
  // Everything else in this tab is derived from it — the prompt sent to fal, and the name the tile is
  // stored under. Say "ice cream with sprinkles" and you get a tileable ice-cream texture in ice-cream-with-
  // sprinkles.png. The tiling boilerplate still exists and is still editable, but it lives one disclosure
  // down, because it is the same every time and is not what you came here to write.
  const subjectLabel = document.createElement('label');
  subjectLabel.className = 'fld';
  subjectLabel.textContent = 'Describe the texture';
  const subject = document.createElement('input');
  subject.type = 'text';
  subject.spellcheck = false;
  subject.placeholder = 'ice cream with sprinkles';
  const subjectHint = document.createElement('p');
  subjectHint.className = 'hint';
  subjectHint.textContent = 'One line is all it needs. The tiling instructions are added for you, and the '
    + 'tile is named from this too — so “ice cream with sprinkles” stores as ice-cream-with-sprinkles.png.';

  const presets = document.createElement('div');
  presets.className = 'presets';
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sp-btn';
    b.textContent = p.label;
    b.onclick = () => { subject.value = p.subject; onSubjectChanged(); };
    presets.appendChild(b);
  }

  // ---- the composed prompt, one disclosure down and editable for anyone who wants the wheel ----
  const promptBox = document.createElement('details');
  promptBox.className = 'promptbox';
  const promptSummary = document.createElement('summary');
  promptSummary.textContent = 'Full prompt sent to fal.ai';
  const prompt = document.createElement('textarea');
  prompt.rows = 6;
  const promptHint = document.createElement('p');
  promptHint.className = 'hint';
  promptHint.textContent = 'Composed from your description. The flat-lay, ambient-light and no-border wording '
    + 'is what makes a model return a material instead of a photograph of one — edit it if you want, and it '
    + 'will stop tracking the box above until you reset.';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'sp-btn';
  reset.textContent = '↺ Recompose from description';
  reset.style.marginTop = '6px';
  promptBox.append(promptSummary, prompt, promptHint, reset);

  // ---- model ----
  const modelLabel = document.createElement('label');
  modelLabel.className = 'fld';
  const price = document.createElement('span');
  price.className = 'price';
  modelLabel.append(document.createTextNode('Model'), price);
  const modelSel = document.createElement('select');
  for (const m of FAL_MODELS) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    modelSel.appendChild(o);
  }
  modelSel.value = prefs.model;
  const modelHint = document.createElement('p');
  modelHint.className = 'hint';
  const modelRights = createFalRightsDisclosure();

  // ---- seamless (New only: the inpaint tabs get their wrap from construction, and a half-offset blend
  //      would smear A into C, or the decal into the corners) ----
  const seamWrap = document.createElement('label');
  seamWrap.className = 'chk';
  const seamChk = document.createElement('input');
  seamChk.type = 'checkbox';
  seamChk.checked = prefs.seamless;
  const seamText = document.createElement('span');
  seamText.textContent = 'Seamless wrap blend';
  seamWrap.append(seamChk, seamText);
  const seamHint = document.createElement('p');
  seamHint.className = 'hint';
  seamHint.textContent = 'No text-to-image model tiles on its own — the prompt only asks it to try. This '
    + 'cross-fades each edge with the opposite half of the image, so the tile genuinely meets itself. It '
    + 'softens the outer quarter slightly, which organic materials hide and hard geometric patterns don’t.';

  panelNew.append(subjectLabel, subject, subjectHint, presets, promptBox,
    modelLabel, modelSel, modelHint, modelRights, seamWrap, seamHint);

  // ================= TRANSITION tab =================
  const panelTrans = document.createElement('div');
  const transIntro = document.createElement('p');
  transIntro.className = 'hint';
  transIntro.textContent = 'A and C are existing tiles; B is generated between them. B’s edge facing A IS '
    + 'A’s art and its edge facing C IS C’s art — put back untouched after the repaint — so painting '
    + 'A · B · C in sequence gives seams exactly as clean as A and C themselves. Only the middle strip is '
    + 'invented.';

  // ---- orientation: a row (blend runs left→right) or a stack (top→bottom) ----
  const vertWrap = document.createElement('label');
  vertWrap.className = 'chk';
  const vertChk = document.createElement('input');
  vertChk.type = 'checkbox';
  vertChk.checked = prefs.transVertical;
  const vertText = document.createElement('span');
  vertText.textContent = 'Vertical stack — A above C';
  vertWrap.append(vertChk, vertText);
  const vertHint = document.createElement('p');
  vertHint.className = 'hint';
  vertHint.textContent = 'For transitions painted as rows instead of columns: A on top, C below, the '
    + 'invented strip running horizontally across the middle.';

  const trans = { a: null as TexRef | null, c: null as TexRef | null, rotA: 0, rotC: 0 };

  /** A tile slot: shows its texture (rotated as it will be composed) or a dashed choose-me state. */
  const slot = (label: string) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'slot empty';
    el.textContent = label;
    const art = document.createElement('div');
    art.className = 'art';
    const set = (ref: TexRef | null, quarters: number) => {
      // a filled slot is pure artwork, so its name has to live in the label — an unnamed button is invisible
      // to the accessibility tree (and to the agent layer riding it)
      el.setAttribute('aria-label', ref ? `${label}: ${ref}` : label);
      if (!ref) { el.classList.add('empty'); art.remove(); el.textContent = label; return; }
      el.classList.remove('empty');
      el.textContent = '';
      el.appendChild(art);
      art.style.backgroundImage = `url(${textureRefUrl(ref)})`;
      art.style.transform = `rotate(${quarters * 90}deg)`;
    };
    return { el, set };
  };

  const abc = document.createElement('div');
  abc.className = 'abc';
  const slotA = slot('Choose A');
  const slotC = slot('Choose C');
  const slotB = document.createElement('div');
  slotB.className = 'slot b empty';
  slotB.textContent = 'B — generated';
  const rotBtn = (which: 'a' | 'c') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rot';
    b.textContent = '⟳';
    b.setAttribute('aria-label', `Rotate ${which.toUpperCase()}`);
    b.disabled = true;
    tooltip(b, `Rotate ${which.toUpperCase()} a quarter turn so directional grain runs into the blend the right way.`);
    return b;
  };
  const rotA = rotBtn('a'), rotC = rotBtn('c');
  const cell = (slotEl: HTMLElement, cap: string, rot?: HTMLButtonElement) => {
    const d = document.createElement('div');
    const c = document.createElement('div');
    c.className = 'slot-cap';
    c.append(cap);
    if (rot) c.append(rot);
    d.append(slotEl, c);
    return d;
  };
  abc.append(cell(slotA.el, 'A', rotA), cell(slotB, 'B', undefined), cell(slotC.el, 'C', rotC));

  const transDescLabel = document.createElement('label');
  transDescLabel.className = 'fld';
  transDescLabel.textContent = 'Describe the blend (optional)';
  const transDesc = document.createElement('input');
  transDesc.type = 'text';
  transDesc.spellcheck = false;
  transDesc.placeholder = 'snow thinning out over wet gravel';
  const transDescHint = document.createElement('p');
  transDescHint.className = 'hint';
  transDescHint.textContent = 'Left blank, the model is simply asked to mix the two materials; a line here '
    + 'steers HOW they meet, and names the tile too.';

  // ---- the wrap repair pass ----
  // B's edges facing A and C wrap by construction (they are A's and C's art), but the invented strip's
  // other pair of edges only meet if the model happens to make them. Rolling the result half a tile across
  // the blend puts that wrap seam mid-frame, where a second inpaint can erase it like any other flaw —
  // after rolling back, the healed pixels ARE the tile's wrap edge, so B repeats along the strip by
  // construction too.
  const vwrapWrap = document.createElement('label');
  vwrapWrap.className = 'chk';
  const vwrapChk = document.createElement('input');
  vwrapChk.type = 'checkbox';
  vwrapChk.checked = prefs.vwrapPass;
  const vwrapText = document.createElement('span');
  vwrapText.textContent = 'Wrap repair pass';
  vwrapWrap.append(vwrapChk, vwrapText);
  const vwrapHint = document.createElement('p');
  vwrapHint.className = 'hint';
  vwrapHint.textContent = 'B’s edges facing A and C wrap by construction, but the invented strip’s other '
    + 'two edges only meet if the model happens to make them — Bs repeated along the strip can show a '
    + 'seam. This rolls the result half a tile, sends ONE more inpaint (a fixed seam-repair prompt over '
    + 'just the strip’s wrap join — same size, so it doubles the run price) and rolls back. A and C’s art '
    + 'still comes back untouched.';

  // ================= DECAL tab =================
  const panelDecal = document.createElement('div');
  const decalIntro = document.createElement('p');
  decalIntro.className = 'hint';
  decalIntro.textContent = 'Paint a described decal INTO an existing tile. The decal lands in the central '
    + 'half; the source’s edges are put back untouched after the repaint, so the result tiles exactly like '
    + 'the tile it came from.';
  const decal = { ref: null as TexRef | null };
  const slotS = slot('Choose source');
  const decalRow = document.createElement('div');
  decalRow.className = 'decal-row';
  const slotWrap = document.createElement('div');
  slotWrap.className = 'slotwrap';
  const slotCap = document.createElement('div');
  slotCap.className = 'slot-cap';
  slotCap.textContent = 'source';
  slotWrap.append(slotS.el, slotCap);
  const decalGrow = document.createElement('div');
  decalGrow.className = 'grow';
  const decalDescLabel = document.createElement('label');
  decalDescLabel.className = 'fld';
  decalDescLabel.textContent = 'Describe the decal';
  const decalDesc = document.createElement('input');
  decalDesc.type = 'text';
  decalDesc.spellcheck = false;
  decalDesc.placeholder = 'faded yellow hazard chevrons, stencilled';
  const decalDescHint = document.createElement('p');
  decalDescHint.className = 'hint';
  decalDescHint.textContent = 'What gets painted onto the material — a logo, a marking, a stain. Names the '
    + 'tile too.';
  decalGrow.append(decalDescLabel, decalDesc, decalDescHint);
  decalRow.append(slotWrap, decalGrow);

  // the inpaint tabs' shared prompt disclosure: same leash as the New tab's (promptRig, module scope)
  const transRig = promptRig(() => transPromptFor(transDesc.value.trim(), vertChk.checked),
    () => { refreshSuggestion(); refresh(); });
  const decalRig = promptRig(() => decalPromptFor(decalDesc.value.trim()), () => { refreshSuggestion(); refresh(); });

  panelTrans.append(transIntro, vertWrap, vertHint, abc, transDescLabel, transDesc, transDescHint,
    vwrapWrap, vwrapHint, transRig.el);
  panelDecal.append(decalIntro, decalRow, decalRig.el);

  // ---- inpaint model (shared by Transition and Decal; hidden on New, which has its own text-to-image menu) ----
  const inpaintWrap = document.createElement('div');
  const inpaintLabel = document.createElement('label');
  inpaintLabel.className = 'fld';
  const inpaintPrice = document.createElement('span');
  inpaintPrice.className = 'price';
  inpaintLabel.append(document.createTextNode('Inpainting model'), inpaintPrice);
  const inpaintSel = document.createElement('select');
  for (const m of FAL_INPAINT_MODELS) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    inpaintSel.appendChild(o);
  }
  inpaintSel.value = prefs.inpaintModel;
  const inpaintHint = document.createElement('p');
  inpaintHint.className = 'hint';
  const inpaintRights = createFalRightsDisclosure();
  inpaintWrap.append(inpaintLabel, inpaintSel, inpaintHint, inpaintRights);

  // ---- sizes ----
  const cols = document.createElement('div');
  cols.className = 'cols';
  const genWrap = document.createElement('div');
  const genLabel = document.createElement('label');
  genLabel.className = 'fld';
  genLabel.textContent = 'Generate at';
  const genSel = document.createElement('select');
  for (const s of GEN_SIZES) {
    const o = document.createElement('option');
    o.value = String(s);
    o.textContent = `${s}²`;
    genSel.appendChild(o);
  }
  genSel.value = String(prefs.genSize);
  genWrap.append(genLabel, genSel);

  const storeWrap = document.createElement('div');
  const storeLabel = document.createElement('label');
  storeLabel.className = 'fld';
  storeLabel.textContent = 'Store as';
  const storeSel = document.createElement('select');
  for (const s of STORE_SIZES) {
    const o = document.createElement('option');
    o.value = String(s);
    o.textContent = `${s}²${s === 128 ? ' — PS2 native' : ''}`;
    storeSel.appendChild(o);
  }
  storeSel.value = String(prefs.storeSize);
  storeWrap.append(storeLabel, storeSel);
  cols.append(genWrap, storeWrap);

  const sizeHint = document.createElement('p');
  sizeHint.className = 'hint';

  // ---- name ----
  const nameLabel = document.createElement('label');
  nameLabel.className = 'fld';
  nameLabel.textContent = 'Save as';
  const name = document.createElement('input');
  name.type = 'text';
  name.spellcheck = false;
  const nameHint = document.createElement('p');
  nameHint.className = 'hint';
  nameHint.textContent = `Stored with ${deps.mountainName} as <name>.png. Leave it blank to use the suggestion, which is drawn `
    + 'from the prompt and numbered so consecutive adds never overwrite each other. Typing a name that '
    + 'already exists replaces that tile’s art everywhere it is painted.';

  // ---- preview ----
  const preview = document.createElement('div');
  preview.className = 'preview empty';
  const placeholder = document.createElement('div');
  placeholder.className = 'placeholder';
  preview.appendChild(placeholder);
  const previewCap = document.createElement('div');
  previewCap.className = 'previewcap';

  // ---- actions ----
  const actions = document.createElement('div');
  actions.className = 'sp-modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sp-btn';
  cancel.textContent = 'Close';
  cancel.onclick = close;
  const generate = document.createElement('button');
  generate.type = 'button';
  generate.className = 'sp-btn';
  generate.textContent = 'Generate';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'sp-btn accent';
  save.textContent = 'Add to library';
  save.disabled = true;
  actions.append(cancel, generate, save);

  host.append(title, tabs, banner, panelNew, panelTrans, panelDecal, inpaintWrap,
    cols, sizeHint, nameLabel, name, nameHint, preview, previewCap, actions);

  // ---- live state ----
  /** Per-tab generation at generation size, before the store-size downscale. Kept per tab so flipping tabs
   *  never throws away a result someone paid for; re-derived (seamless / store size) without paying again. */
  const raws: Record<GenMode, HTMLCanvasElement | null> = { new: null, transition: null, decal: null };
  const seeds: Record<GenMode, number | null> = { new: null, transition: null, decal: null };
  const generations: Record<GenMode, FalGenerationProvenance | null> =
    { new: null, transition: null, decal: null };
  /** The loaded end tiles behind the last transition result, for the A · B · C preview strip. */
  let transImgs: { a: HTMLImageElement; c: HTMLImageElement; rotA: number; rotC: number; vert: boolean } | null = null;
  /** The loaded source behind the last decal result — the preview surrounds the decal tile with it. */
  let decalImg: HTMLImageElement | null = null;
  let busy = false;
  /** Custom tile stems already on disk, so the suggested name can dodge them. Refreshed after each add. */
  let taken = new Set<string>();
  let added = 0;
  /** Set once the author edits the composed prompt by hand, after which the subject stops overwriting it —
   *  silently discarding someone's hand-tuned prompt on the next keystroke would be indefensible. */
  let promptEdited = false;

  const hasKey = () => !!loadSettings().falKey.trim();

  /** Loaded tile images by ref — the transition ends and decal sources being composed. */
  const texImgs = new Map<TexRef, Promise<HTMLImageElement>>();
  const loadTex = (ref: TexRef) => {
    let p = texImgs.get(ref);
    if (!p) {
      p = new Promise<HTMLImageElement>((ok, err) => {
        const img = new Image();
        img.onload = () => ok(img);
        img.onerror = () => err(new Error(`could not load ${ref}`));
        img.src = textureRefUrl(ref);
      });
      texImgs.set(ref, p);
    }
    return p;
  };

  /** Keep the placeholder showing the name a blank field would actually use. With nothing described yet
   *  there is no name to suggest — slugifying the bare boilerplate would offer
   *  "seamless-repeating-pattern-top", which is not a texture name anyone wants. */
  const suggestedName = () => {
    const stem = (ref: TexRef | null) => ref ? parseTexRef(ref).name.replace(/\.png$/i, '') : '';
    const from = mode === 'new'
      ? subject.value.trim() || (promptEdited ? prompt.value : '')
      : mode === 'transition'
        ? transDesc.value.trim() || (trans.a && trans.c ? `${stem(trans.a)} to ${stem(trans.c)}` : '')
        : decalDesc.value.trim();
    return from ? suggestTextureName(from, taken) : '';
  };
  const refreshSuggestion = () => {
    name.placeholder = suggestedName() || 'named from your description';
  };

  /** Recompose the prompt from the description (unless it has been taken over by hand) and re-derive the
   *  suggested file name. The single place the New tab's subject fans out from. */
  function onSubjectChanged() {
    if (!promptEdited) prompt.value = promptFor(subject.value.trim());
    promptSummary.textContent = promptEdited
      ? 'Full prompt sent to fal.ai — edited by hand' : 'Full prompt sent to fal.ai';
    if (promptEdited) promptBox.open = true;
    reset.style.display = promptEdited ? '' : 'none';
    refreshSuggestion();
    refresh();
  }

  const reloadTaken = async () => {
    try {
      const { tiles } = await fetchJson<{ tiles: { name: string }[] }>(
        `/api/textures?level=${encodeURIComponent(CUSTOM_TEX_LEVEL)}`);
      taken = new Set(tiles.map(t => t.name.replace(/\.png$/i, '').toLowerCase()));
    } catch { /* offline: the server still refuses a genuinely bad name, this only sharpens the suggestion */ }
    refreshSuggestion();
  };

  const refresh = () => {
    const keyed = hasKey();
    banner.style.display = keyed ? 'none' : '';
    const genSize = Number(genSel.value);
    if (mode === 'new') {
      const model = falModel(modelSel.value);
      const usd = estimateUsd(modelSel.value, genSize);
      price.textContent = usd == null ? '' : `≈ ${usdText(usd)} / run`;
      modelHint.textContent = model?.note ?? '';
      renderFalRightsDisclosure(modelRights, [modelSel.value]);
    } else {
      const model = falInpaintModel(inpaintSel.value);
      const usd = estimateInpaintUsd(inpaintSel.value, genSize);
      // the wrap repair pass is a second same-size call, so the honest per-run number is double
      const calls = mode === 'transition' && vwrapChk.checked ? 2 : 1;
      inpaintPrice.textContent = usd == null ? ''
        : `≈ ${usdText(usd * calls)} / run${calls > 1 ? ' (2 calls)' : ''}`;
      inpaintHint.textContent = model?.note ?? '';
      renderFalRightsDisclosure(inpaintRights, [inpaintSel.value]);
    }
    const storeSize = Number(storeSel.value);
    sizeHint.innerHTML = `Only <b>Generate at</b> is billed — fal charges by the megapixel, so ${genSize}² costs `
      + `a quarter of what 1024² does. <b>Store as</b> is free and decides the tile itself: `
      + (storeSize === 128
        ? '128² is the dominant native SSX terrain size and the cap an ISO export applies anyway, so it is the '
          + 'one to pick for anything that ships to PS2.'
        : storeSize === 256
          ? '256² keeps more detail for Unity exports; an ISO export with “maximum 128²” on will halve it again.'
          : '512² is the library’s ceiling — good for Unity, well over the PS2 VRAM budget for more than a tile '
            + 'or two.')
      + ` Generating at ${genSize}² and storing at ${storeSize}² downscales by `
      + `${(genSize / storeSize).toFixed(genSize % storeSize ? 1 : 0)}×, which supersamples the tile rather than `
      + 'blurring it.';
    const ready = mode === 'new'
      ? !!subject.value.trim() || promptEdited
      : mode === 'transition'
        ? !!trans.a && !!trans.c
        : !!decal.ref && (!!decalDesc.value.trim() || decalRig.edited());
    const selectedModel = mode === 'new' ? modelSel.value : inpaintSel.value;
    generate.disabled = busy || !keyed || !ready || !falEndpointMayGenerate(selectedModel);
    generate.textContent = busy ? 'Generating…' : raws[mode] ? 'Regenerate' : 'Generate';
    save.disabled = busy || !raws[mode] || !generations[mode];
  };

  /** The tile as it would be stored right now. New runs the optional wrap blend then downscales; the
   *  inpaint tabs only downscale — their wrap comes from construction (the repaint never reaches an edge),
   *  and a half-offset blend would smear A into C, or the decal into the corners. */
  const buildStored = (): HTMLCanvasElement | null => {
    const r = raws[mode];
    if (!r) return null;
    return mode === 'new'
      ? buildTile(r, Number(storeSel.value), seamChk.checked)
      : downscale(r, Number(storeSel.value));
  };

  /** Re-derive the active tab's preview from its cached generation — no network, no bill. */
  const renderPreview = () => {
    const tile = buildStored();
    if (!tile) {
      preview.classList.add('empty');
      preview.style.backgroundImage = '';
      preview.style.backgroundSize = '';
      if (!placeholder.isConnected) preview.appendChild(placeholder);
      placeholder.textContent = mode === 'transition'
        ? 'The result previews here as an A · B · C strip — B between its neighbours, because those are the '
          + 'seams you will actually paint.'
        : 'The result previews here, repeated across the box so you can see whether it tiles.';
      previewCap.textContent = '';
      return;
    }
    placeholder.remove();
    preview.classList.remove('empty');
    const seed = seeds[mode];
    if (mode === 'transition' && transImgs) {
      // B tiled against itself would put C's edge against A's — a seam nobody paints. Show the strip
      // instead, repeated across the box's other axis so B's wrap seam (the repair pass's work) shows too.
      const s = tile.width;
      const { vert } = transImgs;
      const strip = document.createElement('canvas');
      strip.width = vert ? s : s * 3;
      strip.height = vert ? s * 3 : s;
      const ctx = strip.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      if (vert) {
        drawRotated(ctx, transImgs.a, s, transImgs.rotA, 0, 0);
        ctx.drawImage(tile, 0, s);
        drawRotated(ctx, transImgs.c, s, transImgs.rotC, 0, 2 * s);
      } else {
        drawRotated(ctx, transImgs.a, s, transImgs.rotA, 0);
        ctx.drawImage(tile, s, 0);
        drawRotated(ctx, transImgs.c, s, transImgs.rotC, 2 * s);
      }
      preview.style.backgroundImage = `url(${strip.toDataURL('image/png')})`;
      preview.style.backgroundSize = vert ? 'auto 100%' : '100% auto';
      previewCap.textContent = `${s}² tile · shown as A · B · C, the ${vert ? 'rows' : 'columns'} you will paint`
        + (seed != null ? ` · seed ${seed}` : '');
    } else if (mode === 'decal' && decalImg) {
      // the decal tile the way it is actually used: one marked cell in a field of the plain source, so the
      // joins between decaled and plain cells are the thing on show
      const s = tile.width;
      const grid = document.createElement('canvas');
      grid.width = grid.height = s * 3;
      const ctx = grid.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      for (let gy = 0; gy < 3; gy++) {
        for (let gx = 0; gx < 3; gx++) ctx.drawImage(decalImg, gx * s, gy * s, s, s);
      }
      ctx.drawImage(tile, s, s);
      preview.style.backgroundImage = `url(${grid.toDataURL('image/png')})`;
      preview.style.backgroundSize = '50% auto';   // the 3×3 block fills the height, repeating sideways
      previewCap.textContent = `${s}² tile · shown set among plain source tiles`
        + (seed != null ? ` · seed ${seed}` : '');
    } else {
      preview.style.backgroundImage = `url(${tile.toDataURL('image/png')})`;
      preview.style.backgroundSize = '';   // back to the stylesheet's 4 × 2 repeat
      previewCap.textContent = `${tile.width}² tile, shown tiled 4 × 2`
        + (seed != null ? ` · seed ${seed}` : '')
        + (mode === 'new' && !seamChk.checked ? ' · wrap blend off, edges will show' : '');
    }
  };

  const setTab = (m: GenMode) => {
    mode = m;
    for (const [v, b] of tabBtns) b.classList.toggle('on', v === m);
    panelNew.style.display = m === 'new' ? '' : 'none';
    panelTrans.style.display = m === 'transition' ? '' : 'none';
    panelDecal.style.display = m === 'decal' ? '' : 'none';
    inpaintWrap.style.display = m === 'new' ? 'none' : '';
    refreshSuggestion();
    refresh();
    renderPreview();
    (m === 'new' ? subject : m === 'transition' ? transDesc : decalDesc).focus();
  };

  // ---- the library pick behind the A / C / source slots ----
  /** Hide the dialog, borrow the Library's pick mode, restore on answer. The pick grid's "no texture" cell
   *  counts as backing out here — an inpaint input has to BE a texture. */
  const pickInto = (pickTitle: string, current: TexRef | null, set: (ref: TexRef) => void) => {
    back.style.display = 'none';
    deps.pickTexture({
      title: pickTitle,
      current,
      onPick: ref => { back.style.display = ''; if (ref) set(ref); },
      onCancel: () => { back.style.display = ''; },
    });
  };

  /** A / C / rotation changed: the old result no longer reflects its inputs, so it is dropped rather than
   *  left previewing something the next Generate will contradict. */
  let bPreviewToken = 0;
  /** Point the B box at a canvas, or back at its empty label. */
  const showSlotB = (cv: HTMLCanvasElement | null) => {
    if (!cv) {
      slotB.classList.add('empty');
      slotB.style.backgroundImage = '';
      slotB.textContent = 'B — generated';
      return;
    }
    slotB.classList.remove('empty');
    slotB.textContent = '';
    slotB.style.backgroundImage = `url(${cv.toDataURL()})`;
  };
  /** Re-derive the B box from state: the result if one exists, else the compose that WOULD be sent (ends in
   *  place, the strip bridged for fal to repaint), else the empty label. Generate routes through here too,
   *  so a stale result can never sit in B looking like an input. */
  const refreshSlotB = () => {
    const token = ++bPreviewToken;
    if (raws.transition) { showSlotB(downscale(raws.transition, 256)); return; }
    if (!trans.a || !trans.c) { showSlotB(null); return; }
    void Promise.all([loadTex(trans.a), loadTex(trans.c)]).then(([a, c]) => {
      if (token !== bPreviewToken) return;
      showSlotB(composeTransition(a, c, trans.rotA, trans.rotC, 256, true, vertChk.checked));
    }).catch(() => { /* thumbnail only — Generate reports real load failures */ });
  };
  const onTransChanged = () => {
    raws.transition = null;
    seeds.transition = null;
    transImgs = null;
    abc.classList.toggle('vert', vertChk.checked);   // the boxes stack the way the tiles will
    slotA.set(trans.a, trans.rotA);
    slotC.set(trans.c, trans.rotC);
    rotA.disabled = !trans.a;
    rotC.disabled = !trans.c;
    refreshSlotB();
    refreshSuggestion();
    refresh();
    renderPreview();
  };
  // orientation changes the compose, the mask and the prompt, so it invalidates like an end swap does
  vertChk.onchange = () => { transRig.sync(); onTransChanged(); };
  slotA.el.onclick = () => pickInto('Choose texture A — the left material', trans.a,
    ref => { trans.a = ref; onTransChanged(); });
  slotC.el.onclick = () => pickInto('Choose texture C — the right material', trans.c,
    ref => { trans.c = ref; onTransChanged(); });
  rotA.onclick = () => { trans.rotA = (trans.rotA + 1) % 4; onTransChanged(); };
  rotC.onclick = () => { trans.rotC = (trans.rotC + 1) % 4; onTransChanged(); };

  const onDecalChanged = () => {
    raws.decal = null;
    seeds.decal = null;
    decalImg = null;
    slotS.set(decal.ref, 0);
    refreshSuggestion();
    refresh();
    renderPreview();
  };
  slotS.el.onclick = () => pickInto('Choose the decal’s source texture', decal.ref,
    ref => { decal.ref = ref; onDecalChanged(); });

  modelSel.onchange = refresh;
  inpaintSel.onchange = refresh;
  vwrapChk.onchange = refresh;   // the price doubles and halves with it
  genSel.onchange = refresh;
  storeSel.onchange = () => { refresh(); renderPreview(); };
  seamChk.onchange = () => { refresh(); renderPreview(); };

  generate.onclick = async () => {
    const key = loadSettings().falKey.trim();
    if (!key || busy || generate.disabled) return;
    busy = true;
    refresh();
    previewCap.textContent = 'Calling fal.ai — a few seconds…';
    try {
      const genSize = Number(genSel.value);
      const usedModel = mode === 'new' ? modelSel.value : inpaintSel.value;
      if (mode === 'new') {
        const { image, seed } = await callFal(key, modelSel.value, prompt.value, genSize);
        raws.new = image;
        seeds.new = seed;
      } else if (mode === 'transition') {
        const vert = vertChk.checked;
        const [a, c] = await Promise.all([loadTex(trans.a!), loadTex(trans.c!)]);
        const band = transBandRect(genSize, vert);
        // sent: both ends composed, the strip replaced by a neutral bridge — rebuilt from A and C on every
        // run, so nothing of a previous generation can ride along into a regenerate
        const sent = composeTransition(a, c, trans.rotA, trans.rotC, genSize, true, vert);
        ++bPreviewToken;                  // outrank any in-flight thumbnail
        showSlotB(downscale(sent, 256));  // B shows exactly what is in flight, not the old answer
        const { image, seed } = await callFalInpaint(key, inpaintSel.value, transRig.value(),
          sent, maskCanvas(genSize, band));
        // keep the model's strip, put OUR ends back bit-for-bit — the seam guarantee lives right here
        let result = compositeMasked(
          composeTransition(a, c, trans.rotA, trans.rotC, genSize, false, vert),
          image, band, genSize / FEATHER_DIV);
        if (vwrapChk.checked) {
          // Wrap repair: roll half a tile across the blend so the strip's wrap seam sits mid-frame, inpaint
          // just that join (limited to the strip — A and C never enter the mask), roll back. The healed
          // pixels are now the tile's wrap edge, so Bs repeated along the strip meet by construction; what
          // ends up at the edges was mid-frame continuity in the healed image. Rolling twice by half is the
          // identity, so A and C come back pixel-exact outside the healed patch.
          previewCap.textContent = 'Repairing the wrap seam — second call…';
          const roll = (cv: HTMLCanvasElement) => vert ? rollX(cv, genSize / 2) : rollY(cv, genSize / 2);
          const heal: Rect = vert
            ? { x: genSize / 3, y: band.y, w: genSize / 3, h: band.h }
            : { x: band.x, y: genSize / 3, w: band.w, h: genSize / 3 };
          const rolled = roll(result);
          const sentHeal = roll(result);
          // bridge the join out of the sent pixels — a conditioning model handed the seam it is meant to
          // erase will happily hand it back
          bridgeFill(sentHeal, heal, vert ? 'x' : 'y');
          const { image: healed } = await callFalInpaint(key, inpaintSel.value,
            healPromptFor(transDesc.value.trim(), vert), sentHeal, maskCanvas(genSize, heal));
          result = roll(compositeMasked(rolled, healed, heal, genSize / FEATHER_DIV));
        }
        raws.transition = result;
        seeds.transition = seed;
        transImgs = { a, c, rotA: trans.rotA, rotC: trans.rotC, vert };
        refreshSlotB();                   // the B box graduates from bridged strip to answer
      } else {
        const src = await loadTex(decal.ref!);
        const base = squareCanvas(genSize);
        const bctx = base.getContext('2d')!;
        bctx.imageSmoothingQuality = 'high';
        bctx.drawImage(src, 0, 0, genSize, genSize);
        const box: Rect = {
          x: genSize * DECAL_BOX.x0, y: genSize * DECAL_BOX.y0,
          w: genSize * (DECAL_BOX.x1 - DECAL_BOX.x0), h: genSize * (DECAL_BOX.y1 - DECAL_BOX.y0),
        };
        // the source is sent UNBLANKED — the decal goes on the material, so the model should see it
        const { image, seed } = await callFalInpaint(key, inpaintSel.value, decalRig.value(),
          base, maskCanvas(genSize, box));
        raws.decal = compositeMasked(base, image, box, genSize / FEATHER_DIV);
        seeds.decal = seed;
        decalImg = src;
      }
      generations[mode] = createFalGenerationProvenance([usedModel]);
      // remember the choices that produced a result, so the dialog reopens where the author left it
      saveSettings({ texGen: {
        model: modelSel.value, inpaintModel: inpaintSel.value, genSize,
        storeSize: Number(storeSel.value), seamless: seamChk.checked, vwrapPass: vwrapChk.checked,
        transVertical: vertChk.checked,
      } });
      busy = false;
      refresh();
      renderPreview();
    } catch (e) {
      busy = false;
      refresh();
      refreshSlotB();   // the failed run's in-flight compose stands down for whatever state still holds
      const msg = e instanceof Error ? e.message : String(e);
      previewCap.textContent = '';
      toast(`Generation failed — ${msg}`, 'err', 8000);
    }
  };

  // Add, and STAY OPEN. Generating a usable material is a numbers game — you run it several times and keep
  // the ones that worked — so closing on the first keeper would make the common path "reopen the dialog,
  // retype the prompt, pick the model again". The name field rolls forward instead, so the next add lands
  // beside this one rather than on top of it.
  save.onclick = async () => {
    const tile = buildStored();
    const generation = generations[mode];
    if (!tile || !generation || busy) return;
    busy = true;
    refresh();
    try {
      const blob = await new Promise<Blob>((ok, err) =>
        tile.toBlob(b => (b ? ok(b) : err(new Error('PNG encode failed'))), 'image/png'));
      const stem = (name.value.trim() || suggestedName() || 'generated').replace(/\.png$/i, '');
      const res = await clientFetch(`/api/texture-upload?name=${encodeURIComponent(stem)}`, {
        method: 'POST',
        headers: { [FAL_GENERATION_HEADER]: JSON.stringify(generation) },
        body: blob,
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
      // the store answers with the name it used: a name already in the bank lands beside it as <name>_2,
      // so the tile that gets armed below is the one that actually exists (docs/038)
      const stored = await res.json() as { name: string };
      added++;
      taken.add(stored.name.replace(/\.png$/i, '').toLowerCase());
      name.value = '';                 // back to the suggestion, which now dodges the name just used
      refreshSuggestion();
      busy = false;
      refresh();
      await deps.onSaved(stored.name); // reloads the Custom grid behind the dialog and arms the new tile
      toast(`✓ ${stored.name} added at ${tile.width}²${added > 1 ? ` (${added} this session)` : ''}`
        + ' — generate again for another, or Close when you’re done.', 'ok', 4500);
    } catch (e) {
      busy = false;
      refresh();
      toast(`Could not store the tile — ${e instanceof Error ? e.message : String(e)}`, 'err', 6000);
    }
  };

  // A hand-edited prompt is the author's now — the subject stops rewriting it, and the disclosure is forced
  // open so it is never edited-but-hidden, which would make the dialog quietly lie about what it will send.
  // route through the same resync as the description, so the summary and Recompose button react too
  prompt.oninput = () => { promptEdited = true; onSubjectChanged(); };
  reset.onclick = () => { promptEdited = false; onSubjectChanged(); };
  subject.oninput = onSubjectChanged;
  transDesc.oninput = () => { transRig.sync(); refreshSuggestion(); refresh(); };
  decalDesc.oninput = () => { decalRig.sync(); refreshSuggestion(); refresh(); };
  const enterGenerates = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !generate.disabled) { e.preventDefault(); generate.click(); }
  };
  subject.onkeydown = enterGenerates;
  transDesc.onkeydown = enterGenerates;
  decalDesc.onkeydown = enterGenerates;
  onSubjectChanged();
  onTransChanged();   // applies the remembered orientation to the A · B · C boxes before first show
  void reloadTaken();
  setTab('new');
}

/** POST to one of the dev-server's fal proxies (see server/routes/fal.ts) and hand back the raw success
 *  Response; a failure decodes the proxy's JSON error into a thrown sentence. Split from postFal for the
 *  Generate prop dialog, whose /api/fal-3d answer is a GLB rather than an image. */
export async function falFetch(route: string, key: string, body: Record<string, unknown>): Promise<Response> {
  const res = await clientFetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fal-key': key },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // the proxy answers JSON on failure and bytes on success; a non-JSON body here means the route is missing
    const text = await res.text().catch(() => '');
    let message = '';
    try { message = (JSON.parse(text) as { error?: string }).error ?? ''; } catch { /* not JSON */ }
    throw new Error(message || (res.status === 404
      ? `the ${route} route is missing — restart the dev server (Ctrl+C, npm run dev) to pick it up`
      : `${res.status} ${res.statusText}`.trim()));
  }
  return res;
}

/** POST to one of the dev-server's fal proxies and decode the PNG it answers into a canvas at its native
 *  size — square for the texture flows, 2:1 for the skybox one. Exported for the Generate skybox dialog. */
export async function postFal(route: string, key: string, body: Record<string, unknown>):
Promise<{ image: HTMLCanvasElement; seed: number | null }> {
  const res = await falFetch(route, key, body);
  const seedHeader = res.headers.get('x-fal-seed');
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const seed = seedHeader != null && seedHeader !== '' ? Number(seedHeader) : null;
  return { image: canvas, seed: seed != null && Number.isFinite(seed) ? seed : null };
}

const callFal = (key: string, model: string, prompt: string, size: number) =>
  postFal('/api/fal-texture', key, { model, prompt, size });

/** The image and mask travel as PNG data URIs — fal accepts them wherever it takes an image URL, so nothing
 *  is uploaded anywhere first and the proxy passes them through untouched. */
const callFalInpaint = (key: string, model: string, prompt: string,
  image: HTMLCanvasElement, mask: HTMLCanvasElement) =>
  postFal('/api/fal-inpaint', key, {
    model, prompt,
    image: image.toDataURL('image/png'),
    mask: mask.toDataURL('image/png'),
  });

/** The generation → stored tile pipeline: wrap-blend first (at full resolution, where the cross-fade has
 *  pixels to work with), then downscale. Doing it the other way round blends 128² mush. */
function buildTile(raw: HTMLCanvasElement, storeSize: number, seamless: boolean): HTMLCanvasElement {
  return downscale(seamless ? seamlessBlend(raw) : raw, storeSize);
}

function squareCanvas(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/** Roll a square canvas vertically by `dy` pixels, wrapping — drawn twice so the seam land is covered.
 *  Rolling by half the height twice is the identity, which is what lets the wrap repair pass hand A and C
 *  back pixel-exact. */
function rollY(src: HTMLCanvasElement, dy: number): HTMLCanvasElement {
  const out = squareCanvas(src.width);
  const ctx = out.getContext('2d')!;
  ctx.drawImage(src, 0, dy);
  ctx.drawImage(src, 0, dy - src.height);
  return out;
}

/** rollY's sibling for the vertical-stack layout, whose wrap repair runs across the tile instead. */
function rollX(src: HTMLCanvasElement, dx: number): HTMLCanvasElement {
  const out = squareCanvas(src.width);
  const ctx = out.getContext('2d')!;
  ctx.drawImage(src, dx, 0);
  ctx.drawImage(src, dx - src.width, 0);
  return out;
}

/** Draw `img` scaled to a size² square whose top-left sits at (x, y), rotated about that square's centre in
 *  quarter turns — how the transition ends carry their rotation into both the compose and the preview strip. */
function drawRotated(ctx: CanvasRenderingContext2D, img: CanvasImageSource, size: number, quarters: number,
  x = 0, y = 0) {
  ctx.save();
  ctx.translate(x + size / 2, y + size / 2);
  ctx.rotate(quarters * Math.PI / 2);
  ctx.drawImage(img, -size / 2, -size / 2, size, size);
  ctx.restore();
}

/**
 * Fill `r` with a linear blend of the two pixel lines just OUTSIDE its edges along `axis` — a smooth,
 * seam-free, content-free bridge across the gap. This is what the repaint zone is "cleared" to before
 * sending, instead of flat grey: a fill-style model ignores masked content either way, but a
 * controlnet-style one (Z-Image) CONDITIONS on it — flat grey anchors the strip toward grey mush, and the
 * repair pass would be conditioned on the very seam it exists to erase.
 */
function bridgeFill(cv: HTMLCanvasElement, r: Rect, axis: 'x' | 'y') {
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h);
  const out = ctx.createImageData(w, h);
  if (axis === 'x') {
    const a = ctx.getImageData(x - 1, y, 1, h).data;
    const b = ctx.getImageData(x + w, y, 1, h).data;
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const t = (col + 1) / (w + 1);
        const o = (row * w + col) * 4, i = row * 4;
        for (let ch = 0; ch < 4; ch++) out.data[o + ch] = a[i + ch] * (1 - t) + b[i + ch] * t;
      }
    }
  } else {
    const a = ctx.getImageData(x, y - 1, w, 1).data;
    const b = ctx.getImageData(x, y + h, w, 1).data;
    for (let row = 0; row < h; row++) {
      const t = (row + 1) / (h + 1);
      for (let col = 0; col < w; col++) {
        const o = (row * w + col) * 4, i = col * 4;
        for (let ch = 0; ch < 4; ch++) out.data[o + ch] = a[i + ch] * (1 - t) + b[i + ch] * t;
      }
    }
  }
  ctx.putImageData(out, x, y);
}

/**
 * The Transition tab's compose: A fills one half, C the other (side by side, or stacked when `vert`), each
 * rotated as asked. `bridgeBand` replaces the repaint strip with bridgeFill's neutral blend — used for what
 * is SENT and for the B-box preview (so the gap reads as "to be repainted"); the composite base keeps the
 * halves intact. The half/half split puts A's own leading edge at the tile's edge and C's own trailing edge
 * at the other, which is what makes a painted A · B · C sequence seam exactly like A and C tiling against
 * themselves.
 */
function composeTransition(a: CanvasImageSource, c: CanvasImageSource, rotA: number, rotC: number,
  size: number, bridgeBand: boolean, vert: boolean): HTMLCanvasElement {
  const cv = squareCanvas(size);
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  drawRotated(ctx, a, size, rotA);
  ctx.save();
  ctx.beginPath();
  if (vert) ctx.rect(0, size / 2, size, size / 2);
  else ctx.rect(size / 2, 0, size / 2, size);
  ctx.clip();
  drawRotated(ctx, c, size, rotC);
  ctx.restore();
  if (bridgeBand) bridgeFill(cv, transBandRect(size, vert), vert ? 'y' : 'x');
  return cv;
}

/** The mask fal reads: white = repaint, black = keep. Binary on purpose (rounded to whole pixels — a
 *  fractional fillRect antialiases into grey, and grey mask pixels mean "partially repaint" to some
 *  models) — the soft edge belongs to compositeMasked, where it is applied to pixels we control. */
function maskCanvas(size: number, r: Rect): HTMLCanvasElement {
  const cv = squareCanvas(size);
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#fff';
  ctx.fillRect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
  return cv;
}

/**
 * Keep the model's pixels inside the mask and the ORIGINAL pixels outside it, cross-fading over a few
 * pixels at the boundary. Inpainting endpoints re-encode the whole frame, so "unmasked" pixels come back
 * approximately right — and approximately is exactly what a tiling edge cannot afford. Putting the source
 * art back bit-for-bit everywhere that wasn't being painted is what turns the Transition tab's seam claim
 * and the Decal tab's still-tiles claim from "the model usually behaves" into construction.
 */
function compositeMasked(base: HTMLCanvasElement, generated: HTMLCanvasElement, r: Rect, feather: number): HTMLCanvasElement {
  const size = base.width;
  const soft = squareCanvas(size);
  const sc = soft.getContext('2d')!;
  sc.filter = `blur(${feather}px)`;      // the mask's hard step, softened into an alpha ramp
  sc.fillStyle = '#fff';
  sc.fillRect(r.x, r.y, r.w, r.h);
  const layer = squareCanvas(size);
  const lc = layer.getContext('2d')!;
  lc.imageSmoothingQuality = 'high';
  lc.drawImage(generated, 0, 0, size, size);
  lc.globalCompositeOperation = 'destination-in';
  lc.drawImage(soft, 0, 0);
  const out = squareCanvas(size);
  const oc = out.getContext('2d')!;
  oc.drawImage(base, 0, 0);
  oc.drawImage(layer, 0, 0);
  return out;
}

/** Canvas wrapper around the core wrap-offset blend (core/paint/seamless.ts, where the tiling argument and
 *  its test live). Runs at generation resolution, where the cross-fade has pixels to work with. */
function seamlessBlend(src: HTMLCanvasElement): HTMLCanvasElement {
  const size = src.width;
  const ctx = src.getContext('2d', { willReadFrequently: true })!;
  const from = ctx.getImageData(0, 0, size, size);
  const blended = makeSeamless({ w: size, h: size, data: new Uint8Array(from.data) });
  const out = squareCanvas(size);
  out.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(blended.data), size, size), 0, 0);
  return out;
}

/** Halve repeatedly down to the target. A single 1024 → 128 drawImage undersamples badly on some GPUs;
 *  successive halving averages every source pixel in, which is what makes the downscale read as detail. */
function downscale(src: HTMLCanvasElement, target: number): HTMLCanvasElement {
  let cur = src;
  while (cur.width > target * 2) {
    const next = squareCanvas(cur.width >> 1);
    const ctx = next.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, next.width, next.height);
    cur = next;
  }
  if (cur.width === target) return cur;
  const out = squareCanvas(target);
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, target, target);
  return out;
}

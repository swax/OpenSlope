import {
  adoptAccount,
  currentAccount,
  type EquipmentDesignSummary,
  type EquipmentLibrarySummary,
  type EquipmentProfile,
  type Member,
} from '../../net/account';
import { fetchJson, postJson } from '../../net/fetch-json';
import { equipmentTextureRegions, type EquipmentTextureRegion, type RideGear } from '../../ride/gear';
import { clampCoverCrop, coverCropRect, zoomCoverCrop } from '../components/square-crop';
import { infoBadge } from '../components/info';
import { blobDataUrl, encodeCanvas } from './settings-dialog-image';

const EQUIPMENT_HELP = 'Make a named design by loading a separate image beneath every mapped section. Click a '
  + 'section in the preview to select it, then drag and zoom only that image. Save bakes the sections into one '
  + 'fixed square texture. Edit reopens those baked strips for renaming, replacement, or reframing; the original '
  + 'full-size source images outside each saved strip are not retained. '
  + 'A snowboard has top and bottom sections. Skis have left front, right front, left back and right back strips. '
  + 'Use the design list to equip an earlier result or stock artwork, and Delete to stage an old design for removal. '
  + 'The exact procedural silhouette shows which pixels reach the equipment. Sidewalls and end caps use the solid '
  + 'edge colour below.';

export type EquipmentSaveResult = 'saved' | null;

interface EquipmentSection {
  el: HTMLDivElement;
  save: () => Promise<EquipmentSaveResult>;
  dispose: () => void;
}

interface EquipmentCrop {
  image: ImageBitmap;
  zoom: number;
  /** Output-region offsets, where 1 is that atlas strip's full width/height. */
  offsetX: number;
  offsetY: number;
}

const EQUIPMENT_CROP_SIZE = 1024;
const EQUIPMENT_CROP_MAX_ZOOM = 6;

/** Decode an arbitrary aspect ratio once; the live crop keeps this bitmap until Save or Close. */
async function loadEquipmentCrop(file: File): Promise<EquipmentCrop> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > 16 * 1024 * 1024) throw new Error('Choose an image smaller than 16 MB.');
  let image: ImageBitmap;
  try { image = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('That image could not be opened.'); }
  if (!image.width || !image.height) { image.close(); throw new Error('That image has no usable pixels.'); }
  const longest = Math.max(image.width, image.height);
  if (longest > 4096) {
    const scale = 4096 / longest;
    try {
      const resized = await createImageBitmap(image, {
        resizeWidth: Math.max(1, Math.round(image.width * scale)),
        resizeHeight: Math.max(1, Math.round(image.height * scale)), resizeQuality: 'high',
      });
      image.close();
      image = resized;
    } catch {
      image.close();
      throw new Error('That image is too large for this browser to prepare.');
    }
  }
  return { image, zoom: 1, offsetX: 0, offsetY: 0 };
}

interface EquipmentDraft {
  name: string;
  crops: Array<EquipmentCrop | undefined>;
  /** Present when Save should replace a design instead of adding another library entry. */
  editingId?: string;
}

const equipmentRegionCount = (gear: RideGear): number => gear === 'snowboard' ? 2 : 4;

/** Split a baked saved atlas back into its independently editable strips. */
async function loadSavedEquipmentDraft(gear: RideGear, design: EquipmentDesignSummary): Promise<EquipmentDraft> {
  const response = await fetch(design.textureUrl);
  if (!response.ok) throw new Error(`The saved ${gear === 'snowboard' ? 'snowboard' : 'ski'} artwork could not be opened.`);
  let image: ImageBitmap;
  try { image = await createImageBitmap(await response.blob()); }
  catch { throw new Error('That saved equipment image could not be opened.'); }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = EQUIPMENT_CROP_SIZE;
  const context = canvas.getContext('2d');
  if (!context) { image.close(); throw new Error('This browser cannot edit saved equipment images.'); }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  const count = equipmentRegionCount(gear);
  const stripWidth = canvas.width / count;
  const crops: EquipmentCrop[] = [];
  try {
    for (let index = 0; index < count; index++) crops.push({
      image: await createImageBitmap(canvas, index * stripWidth, 0, stripWidth, canvas.height),
      zoom: 1, offsetX: 0, offsetY: 0,
    });
  } catch {
    for (const crop of crops) crop.image.close();
    throw new Error('That saved equipment image could not be prepared for editing.');
  }
  return { name: design.name, crops, editingId: design.id };
}

/** Draw every independently framed source into its atlas strip; strip clipping prevents neighbours bleeding. */
function drawEquipmentDraft(canvas: HTMLCanvasElement, gear: RideGear, draft: EquipmentDraft): void {
  if (canvas.width !== EQUIPMENT_CROP_SIZE) canvas.width = canvas.height = EQUIPMENT_CROP_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot crop equipment images.');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  const count = equipmentRegionCount(gear);
  const stripWidth = canvas.width / count;
  for (let index = 0; index < count; index++) {
    const crop = draft.crops[index];
    if (!crop) continue;
    const x = index * stripWidth;
    const rect = coverCropRect(crop, stripWidth, canvas.height);
    context.save();
    context.beginPath();
    context.rect(x, 0, stripWidth, canvas.height);
    context.clip();
    context.drawImage(crop.image, x + rect.x, rect.y, rect.width, rect.height);
    context.restore();
  }
}

/** Encode exactly what the atlas preview shows; server-side validation independently checks the result. */
async function prepareEquipmentTexture(gear: RideGear, draft: EquipmentDraft): Promise<string> {
  if (draft.crops.length !== equipmentRegionCount(gear) || draft.crops.some(crop => !crop))
    throw new Error(`Load all ${equipmentRegionCount(gear)} artwork sections before saving.`);
  const canvas = document.createElement('canvas');
  drawEquipmentDraft(canvas, gear, draft);
  let encoded = await encodeCanvas(canvas, 'image/webp', 0.9);
  if (encoded.size > 1024 * 1024) encoded = await encodeCanvas(canvas, 'image/jpeg', 0.78);
  if (encoded.size > 1024 * 1024) encoded = await encodeCanvas(canvas, 'image/jpeg', 0.64);
  if (encoded.size > 1024 * 1024) throw new Error('That texture could not be compressed below 1 MB.');
  return await blobDataUrl(encoded);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Dim everything the exact procedural plan does not sample, then trace, label, and select mapped regions. */
function equipmentOverlay(gear: RideGear, selectedRegion?: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 1000 1000');
  svg.setAttribute('aria-hidden', 'true');
  const regions = equipmentTextureRegions(gear);
  const polygonPath = (points: EquipmentTextureRegion['points']) => points
    .map(([x, y], index) => `${index ? 'L' : 'M'}${(x * 1000).toFixed(1)} ${(y * 1000).toFixed(1)}`).join(' ') + ' Z';
  const shade = document.createElementNS(SVG_NS, 'path');
  shade.setAttribute('d', `M0 0H1000V1000H0Z ${regions.map(region => polygonPath(region.points)).join(' ')}`);
  shade.setAttribute('fill', 'rgba(5,13,20,.62)');
  shade.setAttribute('fill-rule', 'evenodd');
  svg.appendChild(shade);
  for (const [index, region] of regions.entries()) {
    const selected = index === selectedRegion;
    const outline = document.createElementNS(SVG_NS, 'path');
    outline.setAttribute('d', polygonPath(region.points));
    outline.setAttribute('fill', selected ? 'rgba(255,177,83,.22)' : 'rgba(205,239,255,.13)');
    outline.setAttribute('stroke', selected ? '#ffc16f' : 'rgba(224,246,255,.78)');
    outline.setAttribute('stroke-width', selected ? '8' : '5');
    outline.setAttribute('vector-effect', 'non-scaling-stroke');
    const label = document.createElementNS(SVG_NS, 'text');
    const centre = region.points.reduce(([x, y], point) => [x + point[0], y + point[1]], [0, 0]);
    label.setAttribute('x', String(centre[0] * 1000 / region.points.length));
    label.setAttribute('y', String(centre[1] * 1000 / region.points.length));
    label.setAttribute('fill', '#f2f8fc');
    label.setAttribute('stroke', 'rgba(0,0,0,.8)');
    label.setAttribute('stroke-width', '5');
    label.setAttribute('paint-order', 'stroke');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'middle');
    label.setAttribute('font-size', gear === 'snowboard' ? '34' : '23');
    label.setAttribute('font-family', 'system-ui, sans-serif');
    label.setAttribute('font-weight', '700');
    label.textContent = region.label;
    svg.append(outline, label);
  }
  return svg;
}

/** Named design libraries plus one unsaved, independently framed per-region draft for each gear. */
export function buildEquipmentSection(): EquipmentSection {
  const sec = document.createElement('div');
  sec.className = 'sec equipment';
  const title = document.createElement('h3');
  title.textContent = 'Board & ski artwork';
  title.appendChild(infoBadge(EQUIPMENT_HELP));

  const toggle = document.createElement('div');
  toggle.className = 'equipment-switch';
  const boardButton = document.createElement('button');
  boardButton.type = 'button'; boardButton.textContent = 'Snowboard';
  const skiButton = document.createElement('button');
  skiButton.type = 'button'; skiButton.textContent = 'Skis';
  toggle.append(boardButton, skiButton);
  const libraryRow = document.createElement('div');
  libraryRow.className = 'equipment-library';
  libraryRow.append(document.createTextNode('Design'));
  const librarySelect = document.createElement('select');
  librarySelect.setAttribute('aria-label', 'Saved equipment design');
  librarySelect.disabled = true;
  const makeNew = document.createElement('button');
  makeNew.type = 'button'; makeNew.className = 'sp-btn'; makeNew.textContent = 'New'; makeNew.disabled = true;
  const editDesign = document.createElement('button');
  editDesign.type = 'button'; editDesign.className = 'sp-btn'; editDesign.textContent = 'Edit';
  editDesign.disabled = true;
  const deleteDesign = document.createElement('button');
  deleteDesign.type = 'button'; deleteDesign.className = 'sp-btn'; deleteDesign.textContent = 'Delete';
  deleteDesign.disabled = true;
  libraryRow.append(librarySelect, makeNew, editDesign, deleteDesign);
  const nameRow = document.createElement('label');
  nameRow.className = 'equipment-name';
  nameRow.style.display = 'none';
  nameRow.append(document.createTextNode('Design name'));
  const designName = document.createElement('input');
  designName.type = 'text'; designName.maxLength = 40; designName.placeholder = 'Name this design';
  nameRow.append(designName);
  const preview = document.createElement('div');
  preview.className = 'equipment-preview';
  preview.setAttribute('aria-label', 'Equipment texture mapping preview');
  const storedImage = document.createElement('img');
  storedImage.alt = '';
  storedImage.onerror = () => { storedImage.style.display = 'none'; };
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropCanvas.height = EQUIPMENT_CROP_SIZE;
  let overlay = equipmentOverlay('snowboard');
  preview.append(storedImage, cropCanvas, overlay);
  const regionLoads = document.createElement('div');
  regionLoads.className = 'equipment-region-loads';
  regionLoads.style.display = 'none';
  const input = document.createElement('input');
  input.className = 'equipment-file'; input.type = 'file'; input.accept = 'image/*';
  const zoomRow = document.createElement('div');
  zoomRow.className = 'equipment-zoom';
  zoomRow.style.display = 'none';
  zoomRow.append(document.createTextNode('Zoom'));
  const zoom = document.createElement('input');
  zoom.type = 'range'; zoom.min = '1'; zoom.max = String(EQUIPMENT_CROP_MAX_ZOOM);
  zoom.step = '0.01'; zoom.value = '1'; zoom.disabled = true;
  const zoomValue = document.createElement('output');
  zoomValue.textContent = '100%';
  const fit = document.createElement('button');
  fit.type = 'button'; fit.className = 'sp-btn'; fit.textContent = 'Fit'; fit.disabled = true;
  zoomRow.append(zoom, zoomValue, fit);
  const colorRow = document.createElement('label');
  colorRow.className = 'edge-color';
  colorRow.append(document.createTextNode('Edge / sidewall colour'));
  const edgeColor = document.createElement('input');
  edgeColor.type = 'color'; edgeColor.value = '#20242c'; edgeColor.disabled = true;
  colorRow.appendChild(edgeColor);
  const state = document.createElement('div');
  state.className = 'state'; state.textContent = 'Reading your account…';
  sec.append(title, toggle, libraryRow, nameRow, preview, regionLoads, zoomRow, colorRow, input, state);

  const DRAFT = '__draft__';
  type SelectedDesign = string | null | typeof DRAFT;
  interface GearState {
    designs: EquipmentDesignSummary[];
    initialSelectedId?: string;
    selected: SelectedDesign;
    deleted: Set<string>;
    draft?: EquipmentDraft;
  }
  const gearStates: Record<RideGear, GearState> = {
    snowboard: { designs: [], selected: null, deleted: new Set() },
    skis: { designs: [], selected: null, deleted: new Set() },
  };
  const selectedRegions: Record<RideGear, number> = { snowboard: 0, skis: 0 };
  let selected: RideGear = 'snowboard';
  let member: Member | null = null;
  let colorDirty = false;
  let preparing: Promise<void> | null = null;
  let disposed = false;
  let saving = false;
  let disposeAfterSave = false;
  let dragging: { pointerId: number; gear: RideGear; region: number; x: number; y: number } | null = null;

  const availableDesigns = (gear: RideGear) => gearStates[gear].designs
    .filter(design => !gearStates[gear].deleted.has(design.id));
  const currentDesign = (gear: RideGear) => {
    const value = gearStates[gear].selected;
    return typeof value === 'string' && value !== DRAFT
      ? availableDesigns(gear).find(design => design.id === value) : undefined;
  };
  const selectedCrop = (gear = selected) => gearStates[gear].selected === DRAFT
    ? gearStates[gear].draft?.crops[selectedRegions[gear]] : undefined;
  const discardDraft = (draft: EquipmentDraft | undefined) => {
    if (!draft) return;
    for (let index = 0; index < draft.crops.length; index++) {
      draft.crops[index]?.image.close();
      draft.crops[index] = undefined;
    }
  };
  const setState = (message: string, tone: '' | 'set' | 'warn' = '') => {
    state.className = `state${tone ? ` ${tone}` : ''}`;
    state.textContent = message;
  };
  const freshName = (gear: RideGear) => {
    const base = gear === 'snowboard' ? 'My snowboard' : 'My skis';
    const names = new Set(gearStates[gear].designs.map(design => design.name.toLocaleLowerCase()));
    if (!names.has(base.toLocaleLowerCase())) return base;
    for (let suffix = 2; ; suffix++) if (!names.has(`${base} ${suffix}`.toLocaleLowerCase())) return `${base} ${suffix}`;
  };
  const startDraft = (gear: RideGear) => {
    const gearState = gearStates[gear];
    if (gearState.draft?.editingId) {
      discardDraft(gearState.draft);
      gearState.draft = undefined;
    }
    gearState.draft ??= {
      name: freshName(gear), crops: Array.from({ length: equipmentRegionCount(gear) }, () => undefined),
    };
    gearState.selected = DRAFT;
    selectedRegions[gear] = 0;
  };
  const syncControls = () => {
    const gearState = gearStates[selected];
    const draft = gearState.selected === DRAFT ? gearState.draft : undefined;
    const crop = selectedCrop();
    const busy = !!preparing || saving || disposed;
    boardButton.disabled = busy;
    skiButton.disabled = busy;
    librarySelect.disabled = !member || busy;
    makeNew.disabled = !member || busy;
    editDesign.disabled = !currentDesign(selected) || busy;
    deleteDesign.disabled = !currentDesign(selected) || busy;
    edgeColor.disabled = !member || busy;
    nameRow.style.display = draft ? 'grid' : 'none';
    regionLoads.style.display = draft ? 'grid' : 'none';
    zoomRow.style.display = draft ? 'flex' : 'none';
    designName.disabled = !draft || busy;
    fit.disabled = !crop || busy;
    zoom.disabled = !crop || busy;
    zoom.value = String(crop?.zoom ?? 1);
    zoomValue.textContent = `${Math.round((crop?.zoom ?? 1) * 100)}%`;
  };
  const drawDraft = (gear = selected) => {
    const draft = gearStates[gear].draft;
    if (!draft || gear !== selected) return;
    drawEquipmentDraft(cropCanvas, gear, draft);
    const crop = selectedCrop(gear);
    zoom.value = String(crop?.zoom ?? 1);
    zoomValue.textContent = `${Math.round((crop?.zoom ?? 1) * 100)}%`;
  };
  const renderLibrary = () => {
    const gearState = gearStates[selected];
    librarySelect.replaceChildren();
    const stock = document.createElement('option');
    stock.value = ''; stock.textContent = 'Stock equipment';
    librarySelect.appendChild(stock);
    for (const design of availableDesigns(selected)) {
      const option = document.createElement('option');
      option.value = design.id; option.textContent = design.name;
      librarySelect.appendChild(option);
    }
    if (gearState.draft) {
      const option = document.createElement('option');
      option.value = DRAFT;
      option.textContent = `${gearState.draft.editingId ? 'Unsaved changes' : 'Unsaved'} — ${gearState.draft.name || 'new design'}`;
      librarySelect.appendChild(option);
    }
    librarySelect.value = gearState.selected ?? '';
  };
  const renderRegionLoads = () => {
    const draft = gearStates[selected].draft;
    const regions = equipmentTextureRegions(selected);
    regionLoads.style.gridTemplateColumns = `repeat(${regions.length}, minmax(0, 1fr))`;
    regionLoads.replaceChildren(...regions.map((region, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = 'Load image';
      button.title = `${draft?.crops[index] ? 'Replace' : 'Load'} ${region.label.toLocaleLowerCase()} image`;
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', String(selectedRegions[selected] === index));
      button.classList.toggle('loaded', !!draft?.crops[index]);
      button.disabled = !draft || !!preparing || saving || disposed;
      button.onclick = () => {
        selectedRegions[selected] = index;
        render();
        input.click();
      };
      return button;
    }));
  };
  const render = () => {
    boardButton.setAttribute('aria-pressed', String(selected === 'snowboard'));
    skiButton.setAttribute('aria-pressed', String(selected === 'skis'));
    const gearState = gearStates[selected];
    const draft = gearState.selected === DRAFT ? gearState.draft : undefined;
    renderLibrary();
    renderRegionLoads();
    if (draft) designName.value = draft.name;
    const nextOverlay = equipmentOverlay(selected, draft ? selectedRegions[selected] : undefined);
    overlay.replaceWith(nextOverlay);
    overlay = nextOverlay;
    const design = currentDesign(selected);
    if (design) {
      storedImage.src = design.textureUrl;
      storedImage.style.display = 'block';
    } else {
      storedImage.removeAttribute('src');
      storedImage.style.display = 'none';
    }
    cropCanvas.style.display = draft ? 'block' : 'none';
    preview.classList.toggle('editable', !!selectedCrop());
    if (draft) drawEquipmentDraft(cropCanvas, selected, draft);
    syncControls();
    if (!member) return;
    const label = selected === 'snowboard' ? 'snowboard' : 'ski';
    if (draft) {
      const missing = draft.crops.filter(crop => !crop).length;
      setState(missing ? `Load ${missing} more ${label} section${missing === 1 ? '' : 's'}, then name and Save the design.`
        : draft.editingId
          ? `Editing “${draft.name || 'this design'}”. Select a strip to fine-tune it, then Save your changes.`
          : `All sections loaded. Select a strip to fine-tune it, then Save “${draft.name || 'this design'}”.`, 'set');
    } else if (design) {
      const staged = gearState.deleted.size ? ` ${gearState.deleted.size} deletion${gearState.deleted.size === 1 ? '' : 's'} staged.` : '';
      setState(`Previewing saved ${label} design “${design.name}”.${staged}`, gearState.deleted.size ? 'set' : '');
    } else {
      setState(`Stock ${label} artwork selected.${gearState.deleted.size ? ` ${gearState.deleted.size} deletion staged.` : ''}`,
        gearState.deleted.size ? 'set' : '');
    }
  };
  boardButton.onclick = () => { selected = 'snowboard'; render(); };
  skiButton.onclick = () => { selected = 'skis'; render(); };
  makeNew.onclick = () => { startDraft(selected); render(); };
  editDesign.onclick = () => {
    const gear = selected;
    const gearState = gearStates[gear];
    const design = currentDesign(gear);
    if (!design) return;
    if (gearState.draft?.editingId === design.id) {
      gearState.selected = DRAFT;
      render();
      return;
    }
    let failed = false;
    setState(`Opening “${design.name}” for editing…`);
    preparing = loadSavedEquipmentDraft(gear, design).then(draft => {
      if (disposed) { discardDraft(draft); return; }
      discardDraft(gearState.draft);
      gearState.draft = draft;
      gearState.selected = DRAFT;
      selectedRegions[gear] = 0;
    }).catch(error => {
      failed = true;
      setState(error instanceof Error ? error.message : String(error), 'warn');
    }).finally(() => {
      preparing = null;
      if (!failed && !disposed) render();
      else syncControls();
    });
    syncControls();
    renderRegionLoads();
  };
  librarySelect.onchange = () => {
    gearStates[selected].selected = librarySelect.value === DRAFT ? DRAFT : librarySelect.value || null;
    render();
  };
  deleteDesign.onclick = () => {
    const gearState = gearStates[selected];
    const design = currentDesign(selected);
    if (!design) return;
    gearState.deleted.add(design.id);
    gearState.selected = availableDesigns(selected)[0]?.id ?? null;
    render();
  };
  designName.oninput = () => {
    const draft = gearStates[selected].draft;
    if (!draft || gearStates[selected].selected !== DRAFT) return;
    draft.name = designName.value;
    renderLibrary();
  };
  input.onchange = () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const gear = selected;
    const region = selectedRegions[gear];
    const draft = gearStates[gear].draft;
    if (!draft || gearStates[gear].selected !== DRAFT) return;
    syncControls();
    setState('Loading image…');
    let failed = false;
    preparing = loadEquipmentCrop(file).then(crop => {
      if (disposed) { crop.image.close(); return; }
      draft.crops[region]?.image.close();
      draft.crops[region] = crop;
    }).catch(error => {
      failed = true;
      setState(error instanceof Error ? error.message : String(error), 'warn');
    })
      .finally(() => {
        preparing = null;
        if (!failed && !disposed) render();
        else syncControls();
      });
    syncControls();
    renderRegionLoads();
  };
  zoom.oninput = () => {
    const crop = selectedCrop();
    if (!crop) return;
    zoomCoverCrop(crop, Number(zoom.value), EQUIPMENT_CROP_MAX_ZOOM,
      1 / equipmentRegionCount(selected), 1);
    drawDraft();
  };
  fit.onclick = () => {
    const crop = selectedCrop();
    if (!crop) return;
    crop.zoom = 1; crop.offsetX = 0; crop.offsetY = 0;
    drawDraft();
  };
  preview.onpointerdown = event => {
    if (event.button !== 0 || gearStates[selected].selected !== DRAFT) return;
    const bounds = preview.getBoundingClientRect();
    const count = equipmentRegionCount(selected);
    selectedRegions[selected] = Math.max(0, Math.min(count - 1,
      Math.floor((event.clientX - bounds.left) / Math.max(1, bounds.width) * count)));
    render();
    if (!selectedCrop()) return;
    dragging = { pointerId: event.pointerId, gear: selected, region: selectedRegions[selected],
      x: event.clientX, y: event.clientY };
    preview.setPointerCapture(event.pointerId);
    preview.classList.add('dragging');
    event.preventDefault();
  };
  preview.onpointermove = event => {
    if (!dragging || dragging.pointerId !== event.pointerId) return;
    const crop = gearStates[dragging.gear].draft?.crops[dragging.region];
    if (!crop) return;
    const count = equipmentRegionCount(dragging.gear);
    crop.offsetX += (event.clientX - dragging.x) / Math.max(1, preview.clientWidth / count);
    crop.offsetY += (event.clientY - dragging.y) / Math.max(1, preview.clientHeight);
    dragging.x = event.clientX; dragging.y = event.clientY;
    clampCoverCrop(crop, 1 / count, 1);
    drawDraft(dragging.gear);
  };
  const stopDragging = (event: PointerEvent) => {
    if (!dragging || dragging.pointerId !== event.pointerId) return;
    dragging = null;
    preview.classList.remove('dragging');
    if (preview.hasPointerCapture(event.pointerId)) preview.releasePointerCapture(event.pointerId);
  };
  preview.onpointerup = stopDragging;
  preview.onpointercancel = stopDragging;
  preview.addEventListener('wheel', event => {
    if (gearStates[selected].selected !== DRAFT) return;
    const bounds = preview.getBoundingClientRect();
    const count = equipmentRegionCount(selected);
    const normalizedX = (event.clientX - bounds.left) / Math.max(1, bounds.width);
    const region = Math.max(0, Math.min(count - 1, Math.floor(normalizedX * count)));
    if (selectedRegions[selected] !== region) { selectedRegions[selected] = region; render(); }
    const crop = selectedCrop();
    if (!crop) return;
    event.preventDefault();
    const focusX = normalizedX * count - region;
    const focusY = (event.clientY - bounds.top) / Math.max(1, bounds.height);
    zoomCoverCrop(crop, crop.zoom * Math.exp(-event.deltaY * 0.0015),
      EQUIPMENT_CROP_MAX_ZOOM, 1 / count, 1, focusX, focusY);
    drawDraft();
  }, { passive: false });
  edgeColor.oninput = () => { colorDirty = true; };

  void currentAccount().then(async account => {
    if (disposed) return;
    if (!('user' in account)) {
      setState('This Slopesmith has no accounts, so it has no shared rider equipment profile.');
      return;
    }
    member = account.user;
    const answer = await fetchJson<{ equipment: EquipmentProfile }>('/api/auth/equipment');
    for (const gear of ['snowboard', 'skis'] as const) {
      const library: EquipmentLibrarySummary = answer.equipment[gear];
      gearStates[gear].designs = library.designs;
      gearStates[gear].initialSelectedId = library.selectedId;
      gearStates[gear].selected = library.selectedId ?? null;
    }
    edgeColor.value = answer.equipment.edgeColor;
    edgeColor.disabled = false;
    render();
  }).catch(error => setState(error instanceof Error ? error.message : String(error), 'warn'));

  return {
    el: sec,
    save: async () => {
      if (preparing) await preparing;
      if (!member) return null;
      const changed = (gear: RideGear) => {
        const gearState = gearStates[gear];
        return gearState.deleted.size > 0 || gearState.selected !== (gearState.initialSelectedId ?? null);
      };
      if (!changed('snowboard') && !changed('skis') && !colorDirty) return null;
      saving = true;
      syncControls();
      renderRegionLoads();
      try {
        const body: { snowboard?: unknown; skis?: unknown; edgeColor?: string } = {};
        const patchFor = async (gear: RideGear) => {
          const gearState = gearStates[gear];
          const base = { deleteIds: [...gearState.deleted] } as {
            deleteIds: string[]; selectedId?: string | null;
            create?: { name: string; texture: string };
            update?: { id: string; name: string; texture: string };
          };
          if (gearState.selected === DRAFT) {
            const draft = gearState.draft!;
            const name = draft.name.trim();
            if (!name) throw new Error(`Name the ${draft.editingId ? 'edited' : 'new'} ${gear === 'snowboard' ? 'snowboard' : 'ski'} design.`);
            const texture = await prepareEquipmentTexture(gear, draft);
            if (draft.editingId) {
              base.update = { id: draft.editingId, name, texture };
              base.selectedId = draft.editingId;
            } else base.create = { name, texture };
          } else if (gearState.selected !== (gearState.initialSelectedId ?? null)) {
            base.selectedId = gearState.selected;
          }
          return base;
        };
        if (changed('snowboard')) body.snowboard = await patchFor('snowboard');
        if (changed('skis')) body.skis = await patchFor('skis');
        if (colorDirty) body.edgeColor = edgeColor.value;
        const answer = await postJson<{ user: Member; equipment: EquipmentProfile }>(
          '/api/auth/equipment', JSON.stringify(body));
        member = answer.user;
        adoptAccount(answer.user);
        for (const gear of ['snowboard', 'skis'] as const) {
          discardDraft(gearStates[gear].draft);
          gearStates[gear].draft = undefined;
          gearStates[gear].deleted.clear();
          gearStates[gear].designs = answer.equipment[gear].designs;
          gearStates[gear].initialSelectedId = answer.equipment[gear].selectedId;
          gearStates[gear].selected = answer.equipment[gear].selectedId ?? null;
        }
        colorDirty = false;
        render();
        return 'saved';
      } finally {
        saving = false;
        if (disposeAfterSave) {
          discardDraft(gearStates.snowboard.draft);
          discardDraft(gearStates.skis.draft);
        }
        if (!disposed) { syncControls(); renderRegionLoads(); }
      }
    },
    dispose: () => {
      disposed = true;
      if (saving) { disposeAfterSave = true; return; }
      discardDraft(gearStates.snowboard.draft);
      discardDraft(gearStates.skis.draft);
    },
  };
}

import type { V3 } from '../../../core/doc/types';
import type { ViewState } from '../../viewport/types';
import { cameraValues, cameraView, type CameraValues } from './camera-values';

export interface CameraSpace {
  id: string;
  label: string;
  origin: V3;
}
export interface SceneCameraDeps {
  getView: () => ViewState;
  applyView: (view: ViewState) => void;
  getSpaces: () => CameraSpace[];
  getName: () => string;
  capture: () => Promise<Blob>;
  viewLink: () => string;
}

/** A view-only inspector. Poll only while visible; edits freeze the draft, never the live camera. */
export function createSceneCamera(
  host: HTMLElement,
  deps: SceneCameraDeps,
  options: { sharedHost?: HTMLElement; getSpace?: () => string } = {},
) {
  const form = document.createElement('form');
  form.className = 'sp-camera';
  form.setAttribute('aria-label', 'Scene camera');
  form.noValidate = true;
  host.appendChild(form);
  const shared = options.sharedHost ? document.createElement('div') : form;
  if (options.sharedHost) {
    shared.className = 'sp-camera';
    options.sharedHost.appendChild(shared);
  }

  const row = (title: string, input: HTMLElement, parent: HTMLElement = form) => {
    const label = document.createElement('label');
    label.className = 'sp-camera-row';
    const text = document.createElement('span');
    text.textContent = title;
    label.append(text, input);
    parent.appendChild(label);
    return label;
  };
  const space = document.createElement('select');
  space.setAttribute('aria-label', 'Camera coordinates');
  const coordinatesRow = row('Coordinates', space);
  if (options.getSpace) coordinatesRow.remove();
  const originNote = document.createElement('p');
  originNote.className = 'sp-camera-hint';
  form.appendChild(originNote);
  const vector = (name: string) => {
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = `${name} (m)`;
    fieldset.appendChild(legend);
    const inputs = ['X', 'Y', 'Z'].map(axis => {
      const label = document.createElement('label');
      label.textContent = axis;
      const input = document.createElement('input');
      input.type = 'number';
      input.step = 'any';
      input.setAttribute('aria-label', `Camera ${name.toLowerCase()} ${axis}`);
      label.appendChild(input);
      fieldset.appendChild(label);
      return input;
    });
    form.appendChild(fieldset);
    return inputs;
  };
  const position = vector('Position'),
    target = vector('Look at');
  const projection = document.createElement('select');
  projection.setAttribute('aria-label', 'Camera projection');
  projection.add(new Option('Perspective', 'perspective'));
  projection.add(new Option('Orthographic', 'ortho'));
  row('Projection', projection, shared);
  const lens = document.createElement('input');
  lens.type = 'number';
  lens.step = 'any';
  const lensRow = row('Field of view (°)', lens, shared);
  const updateLensLabel = () => {
    const label = projection.value === 'ortho' ? 'View height (m)' : 'Field of view (°)';
    lensRow.firstElementChild!.textContent = label;
    lens.setAttribute('aria-label', `Camera ${label}`);
  };
  const actions = document.createElement('div');
  actions.className = 'sp-camera-actions';
  form.appendChild(actions);
  const button = (text: string, parent: HTMLElement = actions) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    parent.appendChild(b);
    return b;
  };
  const apply = button('Apply');
  apply.type = 'submit';
  const restore = button('Restore');
  restore.title = 'Return to the view from when this Camera panel was opened.';
  const read = button('Read current');
  read.title = 'Discard pending edits and read the current camera.';
  const copy = button('Copy view link', shared);
  copy.className = 'sp-camera-save';
  const linkField = document.createElement('input');
  linkField.readOnly = true;
  linkField.hidden = true;
  linkField.setAttribute('aria-label', 'View link');
  shared.appendChild(linkField);
  const save = button('Save screenshot', shared);
  save.className = 'sp-camera-save';
  const help = document.createElement('p');
  help.className = 'sp-camera-hint';
  help.textContent = 'Restore returns to the opening view. Screenshot saves the viewport as a PNG, without panels.';
  form.appendChild(help);
  const status = document.createElement('p');
  status.className = 'sp-camera-status';
  status.setAttribute('role', 'status');
  form.appendChild(status);
  const live = document.createElement('p');
  live.className = 'sp-camera-hint sp-camera-live';
  form.appendChild(live);

  let active = false,
    dirty = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let baseline: ViewState | null = null;
  let spaces: CameraSpace[] = [];
  let selectedSpace: CameraSpace = { id: 'world', label: 'World', origin: [0, 0, 0] };
  let values: CameraValues;
  const format = (v: number) => (Number.isFinite(v) ? String(Number(v.toFixed(3))) : '');
  const message = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle('sp-camera-error', error);
  };
  const write = () => {
    position.forEach((input, i) => {
      input.value = format(values.position[i]);
    });
    target.forEach((input, i) => {
      input.value = format(values.target[i]);
    });
    projection.value = values.ortho ? 'ortho' : 'perspective';
    lens.value = format(values.ortho ? values.height : values.fov);
    updateLensLabel();
  };
  const readCurrent = () => {
    values = cameraValues(deps.getView(), selectedSpace.origin);
    dirty = false;
    write();
    message('Live camera · values follow navigation.');
    live.textContent = '';
  };
  const refreshSpaces = () => {
    const next = deps.getSpaces();
    const desired = options.getSpace?.() ?? selectedSpace.id;
    if (JSON.stringify(next) === JSON.stringify(spaces) && selectedSpace.id === desired) return;
    spaces = next;
    const previous = selectedSpace;
    selectedSpace = spaces.find(s => s.id === desired) ?? spaces[0];
    space.replaceChildren(...spaces.map(s => new Option(s.label, s.id)));
    space.value = selectedSpace.id;
    const unavailable = !!options.getSpace && selectedSpace.id !== desired;
    originNote.textContent = unavailable
      ? 'Load a reference mountain to inspect camera coordinates relative to it.'
      : selectedSpace.id === 'world'
        ? 'Metres · Y up · same axes as the mountain.'
        : `Zero = terrain centre (${selectedSpace.origin.map(format).join(', ')}). Y up.`;
    for (const field of [...position, ...target, apply]) field.disabled = unavailable;
    if (JSON.stringify(previous) !== JSON.stringify(selectedSpace)) {
      if (options.getSpace && dirty && !unavailable && previous.id !== selectedSpace.id) {
        for (const point of [values.position, values.target])
          point.forEach((v, i) => {
            point[i] = v + previous.origin[i] - selectedSpace.origin[i];
          });
        write();
      } else readCurrent(); // moved/unloaded references invalidate drafts against their previous placement
    }
  };
  const refresh = () => {
    refreshSpaces();
    if (!dirty && !(form.contains(document.activeElement) && document.activeElement?.matches('input, select'))) {
      values = cameraValues(deps.getView(), selectedSpace.origin);
      write();
    }
    if (dirty) {
      const now = cameraValues(deps.getView(), selectedSpace.origin);
      live.textContent = `Live position: ${now.position.map(format).join(', ')}\nLive look-at: ${now.target.map(format).join(', ')}`;
    }
  };
  const markDirty = () => {
    dirty = true;
    message('Pending edits · Apply to move the camera.');
  };
  const number = (input: HTMLInputElement) => (input.value.trim() ? Number(input.value) : NaN);
  position.forEach((input, i) =>
    input.addEventListener('input', () => {
      values.position[i] = number(input);
      markDirty();
    }),
  );
  target.forEach((input, i) =>
    input.addEventListener('input', () => {
      values.target[i] = number(input);
      markDirty();
    }),
  );
  lens.addEventListener('input', () => {
    if (values.ortho) values.height = number(lens);
    else values.fov = number(lens);
    markDirty();
  });
  projection.addEventListener('change', () => {
    values.ortho = projection.value === 'ortho';
    lens.value = format(values.ortho ? values.height : values.fov);
    updateLensLabel();
    markDirty();
  });
  space.addEventListener('change', () => {
    const next = spaces.find(s => s.id === space.value)!;
    // Re-express the draft in the new frame without moving the camera or losing pending edits.
    for (const point of [values.position, values.target])
      point.forEach((v, i) => {
        point[i] = v + selectedSpace.origin[i] - next.origin[i];
      });
    selectedSpace = next;
    originNote.textContent =
      next.id === 'world'
        ? 'Metres · Y up · same axes as the mountain.'
        : `Zero = terrain centre (${next.origin.map(format).join(', ')}). Y up.`;
    write();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    try {
      deps.applyView(cameraView(values, selectedSpace.origin, deps.getView()));
      readCurrent();
      message('Camera applied.');
    } catch (error) {
      message(error instanceof Error ? error.message : String(error), true);
    }
  });
  restore.onclick = () => {
    if (baseline) deps.applyView(structuredClone(baseline));
    readCurrent();
    message('Opening view restored.');
  };
  read.onclick = readCurrent;
  copy.onclick = async () => {
    try {
      const url = deps.viewLink();
      linkField.value = url;
      linkField.hidden = false;
      try {
        await navigator.clipboard.writeText(url);
        message(dirty ? 'Copied the live camera; edits are still pending.' : 'View link copied.');
      } catch {
        linkField.focus();
        linkField.select();
        message('Copy the selected view link.');
      }
    } catch (e) {
      message(e instanceof Error ? e.message : String(e), true);
    }
  };
  save.onclick = async () => {
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const blob = await deps.capture();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const name = deps.getName().replace(/[^a-z0-9_-]+/gi, '-') || 'mountain';
      link.download = `${name}-camera-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      message(dirty ? 'Screenshot saved from the live camera. Edits are still pending.' : 'Screenshot saved.');
    } catch (error) {
      message(error instanceof Error ? error.message : String(error), true);
    } finally {
      save.disabled = false;
      save.textContent = 'Save screenshot';
    }
  };
  return {
    refresh() {
      if (active) refresh();
    },
    setActive(on: boolean) {
      if (on === active) return;
      active = on;
      clearInterval(timer);
      timer = undefined;
      if (!on) return;
      baseline = structuredClone(deps.getView());
      refreshSpaces();
      readCurrent();
      timer = setInterval(refresh, 200);
    },
  };
}

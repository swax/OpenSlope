import './new-map.css';
import { defaultMountain } from '../../core/doc/mountain';
import { safeDataName } from '../../core/export/names';
import { localEditorUrl, mapPath } from '../navigation';
import { clientId } from '../net/client';
import { openLocalProjects } from '../state/local-projects';
import type { ClientProject } from '../state/project-sync';
import { element } from './dom';
import { readMountainArchive } from '../mountain/archive';
import { rememberMountainImport } from '../mountain/import-notice';
import type { ProjectBundle } from '../../core/project/transfer';

type MapDialogOptions = { canCreateServer: boolean; localNames: string[] };

/** Name and choose storage before creating anything. Local remains available without a server connection. */
export function showNewMapDialog(options: MapDialogOptions): void {
  showMapDialog(options, false);
}

export function showImportMountainDialog(options: MapDialogOptions): void {
  showMapDialog(options, true);
}

function showMapDialog(options: MapDialogOptions, importing: boolean): void {
  if (document.querySelector('.public-new-map-dialog')) return;
  const dialog = element('dialog', 'public-new-map-dialog');
  const title = importing ? 'Import mountain' : 'New map';
  dialog.setAttribute('aria-label', title);
  const form = element('form', '');
  const heading = element('h2', '', title);
  const fileLabel = element('label', '', 'Mountain file');
  const file = element('input', '');
  file.type = 'file';
  file.accept = '.zip,application/zip';
  fileLabel.append(file);
  const fileStatus = element('p', 'public-new-map-hint');
  fileStatus.setAttribute('role', 'status');
  fileStatus.textContent = 'Choose an editable .slopesmith.zip archive.';
  let bundle: ProjectBundle | null = null;
  let reading = false;
  let fileError = '';
  let submitError = '';
  let fileGeneration = 0;
  const nameLabel = element('label', '', 'Map name');
  const name = element('input', '');
  name.type = 'text';
  name.maxLength = 64;
  name.required = true;
  name.autocomplete = 'off';
  name.spellcheck = false;
  const taken = new Set(options.localNames.map(value => value.toLowerCase()));
  let number = 1;
  while (taken.has(`mountain${String(number).padStart(2, '0')}`)) number++;
  name.value = importing ? '' : `MOUNTAIN${String(number).padStart(2, '0')}`;
  nameLabel.append(name);
  const locationLabel = element('label', '', 'Save location');
  const storage = element('select', '');
  const local = element('option', '', 'Local — this browser');
  local.value = 'local';
  storage.append(local);
  if (options.canCreateServer) {
    const server = element('option', '', 'Server');
    server.value = 'server';
    storage.append(server);
  }
  locationLabel.append(storage);
  const hint = element('p', 'public-new-map-hint');
  const error = element('p', 'public-new-map-error');
  error.setAttribute('role', 'alert');
  const actions = element('div', 'public-new-map-actions');
  const cancel = element('button', '', 'Cancel');
  cancel.type = 'button';
  const submitLabel = importing ? 'Import mountain' : 'Create map';
  const create = element('button', 'public-new-map-submit', submitLabel);
  create.type = 'submit';
  actions.append(cancel, create);
  form.append(heading, ...(importing ? [fileLabel, fileStatus] : []), nameLabel, locationLabel, hint, error, actions);
  dialog.append(form);
  document.body.append(dialog);
  let saving = false;
  const check = () => {
    const value = name.value.trim();
    const problem =
      fileError ||
      (value && safeDataName(value) !== value
        ? 'Use only letters, numbers, hyphens, and underscores.'
        : storage.value === 'local' && taken.has(value.toLowerCase())
          ? 'A local map already uses that name.'
          : '');
    error.textContent = problem || submitError;
    create.disabled = saving || !value || !!problem || (importing && (reading || !bundle));
  };
  const updateStorage = () => {
    hint.textContent =
      storage.value === 'server' ? 'Saved on the server under your account.' : 'Saved in this browser on this device.';
    check();
  };
  name.oninput = () => {
    submitError = '';
    check();
  };
  file.onchange = async () => {
    const selected = file.files?.[0];
    const generation = ++fileGeneration;
    bundle = null;
    fileError = '';
    submitError = '';
    reading = !!selected;
    name.value = selected
      ? selected.name
          .replace(/(?:\.slopesmith)?\.zip$/i, '')
          .replace(/[^A-Za-z0-9_-]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 64) || 'MOUNTAIN01'
      : '';
    fileStatus.textContent = selected ? 'Reading mountain…' : 'Choose an editable .slopesmith.zip archive.';
    check();
    if (!selected) return;
    try {
      const parsed = await readMountainArchive(selected);
      if (generation !== fileGeneration || !dialog.isConnected) return;
      bundle = parsed;
      fileStatus.textContent = 'Archive ready.';
    } catch (cause) {
      if (generation !== fileGeneration || !dialog.isConnected) return;
      fileError = cause instanceof Error ? cause.message : 'Could not read that mountain archive.';
      fileStatus.textContent = '';
    } finally {
      if (generation === fileGeneration && dialog.isConnected) {
        reading = false;
        check();
      }
    }
  };
  storage.onchange = () => {
    submitError = '';
    updateStorage();
  };
  cancel.onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => {
    if (saving) event.preventDefault();
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  async function submit() {
    check();
    if (create.disabled) return;
    saving = true;
    submitError = '';
    create.disabled = cancel.disabled = name.disabled = storage.disabled = file.disabled = true;
    create.textContent = importing ? 'Importing…' : 'Creating…';
    error.textContent = '';
    try {
      const value = name.value.trim();
      let target: string;
      let importedProject: ClientProject | undefined;
      let absent: string[] = [];
      if (storage.value === 'server') {
        if (!options.canCreateServer) throw new Error('Sign in to create a server map.');
        const response = await fetch(importing ? '/api/projects/transfer' : '/api/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-slopesmith-client': clientId },
          body: JSON.stringify(importing ? { bundle, name: value } : { name: value }),
        });
        const result = (await response.json()) as { project: ClientProject; absent?: string[]; error?: string };
        if (!response.ok) throw new Error(result.error ?? 'Could not create the server map.');
        const url = new URL(mapPath('editor', result.project.name), location.origin);
        url.searchParams.set('project', result.project.id);
        target = url.href;
        importedProject = result.project;
        absent = result.absent ?? [];
      } else {
        const projects = await openLocalProjects();
        try {
          if (projects.list().some(project => project.name.toLowerCase() === value.toLowerCase()))
            throw new Error('A local map already uses that name.');
          let project: ClientProject;
          if (importing) {
            const response = await projects.request(new URL('/api/projects/transfer', location.origin), {
              method: 'POST',
              body: JSON.stringify({ bundle, name: value }),
            });
            if (!response) throw new Error('Could not import into browser storage.');
            const result = (await response.json()) as { project: ClientProject; absent?: string[]; error?: string };
            if (!response.ok) throw new Error(result.error ?? 'Could not import that mountain.');
            project = result.project;
            absent = result.absent ?? [];
          } else {
            const document = defaultMountain();
            document.name = value;
            project = (await projects.seed(document)).project;
          }
          importedProject = project;
          target = localEditorUrl(project.name, project.id);
        } finally {
          projects.close();
        }
      }
      if (importing && importedProject)
        rememberMountainImport(importedProject.id, [...new Set([...(bundle?.missing ?? []), ...absent])]);
      location.assign(target);
    } catch (cause) {
      submitError = cause instanceof Error ? cause.message : String(cause);
      saving = false;
      cancel.disabled = name.disabled = storage.disabled = file.disabled = false;
      create.textContent = submitLabel;
      check();
    }
  }
  form.onsubmit = event => {
    event.preventDefault();
    void submit();
  };
  updateStorage();
  dialog.showModal();
  if (importing) file.focus();
  else {
    name.focus();
    name.select();
  }
}
